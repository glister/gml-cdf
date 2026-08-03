import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type NewPerson, db, newUuidV7 } from '@repo/db';
import { createMigrator, makeSession, makeUser, truncateAll } from '@repo/db/test-support';
import {
  disableSignIn,
  enableSignIn,
  ensurePersonForNewUser,
  listCredentials,
  personLineage,
  provisionInvitedUser,
  repointUsers,
  resolvePersonByCredential,
  resolvePersonByUserId,
  restoreUsers,
} from './index.js';

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await truncateAll(db);
});

async function insertPerson(overrides: Partial<NewPerson> = {}): Promise<string> {
  const id = overrides.id ?? newUuidV7();
  await db
    .insertInto('platform.person')
    .values({
      id,
      relationship_type: 'agency',
      display_name: 'Test Person',
      ...overrides,
    })
    .execute();
  return id;
}

async function insertUser(personId: string | null, overrides = {}): Promise<string> {
  const user = makeUser({ person_id: personId, ...overrides });
  await db.insertInto('user').values(user).execute();
  return user.id as string;
}

async function insertAccount(userId: string, providerId: string, accountId: string): Promise<void> {
  await db
    .insertInto('account')
    .values({ id: newUuidV7(), user_id: userId, provider_id: providerId, account_id: accountId })
    .execute();
}

describe('resolution chain (credential → account → user → person)', () => {
  it('resolves a person from a credential and from a user id', async () => {
    const personId = await insertPerson();
    const userId = await insertUser(personId);
    await insertAccount(userId, 'microsoft', 'entra-subject-1');

    expect(
      await resolvePersonByCredential(db, {
        providerId: 'microsoft',
        accountId: 'entra-subject-1',
      }),
    ).toEqual({
      personId,
    });
    expect(await resolvePersonByUserId(db, userId)).toEqual({ personId });
  });

  it('returns null for an unattached user and an unknown credential', async () => {
    const userId = await insertUser(null);
    expect(await resolvePersonByUserId(db, userId)).toBeNull();
    expect(await resolvePersonByCredential(db, { providerId: 'x', accountId: 'y' })).toBeNull();
  });

  it('lists every credential across every user of a person (PL-035)', async () => {
    const personId = await insertPerson();
    const u1 = await insertUser(personId);
    const u2 = await insertUser(personId);
    await insertAccount(u1, 'microsoft', 'sub-1');
    await insertAccount(u2, 'email-otp', 'other@example.com');

    const creds = await listCredentials(db, personId);
    expect(creds.map((c) => c.providerId).sort()).toEqual(['email-otp', 'microsoft']);
  });
});

describe('ensurePersonForNewUser (Entra path)', () => {
  it('attaches to an existing active person matching contact_email (case-insensitive)', async () => {
    const personId = await insertPerson({
      contact_email: 'jo@cdf.test',
      relationship_type: 'employee',
    });
    const userId = await insertUser(null);

    const result = await db
      .transaction()
      .execute((trx) => ensurePersonForNewUser(trx, { userId, email: 'JO@CDF.TEST', name: 'Jo' }));
    expect(result).toEqual({ personId, created: false });
    expect(await resolvePersonByUserId(db, userId)).toEqual({ personId });
  });

  it('creates an employee at draft_shell when no person matches (created: true)', async () => {
    const userId = await insertUser(null);
    const result = await db
      .transaction()
      .execute((trx) =>
        ensurePersonForNewUser(trx, { userId, email: 'new.hire@cdf.test', name: 'New Hire' }),
      );
    expect(result.created).toBe(true);

    const person = await db
      .selectFrom('platform.person')
      .selectAll()
      .where('id', '=', result.personId)
      .executeTakeFirstOrThrow();
    expect(person.relationship_type).toBe('employee');
    expect(person.profile_status).toBe('draft_shell');
    expect(person.contact_email).toBe('new.hire@cdf.test');
  });
});

describe('provisionInvitedUser (PL-036)', () => {
  it('creates a linked user with no credential, idempotent on the same email', async () => {
    const personId = await insertPerson();
    const first = await db
      .transaction()
      .execute((trx) => provisionInvitedUser(trx, { personId, email: 'ext@example.com' }));
    const second = await db
      .transaction()
      .execute((trx) => provisionInvitedUser(trx, { personId, email: 'EXT@example.com' }));
    expect(second.userId).toBe(first.userId); // re-invitation reuses the user
    expect(await resolvePersonByUserId(db, first.userId)).toEqual({ personId });
    // No account row — OTP is the factor, not a stored credential.
    expect(await listCredentials(db, personId)).toEqual([]);
  });

  it('links a second user to the same person when the email changes (PL-035)', async () => {
    const personId = await insertPerson();
    const a = await db
      .transaction()
      .execute((trx) => provisionInvitedUser(trx, { personId, email: 'a@example.com' }));
    const b = await db
      .transaction()
      .execute((trx) => provisionInvitedUser(trx, { personId, email: 'b@example.com' }));
    expect(b.userId).not.toBe(a.userId);
    expect(await resolvePersonByUserId(db, a.userId)).toEqual({ personId });
    expect(await resolvePersonByUserId(db, b.userId)).toEqual({ personId });
  });
});

describe('merge/unmerge user repointing (only user.person_id is touched)', () => {
  it('repoints then restores users, keeping account/session rows intact', async () => {
    const survivor = await insertPerson();
    const loser = await insertPerson();
    const u1 = await insertUser(loser);
    const u2 = await insertUser(loser);
    await insertAccount(u1, 'email-otp', 'u1@example.com');
    await db.insertInto('session').values(makeSession(u1)).execute();

    const moved = await db
      .transaction()
      .execute((trx) => repointUsers(trx, { fromPersonId: loser, toPersonId: survivor }));
    expect(moved.sort()).toEqual([u1, u2].sort());
    expect(await resolvePersonByUserId(db, u1)).toEqual({ personId: survivor });
    // account + session untouched — both logins keep working (AC-8).
    expect(
      await resolvePersonByCredential(db, { providerId: 'email-otp', accountId: 'u1@example.com' }),
    ).toEqual({
      personId: survivor,
    });
    const sessions = await db
      .selectFrom('session')
      .select('id')
      .where('user_id', '=', u1)
      .execute();
    expect(sessions).toHaveLength(1);

    await db
      .transaction()
      .execute((trx) => restoreUsers(trx, { userIds: moved, toPersonId: loser }));
    expect(await resolvePersonByUserId(db, u1)).toEqual({ personId: loser });
  });
});

describe('personLineage (recursive CTE across chained merges)', () => {
  it('returns the person plus every live-superseded person', async () => {
    const survivor = await insertPerson();
    const midLoser = await insertPerson();
    const deepLoser = await insertPerson();
    const actor = await insertPerson();
    const now = new Date();

    // deepLoser was merged into midLoser, then midLoser into survivor (a chain).
    await db
      .insertInto('platform.person_merge')
      .values([
        {
          id: newUuidV7(),
          superseded_person_id: deepLoser,
          surviving_person_id: midLoser,
          reason: 'r',
          moved_user_ids: JSON.stringify([]),
          revoked_grant_ids: JSON.stringify([]),
          merged_by: actor,
          merged_at: now,
        },
        {
          id: newUuidV7(),
          superseded_person_id: midLoser,
          surviving_person_id: survivor,
          reason: 'r',
          moved_user_ids: JSON.stringify([]),
          revoked_grant_ids: JSON.stringify([]),
          merged_by: actor,
          merged_at: now,
        },
      ])
      .execute();

    const lineage = await personLineage(db, survivor);
    expect(lineage.sort()).toEqual([survivor, midLoser, deepLoser].sort());
  });

  it('excludes a reversed merge from the lineage', async () => {
    const survivor = await insertPerson();
    const loser = await insertPerson();
    const actor = await insertPerson();
    const now = new Date();
    await db
      .insertInto('platform.person_merge')
      .values({
        id: newUuidV7(),
        superseded_person_id: loser,
        surviving_person_id: survivor,
        reason: 'r',
        moved_user_ids: JSON.stringify([]),
        revoked_grant_ids: JSON.stringify([]),
        merged_by: actor,
        merged_at: now,
        reversed_by: actor,
        reversed_at: now,
        reversal_reason: 'undo',
      })
      .execute();
    expect(await personLineage(db, survivor)).toEqual([survivor]);
  });
});

describe('disableSignIn / enableSignIn (PL-042)', () => {
  it('bans every user of the person and revokes their sessions, then lifts', async () => {
    const personId = await insertPerson();
    const u1 = await insertUser(personId);
    const u2 = await insertUser(personId);
    await db.insertInto('session').values(makeSession(u1)).execute();
    await db.insertInto('session').values(makeSession(u2)).execute();

    await db.transaction().execute((trx) => disableSignIn(trx, personId, 'access expired'));

    const banned = await db
      .selectFrom('user')
      .select(['banned', 'ban_reason'])
      .where('person_id', '=', personId)
      .execute();
    expect(banned.every((u) => u.banned)).toBe(true);
    expect(banned.every((u) => u.ban_reason === 'access expired')).toBe(true);
    const sessions = await db
      .selectFrom('session')
      .select('id')
      .where('user_id', 'in', [u1, u2])
      .execute();
    expect(sessions).toHaveLength(0);

    await db.transaction().execute((trx) => enableSignIn(trx, personId));
    const relifted = await db
      .selectFrom('user')
      .select('banned')
      .where('person_id', '=', personId)
      .execute();
    expect(relifted.every((u) => !u.banned)).toBe(true);
  });
});
