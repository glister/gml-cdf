/**
 * Postgres integrity-error predicates.
 *
 * Several invariants in this codebase are enforced by the database rather than
 * by application checks — unique codes, the team-membership overlap EXCLUDE
 * constraint (core plan 05 §4.1.2), append-only guards. That is deliberate
 * (ADR-0011: "immutability is a database property, not an application promise"),
 * but it means the *first* time a caller learns about a violation is a raw
 * driver error. Mapping them here keeps the guarantee in the database and the
 * message intelligible in the UI, instead of tempting a pre-flight SELECT that
 * would race anyway.
 *
 * Lives in `@repo/db` rather than `@repo/trpc` because three layers now need it
 * — the routers that map a violation to a `CONFLICT`, `@repo/config`'s
 * supersede write path, and the workflow runtime — and these are predicates over
 * driver errors, not HTTP-shaped translations. The mapping to a `TRPCError`
 * stays at the procedure boundary, where it belongs.
 */

/** SQLSTATE codes we translate. */
const UNIQUE_VIOLATION = '23505';
const EXCLUSION_VIOLATION = '23P01';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

interface PgError {
  code: string;
  constraint?: string;
}

function asPgError(error: unknown): PgError | null {
  if (typeof error !== 'object' || error === null) return null;
  const code: unknown = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return null;
  const constraint: unknown = (error as { constraint?: unknown }).constraint;
  return { code, constraint: typeof constraint === 'string' ? constraint : undefined };
}

/** True when `error` is a unique-constraint violation, optionally a named one. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = asPgError(error);
  if (!pg || pg.code !== UNIQUE_VIOLATION) return false;
  return constraint === undefined || pg.constraint === constraint;
}

/** True when `error` is a gist EXCLUDE violation, optionally a named one. */
export function isExclusionViolation(error: unknown, constraint?: string): boolean {
  const pg = asPgError(error);
  if (!pg || pg.code !== EXCLUSION_VIOLATION) return false;
  return constraint === undefined || pg.constraint === constraint;
}

/** True when `error` is a CHECK violation, optionally a named one. */
export function isCheckViolation(error: unknown, constraint?: string): boolean {
  const pg = asPgError(error);
  if (!pg || pg.code !== CHECK_VIOLATION) return false;
  return constraint === undefined || pg.constraint === constraint;
}

/** True when `error` is a foreign-key violation, optionally a named one. */
export function isForeignKeyViolation(error: unknown, constraint?: string): boolean {
  const pg = asPgError(error);
  if (!pg || pg.code !== FOREIGN_KEY_VIOLATION) return false;
  return constraint === undefined || pg.constraint === constraint;
}
