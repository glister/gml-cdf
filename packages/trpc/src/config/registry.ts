import type { z } from 'zod';
import type { RoleKey } from '../lib/constants.js';

/**
 * The code-side configuration schema registry (core plan 06 §4.6, ADR-0016).
 *
 * `platform.config_entry.value` is `jsonb` with no SQL-level shape. What makes
 * that safe is this registry, not a CHECK constraint: **every key is registered
 * in code with a Zod schema and a frozen default, and values are validated on
 * write AND on read**. There is no free-form-JSON escape hatch — an unregistered
 * key cannot be read, written, or referenced from a workflow definition.
 *
 * It lives in `@repo/trpc` (§4.6 decision, confirmed 2026-08-05 as §12.2 Q1)
 * because that is where shared Zod schemas already live and are consumed by both
 * the server and the web app: the admin editor renders and validates each key
 * from the *same* schema the write path enforces. `@repo/domain` was rejected —
 * pure guards receive resolved config **values** as parameters and must never
 * know where they came from (ADR-0009/0013).
 */

export interface ConfigKeyDef<S extends z.ZodType = z.ZodType> {
  /** Every segment but the last, e.g. `'platform.identity'`. */
  readonly namespace: string;
  /** The last segment, e.g. `'external_access_default_days'`. */
  readonly key: string;
  /** Validates on write and on read. */
  readonly schema: S;
  /**
   * The value in force before any explicit entry exists — and the value a
   * reset returns to.
   *
   * **Frozen once shipped.** Changing behaviour is done by writing a config
   * entry, never by editing this: an as-at read from before a key's first
   * explicit entry would otherwise silently change meaning across releases,
   * breaking the reproducibility the store exists for (ADR-0010 discipline 5).
   * A default may only change alongside a migration that inserts an explicit
   * entry preserving the old value up to the change instant.
   */
  readonly defaultValue: z.infer<S>;
  /** Shown in the admin browser — plain English, for the person editing it. */
  readonly description: string;
  /** Roles permitted to `set`/`reset` this key (ADR-0015 record-level check). */
  readonly editableBy: readonly RoleKey[];
  /**
   * Suppress values from the journal payload (§4.2). Defaults to `false` and
   * should stay there: config values are policy data (roles, thresholds,
   * cadences, dates), never personal data (§4.5), so carrying old/new values in
   * the audit event is what makes the audit view self-contained.
   */
  readonly sensitiveValue?: boolean;
  /** The owning plan, e.g. `'06'`, `'10'`, `'hr-leave'` — for the review trail. */
  readonly registeredBy: string;
}

/** Thrown when a key that is not in the registry is read, written or referenced. */
export class ConfigKeyUnknownError extends Error {
  constructor(readonly qualifiedName: string) {
    super(
      `unknown configuration key '${qualifiedName}': register it with defineConfigKey() before reading or writing it`,
    );
    this.name = 'ConfigKeyUnknownError';
  }
}

/** Thrown when a stored value fails its key's schema — registry/store drift. */
export class ConfigValueInvalidError extends Error {
  constructor(
    readonly qualifiedName: string,
    readonly cause: unknown,
  ) {
    super(
      `stored value for '${qualifiedName}' does not satisfy its registered schema — the registry and the store have drifted; a schema must accept its own key's history (§4.6)`,
    );
    this.name = 'ConfigValueInvalidError';
  }
}

/** Mirrors the `config_entry_namespace_chk` / `config_entry_key_chk` constraints. */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9_]+(\.[a-z][a-z0-9_]+)*$/;
const KEY_PATTERN = /^[a-z][a-z0-9_]+$/;

const registry = new Map<string, ConfigKeyDef>();

/** `${namespace}.${key}` — the stable business identifier across every version. */
export function qualifiedName(def: Pick<ConfigKeyDef, 'namespace' | 'key'>): string {
  return `${def.namespace}.${def.key}`;
}

/**
 * Register one configuration key. Validates the name grammar and the default
 * against the key's own schema **at module load**, so a malformed or
 * self-inconsistent registration fails on boot rather than at first use — the
 * same fail-fast discipline `defineEvent` applies to the journal (ADR-0010).
 *
 * Duplicate registration throws: two definitions of one key would make the
 * meaning of a stored value depend on import order.
 */
export function defineConfigKey<S extends z.ZodType>(def: ConfigKeyDef<S>): ConfigKeyDef<S> {
  const name = qualifiedName(def);

  if (!NAMESPACE_PATTERN.test(def.namespace)) {
    throw new Error(
      `invalid config namespace '${def.namespace}': must be lowercase snake_case segments separated by dots (e.g. 'platform.identity')`,
    );
  }
  if (!KEY_PATTERN.test(def.key)) {
    throw new Error(
      `invalid config key '${def.key}': must be a single lowercase snake_case segment (e.g. 'external_access_default_days')`,
    );
  }
  if (def.editableBy.length === 0) {
    throw new Error(
      `config key '${name}' lists no editableBy roles: a key nobody can edit is a code constant, not configuration (PL-029)`,
    );
  }
  if (registry.has(name)) {
    throw new Error(`duplicate config key registration: '${name}' is already registered`);
  }

  const parsed = def.schema.safeParse(def.defaultValue);
  if (!parsed.success) {
    throw new Error(
      `config key '${name}' has a default that fails its own schema: ${parsed.error.message}`,
    );
  }

  const frozen = Object.freeze({ ...def });
  registry.set(name, frozen as unknown as ConfigKeyDef);
  return frozen;
}

/**
 * Every registered key, by qualified name.
 *
 * The map is populated as a side effect of loading the definition modules, so
 * always reach the registry through the `./index.js` barrel (or `@repo/trpc`),
 * which loads `./keys.js` first. Importing this module alone would see whatever
 * happened to have been loaded.
 */
export const configRegistry: ReadonlyMap<string, ConfigKeyDef> = registry;

/** Look up a key, or throw {@link ConfigKeyUnknownError}. */
export function requireConfigKey(name: string): ConfigKeyDef {
  const def = registry.get(name);
  if (!def) throw new ConfigKeyUnknownError(name);
  return def;
}

/** Test-only: drop a registration so a suite can exercise the load-time rules. */
export function unregisterConfigKeyForTests(name: string): void {
  registry.delete(name);
}
