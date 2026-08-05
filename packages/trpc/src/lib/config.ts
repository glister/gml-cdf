import { type Kysely, sql, type Transaction } from 'kysely';
import { appendEvent, newUuidV7, type DB } from '@repo/db';
import type { EventPayload } from '@repo/domain';
import type { z } from 'zod';
// Through the barrel, never `./registry.js`: keys register as a side effect of
// loading their definition module, and the barrel is what guarantees they have.
import {
  ConfigValueInvalidError,
  qualifiedName,
  requireConfigKey,
  type ConfigKeyDef,
} from '../config/index.js';
import { isUniqueViolation } from './pg-errors.js';

/**
 * The configuration resolution and write API (core plan 06 §4.7).
 *
 * Two properties make historical behaviour reproducible, and both live here:
 *
 *  - **Reads are as-at.** The workflow runtime resolves each `config:` reference
 *    with `at = transition occurred_at`, inside the transaction that writes the
 *    transition and its event — so the transition, its event and the value it
 *    acted on are mutually consistent, and re-reading the journal later with the
 *    same `at` reproduces the decision exactly, however many times the key has
 *    changed since (ADR-0016: "a threshold change never rewrites the past").
 *  - **Writes supersede.** A value is never updated in place; the open row is
 *    closed and a successor inserted, in one transaction with its journal event.
 *
 * **Purity boundary (ADR-0009/0013).** `@repo/domain` guards never call
 * `getConfig` — they are pure functions receiving resolved *values* as
 * parameters (`blackoutCheck(request, { blackoutPeriods })`). Orchestration
 * resolves; the guard decides. A `@repo/db` import inside `@repo/domain` is a
 * review-blocking smell, and the package's lint config forbids it outright.
 *
 * There is no cache (§1 non-goals). Reads are point queries on
 * `config_entry_as_at_ix`; at CDF's scale that is cheaper than invalidating a
 * cache correctly, and it means a change takes effect on the very next decision
 * with no invalidation machinery to get wrong.
 */

/** The event schemas' JSON value type — zod's recursive `z.json()` output. */
type JournalledValue = EventPayload<'platform.config_entry.changed'>['newValue'];

/**
 * A jsonb column comes back as Kysely's `JsonValue`; the event payload schema
 * types the same thing as zod's `z.json()`. The two describe exactly the same
 * set of values but are distinct recursive aliases TypeScript cannot reconcile
 * structurally, so one cast at this boundary is the honest fix — and the value
 * is validated by the key's own schema either side of it.
 */
function asJournalledValue(value: unknown): JournalledValue {
  return value as JournalledValue;
}

/** A read or write for a key whose stored row could not be resolved. */
export class ConfigWriteConflictError extends Error {
  constructor(readonly qualifiedName: string) {
    super(
      `configuration key '${qualifiedName}' was changed by someone else while this change was being saved — reload and try again`,
    );
    this.name = 'ConfigWriteConflictError';
  }
}

/** Rejected before any write: the requested instant would rewrite history. */
export class ConfigEffectiveFromError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigEffectiveFromError';
  }
}

/** One resolved value plus the provenance the admin surfaces render. */
export interface ResolvedConfig<T> {
  value: T;
  /** `true` when no entry was in force and the registered code default applied. */
  isDefault: boolean;
  /** The version row that supplied the value; `null` when it came from the default. */
  version: number | null;
  /** When that version took effect; `null` for the default. */
  validFrom: Date | null;
  /** The entry row's id; `null` for the default. */
  entryId: string | null;
}

/**
 * The single window predicate, half-open `[valid_from, valid_to)`.
 *
 * `at` defaults to Postgres `now()` — the server clock is the only time
 * authority (§12.1), so an app server never computes an effective instant
 * locally. **Note this is not "the row with `valid_to IS NULL`":** a scheduled
 * future change leaves the *successor* open while the predecessor is still the
 * value in force, so selecting the open row would return a value that has not
 * started yet. Current and as-at reads therefore run exactly the same query.
 */
function inForceAt(at?: Date) {
  const instant = at === undefined ? sql<Date>`now()` : sql<Date>`${at}`;
  return sql<boolean>`valid_from <= ${instant} AND (valid_to IS NULL OR valid_to > ${instant})`;
}

/**
 * Resolve a key with its provenance. Used by the admin surfaces; engines want
 * {@link getConfig}, which is this minus the metadata.
 *
 * A stored value that fails its key's schema **throws** rather than returning a
 * best-effort value (ADR-0016 fail-fast): it means the registry and the store
 * have drifted, and a silently misconfigured engine is far worse than a loud
 * failure. Schemas must therefore accept their own key's history — widen with
 * `z.union`, optional fields or transforms; closed rows can never be rewritten.
 */
export async function resolveConfig<S extends z.ZodType>(
  db: Kysely<DB>,
  def: ConfigKeyDef<S>,
  opts?: { at?: Date },
): Promise<ResolvedConfig<z.infer<S>>> {
  const row = await db
    .selectFrom('platform.config_entry')
    .select(['id', 'value', 'version', 'valid_from'])
    .where('namespace', '=', def.namespace)
    .where('key', '=', def.key)
    .where(inForceAt(opts?.at))
    .executeTakeFirst();

  if (!row) {
    return {
      value: def.defaultValue as z.infer<S>,
      isDefault: true,
      version: null,
      validFrom: null,
      entryId: null,
    };
  }

  const parsed = def.schema.safeParse(row.value);
  if (!parsed.success) {
    throw new ConfigValueInvalidError(qualifiedName(def), parsed.error);
  }

  return {
    value: parsed.data as z.infer<S>,
    isDefault: false,
    version: row.version,
    validFrom: row.valid_from,
    entryId: row.id,
  };
}

/**
 * The value in force — now, or at `opts.at` for a historical decision.
 *
 * Falls back to the key's registered default when no entry has ever been
 * written, or when the open row was closed by a reset. Accepts a `Transaction`
 * as well as the root instance (a transaction *is* a `Kysely<DB>`), which is how
 * the workflow runtime resolves inside the transition's own transaction.
 */
export async function getConfig<S extends z.ZodType>(
  db: Kysely<DB>,
  def: ConfigKeyDef<S>,
  opts?: { at?: Date },
): Promise<z.infer<S>> {
  return (await resolveConfig(db, def, opts)).value;
}

/** The `config:` reference grammar workflow definitions use (ADR-0013). */
const CONFIG_REF_PREFIX = 'config:';

/**
 * Parse and resolve a `config:<namespace>.<key>` reference from a workflow
 * definition. Throws on an unknown key **at definition-load time**, so a typo in
 * a definition is a boot failure rather than a transition that silently takes a
 * default (ADR-0013/0016).
 */
export function parseConfigRef(ref: string): ConfigKeyDef {
  if (!ref.startsWith(CONFIG_REF_PREFIX)) {
    throw new Error(
      `invalid config reference '${ref}': workflow definitions reference values as 'config:<namespace>.<key>'`,
    );
  }
  const name = ref.slice(CONFIG_REF_PREFIX.length);
  if (name.length === 0) {
    throw new Error(`invalid config reference '${ref}': no key name after 'config:'`);
  }
  return requireConfigKey(name);
}

export interface SetConfigArgs<S extends z.ZodType> {
  def: ConfigKeyDef<S>;
  value: z.infer<S>;
  actorPersonId: string;
  /** Stage the change for a future instant; omitted means "now". */
  effectiveFrom?: Date;
  correlationId: string;
}

export interface SetConfigResult {
  entryId: string;
  version: number;
  validFrom: Date;
}

/**
 * Supersede a key's value (§4.1 steps 1–7) — the **single write path** for
 * `platform.config_entry` (ADR-0022). Runs entirely inside the caller's
 * transaction, so the entry, its predecessor's closing stamp and the journal
 * event commit together or not at all.
 *
 *  1. Lock the row currently in force (`FOR UPDATE`), serialising writers.
 *  2. Validate the proposed value against the registry schema — an invalid
 *     value aborts before anything is written.
 *  3. Resolve the effective instant from the **database** clock.
 *  4. Close the predecessor at that instant (the one UPDATE the guard permits).
 *  5. Insert the successor at `version + 1`, `valid_from = effective`.
 *  6. Append `platform.config_entry.changed` (`kind='admin'`, PL-030).
 *
 * Because `valid_to` of the predecessor equals `valid_from` of the successor,
 * windows tile exactly and the changeover instant reads the new value.
 *
 * A **future** `effectiveFrom` stages the change: it closes the in-force row at
 * that instant and inserts the successor ahead of time, so current and as-at
 * reads keep returning the old value until it passes. That is how next year's
 * shut-down dates are staged without a scheduler. A **past** `effectiveFrom` is
 * rejected — it would rewrite decisions already made.
 */
export async function setConfig<S extends z.ZodType>(
  trx: Transaction<DB>,
  input: SetConfigArgs<S>,
): Promise<SetConfigResult> {
  const { def } = input;
  const name = qualifiedName(def);

  // Serialise concurrent writers on this key. `forUpdate` locks the in-force
  // row; on a first-ever write there is nothing to lock, and the partial unique
  // index is what picks the winner instead (step 7 below).
  const current = await trx
    .selectFrom('platform.config_entry')
    .select(['id', 'version', 'value', 'valid_from', 'valid_to'])
    .where('namespace', '=', def.namespace)
    .where('key', '=', def.key)
    .where('valid_to', 'is', null)
    .forUpdate()
    .executeTakeFirst();

  const parsed = def.schema.safeParse(input.value);
  if (!parsed.success) {
    // Surfaced as BAD_REQUEST at the tRPC boundary. Thrown before any write, so
    // the transaction leaves neither a row nor an event behind.
    throw parsed.error;
  }

  const { now } = await sql<{ now: Date }>`SELECT now() AS now`
    .execute(trx)
    .then((r) => r.rows[0]!);

  const effective = input.effectiveFrom ?? now;
  if (input.effectiveFrom) {
    if (effective.getTime() < now.getTime()) {
      throw new ConfigEffectiveFromError(
        `'${name}' cannot take effect in the past — a configuration change never rewrites decisions already made (ADR-0016)`,
      );
    }
    if (current && effective.getTime() <= current.valid_from.getTime()) {
      throw new ConfigEffectiveFromError(
        `'${name}' must take effect after the version currently in force (${current.valid_from.toISOString()})`,
      );
    }
  }

  const entryId = newUuidV7();
  const version = (current?.version ?? 0) + 1;

  try {
    if (current) {
      await trx
        .updateTable('platform.config_entry')
        .set({ valid_to: effective, updated_by: input.actorPersonId })
        .where('id', '=', current.id)
        .execute();
    }

    await trx
      .insertInto('platform.config_entry')
      .values({
        id: entryId,
        namespace: def.namespace,
        key: def.key,
        // Explicit cast: a bare JS scalar bound to a jsonb column is a type
        // error in Postgres, and config values are as often numbers as objects.
        value: sql`${JSON.stringify(parsed.data)}::jsonb`,
        valid_from: effective,
        valid_to: null,
        version,
        created_by: input.actorPersonId,
        updated_by: input.actorPersonId,
      })
      .execute();
  } catch (error) {
    // Step 7: a writer that slipped past the lock — the first-ever-write race,
    // where there was no row to lock. The partial unique index and the version
    // constraint make exactly one transaction win; the loser reloads.
    if (
      isUniqueViolation(error, 'config_entry_one_open_uq') ||
      isUniqueViolation(error, 'config_entry_version_uq')
    ) {
      throw new ConfigWriteConflictError(name);
    }
    throw error;
  }

  await appendEvent(trx, {
    kind: 'admin',
    streamType: 'platform.config_entry',
    streamId: entryId,
    eventType: 'platform.config_entry.changed',
    payload: {
      namespace: def.namespace,
      key: def.key,
      fromVersion: current?.version ?? null,
      toVersion: version,
      // Config values are policy data, never personal data (§4.5), so the audit
      // view can be self-contained. `sensitiveValue` is the escape hatch if an
      // exception is ever justified.
      ...(def.sensitiveValue
        ? {}
        : {
            oldValue: asJournalledValue(current ? current.value : def.defaultValue),
            newValue: asJournalledValue(parsed.data),
          }),
      validFrom: effective.toISOString(),
    },
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });

  return { entryId, version, validFrom: effective };
}

export interface ResetConfigArgs {
  def: ConfigKeyDef;
  actorPersonId: string;
  correlationId: string;
}

/**
 * Revert a key to its registered code default: close the in-force row at `now()`
 * with **no** successor, so reads after that instant fall back to the default.
 * Historical reads are untouched — this closes a window, it does not delete one.
 *
 * A key already sitting on its default is a no-op: no write, no event. An admin
 * event asserting a change that did not happen would be noise in plan 13's audit
 * view and in the reporting feed.
 */
export async function resetConfig(
  trx: Transaction<DB>,
  input: ResetConfigArgs,
): Promise<{ reset: boolean; closedVersion: number | null }> {
  const { def } = input;

  const current = await trx
    .selectFrom('platform.config_entry')
    .select(['id', 'version', 'value', 'valid_from'])
    .where('namespace', '=', def.namespace)
    .where('key', '=', def.key)
    .where('valid_to', 'is', null)
    .forUpdate()
    .executeTakeFirst();

  if (!current) return { reset: false, closedVersion: null };

  const { now } = await sql<{ now: Date }>`SELECT now() AS now`
    .execute(trx)
    .then((r) => r.rows[0]!);

  // Reset closes the row **in force now**. When a change is staged, the open row
  // has not started yet and the row actually in force is already closed at the
  // staged instant — closed rows are immutable, so there is no window for reset
  // to close. Closing the staged row at its own `valid_from` would be a
  // zero-width window (`valid_to > valid_from` is a CHECK), and closing it later
  // would still let it apply in between. The intent is expressible, just not as
  // a reset: supersede the staged change with an explicit value instead.
  if (current.valid_from.getTime() > now.getTime()) {
    throw new ConfigEffectiveFromError(
      `'${qualifiedName(def)}' has a change staged for ${current.valid_from.toISOString()} and cannot be reset — set an explicit value effective after that instant to supersede it`,
    );
  }

  await trx
    .updateTable('platform.config_entry')
    .set({ valid_to: now, updated_by: input.actorPersonId })
    .where('id', '=', current.id)
    .execute();

  await appendEvent(trx, {
    kind: 'admin',
    streamType: 'platform.config_entry',
    streamId: current.id,
    eventType: 'platform.config_entry.reset',
    payload: {
      namespace: def.namespace,
      key: def.key,
      closedVersion: current.version,
      ...(def.sensitiveValue
        ? {}
        : {
            oldValue: asJournalledValue(current.value),
            defaultValue: asJournalledValue(def.defaultValue),
          }),
    },
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });

  return { reset: true, closedVersion: current.version };
}
