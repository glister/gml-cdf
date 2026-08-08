import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, newUuidV7, type NewPerson } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import { appRouter } from '../../router.js';
import type { ContextGrant, TRPCContext } from '../../trpc.js';
import { ROLE_KEYS, type RoleKey } from '../../lib/constants.js';

/**
 * Teams — the Tier 3 exemplar (core plan 05 §10, PL-005d/005e, PL-007a).
 *
 * Real Postgres throughout. Three of the behaviours below live entirely in the
 * database — the overlap EXCLUDE constraint, the partial unique name index and
 * the half-open membership window — and a mock would assert nothing about any
 * of them (ADR-0004).
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

let adminPersonId: string;
let adminGrants: ContextGrant[];

beforeEach(async () => {
  await truncateAll(db);
  await reseedRoles();
  adminPersonId = await insertPerson({ relationship_type: 'employee', display_name: 'Admin' });
  adminGrants = await grantsFor(adminPersonId, ['administrator']);
});

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

async function insertPerson(overrides: Partial<NewPerson> = {}): Promise<string> {
  const id = overrides.id ?? newUuidV7();
  await db
    .insertInto('platform.person')
    .values({ id, relationship_type: 'agency', display_name: 'Person', ...overrides })
    .execute();
  return id;
}

async function grantsFor(personId: string, roleKeys: RoleKey[]): Promise<ContextGrant[]> {
  for (const roleKey of roleKeys) {
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
  }
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

function makeCtx(overrides: Partial<TRPCContext> = {}): TRPCContext {
  return {
    db,
    user: { id: 'u', name: 'Admin', email: 'admin@cdf.test', role: 'admin' },
    session: { id: 's', userId: 'u' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    email: { sendOtp: async () => {}, sendInvitation: async () => {} },
    sms: { send: async () => {} },
    rateLimit: { check: () => true },
    correlationId: newUuidV7(),
    actorPersonId: adminPersonId,
    grants: adminGrants,
    // Core plan 11 §4.7: SES evidence records where a signature came from,
    // taken server-side. Null outside an HTTP request — nothing signs from here.
    requestIp: null,
    userAgent: null,
    ...overrides,
  };
}

const caller = () => appRouter.createCaller(makeCtx());

async function callerWith(roleKeys: RoleKey[]) {
  const personId = await insertPerson({ display_name: roleKeys.join('+') });
  const grants = await grantsFor(personId, roleKeys);
  return appRouter.createCaller(makeCtx({ actorPersonId: personId, grants }));
}

/** Create a team through the API, so every fixture exercises the write path. */
async function makeTeam(
  name: string,
  extra: { managerPersonId?: string; deputyPersonId?: string; maxConcurrentLeave?: number } = {},
): Promise<string> {
  const { id } = await caller().platform.team.create({
    name,
    managerPersonId: extra.managerPersonId ?? adminPersonId,
    ...(extra.deputyPersonId ? { deputyPersonId: extra.deputyPersonId } : {}),
    ...(extra.maxConcurrentLeave ? { maxConcurrentLeave: extra.maxConcurrentLeave } : {}),
  });
  return id;
}

async function eventsFor(streamId: string, eventType?: string) {
  let q = db.selectFrom('platform.domain_event').selectAll().where('stream_id', '=', streamId);
  if (eventType) q = q.where('event_type', '=', eventType);
  return q.orderBy('recorded_at').orderBy('id').execute();
}

function isoDate(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

describe('list (keyset, derived member count in SQL)', () => {
  it('pages the whole set in global order with no duplicates or gaps', async () => {
    const names: string[] = [];
    for (let i = 0; i < 25; i++) {
      // Names deliberately out of insertion order so a broken sort key cannot
      // pass by luck.
      const name = `Team ${String((i * 7) % 25).padStart(2, '0')}`;
      await makeTeam(name);
      names.push(name);
    }
    names.sort();

    const seen: string[] = [];
    const ids = new Set<string>();
    let cursor: string | undefined;
    for (let guard = 0; guard < 30; guard++) {
      const page = await caller().platform.team.list({
        limit: 4,
        cursor,
        sort: 'name',
        sortDir: 'asc',
      });
      for (const row of page.items) {
        seen.push(row.name);
        ids.add(row.id);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toEqual(names);
    expect(ids.size).toBe(25);
  });

  it('counts only members current today, in SQL', async () => {
    const teamId = await makeTeam('Crew');
    const current = await insertPerson({ display_name: 'Current' });
    const past = await insertPerson({ display_name: 'Past' });
    const future = await insertPerson({ display_name: 'Future' });

    await caller().platform.team.addMember({
      teamId,
      personId: current,
      validFrom: isoDate(-30),
    });
    const pastMembership = await caller().platform.team.addMember({
      teamId,
      personId: past,
      validFrom: isoDate(-30),
    });
    // Half-open: valid_to = today means they are already out today.
    await caller().platform.team.endMembership({
      membershipId: pastMembership.membershipId,
      validTo: isoDate(0),
    });
    await caller().platform.team.addMember({ teamId, personId: future, validFrom: isoDate(1) });

    const page = await caller().platform.team.list({});
    expect(Number(page.items.find((t) => t.id === teamId)?.member_count)).toBe(1);
  });

  it('hides archived teams from readers, and shows them only to an admin who asks', async () => {
    const teamId = await makeTeam('Retired crew');
    await caller().platform.team.archive({ teamId });

    expect((await caller().platform.team.list({})).items).toHaveLength(0);
    const withArchived = await caller().platform.team.list({ includeArchived: true });
    expect(withArchived.items.map((t) => t.id)).toEqual([teamId]);

    // A non-admin reader asking for archived teams gets the live list, not an
    // error — the flag is a maintenance nicety, not a permission boundary.
    const manager = await callerWith(['line_manager']);
    expect((await manager.platform.team.list({ includeArchived: true })).items).toHaveLength(0);
  });

  it('filters by name in SQL', async () => {
    await makeTeam('Fencing Crew A');
    await makeTeam('Transport');
    const page = await caller().platform.team.list({ search: 'crew' });
    expect(page.items.map((t) => t.name)).toEqual(['Fencing Crew A']);
  });
});

describe('create / update (Tier 3 attributes)', () => {
  it('creates a team with manager, deputy and capacity, and journals it', async () => {
    const manager = await insertPerson({ display_name: 'Manager' });
    const deputy = await insertPerson({ display_name: 'Deputy' });
    const teamId = await makeTeam('Crew A', {
      managerPersonId: manager,
      deputyPersonId: deputy,
      maxConcurrentLeave: 2,
    });

    const { team } = await caller().platform.team.get({ teamId });
    expect(team).toMatchObject({
      name: 'Crew A',
      manager_person_id: manager,
      deputy_person_id: deputy,
      max_concurrent_leave: 2,
    });

    const [event] = await eventsFor(teamId, 'platform.team.created');
    expect(event.kind).toBe('admin');
    expect(event.payload).toEqual({
      name: 'Crew A',
      managerPersonId: manager,
      deputyPersonId: deputy,
      maxConcurrentLeave: 2,
    });
  });

  it('rejects a deputy who is also the manager, and a capacity below one', async () => {
    await expect(
      caller().platform.team.create({
        name: 'Bad deputy',
        managerPersonId: adminPersonId,
        deputyPersonId: adminPersonId,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // Capacity is caught at the schema boundary before it reaches the CHECK.
    await expect(
      caller().platform.team.create({
        name: 'Bad capacity',
        managerPersonId: adminPersonId,
        maxConcurrentLeave: 0,
      }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate live name but frees it once the team is archived', async () => {
    const first = await makeTeam('Crew A');
    await expect(
      caller().platform.team.create({ name: 'Crew A', managerPersonId: adminPersonId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // The index is on lower(name): casing is not a new team.
    await expect(
      caller().platform.team.create({ name: 'crew a', managerPersonId: adminPersonId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await caller().platform.team.archive({ teamId: first });
    await expect(
      caller().platform.team.create({ name: 'Crew A', managerPersonId: adminPersonId }),
    ).resolves.toBeTruthy();
  });

  it('journals manager, deputy and capacity old→new, because nothing else records them', async () => {
    const manager = await insertPerson({ display_name: 'Old manager' });
    const replacement = await insertPerson({ display_name: 'New manager' });
    const teamId = await makeTeam('Crew A', { managerPersonId: manager, maxConcurrentLeave: 2 });

    await caller().platform.team.update({
      teamId,
      managerPersonId: replacement,
      maxConcurrentLeave: 3,
    });

    const [event] = await eventsFor(teamId, 'platform.team.updated');
    expect(event.payload).toEqual({
      managerPersonId: { from: manager, to: replacement },
      maxConcurrentLeave: { from: 2, to: 3 },
    });
    // Surrogate ids only — the people's display names never reach the payload
    // (ADR-0019).
    const serialised = JSON.stringify(event.payload);
    expect(serialised).not.toContain('Old manager');
    expect(serialised).not.toContain('New manager');
  });

  it('writes nothing when an update changes nothing', async () => {
    const teamId = await makeTeam('Crew A');
    const result = await caller().platform.team.update({ teamId, name: 'Crew A' });
    expect(result.changed).toBe(false);
    expect(await eventsFor(teamId, 'platform.team.updated')).toHaveLength(0);
  });

  it('rejects an unknown manager rather than failing with a raw driver error', async () => {
    await expect(
      caller().platform.team.create({ name: 'Ghost', managerPersonId: newUuidV7() }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('membership (effective dating — AC-D4, PL-007a)', () => {
  it('rejects an overlapping window and allows an adjacent one', async () => {
    const teamId = await makeTeam('Crew A');
    const person = await insertPerson();

    const first = await caller().platform.team.addMember({
      teamId,
      personId: person,
      validFrom: '2026-01-01',
    });
    await caller().platform.team.endMembership({
      membershipId: first.membershipId,
      validTo: '2026-04-01',
    });

    // Overlaps [2026-01-01, 2026-04-01).
    await expect(
      caller().platform.team.addMember({ teamId, personId: person, validFrom: '2026-03-01' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // Adjacent: [a,b) then [b,c) — leaving and rejoining on the same day is
    // legal, and is what half-open intervals buy.
    await expect(
      caller().platform.team.addMember({ teamId, personId: person, validFrom: '2026-04-01' }),
    ).resolves.toBeTruthy();
  });

  it('answers "who was in this team on date D?" for past, present and pre-history', async () => {
    const teamId = await makeTeam('Crew A');
    const leaver = await insertPerson({ display_name: 'Leaver' });
    const joiner = await insertPerson({ display_name: 'Joiner' });
    const rejoiner = await insertPerson({ display_name: 'Rejoiner' });

    const leaverMembership = await caller().platform.team.addMember({
      teamId,
      personId: leaver,
      validFrom: '2026-01-01',
    });
    await caller().platform.team.endMembership({
      membershipId: leaverMembership.membershipId,
      validTo: '2026-04-01',
    });
    await caller().platform.team.addMember({
      teamId,
      personId: joiner,
      validFrom: '2026-04-01',
    });
    // Joined, left, and came back — two rows for one person.
    const firstSpell = await caller().platform.team.addMember({
      teamId,
      personId: rejoiner,
      validFrom: '2026-01-01',
    });
    await caller().platform.team.endMembership({
      membershipId: firstSpell.membershipId,
      validTo: '2026-02-01',
    });
    await caller().platform.team.addMember({
      teamId,
      personId: rejoiner,
      validFrom: '2026-06-01',
    });

    const rosterOn = async (asAt: string) =>
      (await caller().platform.team.get({ teamId, asAt })).roster.map((m) => m.display_name).sort();

    expect(await rosterOn('2025-12-31')).toEqual([]); // before any membership
    expect(await rosterOn('2026-01-15')).toEqual(['Leaver', 'Rejoiner']);
    expect(await rosterOn('2026-03-01')).toEqual(['Leaver']); // rejoiner's gap
    expect(await rosterOn('2026-04-01')).toEqual(['Joiner']); // handover day
    expect(await rosterOn('2026-07-01')).toEqual(['Joiner', 'Rejoiner']);
  });

  it('defaults the roster to today when no date is given', async () => {
    const teamId = await makeTeam('Crew A');
    const person = await insertPerson({ display_name: 'Today member' });
    await caller().platform.team.addMember({ teamId, personId: person, validFrom: isoDate(-1) });
    const future = await insertPerson({ display_name: 'Not yet' });
    await caller().platform.team.addMember({ teamId, personId: future, validFrom: isoDate(1) });

    const { roster, asAt } = await caller().platform.team.get({ teamId });
    expect(asAt).toBe(isoDate(0));
    expect(roster.map((m) => m.display_name)).toEqual(['Today member']);
  });

  it('journals add, end and correct as three distinct facts under the team stream', async () => {
    const teamId = await makeTeam('Crew A');
    const person = await insertPerson();
    const { membershipId } = await caller().platform.team.addMember({
      teamId,
      personId: person,
      validFrom: '2026-01-01',
    });
    await caller().platform.team.endMembership({ membershipId, validTo: '2026-04-01' });
    await caller().platform.team.correctMembership({ membershipId, validFrom: '2026-02-01' });

    expect((await eventsFor(teamId, 'platform.team.membership.added'))[0].payload).toEqual({
      membershipId,
      personId: person,
      validFrom: '2026-01-01',
    });
    expect((await eventsFor(teamId, 'platform.team.membership.ended'))[0].payload).toEqual({
      membershipId,
      personId: person,
      validTo: '2026-04-01',
    });
    // Correcting is a separate act from ending: it moves a boundary that other
    // records may already have been read against, so it must look different in
    // the audit trail.
    expect((await eventsFor(teamId, 'platform.team.membership.corrected'))[0].payload).toEqual({
      membershipId,
      personId: person,
      validFrom: { from: '2026-01-01', to: '2026-02-01' },
    });
  });

  it('refuses to re-end an already-ended membership', async () => {
    const teamId = await makeTeam('Crew A');
    const person = await insertPerson();
    const { membershipId } = await caller().platform.team.addMember({
      teamId,
      personId: person,
      validFrom: '2026-01-01',
    });
    await caller().platform.team.endMembership({ membershipId, validTo: '2026-04-01' });

    await expect(
      caller().platform.team.endMembership({ membershipId, validTo: '2026-05-01' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects a correction that would overlap another spell', async () => {
    const teamId = await makeTeam('Crew A');
    const person = await insertPerson();
    const first = await caller().platform.team.addMember({
      teamId,
      personId: person,
      validFrom: '2026-01-01',
    });
    await caller().platform.team.endMembership({
      membershipId: first.membershipId,
      validTo: '2026-04-01',
    });
    const second = await caller().platform.team.addMember({
      teamId,
      personId: person,
      validFrom: '2026-04-01',
    });

    await expect(
      caller().platform.team.correctMembership({
        membershipId: second.membershipId,
        validFrom: '2026-02-01',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('archive', () => {
  it('end-dates open memberships in the same transaction and records their ids', async () => {
    const teamId = await makeTeam('Crew A');
    const current = await insertPerson({ display_name: 'Current' });
    const future = await insertPerson({ display_name: 'Future' });
    const currentMembership = await caller().platform.team.addMember({
      teamId,
      personId: current,
      validFrom: isoDate(-10),
    });
    const futureMembership = await caller().platform.team.addMember({
      teamId,
      personId: future,
      validFrom: isoDate(5),
    });

    const result = await caller().platform.team.archive({ teamId });
    expect(result.endedMembershipIds.sort()).toEqual(
      [currentMembership.membershipId, futureMembership.membershipId].sort(),
    );

    const rows = await db
      .selectFrom('platform.team_membership')
      .select(['id', 'valid_from', 'valid_to'])
      .where('team_id', '=', teamId)
      .execute();
    // None left open, and the not-yet-started one is closed to the smallest
    // legal window rather than erased — memberships are never deleted.
    expect(rows.every((r) => r.valid_to !== null)).toBe(true);
    expect(rows.every((r) => r.valid_to! > r.valid_from)).toBe(true);

    const [event] = await eventsFor(teamId, 'platform.team.archived');
    expect(event.payload).toMatchObject({ name: 'Crew A' });
  });

  it('makes the team unreachable through get', async () => {
    const teamId = await makeTeam('Crew A');
    await caller().platform.team.archive({ teamId });
    await expect(caller().platform.team.get({ teamId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('authorisation (§8, §12.2 Q6)', () => {
  it('lets role-holders read teams but not maintain them', async () => {
    const teamId = await makeTeam('Crew A');

    for (const role of ['line_manager', 'finance', 'director'] as RoleKey[]) {
      const c = await callerWith([role]);
      const page = await c.platform.team.list({});
      expect(page.items.map((t) => t.id)).toEqual([teamId]);
      await expect(
        c.platform.team.create({ name: `X ${role}`, managerPersonId: adminPersonId }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('excludes externals and employees from roster browsing', async () => {
    await makeTeam('Crew A');
    for (const role of ['external', 'external_administrator', 'employee'] as RoleKey[]) {
      const c = await callerWith([role]);
      await expect(c.platform.team.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('lets an HR User maintain teams', async () => {
    const hr = await callerWith(['hr_user']);
    const { id } = await hr.platform.team.create({
      name: 'HR crew',
      managerPersonId: adminPersonId,
    });
    await expect(hr.platform.team.update({ teamId: id, name: 'HR crew 2' })).resolves.toBeTruthy();
  });
});
