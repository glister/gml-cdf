import { type Kysely, type Transaction, sql } from 'kysely';
import { type DB, newUuidV7 } from '@repo/db';

/**
 * `@repo/identity` — the identity adapter (ADR-0014, core plan 03 §5.1).
 *
 * This package is the ONLY code allowed to read or write the Better Auth
 * framework tables — `user`, `account`, `session`. Domain code, tRPC procedures
 * and worker jobs reach identity exclusively through these functions. Merge and
 * unmerge touch the single column `user.person_id` and nothing else — `account`
 * and `session` rows are never repointed, so both logins keep working after a
 * merge (AC-8).
 *
 * Reads accept a `Kysely<DB>` (a `Transaction<DB>` is assignable to it); writes
 * that must be atomic with a journal append take a `Transaction<DB>` explicitly.
 */

type Db = Kysely<DB>;
type Trx = Transaction<DB>;

export { identityConfig, type IdentityConfig } from './config.js';

// --- Resolution (sign-in path + procedure context) --------------------------

/** Resolve the person a Better Auth user belongs to (null if unattached). */
export async function resolvePersonByUserId(
  db: Db,
  userId: string,
): Promise<{ personId: string } | null> {
  const row = await db
    .selectFrom('user')
    .select('person_id')
    .where('id', '=', userId)
    .executeTakeFirst();
  return row?.person_id ? { personId: row.person_id } : null;
}

/** Resolve a person from a credential (issuer + subject), the sign-in path. */
export async function resolvePersonByCredential(
  db: Db,
  { providerId, accountId }: { providerId: string; accountId: string },
): Promise<{ personId: string } | null> {
  const row = await db
    .selectFrom('account')
    .innerJoin('user', 'user.id', 'account.user_id')
    .select('user.person_id')
    .where('account.provider_id', '=', providerId)
    .where('account.account_id', '=', accountId)
    .executeTakeFirst();
  return row?.person_id ? { personId: row.person_id } : null;
}

// --- Linked identities (PL-035) ---------------------------------------------

export interface CredentialRef {
  providerId: string;
  accountId: string;
  userId: string;
  createdAt: Date;
}

/** Every credential across every user of the person (PL-035). */
export async function listCredentials(db: Db, personId: string): Promise<CredentialRef[]> {
  const rows = await db
    .selectFrom('account')
    .innerJoin('user', 'user.id', 'account.user_id')
    .select([
      'account.provider_id as providerId',
      'account.account_id as accountId',
      'account.user_id as userId',
      'account.created_at as createdAt',
    ])
    .where('user.person_id', '=', personId)
    .orderBy('account.created_at', 'asc')
    .execute();
  return rows.map((r) => ({
    providerId: r.providerId,
    accountId: r.accountId,
    userId: r.userId,
    createdAt: r.createdAt,
  }));
}

/**
 * Resolve a user's person plus the provider of its most recent credential, for
 * the sign-in journal (`platform.person.signed_in`). Email-OTP users carry no
 * `account` row, so the provider falls back to `'email-otp'`. Returns null for an
 * unattached user. Lives here because it reads `account` (adapter boundary).
 */
export async function resolveSignInContext(
  db: Db,
  userId: string,
): Promise<{ personId: string; providerId: string } | null> {
  const row = await db
    .selectFrom('user')
    .leftJoin('account', 'account.user_id', 'user.id')
    .select(['user.person_id as personId', 'account.provider_id as providerId'])
    .where('user.id', '=', userId)
    .orderBy('account.created_at', 'desc')
    .executeTakeFirst();
  if (!row?.personId) return null;
  return { personId: row.personId, providerId: row.providerId ?? 'email-otp' };
}

// --- Person lifecycle (Entra databaseHook + admin procedures) ---------------

/**
 * Attach a newly Entra-authenticated user to a person (Entra path only). If an
 * active, non-deleted person carries a matching `contact_email` (HR
 * pre-creation, migration, or PL-046 conversion), attach to it, keeping whatever
 * `profile_status` CDF has taken them to. Otherwise create an employee person at
 * `draft_shell` (an unmatched tenant sign-in is an employee CDF has not set up —
 * `created: true` is the caller's cue to raise the HR review signal). NEVER
 * creates a person at `active` — activation is an explicit authorised transition.
 *
 * Takes a transaction so the caller can append the `person.created`/attach
 * journal event atomically.
 */
export async function ensurePersonForNewUser(
  trx: Trx,
  { userId, email, name }: { userId: string; email: string; name?: string | null },
): Promise<{ personId: string; created: boolean }> {
  const normalisedEmail = email.trim().toLowerCase();
  const existing = await trx
    .selectFrom('platform.person')
    .select('id')
    .where(sql`lower(contact_email)`, '=', normalisedEmail)
    .where('status', '=', 'active')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();

  if (existing) {
    await attachUserToPerson(trx, userId, existing.id);
    return { personId: existing.id, created: false };
  }

  const personId = newUuidV7();
  await trx
    .insertInto('platform.person')
    .values({
      id: personId,
      relationship_type: 'employee',
      profile_status: 'draft_shell',
      status: 'active',
      display_name: name?.trim() || normalisedEmail,
      contact_email: normalisedEmail,
    })
    .execute();
  await attachUserToPerson(trx, userId, personId);
  return { personId, created: true };
}

/** Point a user at a person (the one Better Auth column we write). */
export async function attachUserToPerson(
  trx: Trx,
  userId: string,
  personId: string,
): Promise<void> {
  await trx.updateTable('user').set({ person_id: personId }).where('id', '=', userId).execute();
}

/**
 * Pre-provision the Better Auth user for an invitation (PL-036) — the ONLY
 * external account-creation path. Creates a user with the invited email linked to
 * the person and NO credential (OTP is the factor). Idempotent on email: a
 * re-invitation to the same address reuses the existing user (and ensures it is
 * linked to this person); a changed address yields a new user linked to the same
 * person (a second credential — PL-035).
 */
export async function provisionInvitedUser(
  trx: Trx,
  { personId, email }: { personId: string; email: string },
): Promise<{ userId: string; reused: boolean }> {
  const normalisedEmail = email.trim().toLowerCase();
  const existing = await trx
    .selectFrom('user')
    .select(['id', 'person_id'])
    .where('email', '=', normalisedEmail)
    .executeTakeFirst();

  if (existing) {
    if (existing.person_id !== personId) {
      await attachUserToPerson(trx, existing.id, personId);
    }
    return { userId: existing.id, reused: true };
  }

  const userId = newUuidV7();
  await trx
    .insertInto('user')
    .values({
      id: userId,
      name: normalisedEmail,
      email: normalisedEmail,
      email_verified: false,
      person_id: personId,
    })
    .execute();
  return { userId, reused: false };
}

// --- Merge / unmerge support — user.person_id is the ONLY column touched -----

/** Repoint every user of `fromPersonId` onto `toPersonId`; returns moved ids. */
export async function repointUsers(
  trx: Trx,
  { fromPersonId, toPersonId }: { fromPersonId: string; toPersonId: string },
): Promise<string[]> {
  const moved = await trx
    .updateTable('user')
    .set({ person_id: toPersonId })
    .where('person_id', '=', fromPersonId)
    .returning('id')
    .execute();
  return moved.map((m) => m.id);
}

/** Restore a known set of users to `toPersonId` (the unmerge reversal). */
export async function restoreUsers(
  trx: Trx,
  { userIds, toPersonId }: { userIds: string[]; toPersonId: string },
): Promise<void> {
  if (userIds.length === 0) return;
  await trx.updateTable('user').set({ person_id: toPersonId }).where('id', 'in', userIds).execute();
}

// --- Sign-in enable/disable (PL-042) — wraps the framework ban --------------

/** Ban every user of the person and revoke their sessions (PL-042). */
export async function disableSignIn(trx: Trx, personId: string, reason: string): Promise<void> {
  await trx
    .updateTable('user')
    .set({ banned: true, ban_reason: reason })
    .where('person_id', '=', personId)
    .execute();
  await trx
    .deleteFrom('session')
    .where('user_id', 'in', (qb) =>
      qb.selectFrom('user').select('id').where('person_id', '=', personId),
    )
    .execute();
}

/** Lift the ban on every user of the person (re-engagement). */
export async function enableSignIn(trx: Trx, personId: string): Promise<void> {
  await trx
    .updateTable('user')
    .set({ banned: false, ban_reason: null })
    .where('person_id', '=', personId)
    .execute();
}

// --- Lineage — union-of-history reads (PL-038) ------------------------------

/**
 * The person and every person superseded onto it through live (un-reversed)
 * merges, walked transitively via a recursive CTE. The input id is always
 * included. Used for union-of-history reads after a merge.
 */
export async function personLineage(db: Db, personId: string): Promise<string[]> {
  const result = await sql<{ id: string }>`
    WITH RECURSIVE lineage(id) AS (
      SELECT ${personId}::uuid
      UNION
      SELECT pm.superseded_person_id
        FROM platform.person_merge pm
        JOIN lineage l ON pm.surviving_person_id = l.id
       WHERE pm.reversed_at IS NULL
    )
    SELECT id FROM lineage
  `.execute(db);
  return result.rows.map((r) => r.id);
}
