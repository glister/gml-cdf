import type { z } from 'zod';

/**
 * The event-type registry mechanism (core plan 02 §4.2, ADR-0010/0021). Pure
 * data + Zod validation — no I/O — so it lives in `@repo/domain` (ADR-0009) and
 * both `@repo/db`'s `appendEvent` and any consumer can share one contract.
 */

/**
 * Event-type names are namespaced, past-tense facts: a lowercase dotted path of
 * two or more segments — `<module>.<entity>[.<sub>].<verb-past>` (ADR-0021).
 * Past tense is a review rule the regex cannot enforce.
 */
export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export interface EventDefinition<P = unknown> {
  /** The namespaced past-tense name, e.g. `platform.demo.pinged`. */
  readonly type: string;
  /** Integer ≥ 1, bumped on any breaking payload change. */
  readonly schemaVersion: number;
  /**
   * A **strict** Zod schema (unknown keys rejected). Strictness is the
   * structural half of the PII rule (ADR-0019): a profile row cannot be spread
   * into a payload that rejects unknown keys.
   */
  readonly payloadSchema: z.ZodType<P>;
}

/**
 * Define one event type. Validates the name format and version at import time so
 * a malformed registration fails loudly on boot rather than at first emit.
 * Returns a frozen definition; assemble the definitions into `eventTypes`
 * (`registry.ts`), which is the single runtime + type source.
 */
export function defineEvent<P>(
  type: string,
  schemaVersion: number,
  payloadSchema: z.ZodType<P>,
): EventDefinition<P> {
  if (!EVENT_TYPE_PATTERN.test(type)) {
    throw new Error(
      `invalid event type '${type}': must be a lowercase, namespaced, dotted, past-tense name (e.g. 'platform.demo.pinged')`,
    );
  }
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error(`invalid schemaVersion for event '${type}': must be a positive integer`);
  }
  return Object.freeze({ type, schemaVersion, payloadSchema });
}
