/**
 * Grant resolution for the request context (core plan 04 §9.3).
 *
 * The query itself moved to `@repo/db` (`authz.ts`, beside the grant write
 * paths) when core plan 07's workflow runtime needed the same read to resolve a
 * transition's `by` policy: two callers, one implementation, or authorisation
 * quietly acquires a second read path (ADR-0022). Re-exported here so the API
 * context factory's import is unchanged, and typed as `ContextGrant[]` because a
 * `@repo/domain` `Grant<RoleKey, ModuleKey>` is structurally exactly that.
 */
export { loadGrantsForPerson } from '@repo/db';
