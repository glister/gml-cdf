import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type NewPerson, db, newUuidV7 } from '@repo/db';
import { createMigrator, makeUser, truncateAll } from '@repo/db/test-support';
import { appRouter } from '../../router.js';
import type { ContextGrant, TRPCContext } from '../../trpc.js';
import { ROLE_KEYS, type ModuleKey, type RoleKey } from '../../lib/constants.js';

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

let adminPersonId: string;
/**
 * The acting admin's grants. Since core plan 04, authorisation is
 * `role_grant`-based — a Better Auth `admin` flag no longer reaches any product
 * surface, so the test admin must actually hold the Administrator role.
 */
let adminGrants: ContextGrant[];

beforeEach(async () => {
  await truncateAll(db);
  await reseedRoles();
  adminPersonId = await insertPerson({ relationship_type: 'employee', display_name: 'Admin' });
  adminGrants = await grantRole(adminPersonId, 'administrator');
});

/** `truncateAll` clears the migration's role seed; restore it per test. */
async function reseedRoles(): Promise<void> {
  const existing = await db.selectFrom('platform.role').select('id').executeTakeFirst();
  if (existing) return;
  await db
    .insertInto('platform.role')
    .values(
      ROLE_KEYS.map((key, i) => ({
        id: `019f509e-9d0${i.toString(16)}-7000-8000-00000000000${i.toString(16)}`,
        key,
        name: key,
      })),
    )
    .execute();
}

/** Grant `roleKey` in the platform module and return the caller's grant list. */
async function grantRole(personId: string, roleKey: RoleKey): Promise<ContextGrant[]> {
  const role = await db
    .selectFrom('platform.role')
    .select('id')
    .where('key', '=', roleKey)
    .executeTakeFirstOrThrow();
  await db
    .insertInto('platform.role_grant')
    .values({
      id: newUuidV7(),
      person_id: personId,
      role_id: role.id,
      module: 'platform',
      created_by: personId,
    })
    .execute();
  const rows = await db
    .selectFrom('platform.role_grant as g')
    .innerJoin('platform.role as r', 'r.id', 'g.role_id')
    .select(['r.key as roleKey', 'g.module', 'g.valid_from', 'g.valid_until', 'g.revoked_at'])
    .where('g.person_id', '=', personId)
    .where('g.revoked_at', 'is', null)
    .execute();
  return rows.map((r) => ({
    roleKey: r.roleKey as RoleKey,
    module: r.module,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    revokedAt: r.revoked_at,
  }));
}

/** Insert one grant directly and return its id — for asserting on the row itself. */
async function insertGrant(
  personId: string,
  roleKey: RoleKey,
  opts: { module?: ModuleKey; validFrom?: Date; validUntil?: Date | null } = {},
): Promise<string> {
  const role = await db
    .selectFrom('platform.role')
    .select('id')
    .where('key', '=', roleKey)
    .executeTakeFirstOrThrow();
  const id = newUuidV7();
  await db
    .insertInto('platform.role_grant')
    .values({
      id,
      person_id: personId,
      role_id: role.id,
      module: opts.module ?? 'platform',
      ...(opts.validFrom ? { valid_from: opts.validFrom } : {}),
      valid_until: opts.validUntil ?? null,
      created_by: personId,
    })
    .execute();
  return id;
}

async function insertPerson(overrides: Partial<NewPerson> = {}): Promise<string> {
  const id = overrides.id ?? newUuidV7();
  await db
    .insertInto('platform.person')
    .values({ id, relationship_type: 'agency', display_name: 'Person', ...overrides })
    .execute();
  return id;
}

const sendInvitation = vi.fn(async () => {});

function makeCtx(overrides: Partial<TRPCContext> = {}): TRPCContext {
  return {
    db,
    user: { id: 'admin-user', name: 'Admin', email: 'admin@cdf.test', role: 'admin' },
    session: { id: 'sess', userId: 'admin-user' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    email: { sendOtp: async () => {}, sendInvitation },
    sms: { send: async () => {} },
    rateLimit: { check: () => true },
    correlationId: newUuidV7(),
    actorPersonId: adminPersonId,
    grants: adminGrants,
    ...overrides,
  };
}

const caller = () => appRouter.createCaller(makeCtx());

async function eventsFor(personId: string, eventType: string) {
  return db
    .selectFrom('platform.domain_event')
    .selectAll()
    .where('stream_id', '=', personId)
    .where('event_type', '=', eventType)
    .execute();
}

describe('listPersons (keyset, SQL facets)', () => {
  it('pages the whole set in global order with no duplicates or gaps', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      // Distinct created_at so the sort key is total-ordered.
      const id = newUuidV7();
      await db
        .insertInto('platform.person')
        .values({
          id,
          relationship_type: 'agency',
          display_name: `P${i}`,
          created_at: new Date(Date.UTC(2026, 0, i + 1)),
        })
        .execute();
      ids.push(id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await caller().platform.identity.listPersons({
        limit: 2,
        cursor,
        sort: 'created_at',
        sortDir: 'asc',
      });
      seen.push(...page.items.filter((p) => p.id !== adminPersonId).map((p) => p.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(ids); // asc created_at order, every id once
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('applies relationshipType and search filters in SQL', async () => {
    await insertPerson({ relationship_type: 'subcontractor', display_name: 'Zephyr Unique' });
    await insertPerson({ relationship_type: 'agency', display_name: 'Ordinary' });

    const byType = await caller().platform.identity.listPersons({
      relationshipType: 'subcontractor',
    });
    expect(byType.items.every((p) => p.relationship_type === 'subcontractor')).toBe(true);

    const bySearch = await caller().platform.identity.listPersons({ search: 'zephyr' });
    expect(bySearch.items.map((p) => p.display_name)).toContain('Zephyr Unique');
    expect(bySearch.items.map((p) => p.display_name)).not.toContain('Ordinary');
  });
});

describe('pre-creation check + createPerson (PL-047, AC-D7)', () => {
  it('surfaces an existing match and blocks create-without-override', async () => {
    await insertPerson({
      display_name: 'Jane Smith',
      given_name: 'Jane',
      family_name: 'Smith',
      date_of_birth: '1990-01-02',
    });

    const matches = await caller().platform.identity.checkExisting({
      givenName: 'jane',
      familyName: 'SMITH',
      dateOfBirth: '1990-01-02',
    });
    expect(matches.length).toBe(1);
    expect(matches[0]!.reasons).toContain('name_dob');

    await expect(
      caller().platform.identity.createPerson({
        displayName: 'Jane Smith',
        givenName: 'Jane',
        familyName: 'Smith',
        dateOfBirth: '1990-01-02',
        relationshipType: 'agency',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('creates with an override and journals precreation_check_overridden', async () => {
    const existing = await insertPerson({
      display_name: 'Jane Smith',
      given_name: 'Jane',
      family_name: 'Smith',
      date_of_birth: '1990-01-02',
    });
    const { personId } = await caller().platform.identity.createPerson({
      displayName: 'Jane Smith',
      givenName: 'Jane',
      familyName: 'Smith',
      dateOfBirth: '1990-01-02',
      relationshipType: 'agency',
      overrideMatches: { candidatePersonIds: [existing], reason: 'confirmed different person' },
    });
    expect(await eventsFor(personId, 'platform.person.created')).toHaveLength(1);
    expect(await eventsFor(personId, 'platform.person.precreation_check_overridden')).toHaveLength(
      1,
    );
  });
});

describe('merge / unmerge with flag never-lose (ON AC-8, AC-D2, PL-040)', () => {
  it('merges, unions a do-not-rehire flag, and reverses keeping the copy', async () => {
    const survivor = await insertPerson({ display_name: 'Survivor' });
    const loser = await insertPerson({ display_name: 'Loser' });
    const loserUser = makeUser({ person_id: loser });
    await db.insertInto('user').values(loserUser).execute();

    // A do-not-rehire flag on the loser must survive onto the survivor.
    await caller().platform.identity.addFlag({
      personId: loser,
      flagType: 'do_not_rehire',
      reason: 'incident',
    });

    const { mergeId, copiedFlagIds } = await caller().platform.identity.merge({
      survivingPersonId: survivor,
      supersededPersonId: loser,
      reason: 'same person',
    });
    expect(copiedFlagIds).toHaveLength(1);

    // Loser superseded; user repointed to survivor; flag copied and active on survivor.
    const loserRow = await db
      .selectFrom('platform.person')
      .select('status')
      .where('id', '=', loser)
      .executeTakeFirstOrThrow();
    expect(loserRow.status).toBe('superseded');
    const movedUser = await db
      .selectFrom('user')
      .select('person_id')
      .where('id', '=', loserUser.id as string)
      .executeTakeFirstOrThrow();
    expect(movedUser.person_id).toBe(survivor);
    const survivorFlags = await db
      .selectFrom('platform.person_flag')
      .selectAll()
      .where('person_id', '=', survivor)
      .where('ended_at', 'is', null)
      .execute();
    expect(survivorFlags.map((f) => f.flag_type)).toContain('do_not_rehire');
    expect(await eventsFor(survivor, 'platform.person.merged')).toHaveLength(1);

    // Unmerge restores the user and reactivates the loser; the copied flag remains.
    await caller().platform.identity.unmerge({ mergeId, reason: 'mistake' });
    const restored = await db
      .selectFrom('user')
      .select('person_id')
      .where('id', '=', loserUser.id as string)
      .executeTakeFirstOrThrow();
    expect(restored.person_id).toBe(loser);
    const loserAfter = await db
      .selectFrom('platform.person')
      .select('status')
      .where('id', '=', loser)
      .executeTakeFirstOrThrow();
    expect(loserAfter.status).toBe('active');
    const stillThere = await db
      .selectFrom('platform.person_flag')
      .select('id')
      .where('person_id', '=', survivor)
      .where('ended_at', 'is', null)
      .execute();
    expect(stillThere).toHaveLength(1); // never-lose
  });
});

describe('merge de-roles the superseded person (PL-042, core plan 03 §9.5)', () => {
  /** Live (unrevoked, undeleted) grants for a person, oldest first. */
  async function liveGrants(personId: string) {
    return db
      .selectFrom('platform.role_grant as g')
      .innerJoin('platform.role as r', 'r.id', 'g.role_id')
      .select(['g.id', 'g.module', 'g.valid_until', 'r.key as role_key'])
      .where('g.person_id', '=', personId)
      .where('g.revoked_at', 'is', null)
      .where('g.deleted_at', 'is', null)
      .orderBy('g.id')
      .execute();
  }

  it('revokes every live grant on the loser, leaves the survivor untouched, and journals each', async () => {
    const survivor = await insertPerson({ display_name: 'Survivor' });
    const loser = await insertPerson({ display_name: 'Loser' });
    const platformGrant = await insertGrant(loser, 'hr_user');
    const hrGrant = await insertGrant(loser, 'line_manager', { module: 'hr.core' });
    const survivorGrant = await insertGrant(survivor, 'hr_user');

    const { mergeId } = await caller().platform.identity.merge({
      survivingPersonId: survivor,
      supersededPersonId: loser,
      reason: 'same person',
    });

    // The loser holds nothing; the survivor inherits nothing and loses nothing.
    expect(await liveGrants(loser)).toHaveLength(0);
    expect((await liveGrants(survivor)).map((g) => g.id)).toEqual([survivorGrant]);

    const revoked = await db
      .selectFrom('platform.role_grant')
      .select(['id', 'revoke_reason', 'revoked_by'])
      .where('person_id', '=', loser)
      .where('revoked_at', 'is not', null)
      .execute();
    expect(revoked.map((r) => r.id).sort()).toEqual([platformGrant, hrGrant].sort());
    expect(revoked.every((r) => r.revoke_reason === 'merged')).toBe(true);
    // A person revoked these, not the system — unlike the expiry sweep.
    expect(revoked.every((r) => r.revoked_by === adminPersonId)).toBe(true);

    // One journal event per grant, and the reversal set recorded on the merge.
    // (`domain_event` is append-only, so `truncateAll` leaves earlier tests'
    // rows in place — scope the query to these grants.)
    const events = await db
      .selectFrom('platform.domain_event')
      .select('stream_id')
      .where('event_type', '=', 'platform.role.revoked')
      .where('stream_id', 'in', [platformGrant, hrGrant])
      .execute();
    expect(events.map((e) => e.stream_id).sort()).toEqual([platformGrant, hrGrant].sort());
    const mergeRow = await db
      .selectFrom('platform.person_merge')
      .select('revoked_grant_ids')
      .where('id', '=', mergeId)
      .executeTakeFirstOrThrow();
    expect((mergeRow.revoked_grant_ids as string[]).sort()).toEqual(
      [platformGrant, hrGrant].sort(),
    );
  });

  it('unmerge re-grants as new rows, leaving the revoked rows revoked', async () => {
    const survivor = await insertPerson({ display_name: 'Survivor' });
    const loser = await insertPerson({ display_name: 'Loser' });
    const original = await insertGrant(loser, 'hr_user', { module: 'hr.core' });

    const { mergeId } = await caller().platform.identity.merge({
      survivingPersonId: survivor,
      supersededPersonId: loser,
      reason: 'same person',
    });
    const { restoredGrantIds } = await caller().platform.identity.unmerge({
      mergeId,
      reason: 'mistake',
    });

    // A revoked grant is never un-revoked (core plan 04 §4.3) — a NEW row appears.
    expect(restoredGrantIds).toHaveLength(1);
    expect(restoredGrantIds[0]).not.toBe(original);
    const live = await liveGrants(loser);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(restoredGrantIds[0]);
    expect(live[0]?.role_key).toBe('hr_user');
    expect(live[0]?.module).toBe('hr.core');
    const originalRow = await db
      .selectFrom('platform.role_grant')
      .select('revoked_at')
      .where('id', '=', original)
      .executeTakeFirstOrThrow();
    expect(originalRow.revoked_at).not.toBeNull();
    // Both halves of the round-trip are on the journal.
    expect(
      await db
        .selectFrom('platform.domain_event')
        .select('id')
        .where('stream_id', '=', restoredGrantIds[0] as string)
        .where('event_type', '=', 'platform.role.granted')
        .execute(),
    ).toHaveLength(1);
  });

  it('skips restoring a grant whose window has closed, or one re-granted meanwhile', async () => {
    const survivor = await insertPerson({ display_name: 'Survivor' });
    const loser = await insertPerson({ display_name: 'Loser' });
    const day = 24 * 60 * 60 * 1000;
    // Expired before the merge: revoked with the rest, but pointless to restore.
    await insertGrant(loser, 'hr_user', {
      validFrom: new Date(Date.now() - 2 * day),
      validUntil: new Date(Date.now() - day),
    });
    await insertGrant(loser, 'line_manager', { module: 'hr.core' });

    const { mergeId } = await caller().platform.identity.merge({
      survivingPersonId: survivor,
      supersededPersonId: loser,
      reason: 'same person',
    });
    // An administrator re-grants one of them on the superseded record before the
    // reversal — that live row is the current truth and must not be duplicated.
    const reGranted = await insertGrant(loser, 'line_manager', { module: 'hr.core' });

    const { restoredGrantIds } = await caller().platform.identity.unmerge({
      mergeId,
      reason: 'mistake',
    });

    expect(restoredGrantIds).toHaveLength(0);
    expect((await liveGrants(loser)).map((g) => g.id)).toEqual([reGranted]);
  });
});

describe('profile status transitions (CORE-01, AC-D9)', () => {
  it('permits a legal edge and journals from/to, rejects an illegal one', async () => {
    const p = await insertPerson({ display_name: 'Candidate' }); // draft_shell default
    await caller().platform.identity.setProfileStatus({
      personId: p,
      to: 'information_requested',
      reason: 'intake',
    });
    const events = await eventsFor(p, 'platform.person.profile_status_changed');
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { from: string; to: string }).from).toBe('draft_shell');

    await expect(
      caller().platform.identity.setProfileStatus({ personId: p, to: 'leaver', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('convertToEmployee (PL-046)', () => {
  it('keeps the id, clears access expiry, and journals relationship_changed', async () => {
    const p = await insertPerson({
      relationship_type: 'agency',
      display_name: 'Agency',
      access_valid_until: new Date(),
    });
    await caller().platform.identity.convertToEmployee({ personId: p, reason: 'hired' });
    const row = await db
      .selectFrom('platform.person')
      .selectAll()
      .where('id', '=', p)
      .executeTakeFirstOrThrow();
    expect(row.relationship_type).toBe('employee');
    expect(row.access_valid_until).toBeNull();
    expect(await eventsFor(p, 'platform.person.relationship_changed')).toHaveLength(1);

    await expect(
      caller().platform.identity.convertToEmployee({ personId: p, reason: 'again' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('duplicate review (AC-D6)', () => {
  it('lists a candidate pair, then excludes it once dismissed', async () => {
    const a = await insertPerson({
      display_name: 'Dup A',
      given_name: 'Sam',
      family_name: 'Jones',
      date_of_birth: '1985-05-05',
    });
    const b = await insertPerson({
      display_name: 'Dup B',
      given_name: 'Sam',
      family_name: 'Jones',
      date_of_birth: '1985-05-05',
    });

    const before = await caller().platform.identity.listDuplicateCandidates({});
    const pairIds = before.items.map((i) => [i.personA.id, i.personB.id].sort().join('|'));
    expect(pairIds).toContain([a, b].sort().join('|'));

    await caller().platform.identity.dismissDuplicate({ personIdA: a, personIdB: b });
    const after = await caller().platform.identity.listDuplicateCandidates({});
    const afterPairs = after.items.map((i) => [i.personA.id, i.personB.id].sort().join('|'));
    expect(afterPairs).not.toContain([a, b].sort().join('|'));
  });
});

describe('access expiry & re-engagement (PL-042)', () => {
  it('re-engages an inactive person against the same id and lifts the ban', async () => {
    const p = await insertPerson({
      relationship_type: 'agency',
      display_name: 'Ext',
      status: 'inactive',
    });
    const u = makeUser({ person_id: p, banned: true });
    await db.insertInto('user').values(u).execute();

    const future = new Date(Date.now() + 90 * 86_400_000).toISOString();
    await caller().platform.identity.reengage({ personId: p, accessValidUntil: future });
    const row = await db
      .selectFrom('platform.person')
      .select('status')
      .where('id', '=', p)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('active');
    const user = await db
      .selectFrom('user')
      .select('banned')
      .where('id', '=', u.id as string)
      .executeTakeFirstOrThrow();
    expect(user.banned).toBe(false);
    expect(await eventsFor(p, 'platform.person.reengaged')).toHaveLength(1);
  });
});

describe('invite (PL-036)', () => {
  it('provisions a linked user, journals invited, and sends the email', async () => {
    sendInvitation.mockClear();
    const p = await insertPerson({ relationship_type: 'agency', display_name: 'Invitee' });
    const res = await caller().platform.identity.invite({
      personId: p,
      email: 'invitee@example.com',
    });
    expect(res.reinvited).toBe(false);
    const user = await db
      .selectFrom('user')
      .select('person_id')
      .where('email', '=', 'invitee@example.com')
      .executeTakeFirstOrThrow();
    expect(user.person_id).toBe(p);
    expect(await eventsFor(p, 'platform.person.invited')).toHaveLength(1);
    expect(sendInvitation).toHaveBeenCalledWith('invitee@example.com');
  });
});

describe('RBAC boundary', () => {
  it('denies a caller holding no role grant, and returns own summary from me', async () => {
    const ungranted = appRouter.createCaller(makeCtx({ grants: [] }));
    await expect(ungranted.platform.identity.listPersons({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const me = await appRouter.createCaller(makeCtx()).platform.identity.me();
    expect(me?.id).toBe(adminPersonId);
  });

  it("Better Auth's admin flag is NOT the control (core plan 04 Q1)", async () => {
    // Same session that used to pass: `role: 'admin'` on the Better Auth user.
    // Since the re-base, only a `platform.role_grant` row authorises, so this is
    // rejected — proving the two role systems are no longer interchangeable.
    const frameworkAdminOnly = appRouter.createCaller(
      makeCtx({
        user: { id: 'admin-user', name: 'Admin', email: 'admin@cdf.test', role: 'admin' },
        grants: [],
      }),
    );
    await expect(frameworkAdminOnly.platform.identity.listPersons({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

// §10 "Append-only/immutability" — the DB-level guards on the two history tables
// (migration 20260710T100100). The guard permits exactly one lifecycle stamp
// (reversal / close-out); every other UPDATE, and every DELETE, is rejected. The
// erasure role isn't present in the test DB, so the guard enforces here.
describe('append-only guards (immutability, PL-039/040)', () => {
  it('person_merge: DELETE + non-reversal UPDATE + second reversal are all rejected', async () => {
    const survivor = await insertPerson({ display_name: 'S' });
    const loser = await insertPerson({ display_name: 'L' });
    const { mergeId } = await caller().platform.identity.merge({
      survivingPersonId: survivor,
      supersededPersonId: loser,
      reason: 'same person',
    });

    // DELETE is blocked outright.
    await expect(
      db.deleteFrom('platform.person_merge').where('id', '=', mergeId).execute(),
    ).rejects.toThrow(/append-only/i);
    // A non-reversal UPDATE (tampering with the reason) is blocked.
    await expect(
      db
        .updateTable('platform.person_merge')
        .set({ reason: 'tampered' })
        .where('id', '=', mergeId)
        .execute(),
    ).rejects.toThrow(/append-only/i);

    // The one permitted UPDATE — the reversal stamp — succeeds via unmerge.
    await caller().platform.identity.unmerge({ mergeId, reason: 'undo' });
    // A second reversal is rejected by the router (already reversed) …
    await expect(
      caller().platform.identity.unmerge({ mergeId, reason: 'again' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // … and a raw second stamp is rejected by the DB guard (reversed_at already set).
    await expect(
      db
        .updateTable('platform.person_merge')
        .set({ reversed_at: new Date(), reversed_by: adminPersonId, reversal_reason: 'x' })
        .where('id', '=', mergeId)
        .execute(),
    ).rejects.toThrow(/append-only/i);
  });

  it('person_flag: DELETE + non-close-out UPDATE are rejected; the close-out stamp is permitted once', async () => {
    const p = await insertPerson({ display_name: 'Flagged' });
    const { flagId } = await caller().platform.identity.addFlag({
      personId: p,
      flagType: 'safety',
      reason: 'incident',
    });

    // Never deleted (never-lose, PL-040).
    await expect(
      db.deleteFrom('platform.person_flag').where('id', '=', flagId).execute(),
    ).rejects.toThrow(/never deleted/i);
    // A non-close-out UPDATE (tampering with the reason) is blocked.
    await expect(
      db
        .updateTable('platform.person_flag')
        .set({ reason: 'tampered' })
        .where('id', '=', flagId)
        .execute(),
    ).rejects.toThrow(/append-only/i);

    // The one permitted UPDATE — the close-out stamp — succeeds via endFlag, once.
    await caller().platform.identity.endFlag({ flagId, reason: 'resolved' });
    const row = await db
      .selectFrom('platform.person_flag')
      .select('ended_at')
      .where('id', '=', flagId)
      .executeTakeFirstOrThrow();
    expect(row.ended_at).not.toBeNull();
    await expect(
      caller().platform.identity.endFlag({ flagId, reason: 'again' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

// §10 "Event-ledger test" — a person's lifecycle is fully reconstructable from the
// journal, in order, with nothing overwritten (AC-D5 event production; CORE-01).
describe('event-ledger reconstruction (AC-D5, CORE-01)', () => {
  it('reconstructs the ordered lifecycle from the journal; state changes never overwrite history', async () => {
    const p = await insertPerson({ relationship_type: 'agency', display_name: 'Ledger' });
    const future = new Date(Date.now() + 90 * 86_400_000).toISOString();

    await caller().platform.identity.setProfileStatus({
      personId: p,
      to: 'information_requested',
      reason: 'intake',
    });
    await caller().platform.identity.setProfileStatus({
      personId: p,
      to: 'information_submitted',
      reason: 'submitted',
    });
    const { flagId } = await caller().platform.identity.addFlag({
      personId: p,
      flagType: 'safety',
      reason: 'ppe',
    });
    await caller().platform.identity.setAccessValidUntil({ personId: p, accessValidUntil: future });
    await caller().platform.identity.endFlag({ flagId, reason: 'cleared' });

    // UUIDv7 ids are time-ordered, so ordering by id replays creation order.
    const events = await db
      .selectFrom('platform.domain_event')
      .select(['event_type', 'payload', 'kind'])
      .where('stream_id', '=', p)
      .orderBy('id', 'asc')
      .execute();

    // The person was also created via insertPerson (no journal there), so the
    // ledger holds exactly the five actions above, in order.
    expect(events.map((e) => e.event_type)).toEqual([
      'platform.person.profile_status_changed',
      'platform.person.profile_status_changed',
      'platform.person.flag_added',
      'platform.person.access_expiry_set',
      'platform.person.flag_ended',
    ]);
    // Every identity fact is a security event.
    expect(events.every((e) => e.kind === 'security')).toBe(true);

    // The status chain reconstructs without overwriting: each event carries the
    // exact from→to edge, and the two transitions are distinct rows.
    const statusEdges = events
      .filter((e) => e.event_type === 'platform.person.profile_status_changed')
      .map((e) => e.payload as { from: string; to: string });
    expect(statusEdges).toEqual([
      { from: 'draft_shell', to: 'information_requested', reason: 'intake' },
      { from: 'information_requested', to: 'information_submitted', reason: 'submitted' },
    ]);

    const current = await db
      .selectFrom('platform.person')
      .select('profile_status')
      .where('id', '=', p)
      .executeTakeFirstOrThrow();
    expect(current.profile_status).toBe('information_submitted');
  });
});

// §10 "Account containment" (testable slice — the `role_grant` clause and the
// first-Entra-SSO path are plan 04 / the api-layer auth flow). An invited account
// is an inert shell: draft_shell, and its own (non-admin) caller cannot read other
// records or escalate its own profile status (PL-036/043, AC-D10/D11).
describe('account containment (PL-036/043)', () => {
  it('a freshly invited person is a draft_shell that cannot self-escalate or read others', async () => {
    const p = await insertPerson({ relationship_type: 'agency', display_name: 'Shell' });
    await caller().platform.identity.invite({ personId: p, email: 'shell@example.com' });

    const shell = await db
      .selectFrom('platform.person')
      .select(['profile_status', 'status'])
      .where('id', '=', p)
      .executeTakeFirstOrThrow();
    expect(shell.profile_status).toBe('draft_shell');

    // The invited person's own session. `grants: []` is not a convenience here —
    // it is the real state of a freshly invited person: neither the invitation
    // nor a first sign-in inserts any role_grant row (§4.1, core plan 04).
    const invitee = appRouter.createCaller(
      makeCtx({
        user: { id: 'shell-user', name: 'Shell', email: 'shell@example.com', role: 'agent' },
        actorPersonId: p,
        grants: [],
      }),
    );
    // No admin surface: cannot read others, cannot move its own profile status.
    await expect(invitee.platform.identity.listPersons({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(invitee.platform.identity.getPerson({ personId: p })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      invitee.platform.identity.setProfileStatus({
        personId: p,
        to: 'information_requested',
        reason: 'self',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Only its own summary is visible, still a draft_shell.
    const me = await invitee.platform.identity.me();
    expect(me?.id).toBe(p);
    expect(me?.profile_status).toBe('draft_shell');
  });
});
