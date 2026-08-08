import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { db, newUuidV7, type NewPerson } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import {
  calendarKindColours,
  leaveBlackoutPeriods,
  leaveShutdownPeriods,
  setConfig,
} from '@repo/config';
import { appRouter } from '../../router.js';
import type { ContextGrant, TRPCContext } from '../../trpc.js';
import { ROLE_KEYS, type RoleKey } from '../../lib/constants.js';
import {
  canonicalFragment,
  registerCalendarSource,
  unregisterCalendarSourceForTests,
  SRC_PERSON_ID,
} from '../../lib/calendar/registry.js';

/**
 * The shared calendar feed (core plan 12 §10, PL-022/PL-023/PL-023a).
 *
 * **Real Postgres throughout, and not as a matter of taste.** Every behaviour
 * asserted here is a property of one SQL statement — a range-overlap predicate,
 * a `UNION ALL` of fragments whose column order must line up, an
 * effective-dated lateral join, a scope subquery, `jsonb_to_recordset` over a
 * config value, and a colour `CASE`. A mock database executes none of it, so a
 * suite built on one could pass with the union transposed (ADR-0004's
 * "validate against a real database").
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
  // The stub sources below need a person-keyed carrier table, and the platform
  // ships none: leave and absence land with the HR plans. Rather than abusing a
  // production table with columns that mean something else, the fixture owns a
  // schema of its own — created here, dropped after, invisible to `truncateAll`.
  await sql`CREATE SCHEMA IF NOT EXISTS calendar_test`.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS calendar_test.item (
      id         uuid PRIMARY KEY,
      person_id  uuid NOT NULL,
      starts_on  date NOT NULL,
      ends_on    date NOT NULL,
      type_ref   text NOT NULL,
      label      text NOT NULL,
      status     text NOT NULL DEFAULT 'approved'
    )
  `.execute(db);
});

afterAll(async () => {
  await sql`DROP SCHEMA IF EXISTS calendar_test CASCADE`.execute(db);
  await db.destroy();
});

let adminPersonId: string;
let adminGrants: ContextGrant[];

beforeEach(async () => {
  await truncateAll(db);
  await sql`TRUNCATE calendar_test.item`.execute(db);
  await reseedRoles();
  adminPersonId = await insertPerson({ display_name: 'Admin', relationship_type: 'employee' });
  adminGrants = await grantsFor(adminPersonId, ['administrator']);
});

async function reseedRoles(): Promise<void> {
  const existing = await db.selectFrom('platform.role').select('id').executeTakeFirst();
  if (existing) return;
  await db
    .insertInto('platform.role')
    .values(
      ROLE_KEYS.map((key, i) => ({
        id: `019f509e-9e0${i.toString(16)}-7000-8000-00000000000${i.toString(16)}`,
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
    .values({ id, relationship_type: 'employee', display_name: 'Person', ...overrides })
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
    requestIp: null,
    userAgent: null,
    ...overrides,
  };
}

const caller = () => appRouter.createCaller(makeCtx());

async function callerFor(personId: string, roleKeys: RoleKey[]) {
  const grants = await grantsFor(personId, roleKeys);
  return appRouter.createCaller(makeCtx({ actorPersonId: personId, grants }));
}

async function makeTeam(name: string, opts: { colour?: string; managerPersonId?: string } = {}) {
  const id = newUuidV7();
  await db
    .insertInto('platform.team')
    .values({
      id,
      name,
      colour: opts.colour ?? null,
      manager_person_id: opts.managerPersonId ?? adminPersonId,
      created_by: adminPersonId,
      updated_by: adminPersonId,
    })
    .execute();
  return id;
}

async function addMember(
  teamId: string,
  personId: string,
  validFrom = '2020-01-01',
  validTo?: string,
) {
  await db
    .insertInto('platform.team_membership')
    .values({
      id: newUuidV7(),
      team_id: teamId,
      person_id: personId,
      valid_from: validFrom,
      valid_to: validTo ?? null,
      created_by: adminPersonId,
      updated_by: adminPersonId,
    })
    .execute();
}

async function setPeriods(
  key: typeof leaveBlackoutPeriods | typeof leaveShutdownPeriods,
  periods: { from: string; to: string; label: string }[],
) {
  await db.transaction().execute((trx) =>
    setConfig(trx, {
      def: key,
      value: periods,
      actorPersonId: adminPersonId,
      correlationId: newUuidV7(),
    }),
  );
}

/** A whole month, as the month view asks for it. */
const AUGUST = { from: '2026-08-01', to: '2026-08-31' } as const;

// --- The config-period source (PL-023) --------------------------------------

describe('the config-period source — blackout and shut-down, with no table', () => {
  it('renders both kinds from configuration, with no code change per period', async () => {
    await setPeriods(leaveBlackoutPeriods, [
      { from: '2026-08-10', to: '2026-08-14', label: 'Stocktake' },
    ]);
    await setPeriods(leaveShutdownPeriods, [
      { from: '2026-08-24', to: '2026-08-28', label: 'Works shutdown' },
    ]);

    const { events } = await caller().platform.calendar.feed(AUGUST);

    expect(events.map((e) => [e.kind, e.label, e.startsOn, e.endsOn])).toEqual([
      ['blackout', 'Stocktake', '2026-08-10', '2026-08-14'],
      ['shutdown', 'Works shutdown', '2026-08-24', '2026-08-28'],
    ]);
    // Organisation-wide: nobody's personal data, everybody's business.
    expect(events.every((e) => e.personId === null)).toBe(true);
    expect(events.every((e) => e.status === 'approved')).toBe(true);
  });

  it('gives every period a distinct source_ref, even with identical dates', async () => {
    await setPeriods(leaveBlackoutPeriods, [
      { from: '2026-08-10', to: '2026-08-11', label: 'Site A' },
      { from: '2026-08-10', to: '2026-08-11', label: 'Site B' },
    ]);

    const { events } = await caller().platform.calendar.feed(AUGUST);

    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.sourceRef)).size).toBe(2);
  });

  it('resolves the configuration as at the end of the requested window (ADR-0016)', async () => {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const plus = (days: number) => new Date(Date.now() + days * 86_400_000);

    await setPeriods(leaveBlackoutPeriods, [
      { from: iso(plus(5)), to: iso(plus(6)), label: 'Original' },
    ]);
    // A change staged for later — plan 06 supports this, and the calendar has to
    // agree with it about the future as well as about the past.
    await db.transaction().execute((trx) =>
      setConfig(trx, {
        def: leaveBlackoutPeriods,
        value: [{ from: iso(plus(5)), to: iso(plus(6)), label: 'Revised' }],
        actorPersonId: adminPersonId,
        correlationId: newUuidV7(),
        effectiveFrom: plus(30),
      }),
    );

    // A window that closes before the change: the value in force then.
    const before = await caller().platform.calendar.feed({
      from: iso(plus(1)),
      to: iso(plus(20)),
    });
    expect(before.events.map((e) => e.label)).toEqual(['Original']);

    // The same period, seen through a window that closes after the change.
    const after = await caller().platform.calendar.feed({
      from: iso(plus(1)),
      to: iso(plus(40)),
    });
    expect(after.events.map((e) => e.label)).toEqual(['Revised']);
  });

  it('does not project today’s periods back into a month before they existed', async () => {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const minus = (days: number) => new Date(Date.now() - days * 86_400_000);

    await setPeriods(leaveBlackoutPeriods, [
      { from: iso(minus(30)), to: iso(minus(25)), label: 'Set today, dated last month' },
    ]);

    const past = await caller().platform.calendar.feed({
      from: iso(minus(40)),
      to: iso(minus(20)),
    });

    // Nothing was configured then, so nothing is shown then — even though the
    // period's own dates fall inside the window.
    expect(past.events).toEqual([]);
  });
});

// --- Window overlap (§10) ----------------------------------------------------

describe('window overlap — the edges are where a range predicate goes wrong', () => {
  beforeEach(async () => {
    await setPeriods(leaveBlackoutPeriods, [
      { from: '2026-07-28', to: '2026-08-02', label: 'straddles from' },
      { from: '2026-08-29', to: '2026-09-03', label: 'straddles to' },
      { from: '2026-08-15', to: '2026-08-15', label: 'exactly one day' },
      { from: '2026-07-01', to: '2026-09-30', label: 'contains the window' },
      { from: '2026-07-01', to: '2026-07-31', label: 'entirely before' },
      { from: '2026-09-01', to: '2026-09-30', label: 'entirely after' },
    ]);
  });

  it('includes every overlapping period and excludes the two that do not', async () => {
    const { events } = await caller().platform.calendar.feed(AUGUST);

    expect(new Set(events.map((e) => e.label))).toEqual(
      new Set(['straddles from', 'straddles to', 'exactly one day', 'contains the window']),
    );
  });

  it('treats both window ends as inclusive', async () => {
    const oneDay = await caller().platform.calendar.feed({
      from: '2026-08-15',
      to: '2026-08-15',
    });
    expect(oneDay.events.map((e) => e.label)).toContain('exactly one day');

    const dayBefore = await caller().platform.calendar.feed({
      from: '2026-08-14',
      to: '2026-08-14',
    });
    expect(dayBefore.events.map((e) => e.label)).not.toContain('exactly one day');
  });

  it('refuses a window longer than the month/week views need', async () => {
    await expect(
      caller().platform.calendar.feed({ from: '2026-01-01', to: '2026-12-31' }),
    ).rejects.toThrow();
  });

  it('refuses an inverted window rather than returning nothing', async () => {
    await expect(
      caller().platform.calendar.feed({ from: '2026-08-31', to: '2026-08-01' }),
    ).rejects.toThrow();
  });
});

// --- A stub personal source, for scoping and colour --------------------------
//
// The platform ships no person-keyed source (leave and absence land with HR), so
// scoping, team filtering and colour resolution would be untestable without one.
// These register fragments over the fixture's own `calendar_test.item` table.
// What is under test is the composer — the union, the scope and the colour — and
// a stub is the honest carrier for that: it is exactly what an HR source will
// hand the registry, minus the business rules that are not this plan's.

const STUB_KEY = 'platform.stub_personal';
const RESTRICTED_KEY = 'platform.stub_restricted';
const AUDIENCE_KEY = 'platform.stub_audience';

function stubFragment(key: string, visibilityClass: 'normal' | 'restricted', typeColour = true) {
  return (window: { from: string; to: string }) =>
    canonicalFragment(
      {
        key,
        visibilityClass,
        ...(visibilityClass === 'restricted' ? { restrictedLabel: restrictedLabelOf(key) } : {}),
      },
      {
        sourceRef: sql`f.id::text`,
        personId: sql`f.person_id`,
        startsOn: sql`f.starts_on`,
        endsOn: sql`f.ends_on`,
        kind: sql`${sql.lit(kindOf(key))}`,
        typeRef: sql`f.type_ref`,
        typeLabel: sql`f.type_ref`,
        typeColour: typeColour ? sql`'#123456'` : sql`NULL`,
        label: sql`f.label`,
        status: sql`f.status`,
      },
      sql`FROM calendar_test.item f
          WHERE f.starts_on <= ${window.to}::date
            AND f.ends_on   >= ${window.from}::date`,
    );
}

function restrictedLabelOf(key: string): string {
  return key === AUDIENCE_KEY ? 'HR event' : 'Absence';
}

function kindOf(key: string): string {
  if (key === RESTRICTED_KEY) return 'absence';
  if (key === AUDIENCE_KEY) return 'hr_event';
  return 'leave';
}

async function addStubItem(
  personId: string,
  from: string,
  to: string,
  label: string,
  extra: { typeRef?: string; status?: string } = {},
) {
  const id = newUuidV7();
  await sql`
    INSERT INTO calendar_test.item (id, person_id, starts_on, ends_on, type_ref, label, status)
    VALUES (${id}::uuid, ${personId}::uuid, ${from}::date, ${to}::date,
            ${extra.typeRef ?? 'annual'}, ${label}, ${extra.status ?? 'approved'})
  `.execute(db);
  return id;
}

describe('viewer scoping (AC-D2) — proved against real rows, not asserted in a comment', () => {
  let alice: string;
  let bob: string;
  let stranger: string;
  let external: string;
  let teamId: string;

  beforeEach(async () => {
    registerCalendarSource({
      key: STUB_KEY,
      kinds: ['leave'],
      visibilityClass: 'normal',
      fragment: stubFragment(STUB_KEY, 'normal'),
    });

    alice = await insertPerson({ display_name: 'Alice' });
    bob = await insertPerson({ display_name: 'Bob' });
    stranger = await insertPerson({ display_name: 'Stranger' });
    external = await insertPerson({ display_name: 'Agency Ann', relationship_type: 'agency' });

    teamId = await makeTeam('Fabrication');
    await addMember(teamId, alice);
    await addMember(teamId, bob);

    await addStubItem(alice, '2026-08-03', '2026-08-07', 'Alice away');
    await addStubItem(bob, '2026-08-10', '2026-08-12', 'Bob away');
    await addStubItem(stranger, '2026-08-17', '2026-08-19', 'Stranger away');
    await addStubItem(external, '2026-08-20', '2026-08-21', 'Ann away');
    await setPeriods(leaveShutdownPeriods, [
      { from: '2026-08-24', to: '2026-08-28', label: 'Works shutdown' },
    ]);
  });

  afterEach(() => unregisterCalendarSourceForTests(STUB_KEY));

  it('lets an employee see their team, including a manager’s, and no further (HL-044)', async () => {
    const aliceCaller = await callerFor(alice, ['employee']);
    const { events } = await aliceCaller.platform.calendar.feed(AUGUST);

    expect(new Set(events.map((e) => e.label))).toEqual(
      new Set(['Alice away', 'Bob away', 'Works shutdown']),
    );
    // The two rows outside her team never left Postgres.
    expect(events.map((e) => e.label)).not.toContain('Stranger away');
  });

  it('gives HR and Director the whole organisation', async () => {
    for (const role of ['hr_user', 'director'] as const) {
      const person = await insertPerson({ display_name: role });
      const asRole = await callerFor(person, [role]);
      const { events } = await asRole.platform.calendar.feed(AUGUST);

      expect(new Set(events.map((e) => e.label))).toEqual(
        new Set(['Alice away', 'Bob away', 'Stranger away', 'Ann away', 'Works shutdown']),
      );
    }
  });

  it('gives an agency worker their own rows and the org-wide ones only (PL-004)', async () => {
    const asExternal = await callerFor(external, ['external']);
    const { events } = await asExternal.platform.calendar.feed(AUGUST);

    expect(new Set(events.map((e) => e.label))).toEqual(new Set(['Ann away', 'Works shutdown']));
  });

  it('gives a line manager their roster even when they are not a member of the team', async () => {
    const manager = await insertPerson({ display_name: 'Mgr' });
    const managed = await makeTeam('Transport', { managerPersonId: manager });
    await addMember(managed, stranger);

    const asManager = await callerFor(manager, ['line_manager']);
    const { events } = await asManager.platform.calendar.feed(AUGUST);

    expect(events.map((e) => e.label)).toContain('Stranger away');
    expect(events.map((e) => e.label)).not.toContain('Alice away');
  });

  it('drops a teammate from view once their membership ends', async () => {
    await db
      .updateTable('platform.team_membership')
      .set({ valid_to: '2020-06-01' })
      .where('person_id', '=', bob)
      .execute();

    const aliceCaller = await callerFor(alice, ['employee']);
    const { events } = await aliceCaller.platform.calendar.feed(AUGUST);

    expect(events.map((e) => e.label)).not.toContain('Bob away');
  });
});

// --- Facets ------------------------------------------------------------------

describe('facets — every one of them applied in SQL', () => {
  let alice: string;
  let teamA: string;
  let teamB: string;
  let carol: string;

  beforeEach(async () => {
    registerCalendarSource({
      key: STUB_KEY,
      kinds: ['leave'],
      visibilityClass: 'normal',
      fragment: stubFragment(STUB_KEY, 'normal'),
    });

    alice = await insertPerson({ display_name: 'Alice' });
    carol = await insertPerson({ display_name: 'Carol' });
    teamA = await makeTeam('Alpha', { colour: '#aa0000' });
    teamB = await makeTeam('Bravo', { colour: '#00bb00' });
    await addMember(teamA, alice);
    await addMember(teamB, carol);

    await addStubItem(alice, '2026-08-03', '2026-08-07', 'Alice away');
    await addStubItem(carol, '2026-08-10', '2026-08-12', 'Carol away');
    await setPeriods(leaveBlackoutPeriods, [
      { from: '2026-08-20', to: '2026-08-21', label: 'Stocktake' },
    ]);
  });

  afterEach(() => unregisterCalendarSourceForTests(STUB_KEY));

  it('narrows to one team, and keeps org-wide rows visible while it does', async () => {
    const { events } = await caller().platform.calendar.feed({ ...AUGUST, teamIds: [teamA] });

    expect(new Set(events.map((e) => e.label))).toEqual(new Set(['Alice away', 'Stocktake']));
  });

  it('filters by kind', async () => {
    const { events } = await caller().platform.calendar.feed({ ...AUGUST, kinds: ['blackout'] });

    expect(events.map((e) => e.label)).toEqual(['Stocktake']);
  });

  it('filters by type ref', async () => {
    const { events } = await caller().platform.calendar.feed({ ...AUGUST, typeRefs: ['annual'] });

    expect(new Set(events.map((e) => e.label))).toEqual(new Set(['Alice away', 'Carol away']));
  });

  it('filters by status, and config-sourced items are always approved', async () => {
    const approved = await caller().platform.calendar.feed({ ...AUGUST, status: 'approved' });
    expect(approved.events).toHaveLength(3);

    const requested = await caller().platform.calendar.feed({ ...AUGUST, status: 'requested' });
    expect(requested.events).toHaveLength(0);
  });

  it('returns a total, deterministic order across sources', async () => {
    const first = await caller().platform.calendar.feed(AUGUST);
    const second = await caller().platform.calendar.feed(AUGUST);

    expect(first.events.map((e) => e.sourceRef)).toEqual(second.events.map((e) => e.sourceRef));
    const dates = first.events.map((e) => e.startsOn);
    expect([...dates].sort()).toEqual(dates);
  });

  it('reports every team a person was in during the window', async () => {
    await addMember(teamB, alice);
    const { events } = await caller().platform.calendar.feed(AUGUST);
    const aliceRow = events.find((e) => e.label === 'Alice away')!;

    expect(new Set(aliceRow.teamIds)).toEqual(new Set([teamA, teamB]));
  });
});

// --- Colour and legend (§6) --------------------------------------------------

describe('colour resolution — one expression for the bar and the legend', () => {
  let alice: string;
  let teamA: string;

  beforeEach(async () => {
    registerCalendarSource({
      key: STUB_KEY,
      kinds: ['leave'],
      visibilityClass: 'normal',
      fragment: stubFragment(STUB_KEY, 'normal'),
    });
    alice = await insertPerson({ display_name: 'Alice' });
    teamA = await makeTeam('Alpha', { colour: '#aa0000' });
    await addMember(teamA, alice);
    await addStubItem(alice, '2026-08-03', '2026-08-07', 'Alice away');
    await setPeriods(leaveBlackoutPeriods, [
      { from: '2026-08-20', to: '2026-08-21', label: 'Stocktake' },
    ]);
  });

  afterEach(() => unregisterCalendarSourceForTests(STUB_KEY));

  it('prefers the source’s own type colour in colour-by-type mode', async () => {
    const { events, legend } = await caller().platform.calendar.feed(AUGUST);

    expect(events.find((e) => e.label === 'Alice away')!.colour).toBe('#123456');
    expect(legend.find((l) => l.by === 'type')!.colour).toBe('#123456');
  });

  it('falls back to the kind colour when there is no type colour', async () => {
    const { events, legend } = await caller().platform.calendar.feed(AUGUST);
    const blackout = events.find((e) => e.label === 'Stocktake')!;

    expect(blackout.colour).toBe(calendarKindColours.defaultValue.blackout);
    expect(legend.some((l) => l.by === 'kind' && l.colour === blackout.colour)).toBe(true);
  });

  it('uses the team colour in colour-by-team mode, and falls back for org-wide rows', async () => {
    const { events, legend } = await caller().platform.calendar.feed({
      ...AUGUST,
      colourBy: 'team',
    });

    expect(events.find((e) => e.label === 'Alice away')!.colour).toBe('#aa0000');
    expect(legend.some((l) => l.by === 'team' && l.label === 'Alpha')).toBe(true);
    // A shut-down belongs to no team, so it keeps its kind colour.
    expect(events.find((e) => e.label === 'Stocktake')!.colour).toBe(
      calendarKindColours.defaultValue.blackout,
    );
  });

  it('re-colours the whole feed when the configuration changes, with no release', async () => {
    const before = await caller().platform.calendar.feed(AUGUST);
    expect(before.events.find((e) => e.label === 'Stocktake')!.colour).toBe(
      calendarKindColours.defaultValue.blackout,
    );

    await db.transaction().execute((trx) =>
      setConfig(trx, {
        def: calendarKindColours,
        value: { ...calendarKindColours.defaultValue, blackout: '#000fff' },
        actorPersonId: adminPersonId,
        correlationId: newUuidV7(),
      }),
    );

    const after = await caller().platform.calendar.feed(AUGUST);
    expect(after.events.find((e) => e.label === 'Stocktake')!.colour).toBe('#000fff');
    expect(after.legend.some((l) => l.colour === '#000fff')).toBe(true);

    // …and the change itself is audited (§6 "configuration changes are written
    // to the audit log").
    const audit = await db
      .selectFrom('platform.domain_event')
      .select(['event_type', 'kind'])
      .where('event_type', '=', 'platform.config_entry.changed')
      .execute();
    expect(audit.some((e) => e.kind === 'admin')).toBe(true);
  });
});

// --- Restricted sources (AC-D4, SA-023) --------------------------------------

describe('a restricted source cannot say what it is', () => {
  let alice: string;

  beforeEach(async () => {
    // A deliberately hostile fragment: it projects a real label, a type ref, a
    // type name and a type colour. All four must be discarded.
    registerCalendarSource({
      key: RESTRICTED_KEY,
      kinds: ['absence'],
      visibilityClass: 'restricted',
      restrictedLabel: 'Absence',
      fragment: stubFragment(RESTRICTED_KEY, 'restricted'),
    });
    alice = await insertPerson({ display_name: 'Alice' });
    await addStubItem(alice, '2026-08-03', '2026-08-07', 'Chemotherapy, ward 4');
  });

  afterEach(() => unregisterCalendarSourceForTests(RESTRICTED_KEY));

  it('renders the injected constant for every role, including HR', async () => {
    for (const role of ['administrator', 'hr_user', 'director', 'employee'] as const) {
      const person = role === 'employee' ? alice : await insertPerson({ display_name: role });
      const asRole = await callerFor(person, [role]);
      const { events } = await asRole.platform.calendar.feed(AUGUST);
      const row = events.find((e) => e.sourceKey === RESTRICTED_KEY);
      if (!row) continue;

      expect(row.label).toBe('Absence');
      expect(row.visibilityClass).toBe('restricted');
      // The hostile fragment's text is nowhere in the response at all.
      expect(JSON.stringify(events)).not.toContain('Chemotherapy');
    }
  });

  it('forces the type ref to the kind and takes the kind colour, never the type’s', async () => {
    const { events } = await caller().platform.calendar.feed(AUGUST);
    const row = events.find((e) => e.sourceKey === RESTRICTED_KEY)!;

    expect(row.typeRef).toBe('absence');
    expect(row.colour).toBe(calendarKindColours.defaultValue.absence);
    expect(row.colour).not.toBe('#123456');
  });

  it('refuses to register a restricted source with no constant label', () => {
    expect(() =>
      registerCalendarSource({
        key: 'platform.bad_restricted',
        kinds: ['absence'],
        visibilityClass: 'restricted',
        fragment: stubFragment('platform.bad_restricted', 'restricted'),
      }),
    ).toThrow(/restrictedLabel/);
  });
});

// --- Audience predicates (AC-D7, PL-023a) ------------------------------------

describe('an hr_event source with an audience predicate', () => {
  let subject: string;
  let manager: string;
  let teammate: string;

  beforeEach(async () => {
    subject = await insertPerson({ display_name: 'Subject' });
    manager = await insertPerson({ display_name: 'Manager' });
    teammate = await insertPerson({ display_name: 'Teammate' });

    const team = await makeTeam('Wellbeing test', { managerPersonId: manager });
    await addMember(team, subject);
    await addMember(team, teammate);

    // HR, the subject, and the subject's line manager — and nobody else. Note
    // this is *narrower* than the uniform team scoping in one direction (the
    // teammate is excluded) and wider in another (HR always sees it), which is
    // why it replaces that scoping rather than intersecting with it.
    registerCalendarSource({
      key: AUDIENCE_KEY,
      kinds: ['hr_event'],
      visibilityClass: 'restricted',
      restrictedLabel: 'HR event',
      fragment: stubFragment(AUDIENCE_KEY, 'restricted'),
      audience: (viewer) => {
        if (viewer.roleKeys.includes('hr_user') || viewer.roleKeys.includes('administrator')) {
          return sql`true`;
        }
        return sql`(
          ${SRC_PERSON_ID} = ${viewer.personId}
          OR ${SRC_PERSON_ID} IN (
            SELECT m.person_id FROM platform.team_membership m
            JOIN platform.team t ON t.id = m.team_id
            WHERE t.manager_person_id = ${viewer.personId} AND t.deleted_at IS NULL
          )
        )`;
      },
    });

    await addStubItem(subject, '2026-08-05', '2026-08-05', 'Occupational health review');
  });

  afterEach(() => unregisterCalendarSourceForTests(AUDIENCE_KEY));

  it('is visible to HR, the subject and the line manager', async () => {
    for (const [personId, role] of [
      [subject, 'employee'],
      [manager, 'line_manager'],
    ] as const) {
      const asPerson = await callerFor(personId, [role]);
      const { events } = await asPerson.platform.calendar.feed(AUGUST);
      expect(events.map((e) => e.sourceKey)).toContain(AUDIENCE_KEY);
    }

    const hr = await insertPerson({ display_name: 'HR' });
    const asHr = await callerFor(hr, ['hr_user']);
    const { events } = await asHr.platform.calendar.feed(AUGUST);
    expect(events.map((e) => e.sourceKey)).toContain(AUDIENCE_KEY);
  });

  it('is invisible to a teammate who would see ordinary team rows', async () => {
    const asTeammate = await callerFor(teammate, ['employee']);
    const { events } = await asTeammate.platform.calendar.feed(AUGUST);

    expect(events.map((e) => e.sourceKey)).not.toContain(AUDIENCE_KEY);
  });

  it('renders only the generic label and kind colour to those who can see it', async () => {
    const asSubject = await callerFor(subject, ['employee']);
    const { events } = await asSubject.platform.calendar.feed(AUGUST);
    const row = events.find((e) => e.sourceKey === AUDIENCE_KEY)!;

    expect(row.label).toBe('HR event');
    expect(row.typeRef).toBe('hr_event');
    expect(JSON.stringify(events)).not.toContain('Occupational health');
  });
});

// --- Sources listing ---------------------------------------------------------

describe('sources', () => {
  it('lists the platform source and the pilot, with their visibility classes', async () => {
    const sources = await caller().platform.calendar.sources();
    const keys = sources.map((s) => s.key);

    expect(keys).toContain('platform.config_period');
    expect(keys).toContain('platform.demo_item');
    expect(sources.find((s) => s.key === 'platform.demo_item')!.syncsToOutlook).toBe(true);
    expect(sources.find((s) => s.key === 'platform.config_period')!.syncsToOutlook).toBe(false);
  });
});
