import type { Kysely } from 'kysely';
import type { DB } from '@repo/db';
import type { ContextGrant } from '../trpc.js';
import type { RoleKey } from './constants.js';

/**
 * Resolve a person's live role grants for the request context (core plan 04
 * §9.3). One indexed query per authenticated request — `role_grant_person_active_ix`
 * is a partial index over exactly this predicate, and at CDF's scale (hundreds
 * of people, a handful of grants each) no caching is warranted (§12.1).
 *
 * "Live" means unrevoked and not soft-deleted. The **time window is deliberately
 * not filtered here**: `roleProcedure` evaluates it per call, so a grant that
 * expires part-way through a session stops authorising immediately rather than
 * at the next sign-in (§5.1). Filtering it here would silently reintroduce
 * session-lifetime authorisation.
 */
export async function loadGrantsForPerson(
  db: Kysely<DB>,
  personId: string | null,
): Promise<ContextGrant[]> {
  if (!personId) return [];
  const rows = await db
    .selectFrom('platform.role_grant as g')
    .innerJoin('platform.role as r', 'r.id', 'g.role_id')
    .select(['r.key as roleKey', 'g.module', 'g.valid_from', 'g.valid_until', 'g.revoked_at'])
    .where('g.person_id', '=', personId)
    .where('g.revoked_at', 'is', null)
    .where('g.deleted_at', 'is', null)
    .execute();

  return rows.map((row) => ({
    // `role.key` is text (roles are data, PL-002), so an unrecognised key is
    // possible in principle — a Phase 2 role added before the tuple is updated.
    // It simply never matches a builder's role list, which fails closed.
    roleKey: row.roleKey as RoleKey,
    module: row.module,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    revokedAt: row.revoked_at,
  }));
}
