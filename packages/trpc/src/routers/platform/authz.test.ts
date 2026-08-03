import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { db, newUuidV7, revokeAllGrantsForPerson, type NewPerson } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import { appRouter } from '../../router.js';
import type { ContextGrant, TRPCContext } from '../../trpc.js';
import type { ModuleKey, RoleKey } from '../../lib/constants.js';
import { scopeFor, scopePersons } from '../../lib/scope.js';
import { fieldsUpTo } from '../../lib/field-classification.js';
import {
  personClassification,
  personFlagClassification,
  personFlagOutputRestricted,
  personOutputRestricted,
} from '../../schemas.js';
import { personColumnVariants } from './identity.js';

/**
 * Authorisation integration tests (core plan 04 §10). Real Postgres throughout:
 * mock-DB tests cannot prove SQL scoping or keyset correctness (ADR-0004).
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

let actorPersonId: string;

beforeEach(async () => {
  await truncateAll(db);
  // truncateAll clears the seeded roles, so restore them for each test.
  await reseedRoles();
  actorPersonId = await insertPerson({ display_name: 'Acting Admin' });
});

const ROLE_IDS: Record<RoleKey, string> = {
  administrator: '019f509e-9d00-7000-8000-000000000000',
  hr_user: '019f509e-9d01-7000-8000-000000000001',
  line_manager: '019f509e-9d02-7000-8000-000000000002',
  finance: '019f509e-9d03-7000-8000-000000000003',
  it: '019f509e-9d04-7000-8000-000000000004',
  transport: '019f509e-9d05-7000-8000-000000000005',
  office_admin: '019f509e-9d06-7000-8000-000000000006',
  director: '019f509e-9d07-7000-8000-000000000007',
  employee: '019f509e-9d08-7000-8000-000000000008',
  external: '019f509e-9d09-7000-8000-000000000009',
  external_administrator: '019f509e-9d0a-7000-8000-00000000000a',
};

async function reseedRoles(): Promise<void> {
  const existing = await db.selectFrom('platform.role').select('id').executeTakeFirst();
  if (existing) return;
  await db
    .insertInto('platform.role')
    .values(
      (Object.entries(ROLE_IDS) as [RoleKey, string][]).map(([key, id]) => ({
        id,
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

/** Insert a grant row directly (bypassing the API) to set up a caller. */
async function insertGrant(input: {
  personId: string;
  roleKey: RoleKey;
  module: ModuleKey;
  validFrom?: Date;
  validUntil?: Date | null;
  revokedAt?: Date | null;
}): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.role_grant')
    .values({
      id,
      person_id: input.personId,
      role_id: ROLE_IDS[input.roleKey],
      module: input.module,
      valid_from: input.validFrom ?? new Date(Date.now() - 60_000),
      valid_until: input.validUntil ?? null,
      revoked_at: input.revokedAt ?? null,
      created_by: input.personId,
    })
    .execute();
  return id;
}

/** `YYYY-MM-DD` offset from today, matching the `date` columns' raw form. */
function isoDate(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
const today = () => isoDate(0);
const tomorrow = () => isoDate(1);

/**
 * Seed a team directly (core plan 05's tables), so plan 04's record-scoping
 * tests do not depend on plan 05's procedures to set up their fixture.
 */
async function insertTeam(input: { managerPersonId: string; name?: string }): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.team')
    .values({
      id,
      name: input.name ?? `Team ${id.slice(0, 8)}`,
      manager_person_id: input.managerPersonId,
      created_by: input.managerPersonId,
      updated_by: input.managerPersonId,
    })
    .execute();
  return id;
}

async function insertMembership(
  teamId: string,
  personId: string,
  window: { validFrom: string; validTo?: string },
): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.team_membership')
    .values({
      id,
      team_id: teamId,
      person_id: personId,
      valid_from: window.validFrom,
      valid_to: window.validTo ?? null,
      created_by: personId,
      updated_by: personId,
    })
    .execute();
  return id;
}

/** Load a person's live grants the way the API context factory does. */
async function contextGrants(personId: string): Promise<ContextGrant[]> {
  const rows = await db
    .selectFrom('platform.role_grant as g')
    .innerJoin('platform.role as r', 'r.id', 'g.role_id')
    .select(['r.key as roleKey', 'g.module', 'g.valid_from', 'g.valid_until', 'g.revoked_at'])
    .where('g.person_id', '=', personId)
    .where('g.revoked_at', 'is', null)
    .where('g.deleted_at', 'is', null)
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
    user: { id: 'u1', name: 'Caller', email: 'caller@cdf.test', role: 'agent' },
    session: { id: 'sess', userId: 'u1' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    email: { sendOtp: async () => {}, sendInvitation: async () => {} },
    sms: { send: async () => {} },
    rateLimit: { check: () => true },
    correlationId: newUuidV7(),
    actorPersonId,
    grants: [],
    ...overrides,
  };
}

/** A caller holding exactly the grants currently in the database. */
async function callerFor(personId: string) {
  return appRouter.createCaller(
    makeCtx({ actorPersonId: personId, grants: await contextGrants(personId) }),
  );
}

/**
 * Events on one stream. Scoped by `stream_id` on purpose: `platform.domain_event`
 * is append-only, so `truncateAll` deliberately leaves it alone (ADR-0011) and a
 * global count would leak across tests in this file.
 */
async function eventsForStream(streamId: string, eventType: string) {
  return db
    .selectFrom('platform.domain_event')
    .selectAll()
    .where('stream_id', '=', streamId)
    .where('event_type', '=', eventType)
    .execute();
}

/** Events whose payload names this person as the subject. */
async function eventsAboutPerson(personId: string, eventType: string) {
  return db
    .selectFrom('platform.domain_event')
    .selectAll()
    .where('event_type', '=', eventType)
    .where(sql<boolean>`payload->>'personId' = ${personId}`)
    .execute();
}

// ---------------------------------------------------------------------------

describe('procedure-level enforcement (PL-002, AC-D2)', () => {
  it('rejects a caller holding only the employee role, admits an administrator', async () => {
    const employee = await insertPerson({ display_name: 'Ordinary Employee' });
    await insertGrant({ personId: employee, roleKey: 'employee', module: 'platform' });
    const target = await insertPerson();

    await expect(
      (await callerFor(employee)).platform.authz.grants.grant({
        personId: target,
        roleKey: 'employee',
        module: 'platform',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await insertGrant({ personId: actorPersonId, roleKey: 'administrator', module: 'platform' });
    const result = await (
      await callerFor(actorPersonId)
    ).platform.authz.grants.grant({
      personId: target,
      roleKey: 'employee',
      module: 'platform',
    });
    expect(result.grantId).toBeTruthy();
  });

  it('rejects an authenticated caller with no person record', async () => {
    const caller = appRouter.createCaller(makeCtx({ actorPersonId: null, grants: [] }));
    await expect(caller.platform.authz.roles.list()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('holding a login grants nothing on its own (§4.1)', async () => {
    const newcomer = await insertPerson({ display_name: 'Just Invited' });
    await expect((await callerFor(newcomer)).platform.authz.roles.list()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('module scoping (PL-002, Q5)', () => {
  it('a grant in one HR module does not satisfy a check for another', async () => {
    // administrator in hr.holiday_leave — but authz admin requires 'platform'.
    await insertGrant({
      personId: actorPersonId,
      roleKey: 'administrator',
      module: 'hr.holiday_leave',
    });
    await expect(
      (await callerFor(actorPersonId)).platform.authz.roles.list(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('the same role in the right module succeeds', async () => {
    await insertGrant({ personId: actorPersonId, roleKey: 'administrator', module: 'platform' });
    const roles = await (await callerFor(actorPersonId)).platform.authz.roles.list();
    expect(roles).toHaveLength(11);
  });
});

describe('time-boxed grants are honoured per call (PL-042 substrate, AC-D3)', () => {
  it('a grant whose valid_until has passed no longer authorises', async () => {
    await insertGrant({
      personId: actorPersonId,
      roleKey: 'administrator',
      module: 'platform',
      validFrom: new Date(Date.now() - 120_000),
      validUntil: new Date(Date.now() - 60_000),
    });
    await expect(
      (await callerFor(actorPersonId)).platform.authz.roles.list(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a grant whose valid_from is in the future does not yet authorise', async () => {
    await insertGrant({
      personId: actorPersonId,
      roleKey: 'administrator',
      module: 'platform',
      validFrom: new Date(Date.now() + 3_600_000),
    });
    await expect(
      (await callerFor(actorPersonId)).platform.authz.roles.list(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('grants.list — keyset paging and SQL facets (ADR-0004)', () => {
  beforeEach(async () => {
    await insertGrant({ personId: actorPersonId, roleKey: 'administrator', module: 'platform' });
  });

  it('pages the whole set in global order with no duplicates or gaps', async () => {
    const created: string[] = [];
    for (let i = 0; i < 7; i++) {
      const person = await insertPerson({ display_name: `P${i}` });
      const id = newUuidV7();
      await db
        .insertInto('platform.role_grant')
        .values({
          id,
          person_id: person,
          role_id: ROLE_IDS.employee,
          module: 'platform',
          created_by: actorPersonId,
          // Distinct created_at so the sort key is a strict total order.
          created_at: new Date(Date.UTC(2026, 0, i + 1)),
        })
        .execute();
      created.push(id);
    }

    const caller = await callerFor(actorPersonId);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await caller.platform.authz.grants.list({
        limit: 2,
        cursor,
        sortDir: 'asc',
      });
      seen.push(...page.items.map((g) => g.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    // The acting admin's own grant sorts last (created now); drop it and compare.
    const withoutActor = seen.filter((id) => created.includes(id));
    expect(withoutActor).toEqual(created);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(seen).toHaveLength(created.length + 1); // no gaps
  });

  it('derives the state facet in SQL, matching the domain engine', async () => {
    const p = await insertPerson();
    await insertGrant({
      personId: p,
      roleKey: 'employee',
      module: 'platform',
      validFrom: new Date(Date.now() + 3_600_000),
    });
    await insertGrant({
      personId: p,
      roleKey: 'finance',
      module: 'platform',
      validFrom: new Date(Date.now() - 120_000),
      validUntil: new Date(Date.now() - 60_000),
    });
    await insertGrant({
      personId: p,
      roleKey: 'it',
      module: 'platform',
      revokedAt: new Date(),
    });

    const caller = await callerFor(actorPersonId);
    const pending = await caller.platform.authz.grants.list({ personId: p, state: 'pending' });
    expect(pending.items.map((g) => g.roleKey)).toEqual(['employee']);

    const expired = await caller.platform.authz.grants.list({ personId: p, state: 'expired' });
    expect(expired.items.map((g) => g.roleKey)).toEqual(['finance']);

    const revoked = await caller.platform.authz.grants.list({ personId: p, state: 'revoked' });
    expect(revoked.items.map((g) => g.roleKey)).toEqual(['it']);

    const active = await caller.platform.authz.grants.list({ personId: p, state: 'active' });
    expect(active.items).toHaveLength(0);
  });

  it('filters by role, module and person search in SQL', async () => {
    const alice = await insertPerson({ display_name: 'Alice Zephyr' });
    const bob = await insertPerson({ display_name: 'Bob Ordinary' });
    await insertGrant({ personId: alice, roleKey: 'hr_user', module: 'hr.core' });
    await insertGrant({ personId: bob, roleKey: 'finance', module: 'platform' });

    const caller = await callerFor(actorPersonId);
    expect(
      (await caller.platform.authz.grants.list({ roleKey: 'hr_user' })).items.map(
        (g) => g.personDisplayName,
      ),
    ).toEqual(['Alice Zephyr']);
    expect(
      (await caller.platform.authz.grants.list({ module: 'hr.core' })).items.map((g) => g.module),
    ).toEqual(['hr.core']);
    expect(
      (await caller.platform.authz.grants.list({ search: 'zephyr' })).items.map(
        (g) => g.personDisplayName,
      ),
    ).toEqual(['Alice Zephyr']);
  });
});

describe('grant / revoke journalling (AC-D6, ADR-0010)', () => {
  beforeEach(async () => {
    await insertGrant({ personId: actorPersonId, roleKey: 'administrator', module: 'platform' });
  });

  it('grant then revoke emits both events, and the row matches the trail', async () => {
    const caller = await callerFor(actorPersonId);
    const subject = await insertPerson();

    const { grantId } = await caller.platform.authz.grants.grant({
      personId: subject,
      roleKey: 'hr_user',
      module: 'hr.core',
    });

    const granted = await eventsForStream(grantId, 'platform.role.granted');
    expect(granted).toHaveLength(1);
    expect(granted[0]?.stream_type).toBe('platform.role_grant');
    expect(granted[0]?.kind).toBe('security');
    expect(granted[0]?.actor_person_id).toBe(actorPersonId);
    expect(granted[0]?.payload).toMatchObject({
      personId: subject,
      roleKey: 'hr_user',
      module: 'hr.core',
    });

    await caller.platform.authz.grants.revoke({ grantId, reason: 'left the project' });

    const revoked = await eventsForStream(grantId, 'platform.role.revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.payload).toMatchObject({
      personId: subject,
      roleKey: 'hr_user',
      module: 'hr.core',
      revokeReason: 'left the project',
    });

    const row = await db
      .selectFrom('platform.role_grant')
      .selectAll()
      .where('id', '=', grantId)
      .executeTakeFirstOrThrow();
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_by).toBe(actorPersonId);
    expect(row.revoke_reason).toBe('left the project');
  });

  it('payloads carry no name or email (ADR-0019)', async () => {
    const caller = await callerFor(actorPersonId);
    const subject = await insertPerson({
      display_name: 'Sensitive Name',
      contact_email: 'someone@example.test',
    });
    const { grantId } = await caller.platform.authz.grants.grant({
      personId: subject,
      roleKey: 'employee',
      module: 'platform',
    });
    const serialised = JSON.stringify(
      (await eventsForStream(grantId, 'platform.role.granted'))[0]?.payload,
    );
    expect(serialised).not.toContain('Sensitive Name');
    expect(serialised).not.toContain('someone@example.test');
  });

  it('revoking is idempotent — a second revoke does not double-journal', async () => {
    const caller = await callerFor(actorPersonId);
    const subject = await insertPerson();
    const { grantId } = await caller.platform.authz.grants.grant({
      personId: subject,
      roleKey: 'employee',
      module: 'platform',
    });
    await caller.platform.authz.grants.revoke({ grantId, reason: 'first' });
    await expect(
      caller.platform.authz.grants.revoke({ grantId, reason: 'second' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await eventsForStream(grantId, 'platform.role.revoked')).toHaveLength(1);
  });

  it('refuses a duplicate live grant for the same person/role/module', async () => {
    const caller = await callerFor(actorPersonId);
    const subject = await insertPerson();
    await caller.platform.authz.grants.grant({
      personId: subject,
      roleKey: 'employee',
      module: 'platform',
    });
    await expect(
      caller.platform.authz.grants.grant({
        personId: subject,
        roleKey: 'employee',
        module: 'platform',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a re-grant after revocation is a NEW row — history is never rewritten', async () => {
    const caller = await callerFor(actorPersonId);
    const subject = await insertPerson();
    const first = await caller.platform.authz.grants.grant({
      personId: subject,
      roleKey: 'employee',
      module: 'platform',
    });
    await caller.platform.authz.grants.revoke({ grantId: first.grantId, reason: 'paused' });
    const second = await caller.platform.authz.grants.grant({
      personId: subject,
      roleKey: 'employee',
      module: 'platform',
    });
    expect(second.grantId).not.toBe(first.grantId);
    const rows = await db
      .selectFrom('platform.role_grant')
      .selectAll()
      .where('person_id', '=', subject)
      .execute();
    expect(rows).toHaveLength(2);
  });
});

describe('revokeAllGrantsForPerson — the expiry-sweep write path (PL-042)', () => {
  it('revokes every live grant with a system actor and journals each one', async () => {
    const subject = await insertPerson();
    await insertGrant({ personId: subject, roleKey: 'external', module: 'platform' });
    await insertGrant({ personId: subject, roleKey: 'employee', module: 'hr.core' });
    // An already-revoked grant must not be touched twice.
    await insertGrant({
      personId: subject,
      roleKey: 'finance',
      module: 'platform',
      revokedAt: new Date(),
    });

    const revoked = await db.transaction().execute((trx) =>
      revokeAllGrantsForPerson(trx, {
        personId: subject,
        actorPersonId: null,
        reason: 'expired',
        correlationId: newUuidV7(),
      }),
    );

    expect(revoked).toHaveLength(2);
    expect(await eventsAboutPerson(subject, 'platform.role.revoked')).toHaveLength(2);

    const rows = await db
      .selectFrom('platform.role_grant')
      .selectAll()
      .where('person_id', '=', subject)
      .where('revoked_at', 'is', null)
      .execute();
    expect(rows).toHaveLength(0);

    // System revocation records a NULL actor, never the subject themselves.
    const sweepRevoked = await db
      .selectFrom('platform.role_grant')
      .select(['revoked_by', 'revoke_reason'])
      .where('person_id', '=', subject)
      .where('revoke_reason', '=', 'expired')
      .execute();
    expect(sweepRevoked).toHaveLength(2);
    expect(sweepRevoked.every((r) => r.revoked_by === null)).toBe(true);
  });
});

describe('allocated scoping (CORE-05, AC-D7)', () => {
  it('an external administrator reaches exactly their live allocations', async () => {
    const extAdmin = await insertPerson({ display_name: 'External Admin' });
    await insertGrant({
      personId: extAdmin,
      roleKey: 'external_administrator',
      module: 'platform',
    });

    const people: string[] = [];
    for (let i = 0; i < 10; i++) people.push(await insertPerson({ display_name: `Worker ${i}` }));

    await insertGrant({ personId: actorPersonId, roleKey: 'administrator', module: 'platform' });
    const admin = await callerFor(actorPersonId);
    const a0 = await admin.platform.authz.allocations.add({
      adminPersonId: extAdmin,
      personId: people[0]!,
    });
    await admin.platform.authz.allocations.add({
      adminPersonId: extAdmin,
      personId: people[1]!,
    });

    const grants = await contextGrants(extAdmin);
    expect(scopeFor(grants, 'platform', new Date())).toBe('allocated');

    // Page the whole person set through the scoping predicate, in SQL.
    const visible = await db
      .selectFrom('platform.person as p')
      .select('p.id')
      .where(scopePersons('p.id', extAdmin, 'allocated'))
      .orderBy('p.id')
      .execute();
    expect(visible.map((r) => r.id).sort()).toEqual([people[0]!, people[1]!].sort());

    // Ending an allocation closes visibility without deleting the row.
    await admin.platform.authz.allocations.end({
      allocationId: a0.allocationId,
      reason: 'engagement finished',
    });
    const afterEnd = await db
      .selectFrom('platform.person as p')
      .select('p.id')
      .where(scopePersons('p.id', extAdmin, 'allocated'))
      .execute();
    expect(afterEnd.map((r) => r.id)).toEqual([people[1]!]);

    const stillThere = await db
      .selectFrom('platform.person_allocation')
      .selectAll()
      .where('id', '=', a0.allocationId)
      .executeTakeFirstOrThrow();
    expect(stillThere.ended_at).not.toBeNull();
    expect(stillThere.end_reason).toBe('engagement finished');

    expect(await eventsForStream(a0.allocationId, 'platform.person.allocation_added')).toHaveLength(
      1,
    );
    expect(await eventsForStream(a0.allocationId, 'platform.person.allocation_ended')).toHaveLength(
      1,
    );
  });

  it('an out-of-window allocation confers no visibility', async () => {
    const extAdmin = await insertPerson();
    const subject = await insertPerson();
    await db
      .insertInto('platform.person_allocation')
      .values({
        id: newUuidV7(),
        admin_person_id: extAdmin,
        person_id: subject,
        valid_from: new Date(Date.now() - 120_000),
        valid_until: new Date(Date.now() - 60_000),
        created_by: extAdmin,
      })
      .execute();

    const visible = await db
      .selectFrom('platform.person as p')
      .select('p.id')
      .where(scopePersons('p.id', extAdmin, 'allocated'))
      .execute();
    expect(visible).toHaveLength(0);
  });

  it('refuses to allocate to someone who does not hold the role', async () => {
    await insertGrant({ personId: actorPersonId, roleKey: 'administrator', module: 'platform' });
    const notAnAdmin = await insertPerson();
    const subject = await insertPerson();
    await expect(
      (await callerFor(actorPersonId)).platform.authz.allocations.add({
        adminPersonId: notAnAdmin,
        personId: subject,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('external administrator is structurally excluded from privileged actions (CORE-05)', () => {
  it('never satisfies an administrator- or hr_user-guarded builder', async () => {
    const extAdmin = await insertPerson();
    await insertGrant({
      personId: extAdmin,
      roleKey: 'external_administrator',
      module: 'platform',
    });
    const caller = await callerFor(extAdmin);

    // roles.list is administrator-only; allocations.* is administrator|hr_user.
    await expect(caller.platform.authz.roles.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.platform.authz.allocations.list({ liveOnly: true, limit: 25, sortDir: 'desc' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Plan 17's approve/readiness procedures use the same builders, so the
    // exclusion holds for them by construction when they land.
  });
});

describe('record scoping ladder (scopeFor / scopePersons)', () => {
  it('maps roles to the documented scopes', async () => {
    const at = new Date();
    const g = (roleKey: RoleKey, module: ModuleKey = 'platform'): ContextGrant => ({
      roleKey,
      module,
      validFrom: new Date(Date.now() - 1000),
      validUntil: null,
      revokedAt: null,
    });
    expect(scopeFor([g('administrator')], 'platform', at)).toBe('all');
    expect(scopeFor([g('hr_user')], 'platform', at)).toBe('all');
    expect(scopeFor([g('director')], 'platform', at)).toBe('all'); // Q3
    expect(scopeFor([g('line_manager')], 'platform', at)).toBe('team');
    expect(scopeFor([g('external_administrator')], 'platform', at)).toBe('allocated');
    expect(scopeFor([g('employee')], 'platform', at)).toBe('self');
    expect(scopeFor([g('external')], 'platform', at)).toBe('self');
    // Operational roles default to self (§12.2 Q6).
    expect(scopeFor([g('finance')], 'platform', at)).toBe('self');
    // Widest wins across several roles.
    expect(scopeFor([g('employee'), g('hr_user')], 'platform', at)).toBe('all');
    // A grant in another module confers nothing here.
    expect(scopeFor([g('hr_user', 'hr.core')], 'platform', at)).toBe('self');
  });

  it("'self' scope restricts to the viewer's own row, in SQL", async () => {
    const me = await insertPerson();
    await insertPerson();
    const rows = await db
      .selectFrom('platform.person as p')
      .select('p.id')
      .where(scopePersons('p.id', me, 'self'))
      .execute();
    expect(rows.map((r) => r.id)).toEqual([me]);
  });

  it("'team' scope resolves through effective-dated membership (core plan 05)", async () => {
    // This helper shipped fail-closed through plan 04 and went live when plan 05
    // landed platform.team/team_membership. The cases below are exactly the ones
    // a naive `JOIN team_membership` would get wrong.
    const manager = await insertPerson({ display_name: 'Manager' });
    const current = await insertPerson({ display_name: 'Current member' });
    const departed = await insertPerson({ display_name: 'Left yesterday' });
    const future = await insertPerson({ display_name: 'Joins tomorrow' });
    const stranger = await insertPerson({ display_name: 'Another team entirely' });

    const teamId = await insertTeam({ managerPersonId: manager });
    await insertMembership(teamId, current, { validFrom: '2026-01-01' });
    // Half-open [from, to): valid_to = today means they are ALREADY out today.
    await insertMembership(teamId, departed, { validFrom: '2026-01-01', validTo: today() });
    await insertMembership(teamId, future, { validFrom: tomorrow() });

    const otherTeam = await insertTeam({ managerPersonId: stranger, name: 'Other' });
    await insertMembership(otherTeam, stranger, { validFrom: '2026-01-01' });

    const visible = async (viewer: string) =>
      (
        await db
          .selectFrom('platform.person as p')
          .select('p.id')
          .where(scopePersons('p.id', viewer, 'team'))
          .execute()
      ).map((r) => r.id);

    expect(await visible(manager)).toEqual([current]);

    // A deputy covers for the manager, so a deputy who cannot see the team is
    // not cover (core plan 04 §12.2 Q2's residual half).
    const deputy = await insertPerson({ display_name: 'Deputy' });
    await db
      .updateTable('platform.team')
      .set({ deputy_person_id: deputy })
      .where('id', '=', teamId)
      .execute();
    expect(await visible(deputy)).toEqual([current]);

    // Archiving retires the configuration, and with it the access it conferred.
    await db
      .updateTable('platform.team')
      .set({ deleted_at: new Date() })
      .where('id', '=', teamId)
      .execute();
    expect(await visible(manager)).toEqual([]);
  });

  it("'all' scope does not restrict", async () => {
    await insertPerson();
    await insertPerson();
    const rows = await db
      .selectFrom('platform.person as p')
      .select('p.id')
      .where(scopePersons('p.id', actorPersonId, 'all'))
      .execute();
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the converted identity surface (§9.5 reference conversion)', () => {
  /** Grant a role and return the caller bound to the resulting grants. */
  async function readerWith(roleKey: RoleKey, personId: string) {
    await insertGrant({ personId, roleKey, module: 'platform' });
    return callerFor(personId);
  }

  it('AC-D5/ON AC-10 — a restricted reader never receives sensitive fields', async () => {
    await insertPerson({
      display_name: 'Subject',
      contact_email: 'subject@example.test',
      date_of_birth: '1985-03-04',
    });

    const director = await insertPerson({ display_name: 'A Director' });
    const page = await (
      await readerWith('director', director)
    ).platform.identity.listPersons({ limit: 50 });

    expect(page.items.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(page.items);
    // Not merely absent from the payload — never selected in SQL.
    expect(serialised).not.toContain('subject@example.test');
    expect(serialised).not.toContain('1985-03-04');
    for (const item of page.items) {
      expect(item).not.toHaveProperty('contact_email');
      expect(item).not.toHaveProperty('date_of_birth');
    }
  });

  it('an HR User does receive the sensitive fields', async () => {
    await insertPerson({ display_name: 'Subject', contact_email: 'subject@example.test' });
    const hr = await insertPerson({ display_name: 'HR' });
    const page = await (
      await readerWith('hr_user', hr)
    ).platform.identity.listPersons({
      limit: 50,
    });
    expect(JSON.stringify(page.items)).toContain('subject@example.test');
  });

  it('AC-D7 — an external administrator lists only their allocated people', async () => {
    const extAdmin = await insertPerson({ display_name: 'Ext Admin' });
    await insertGrant({
      personId: extAdmin,
      roleKey: 'external_administrator',
      module: 'platform',
    });
    const allocated = await insertPerson({ display_name: 'Allocated Worker' });
    const other = await insertPerson({ display_name: 'Unrelated Worker' });

    await insertGrant({ personId: actorPersonId, roleKey: 'administrator', module: 'platform' });
    await (
      await callerFor(actorPersonId)
    ).platform.authz.allocations.add({ adminPersonId: extAdmin, personId: allocated });

    const caller = await callerFor(extAdmin);
    const page = await caller.platform.identity.listPersons({ limit: 50 });
    expect(page.items.map((p) => p.id)).toEqual([allocated]);

    // Detail of a non-allocated person is NOT_FOUND, not FORBIDDEN — a
    // "forbidden" would confirm the record exists.
    await expect(caller.platform.identity.getPerson({ personId: other })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const detail = await caller.platform.identity.getPerson({ personId: allocated });
    expect(detail.person.id).toBe(allocated);
  });

  it('a line manager sees their current team through listPersons, and nobody else', async () => {
    const outsider = await insertPerson({ display_name: 'Somebody else' });
    const manager = await insertPerson({ display_name: 'Manager' });
    const member = await insertPerson({ display_name: 'Team member' });
    const teamId = await insertTeam({ managerPersonId: manager });
    await insertMembership(teamId, member, { validFrom: '2026-01-01' });

    const page = await (
      await readerWith('line_manager', manager)
    ).platform.identity.listPersons({ limit: 50 });
    // Note the manager is not in their own team's roster, so they do not appear
    // either — `team` scope is about who you manage, not who you are.
    expect(page.items.map((p) => p.id)).toEqual([member]);
    expect(page.items.map((p) => p.id)).not.toContain(outsider);
  });

  it('special-category flag detail is withheld from a restricted reader, and journalled for an authorised one', async () => {
    const subject = await insertPerson({ display_name: 'Flagged' });
    await insertGrant({ personId: actorPersonId, roleKey: 'administrator', module: 'platform' });
    const admin = await callerFor(actorPersonId);
    await admin.platform.identity.addFlag({
      personId: subject,
      flagType: 'safeguarding',
      reason: 'a rationale that must not leak',
    });

    // Authorised: sees the detail, and the read is journalled exactly once.
    const full = await admin.platform.identity.getPerson({ personId: subject });
    expect(full.flags[0]).toHaveProperty('flag_type', 'safeguarding');
    const reads = await eventsForStream(subject, 'platform.data.special_category.accessed');
    expect(reads).toHaveLength(1);
    expect(reads[0]?.kind).toBe('security');
    expect(reads[0]?.payload).toMatchObject({
      entity: 'platform.person_flag',
      fields: ['end_reason', 'flag_type', 'reason'],
      readerPersonId: actorPersonId,
    });
    // Field NAMES only — the rationale itself is never in the payload.
    expect(JSON.stringify(reads[0]?.payload)).not.toContain('must not leak');

    // Restricted: a director gets no flags at all — the existence of a
    // safeguarding flag is itself special-category — and emits no read event.
    const director = await insertPerson({ display_name: 'Director' });
    const restricted = await (
      await readerWith('director', director)
    ).platform.identity.getPerson({ personId: subject });
    expect(restricted.flags).toHaveLength(0);
    expect(JSON.stringify(restricted.flags)).not.toContain('must not leak');
    expect(await eventsForStream(subject, 'platform.data.special_category.accessed')).toHaveLength(
      1,
    );
  });
});

describe('field classification (PL-003, PL-043, ON AC-10)', () => {
  it('the column variants match the classification map (drift guard)', () => {
    const strip = (cols: readonly string[]) => cols.map((c) => c.replace(/^p\./, '')).sort();
    expect(strip(personColumnVariants.restricted)).toEqual(
      fieldsUpTo(personClassification, 'internal').sort(),
    );
    expect(strip(personColumnVariants.full)).toEqual(
      fieldsUpTo(personClassification, 'sensitive').sort(),
    );
    expect(strip(personColumnVariants.flagFull)).toEqual(
      fieldsUpTo(personFlagClassification, 'special-category').sort(),
    );
  });

  it('the restricted person variant drops sensitive fields', () => {
    const shape = Object.keys(personOutputRestricted.shape);
    expect(shape).toContain('display_name');
    expect(shape).toContain('relationship_type');
    expect(shape).not.toContain('contact_email');
    expect(shape).not.toContain('date_of_birth');
  });

  it('the restricted flag variant drops the special-category detail', () => {
    // ON AC-10 pattern: the existence and provenance of a safeguarding flag
    // survive; its type and rationale do not.
    const shape = Object.keys(personFlagOutputRestricted.shape);
    expect(shape).toContain('person_id');
    expect(shape).toContain('raised_at');
    expect(shape).not.toContain('flag_type');
    expect(shape).not.toContain('reason');
    expect(shape).not.toContain('end_reason');
  });

  it('a restricted payload parsed through the schema strips sensitive values', () => {
    const parsed = personOutputRestricted.parse({
      id: newUuidV7(),
      relationship_type: 'agency',
      profile_status: 'active',
      status: 'active',
      display_name: 'Someone',
      given_name: 'Some',
      family_name: 'One',
      contact_email: 'leak@example.test',
      date_of_birth: '1990-01-01',
      agency_worker_reference: null,
      access_valid_until: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(JSON.stringify(parsed)).not.toContain('leak@example.test');
    expect(JSON.stringify(parsed)).not.toContain('1990-01-01');
  });
});
