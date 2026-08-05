import { TRPCError } from '@trpc/server';
import { sql } from 'kysely';
import { z } from 'zod';
import { hasRole } from '@repo/domain';
import { roleProcedure, router, type TRPCContext } from '../../trpc.js';
import {
  configHistoryInput,
  getConfigInput,
  listConfigInput,
  resetConfigInput,
  setConfigInput,
  type ConfigEditorKind,
  type ConfigEntrySummary,
  type ConfigSchemaDescriptor,
} from '../../schemas.js';
// Through the barrel, never `../../config/registry.js`: keys register as a side
// effect of loading their definition module, so importing the registry alone
// would list whatever happened to have been loaded — an empty browser in the
// worst case. The "lists the pilot key" test is the tripwire for that mistake.
import { configRegistry, qualifiedName, type ConfigKeyDef } from '../../config/index.js';
import {
  ConfigEffectiveFromError,
  ConfigWriteConflictError,
  resetConfig,
  resolveConfig,
  setConfig,
} from '../../lib/config.js';
import { decodeCursor, encodeCursor, keysetBoundary, timestampSortKey } from '../../lib/keyset.js';
import type { RoleKey } from '../../lib/constants.js';

/**
 * The configuration store's admin surface (core plan 06 §5.1, PL-029/030).
 *
 * Two authorisation granularities, both server-side (ADR-0015):
 *
 *  - **Procedure level** — Administrator ∪ HR User in the platform module may
 *    read every key and its history. Configuration is not secret; knowing the
 *    fit-note threshold is part of doing the job.
 *  - **Record level** — editing is gated per key by the registry's `editableBy`,
 *    checked inside `set`/`reset`. §12.2 Q4 (resolved 2026-08-05) settled that
 *    there is no blanket "`platform.*` is Administrator-only" rule: the key's
 *    own list decides, so plan 10 can hand `platform.notifications.*` to HR User
 *    while `platform.identity.*` stays with Administrator.
 *
 * `list` is **registry-driven**: the set of keys is code, not rows, so it cannot
 * be a SQL query and there is nothing to paginate — the row count is fixed at
 * build time. Filtering and sorting still happen server-side, which is what the
 * hard rule is actually about; one SQL query fetches the entries in force for
 * the matching keys.
 */

/**
 * Configuration maintenance: Administrator ∪ HR User, in the platform module.
 * Composed here rather than imported, per the 2026-08-03 reconciliation entry —
 * plan 04 exports the generic `roleProcedure`, and a bespoke builder is defined
 * once beside its primary router.
 */
const configAdminProcedure = roleProcedure(['administrator', 'hr_user'], { module: 'platform' });

/** The acting person's id — guaranteed non-null by `roleProcedure`. */
function requireActor(ctx: TRPCContext): string {
  if (!ctx.actorPersonId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The acting user is not linked to a person record',
    });
  }
  return ctx.actorPersonId;
}

/** Resolve a registered key, or 404. An unknown key has no rows to hide. */
function requireKey(namespace: string, key: string): ConfigKeyDef {
  const def = configRegistry.get(`${namespace}.${key}`);
  if (!def) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `'${namespace}.${key}' is not a registered configuration key`,
    });
  }
  return def;
}

/** May this caller edit this key? The record-level half of ADR-0015. */
function canEdit(ctx: TRPCContext, def: ConfigKeyDef): boolean {
  return hasRole(ctx.grants, def.editableBy as readonly RoleKey[], 'platform', new Date());
}

function assertCanEdit(ctx: TRPCContext, def: ConfigKeyDef): void {
  if (!canEdit(ctx, def)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `'${qualifiedName(def)}' is editable by [${def.editableBy.join(', ')}] only`,
    });
  }
}

/**
 * Describe a key's registered schema for the editor.
 *
 * Derived from the schema, never from the current value: a key whose value
 * happens to be `0` today is still a number key when it is unset, and a key
 * that has never been written has no value to infer from at all. Anything the
 * registry can express but this cannot — objects, arrays, unions — falls to
 * `json`, which the UI edits as validated JSON text rather than pretending to
 * offer a typed control.
 */
function describeSchema(def: ConfigKeyDef): ConfigSchemaDescriptor {
  let jsonSchema: unknown = null;
  try {
    jsonSchema = z.toJSONSchema(def.schema, { io: 'input' });
  } catch {
    // A schema with a transform or a custom check has no JSON-Schema form. The
    // editor falls back to JSON text and the server still validates on write.
    jsonSchema = null;
  }

  const node = (jsonSchema ?? {}) as {
    type?: string;
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
  };

  let editorKind: ConfigEditorKind = 'json';
  if (Array.isArray(node.enum)) editorKind = 'enum';
  else if (node.type === 'integer') editorKind = 'integer';
  else if (node.type === 'number') editorKind = 'number';
  else if (node.type === 'string') editorKind = 'string';
  else if (node.type === 'boolean') editorKind = 'boolean';

  return {
    editorKind,
    jsonSchema,
    options:
      editorKind === 'enum' && Array.isArray(node.enum) ? node.enum.map((v) => String(v)) : null,
    minimum: typeof node.minimum === 'number' ? node.minimum : null,
    maximum: typeof node.maximum === 'number' ? node.maximum : null,
  };
}

/**
 * A `jsonb` column reads back as Kysely's `Json` alias, which is declared inside
 * `@repo/db`'s generated types. Letting it into a procedure's return type makes
 * the whole router's inferred type unnameable from outside the package
 * (TS2742). It is `unknown` to every caller anyway — the registry schema, not
 * the column type, is what gives a config value its shape — so it is narrowed
 * here, once, at the boundary.
 */
function asOpaqueValue(value: unknown): unknown {
  return value;
}

/** One entry row joined to the name of whoever last touched it. */
interface EntryRow {
  namespace: string;
  key: string;
  value: unknown;
  version: number;
  valid_from: Date;
  updated_at: Date;
  updated_by_name: string | null;
}

/**
 * The entries in force **now** for a set of keys, in one query.
 *
 * The predicate is the window, not `valid_to IS NULL`: a staged future change
 * leaves the successor open while the predecessor is still in force, so reading
 * the open row would show every staged change as though it had already happened
 * (§4.1).
 */
async function entriesInForce(
  ctx: TRPCContext,
  defs: ConfigKeyDef[],
): Promise<Map<string, EntryRow>> {
  if (defs.length === 0) return new Map();

  const rows = await ctx.db
    .selectFrom('platform.config_entry as c')
    .leftJoin('platform.person as p', 'p.id', 'c.updated_by')
    .select([
      'c.namespace',
      'c.key',
      'c.value',
      'c.version',
      'c.valid_from',
      'c.updated_at',
      'p.display_name as updated_by_name',
    ])
    .where(sql<boolean>`c.valid_from <= now() AND (c.valid_to IS NULL OR c.valid_to > now())`)
    .where((eb) =>
      eb.or(
        defs.map((def) =>
          eb.and([eb('c.namespace', '=', def.namespace), eb('c.key', '=', def.key)]),
        ),
      ),
    )
    .execute();

  return new Map(rows.map((row) => [`${row.namespace}.${row.key}`, row as EntryRow]));
}

/** Merge one registry key with its in-force entry (or the frozen default). */
function toSummary(
  ctx: TRPCContext,
  def: ConfigKeyDef,
  entry: EntryRow | undefined,
): ConfigEntrySummary {
  return {
    namespace: def.namespace,
    key: def.key,
    qualifiedName: qualifiedName(def),
    description: def.description,
    registeredBy: def.registeredBy,
    value: entry ? entry.value : def.defaultValue,
    defaultValue: def.defaultValue,
    isDefault: entry === undefined,
    version: entry?.version ?? null,
    validFrom: entry?.valid_from.toISOString() ?? null,
    updatedAt: entry?.updated_at.toISOString() ?? null,
    updatedByName: entry?.updated_by_name ?? null,
    editableBy: [...def.editableBy],
    canEdit: canEdit(ctx, def),
  };
}

export const configRouter = router({
  /**
   * The config browser. Every registered key merged with the entry in force,
   * filtered and sorted server-side.
   */
  list: configAdminProcedure.input(listConfigInput).query(async ({ ctx, input }) => {
    const search = input.search?.toLowerCase();
    const defs = [...configRegistry.values()].filter((def) => {
      if (input.namespace && def.namespace !== input.namespace) return false;
      if (input.editableOnly && !canEdit(ctx, def)) return false;
      if (search) {
        const haystack = `${qualifiedName(def)} ${def.description}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

    const entries = await entriesInForce(ctx, defs);
    const items = defs.map((def) => toSummary(ctx, def, entries.get(qualifiedName(def))));

    // Sorting is server-side for the same reason filtering is: the client must
    // never be the place a list's order is decided. `updated_at` sorts unset
    // keys last in either direction — "never changed" is not a date, and
    // pretending it is one would put defaults at an arbitrary end.
    items.sort((a, b) => {
      const dir = input.sortDir === 'asc' ? 1 : -1;
      if (input.sort === 'updated_at') {
        if (a.updatedAt === b.updatedAt) return a.qualifiedName.localeCompare(b.qualifiedName);
        if (a.updatedAt === null) return 1;
        if (b.updatedAt === null) return -1;
        return a.updatedAt < b.updatedAt ? -dir : dir;
      }
      return a.qualifiedName.localeCompare(b.qualifiedName) * dir;
    });

    // No cursor: the registry is code, so this set cannot grow at runtime.
    return { items, total: items.length, namespaces: namespacesOf() };
  }),

  /** One key: the value in force (or as-at), its schema, and any staged change. */
  get: configAdminProcedure.input(getConfigInput).query(async ({ ctx, input }) => {
    const def = requireKey(input.namespace, input.key);
    const at = input.at ? new Date(input.at) : undefined;

    const resolved = await resolveConfig(ctx.db, def, { at });

    const [entries, staged] = await Promise.all([
      entriesInForce(ctx, [def]),
      // The open row when it has not started yet — a change staged for later.
      // Surfacing it matters: it is the row `set` will supersede, and a screen
      // that showed only "current" would hide it entirely.
      ctx.db
        .selectFrom('platform.config_entry')
        .select(['version', 'valid_from', 'value'])
        .where('namespace', '=', def.namespace)
        .where('key', '=', def.key)
        .where('valid_to', 'is', null)
        .where('valid_from', '>', sql<Date>`now()`)
        .executeTakeFirst(),
    ]);

    const summary = toSummary(ctx, def, entries.get(qualifiedName(def)));

    return {
      ...summary,
      // An as-at read answers a different question from "what is in force", so
      // the value and its provenance come from the as-at resolution.
      value: resolved.value,
      isDefault: at ? resolved.isDefault : summary.isDefault,
      version: at ? resolved.version : summary.version,
      validFrom: at ? (resolved.validFrom?.toISOString() ?? null) : summary.validFrom,
      schema: describeSchema(def),
      pendingChange: staged
        ? {
            version: staged.version,
            validFrom: staged.valid_from.toISOString(),
            value: asOpaqueValue(staged.value),
          }
        : null,
    };
  }),

  /**
   * Change a value — the PL-029 path: an authorised role edits a decision point
   * and the next decision uses it, with no code change, build or deployment.
   */
  set: configAdminProcedure.input(setConfigInput).mutation(async ({ ctx, input }) => {
    const def = requireKey(input.namespace, input.key);
    assertCanEdit(ctx, def);
    const actor = requireActor(ctx);

    try {
      const result = await ctx.db.transaction().execute((trx) =>
        setConfig(trx, {
          def,
          value: input.value,
          actorPersonId: actor,
          effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : undefined,
          correlationId: ctx.correlationId,
        }),
      );
      return { version: result.version, validFrom: result.validFrom.toISOString() };
    } catch (error) {
      throw toTRPCError(error, def);
    }
  }),

  /** Revert to the registered code default: close the in-force row, no successor. */
  reset: configAdminProcedure.input(resetConfigInput).mutation(async ({ ctx, input }) => {
    const def = requireKey(input.namespace, input.key);
    assertCanEdit(ctx, def);
    const actor = requireActor(ctx);

    try {
      return await ctx.db
        .transaction()
        .execute((trx) =>
          resetConfig(trx, { def, actorPersonId: actor, correlationId: ctx.correlationId }),
        );
    } catch (error) {
      throw toTRPCError(error, def);
    }
  }),

  /**
   * Per-key version history, keyset-paginated newest-first.
   *
   * `valid_from` is rendered as fixed-width text for both the ORDER BY and the
   * cursor boundary: a JS `Date` holds milliseconds, and Postgres timestamps
   * hold microseconds, so round-tripping the boundary through a `Date` would
   * drop or duplicate rows at page edges (`lib/keyset.ts`).
   */
  history: configAdminProcedure.input(configHistoryInput).query(async ({ ctx, input }) => {
    const def = requireKey(input.namespace, input.key);
    const sortKey = timestampSortKey('c.valid_from');

    let query = ctx.db
      .selectFrom('platform.config_entry as c')
      .leftJoin('platform.person as p', 'p.id', 'c.created_by')
      .select([
        'c.id',
        'c.version',
        'c.value',
        'c.valid_from',
        'c.valid_to',
        'c.created_at',
        'p.display_name as created_by_name',
      ])
      .select(sortKey.as('sort_key'))
      .where('c.namespace', '=', def.namespace)
      .where('c.key', '=', def.key);

    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      if (cursor) query = query.where(keysetBoundary(sortKey, 'c.id', cursor, 'desc'));
    }

    const rows = await query
      .orderBy(sortKey, 'desc')
      .orderBy('c.id', 'desc')
      .limit(input.limit + 1)
      .execute();

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map((row) => ({
        id: row.id,
        version: row.version,
        value: asOpaqueValue(row.value),
        validFrom: row.valid_from.toISOString(),
        validTo: row.valid_to?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
        createdByName: row.created_by_name,
      })),
      nextCursor: hasMore && last ? encodeCursor({ key: last.sort_key, id: last.id }) : null,
      defaultValue: asOpaqueValue(def.defaultValue),
    };
  }),
});

/** The distinct namespaces in the registry, for the browser's filter control. */
function namespacesOf(): string[] {
  return [...new Set([...configRegistry.values()].map((def) => def.namespace))].sort();
}

/**
 * Map the write path's typed errors onto tRPC codes. `lib/config.ts` throws
 * plain errors so `apps/worker` is not forced to speak an HTTP-shaped
 * vocabulary; the translation belongs here, at the boundary.
 */
function toTRPCError(error: unknown, def: ConfigKeyDef): unknown {
  if (error instanceof ConfigWriteConflictError) {
    return new TRPCError({ code: 'CONFLICT', message: error.message, cause: error });
  }
  if (error instanceof ConfigEffectiveFromError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  }
  if (error instanceof z.ZodError) {
    // The key's own schema rejected the value. Its message is far more useful
    // than a generic "invalid input" — it names the constraint that failed.
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: `'${qualifiedName(def)}': ${error.issues.map((i) => i.message).join('; ')}`,
      cause: error,
    });
  }
  return error;
}
