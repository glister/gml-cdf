import { sql, type Expression, type SqlBool } from 'kysely';
import { isGrantActive } from '@repo/domain';
import type { ContextGrant } from '../trpc.js';
import type { ModuleKey, PersonScope, RoleKey } from './constants.js';

/**
 * Record-level scoping (core plan 04 §5.1, PL-004/PL-043/CORE-05, ADR-0015).
 *
 * Every helper returns a **SQL expression applied inside the query**. Nothing
 * here filters a fetched page: a caller who post-filters rows has already sent
 * them over the wire, and with keyset pagination would also silently corrupt the
 * page boundary (ADR-0004, the data-tables hard rule).
 *
 * **Module-boundary note (ADR-0008).** This file names `platform.*` tables from
 * `lib/` rather than from `routers/platform/`. That is deliberate and is the
 * exception the boundary rule anticipates: these helpers *are* the platform
 * module's exported service surface for record scoping. An HR router consumes
 * `scopePersons(...)`; it must never reach into `platform.person_allocation`
 * itself.
 */

/**
 * Which record scope each role confers. Roles absent from this map get `self`
 * — the safe default, and the SoW's position for the operational roles
 * (IT/Transport/Admin do provisioning tasks, not people-browsing; §12.2 Q6).
 *
 * `director` is `all` per Q3 (resolved 2026-07-28 with CDF). Note that this is
 * *record* reach only — field-level classification applies independently, so a
 * Director still receives the restricted output variant of any entity whose
 * classification ceiling they do not meet.
 */
const SCOPE_BY_ROLE: Partial<Record<RoleKey, PersonScope>> = {
  administrator: 'all',
  hr_user: 'all',
  director: 'all',
  line_manager: 'team',
  external_administrator: 'allocated',
  employee: 'self',
  external: 'self',
};

/** Widest-wins ordering. A viewer holding several roles gets the widest scope. */
const SCOPE_RANK: Record<PersonScope, number> = { all: 3, team: 2, allocated: 1, self: 0 };

/**
 * The visibility scope a viewer holds for `module`, derived from their active
 * grants. Only grants in that exact module count (Q5) — the same rule the
 * procedure builder applies, so scope can never be wider than reach.
 */
export function scopeFor(
  grants: readonly ContextGrant[],
  module: ModuleKey,
  at: Date,
): PersonScope {
  let widest: PersonScope = 'self';
  for (const grant of grants) {
    if (grant.module !== module) continue;
    if (!isGrantActive(grant, at)) continue;
    const scope = SCOPE_BY_ROLE[grant.roleKey];
    if (scope && SCOPE_RANK[scope] > SCOPE_RANK[widest]) widest = scope;
  }
  return widest;
}

/**
 * The people allocated to a restricted external administrator (CORE-05): live
 * `platform.person_allocation` rows, inside their time window. Ending an
 * allocation closes visibility immediately while the row survives as history.
 */
export function allocatedPersonIds(adminPersonId: string): Expression<string> {
  return sql<string>`(
    SELECT a.person_id FROM platform.person_allocation a
    WHERE a.admin_person_id = ${adminPersonId}
      AND a.ended_at IS NULL
      AND a.deleted_at IS NULL
      AND a.valid_from <= now()
      AND (a.valid_until IS NULL OR a.valid_until > now())
  )`;
}

/**
 * The people a manager can see (PL-004) — **live since core plan 05 landed
 * `platform.team` / `platform.team_membership` (2026-08-03)**. This helper
 * shipped fail-closed through plan 04 precisely so this swap would be a body
 * change and nothing else; no call site moved.
 *
 * Three properties are deliberate:
 *
 *  1. **Effective-dated, evaluated now.** Membership is half-open
 *     `[valid_from, valid_to)` (ADR-0012), so a member who left yesterday is
 *     already out of scope and one who joins tomorrow is not yet in it —
 *     without anyone running a job. `current_date` is the database's today, the
 *     same clock the EXCLUDE constraint uses.
 *  2. **Deputy counts.** A deputy exists to cover the manager, and a cover that
 *     cannot see the team is not cover (core plan 04 §12.2 Q2's residual half,
 *     resolved here).
 *  3. **Archived teams confer nothing.** A soft-deleted team is retired
 *     configuration; leaving its manager with visibility would make archiving
 *     a no-op for access.
 *
 * A later CONSUMPTION POINT unions this with a recursive CTE over
 * `hr.employee.manager_person_id` when the HR employee record lands. Call sites
 * still will not change.
 */
export function managedPersonIds(viewerPersonId: string): Expression<string> {
  return sql<string>`(
    SELECT m.person_id FROM platform.team_membership m
    JOIN platform.team t ON t.id = m.team_id
    WHERE (t.manager_person_id = ${viewerPersonId} OR t.deputy_person_id = ${viewerPersonId})
      AND t.deleted_at IS NULL
      AND m.valid_from <= current_date
      AND (m.valid_to IS NULL OR m.valid_to > current_date)
  )`;
}

/**
 * Restrict a person-keyed column to the viewer's scope, as a WHERE expression:
 *
 *   'all'       -> unrestricted
 *   'self'      -> col = viewer                      (PL-043: externals see own records)
 *   'team'      -> col IN managedPersonIds(viewer)   (PL-004)
 *   'allocated' -> col IN allocatedPersonIds(viewer) (CORE-05)
 *
 * `col` must be a caller-supplied column reference (e.g. `'p.id'`), never user
 * input — it is interpolated as an identifier.
 */
export function scopePersons(
  col: string,
  viewerPersonId: string,
  scope: PersonScope,
): Expression<SqlBool> {
  switch (scope) {
    case 'all':
      return sql<SqlBool>`true`;
    case 'self':
      return sql<SqlBool>`${sql.ref(col)} = ${viewerPersonId}`;
    case 'team':
      return sql<SqlBool>`${sql.ref(col)} IN ${managedPersonIds(viewerPersonId)}`;
    case 'allocated':
      return sql<SqlBool>`${sql.ref(col)} IN ${allocatedPersonIds(viewerPersonId)}`;
  }
}
