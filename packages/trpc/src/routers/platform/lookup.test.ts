import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, newUuidV7, type NewPerson } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import { appRouter } from '../../router.js';
import type { ContextGrant, TRPCContext } from '../../trpc.js';
import { ROLE_KEYS, type LookupListType, type RoleKey } from '../../lib/constants.js';

/**
 * Tier 1 reference data (core plan 05 §10, PL-005/005b/006/007).
 *
 * Real Postgres throughout: the keyset boundary, the `(list_type, code)`
 * uniqueness that spans soft-deleted rows, and the same-transaction journal
 * append are all SQL behaviours a mock would assert nothing about (ADR-0004).
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

async function insertPerson(overrides: Partial<NewPerson> = {}): Promise<string> {
  const id = overrides.id ?? newUuidV7();
  await db
    .insertInto('platform.person')
    .values({ id, relationship_type: 'agency', display_name: 'Person', ...overrides })
    .execute();
  return id;
}

/** Grant each role in the platform module and return the context grant list. */
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
    ...overrides,
  };
}

const caller = () => appRouter.createCaller(makeCtx());

/** A caller holding exactly `roleKeys` in the platform module. */
async function callerWith(roleKeys: RoleKey[]) {
  const personId = await insertPerson({ display_name: roleKeys.join('+') });
  const grants = await grantsFor(personId, roleKeys);
  return appRouter.createCaller(makeCtx({ actorPersonId: personId, grants }));
}

async function seedValue(
  listType: LookupListType,
  code: string,
  overrides: { label?: string; sortOrder?: number; active?: boolean } = {},
): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.lookup')
    .values({
      id,
      list_type: listType,
      code,
      label: overrides.label ?? code,
      sort_order: overrides.sortOrder ?? 0,
      active: overrides.active ?? true,
      created_by: adminPersonId,
      updated_by: adminPersonId,
    })
    .execute();
  return id;
}

async function eventsFor(streamId: string, eventType?: string) {
  let q = db.selectFrom('platform.domain_event').selectAll().where('stream_id', '=', streamId);
  if (eventType) q = q.where('event_type', '=', eventType);
  return q.orderBy('recorded_at').execute();
}

describe('adminList (keyset, SQL facets — ADR-0004)', () => {
  it('pages the whole set in global order with no duplicates and no gaps', async () => {
    // 60+ values across list types, per §10. Labels are deliberately not
    // insertion-ordered so a broken sort key cannot pass by accident.
    const expectedByLabel: string[] = [];
    for (let i = 0; i < 65; i++) {
      const code = `code_${String(i).padStart(3, '0')}`;
      await seedValue(i % 2 === 0 ? 'department' : 'job_role', code, {
        label: `L${String((i * 37) % 65).padStart(3, '0')}`,
        sortOrder: i,
      });
      expectedByLabel.push(`L${String((i * 37) % 65).padStart(3, '0')}`);
    }
    expectedByLabel.sort();

    const seen: string[] = [];
    const ids = new Set<string>();
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await caller().platform.lookup.adminList({
        limit: 7,
        cursor,
        sort: 'label',
        sortDir: 'asc',
      });
      for (const row of page.items) {
        seen.push(row.label);
        ids.add(row.id);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toEqual(expectedByLabel); // correct global order
    expect(ids.size).toBe(65); // no duplicates
    expect(seen).toHaveLength(65); // no gaps
  });

  it('pages correctly on the numeric sort_order key, which is not lexical', async () => {
    // The trap: '10' < '2' as text. The sort key is zero-padded for exactly
    // this reason, and only a multi-page walk over a double-digit set catches
    // it.
    for (let i = 0; i < 12; i++) {
      await seedValue('ppe_type', `p${i}`, { sortOrder: i });
    }
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await caller().platform.lookup.adminList({
        limit: 5,
        cursor,
        listType: 'ppe_type',
        sort: 'sort_order',
        sortDir: 'asc',
      });
      seen.push(...page.items.map((r) => r.sort_order));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('applies listType, active and search facets in SQL', async () => {
    await seedValue('department', 'ops', { label: 'Operations' });
    await seedValue('department', 'admin_office', { label: 'Back office', active: false });
    await seedValue('job_role', 'ops_lead', { label: 'Operations lead' });

    const byList = await caller().platform.lookup.adminList({ listType: 'department' });
    expect(byList.items.map((r) => r.code).sort()).toEqual(['admin_office', 'ops']);

    const activeOnly = await caller().platform.lookup.adminList({
      listType: 'department',
      active: true,
    });
    expect(activeOnly.items.map((r) => r.code)).toEqual(['ops']);

    // Search spans label AND code — an admin looking for a value knows one or
    // the other, rarely both.
    const byLabel = await caller().platform.lookup.adminList({ search: 'operations' });
    expect(byLabel.items.map((r) => r.code).sort()).toEqual(['ops', 'ops_lead']);
    const byCode = await caller().platform.lookup.adminList({ search: 'admin_off' });
    expect(byCode.items.map((r) => r.code)).toEqual(['admin_office']);
  });

  it('never returns a soft-deleted value', async () => {
    const id = await seedValue('department', 'mistake');
    await caller().platform.lookup.remove({ id, confirmNeverUsed: true });
    const page = await caller().platform.lookup.adminList({ listType: 'department' });
    expect(page.items).toHaveLength(0);
  });
});

describe('create (PL-005b — AC-D1: data entry, no release)', () => {
  it('adds a value that is immediately selectable in options', async () => {
    const { id } = await caller().platform.lookup.create({
      listType: 'sickness_type',
      code: 'migraine',
      label: 'Migraine',
    });

    // The AC-D1 claim in full: another signed-in user, with no redeployment,
    // sees the new value in the consuming dropdown.
    const employee = await callerWith(['employee']);
    const options = await employee.platform.lookup.options({ listType: 'sickness_type' });
    expect(options.map((o) => o.id)).toContain(id);
    expect(options.find((o) => o.id === id)?.label).toBe('Migraine');
  });

  it('appends a value to the end of its list rather than the top', async () => {
    await seedValue('department', 'first', { sortOrder: 0 });
    await seedValue('department', 'second', { sortOrder: 1 });
    await caller().platform.lookup.create({
      listType: 'department',
      code: 'third',
      label: 'Third',
    });
    const options = await caller().platform.lookup.options({ listType: 'department' });
    expect(options.map((o) => o.code)).toEqual(['first', 'second', 'third']);
  });

  it('rejects a duplicate code in the same list, including against a soft-deleted row', async () => {
    await caller().platform.lookup.create({
      listType: 'department',
      code: 'ops',
      label: 'Operations',
    });
    await expect(
      caller().platform.lookup.create({ listType: 'department', code: 'ops', label: 'Other' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // Uniqueness spans soft-deleted rows on purpose: a deleted code must not
    // come back meaning something else.
    const deleted = await caller().platform.lookup.create({
      listType: 'department',
      code: 'gone',
      label: 'Gone',
    });
    await caller().platform.lookup.remove({ id: deleted.id, confirmNeverUsed: true });
    await expect(
      caller().platform.lookup.create({ listType: 'department', code: 'gone', label: 'Back' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('allows the same code in a different list', async () => {
    await caller().platform.lookup.create({ listType: 'ppe_type', code: 'other', label: 'Other' });
    await expect(
      caller().platform.lookup.create({
        listType: 'sickness_type',
        code: 'other',
        label: 'Other',
      }),
    ).resolves.toBeTruthy();
  });

  it('rejects a malformed code at the schema boundary', async () => {
    for (const code of ['Ops', 'ops-lead', 'ops lead', '_ops', '']) {
      await expect(
        caller().platform.lookup.create({ listType: 'department', code, label: 'x' }),
      ).rejects.toThrow();
    }
  });

  it('writes exactly one kind=admin event, atomically with the row', async () => {
    const { id } = await caller().platform.lookup.create({
      listType: 'leaver_reason',
      code: 'resignation',
      label: 'Resignation',
    });

    const events = await eventsFor(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'admin',
      stream_type: 'platform.lookup',
      event_type: 'platform.lookup.value.created',
      actor_person_id: adminPersonId,
    });
    expect(events[0].payload).toEqual({
      listType: 'leaver_reason',
      code: 'resignation',
      label: 'Resignation',
      sortOrder: 0,
    });
  });

  it('rolls the event back with the row when the insert fails (ADR-0010 rule 1)', async () => {
    await caller().platform.lookup.create({
      listType: 'department',
      code: 'ops',
      label: 'Operations',
    });
    const before = await db
      .selectFrom('platform.domain_event')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('event_type', '=', 'platform.lookup.value.created')
      .executeTakeFirstOrThrow();

    await expect(
      caller().platform.lookup.create({ listType: 'department', code: 'ops', label: 'Dup' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const after = await db
      .selectFrom('platform.domain_event')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('event_type', '=', 'platform.lookup.value.created')
      .executeTakeFirstOrThrow();
    // No orphan event survived the failed state write.
    expect(Number(after.c)).toBe(Number(before.c));
  });

  it('emits payloads carrying ids, codes and labels only (ADR-0019)', async () => {
    const { id } = await caller().platform.lookup.create({
      listType: 'job_role',
      code: 'fencer',
      label: 'Fencer',
    });
    const [event] = await eventsFor(id);
    const payload = event.payload as Record<string, unknown>;
    // The strict schema already rejects unknown keys; this pins the *shape* so a
    // future schemaVersion bump cannot quietly widen it into profile data.
    expect(Object.keys(payload).sort()).toEqual(['code', 'label', 'listType', 'sortOrder']);
  });
});

describe('update (code immutability, PL-007)', () => {
  it('edits the label and reflects it in options immediately (AC-D1 path)', async () => {
    const id = await seedValue('department', 'ops', { label: 'Operations' });
    await caller().platform.lookup.update({ id, label: 'Fencing Operations' });

    const options = await caller().platform.lookup.options({ listType: 'department' });
    expect(options.find((o) => o.id === id)?.label).toBe('Fencing Operations');
    // The code — what migrations and consumers key on — is untouched.
    expect(options.find((o) => o.id === id)?.code).toBe('ops');
  });

  it('rejects an attempt to change the code rather than silently ignoring it', async () => {
    const id = await seedValue('department', 'ops');
    await expect(
      // @ts-expect-error — `code` is not part of the input; the strict schema
      // makes sending it an error rather than a silent no-op.
      caller().platform.lookup.update({ id, code: 'operations' }),
    ).rejects.toThrow();

    const row = await db
      .selectFrom('platform.lookup')
      .select('code')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.code).toBe('ops');
  });

  it('journals only the fields that actually changed', async () => {
    const id = await seedValue('department', 'ops', { label: 'Operations', sortOrder: 3 });
    await caller().platform.lookup.update({ id, label: 'Ops', sortOrder: 3 });

    const [event] = await eventsFor(id, 'platform.lookup.value.updated');
    expect(event.payload).toEqual({
      listType: 'department',
      code: 'ops',
      label: { from: 'Operations', to: 'Ops' },
    });
  });

  it('writes nothing at all when the submitted values match the row', async () => {
    const id = await seedValue('department', 'ops', { label: 'Operations' });
    const result = await caller().platform.lookup.update({ id, label: 'Operations' });
    expect(result.changed).toBe(false);
    // An empty "updated" event would be noise in the audit view and the ETL feed.
    expect(await eventsFor(id, 'platform.lookup.value.updated')).toHaveLength(0);
  });

  it('404s on an unknown or soft-deleted value', async () => {
    await expect(
      caller().platform.lookup.update({ id: newUuidV7(), label: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('setActive (PL-007 — deactivate, do not delete)', () => {
  it('hides a value from options while adminList and existing references keep it', async () => {
    const id = await seedValue('sickness_type', 'legacy', { label: 'Legacy reason' });
    await caller().platform.lookup.setActive({ id, active: false });

    const options = await caller().platform.lookup.options({ listType: 'sickness_type' });
    expect(options.map((o) => o.id)).not.toContain(id);

    const admin = await caller().platform.lookup.adminList({ listType: 'sickness_type' });
    expect(admin.items.map((r) => r.id)).toContain(id);

    // The row is still resolvable, so a historical record FK-ing it still joins
    // for its label — that pairing IS PL-007 for Tier 1.
    const row = await db
      .selectFrom('platform.lookup')
      .select(['label', 'active'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ label: 'Legacy reason', active: false });

    await caller().platform.lookup.setActive({ id, active: true });
    const restored = await caller().platform.lookup.options({ listType: 'sickness_type' });
    expect(restored.map((o) => o.id)).toContain(id);
  });

  it('journals the transition in each direction and is a no-op when already there', async () => {
    const id = await seedValue('ppe_type', 'gloves');
    await caller().platform.lookup.setActive({ id, active: false });
    await caller().platform.lookup.setActive({ id, active: true });
    const noop = await caller().platform.lookup.setActive({ id, active: true });

    expect(noop.changed).toBe(false);
    expect(await eventsFor(id, 'platform.lookup.value.deactivated')).toHaveLength(1);
    expect(await eventsFor(id, 'platform.lookup.value.reactivated')).toHaveLength(1);
  });

  it('shows retired values to an admin who asks, and refuses everyone else', async () => {
    const id = await seedValue('ppe_type', 'retired', { active: false });

    const admin = await caller().platform.lookup.options({
      listType: 'ppe_type',
      includeInactive: true,
    });
    expect(admin.map((o) => o.id)).toContain(id);

    const employee = await callerWith(['employee']);
    await expect(
      employee.platform.lookup.options({ listType: 'ppe_type', includeInactive: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('authorisation (§8, AC-D3)', () => {
  it('lets any authenticated role read options', async () => {
    await seedValue('document_category', 'contract', { label: 'Contract' });
    for (const role of ['employee', 'external', 'line_manager'] as RoleKey[]) {
      const c = await callerWith([role]);
      const options = await c.platform.lookup.options({ listType: 'document_category' });
      expect(options.map((o) => o.code)).toEqual(['contract']);
    }
  });

  it('denies maintenance to an Employee and allows it to an HR User', async () => {
    const employee = await callerWith(['employee']);
    await expect(
      employee.platform.lookup.adminList({ listType: 'department' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      employee.platform.lookup.create({ listType: 'department', code: 'x', label: 'X' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const hr = await callerWith(['hr_user']);
    await expect(hr.platform.lookup.adminList({ listType: 'department' })).resolves.toBeTruthy();
    await expect(
      hr.platform.lookup.create({ listType: 'department', code: 'x', label: 'X' }),
    ).resolves.toBeTruthy();
  });

  it('does not accept a grant held in another module', async () => {
    // `{ module: 'platform' }` is matched exactly (plan 04 Q5): an HR User in
    // hr.core administers HR, not the platform's reference data.
    const personId = await insertPerson();
    const role = await db
      .selectFrom('platform.role')
      .select('id')
      .where('key', '=', 'hr_user')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('platform.role_grant')
      .values({
        id: newUuidV7(),
        person_id: personId,
        role_id: role.id,
        module: 'hr.core',
        created_by: personId,
      })
      .execute();
    const grants = await grantsFor(personId, []);
    const c = appRouter.createCaller(makeCtx({ actorPersonId: personId, grants }));

    await expect(c.platform.lookup.adminList({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('the journal is a complete record of a list (event-ledger reconstruction)', () => {
  it('replaying platform.lookup.value.* rebuilds the list current state', async () => {
    const a = await caller().platform.lookup.create({
      listType: 'equipment_type',
      code: 'van',
      label: 'Van',
    });
    const b = await caller().platform.lookup.create({
      listType: 'equipment_type',
      code: 'laptop',
      label: 'Laptop',
    });
    await caller().platform.lookup.update({ id: b.id, label: 'Laptop / tablet' });
    await caller().platform.lookup.setActive({ id: a.id, active: false });

    // Scoped to this test's streams: `platform.domain_event` is append-only, so
    // `truncateAll` deliberately skips it and rows from sibling tests survive.
    const events = await db
      .selectFrom('platform.domain_event')
      .select(['event_type', 'payload'])
      .where('stream_type', '=', 'platform.lookup')
      .where('stream_id', 'in', [a.id, b.id])
      .orderBy('recorded_at')
      .orderBy('id')
      .execute();

    // Fold the events into state, exactly as a reporting consumer would.
    const rebuilt = new Map<string, { label: string; active: boolean }>();
    for (const e of events) {
      // `created` carries a plain label; `updated` carries a from/to delta.
      const p = e.payload as { code: string; label?: string | { from: string; to: string } };
      const current = rebuilt.get(p.code);
      switch (e.event_type) {
        case 'platform.lookup.value.created':
          if (typeof p.label === 'string') rebuilt.set(p.code, { label: p.label, active: true });
          break;
        case 'platform.lookup.value.updated':
          if (current && p.label && typeof p.label === 'object') current.label = p.label.to;
          break;
        case 'platform.lookup.value.deactivated':
          if (current) current.active = false;
          break;
        case 'platform.lookup.value.reactivated':
          if (current) current.active = true;
          break;
        case 'platform.lookup.value.deleted':
          rebuilt.delete(p.code);
          break;
      }
    }

    const live = await db
      .selectFrom('platform.lookup')
      .select(['code', 'label', 'active'])
      .where('list_type', '=', 'equipment_type')
      .where('deleted_at', 'is', null)
      .orderBy('code')
      .execute();

    expect([...rebuilt.entries()].sort(([x], [y]) => x.localeCompare(y))).toEqual(
      live.map((r) => [r.code, { label: r.label, active: r.active }]),
    );
  });
});
