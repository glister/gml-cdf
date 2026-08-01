import { isWithinPeriod } from '../lib/period.js';

/**
 * Grant validity and role resolution (core plan 04 §4.3, PL-002). Pure: the
 * evaluating instant is always passed in, never read from a clock (ADR-0009), so
 * `roleProcedure` can evaluate the time window **per call** — a grant that
 * expires mid-session stops authorising without a restart, and a test can assert
 * every boundary without faking time.
 *
 * The grant window is half-open `[valid_from, valid_until)`, consistent with
 * `lib/period.ts` and the effective-dated reads elsewhere: a `valid_until` of
 * exactly now has already ended.
 *
 * These functions know nothing about the database or the role/module vocabulary
 * — the key types are generic parameters, so `@repo/trpc` recovers its literal
 * `RoleKey`/`ModuleKey` unions at the call site while this package stays pure.
 */

/** The lifecycle states of a grant, derived from timestamps — never a flag. */
export type GrantState = 'pending' | 'active' | 'expired' | 'revoked';

/**
 * The fields of a grant that bear on whether it authorises. A `platform.role_grant`
 * row (or a `ContextGrant`) is structurally assignable to this.
 */
export interface Grant<R extends string = string, M extends string = string> {
  readonly roleKey: R;
  /** The grant's scope. Matched EXACTLY — there is no wildcard module (Q5). */
  readonly module: M;
  readonly validFrom: Date;
  /** `null` = open-ended. */
  readonly validUntil: Date | null;
  /** `null` = not revoked. A revoked grant never authorises again (§4.3). */
  readonly revokedAt: Date | null;
}

/**
 * Does this grant authorise at `at`? True only when it is unrevoked and `at`
 * falls inside the half-open window. This is the single predicate every
 * enforcement path uses — `grantState` is for display and filtering.
 */
export function isGrantActive(grant: Grant, at: Date): boolean {
  if (grant.revokedAt !== null) return false;
  return isWithinPeriod(at, grant.validFrom, grant.validUntil);
}

/**
 * The grant's lifecycle state at `at`, for display and the `grants.list` facet.
 *
 * Precedence is `revoked → expired → pending → active`, and the SQL CASE in
 * `platform.authz.grants.list` mirrors it exactly so the displayed value, the
 * filter and any aggregate read the same expression (ADR-0004).
 *
 * Note the consequence of putting `revoked` first: a grant that the plan-03
 * expiry sweep has revoked reads as `revoked`, not `expired` — the explicit act
 * is the more truthful fact, and `revoke_reason='expired'` records why. A grant
 * shows as `expired` only while its window has passed but the sweep has not yet
 * reached it (during which `isGrantActive` is already false, so it authorises
 * nothing either way).
 */
export function grantState(grant: Grant, at: Date): GrantState {
  if (grant.revokedAt !== null) return 'revoked';
  if (grant.validUntil !== null && at.getTime() >= grant.validUntil.getTime()) return 'expired';
  if (at.getTime() < grant.validFrom.getTime()) return 'pending';
  return 'active';
}

/**
 * Does the holder of `grants` hold any of `roles` in `module`, active at `at`?
 *
 * `module` is matched exactly. A grant in `platform` does not satisfy a check
 * for `hr.er`, and vice versa (core plan 04 Q5, resolved 2026-07-28) — the
 * module dimension is enforcement, not documentation.
 */
export function hasRole<R extends string, M extends string>(
  grants: readonly Grant<R, M>[],
  roles: readonly R[],
  module: M,
  at: Date,
): boolean {
  return grants.some(
    (g) => g.module === module && roles.includes(g.roleKey) && isGrantActive(g, at),
  );
}

/**
 * The modules in which the holder has any of `roles` active at `at`. Used to
 * drive UX-only navigation from `grants.mine` — never as an access decision.
 */
export function activeModulesFor<R extends string, M extends string>(
  grants: readonly Grant<R, M>[],
  roles: readonly R[],
  at: Date,
): M[] {
  const modules = new Set<M>();
  for (const g of grants) {
    if (roles.includes(g.roleKey) && isGrantActive(g, at)) modules.add(g.module);
  }
  return [...modules];
}
