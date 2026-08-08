import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { db, newUuidV7 } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import { appRouter } from '../../router.js';
import type { ContextGrant, TRPCContext } from '../../trpc.js';
import { ROLE_KEYS, type RoleKey } from '../../lib/constants.js';
import { openGate, raiseTaskList, type TaskListItem } from '../../lib/tasks.js';

/**
 * The `platform.tasks` surface against real Postgres (core plan 08 §10).
 *
 * Two things are proven here that a mock database cannot prove at all: that
 * paging `myTasks` over a nullable, microsecond-adjacent `due_at` returns every
 * row exactly once in the right order (ADR-0004's keyset rule), and that role
 * resolution happens **at read time** — the AC-5 model, where changing a role's
 * membership redirects task lists with no writes to task rows.
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

const CASE_TYPE = 'platform.pilot_case';

let adminPersonId: string;
let adminGrants: ContextGrant[];
let caseId: string;
let itRoleId: string;
/** Someone who actually holds the assignee role — an administrator does not. */
let itMemberId: string;

beforeEach(async () => {
  await truncateAll(db);
  await reseedRoles();
  adminPersonId = await insertPerson('Task Admin');
  adminGrants = await grantsFor(adminPersonId, ['administrator']);
  caseId = newUuidV7();
  itRoleId = await roleId('it');
  itMemberId = await insertPerson('IT Member');
  await grantsFor(itMemberId, ['it']);
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

async function roleId(key: RoleKey): Promise<string> {
  const row = await db
    .selectFrom('platform.role')
    .select('id')
    .where('key', '=', key)
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertPerson(displayName: string): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.person')
    .values({ id, relationship_type: 'employee', display_name: displayName })
    .execute();
  return id;
}

async function grantsFor(personId: string, roleKeys: RoleKey[]): Promise<ContextGrant[]> {
  for (const roleKey of roleKeys) {
    await db
      .insertInto('platform.role_grant')
      .values({
        id: newUuidV7(),
        person_id: personId,
        role_id: await roleId(roleKey),
        module: 'platform',
        valid_from: new Date('2020-01-01T00:00:00.000Z'),
        created_by: personId,
      })
      .execute();
  }
  return loadGrants(personId);
}

async function loadGrants(personId: string): Promise<ContextGrant[]> {
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

/**
 * The caller for `myTasks` assertions. It is **not** the administrator:
 * `myTasks` is self-scoping, and `administrator` confers no bypass — an admin
 * who holds no operational role has no tasks, which is the model working.
 */
const member = () => callerFor(itMemberId);

async function callerFor(personId: string) {
  return appRouter.createCaller(
    makeCtx({ actorPersonId: personId, grants: await loadGrants(personId) }),
  );
}

async function raise(
  tasks: TaskListItem[],
  streamId = caseId,
  anchors: Record<string, string> = {},
) {
  return db.transaction().execute((trx) =>
    raiseTaskList(trx, {
      streamType: CASE_TYPE,
      streamId,
      anchors,
      tasks,
      source: 'workflow',
      actorPersonId: adminPersonId,
      correlationId: newUuidV7(),
      now: new Date(),
    }),
  );
}

function spec(overrides: Partial<TaskListItem> & { ref: string }): TaskListItem {
  return {
    title: `Task ${overrides.ref}`,
    assigneeRoleId: itRoleId,
    due: { mode: 'none' },
    dependsOn: [],
    gates: [],
    ...overrides,
  };
}

describe('myTasks — keyset paging over real Postgres (ADR-0004)', () => {
  const TOTAL = 60;

  /**
   * A deliberately awkward set: a third with no due date at all, a third
   * clustered on **microsecond-adjacent** instants, and a third spread over
   * days. The nulls exercise the coalesced sort key and the microseconds
   * exercise the fixed-width cursor — a JS `Date` holds only milliseconds, so a
   * cursor round-tripped through one would drop or repeat rows at page edges.
   */
  async function seedSixty(): Promise<void> {
    const base = Date.UTC(2026, 8, 1, 9, 0, 0);
    const specs: TaskListItem[] = [];
    for (let i = 0; i < TOTAL; i += 1) {
      const bucket = i % 3;
      specs.push(
        spec({
          ref: `t${i}`,
          title: `Task number ${i}`,
          lane: bucket === 0 ? 'it' : 'transport',
          due:
            bucket === 0
              ? { mode: 'none' }
              : bucket === 1
                ? { mode: 'absolute', dueAt: new Date(base + i * 86_400_000).toISOString() }
                : { mode: 'absolute', dueAt: new Date(base).toISOString() },
        }),
      );
    }
    await raise(specs);

    // Nudge the clustered third apart by **microseconds** — a precision a JS
    // `Date` cannot express at all, which is exactly what the fixed-width cursor
    // has to preserve. Written in SQL for the same reason.
    const clustered = await db
      .selectFrom('platform.task')
      .select('id')
      .where('due_at', '=', new Date(base))
      .orderBy('id')
      .execute();
    for (const [i, row] of clustered.entries()) {
      await sql`
        UPDATE platform.task
           SET due_at = due_at + (${(i + 1).toString()} || ' microseconds')::interval
         WHERE id = ${row.id}
      `.execute(db);
    }
  }

  it('pages the whole set in order, with no duplicates and no gaps', async () => {
    await seedSixty();
    const seen: string[] = [];
    const keys: string[] = [];
    let cursor: string | null = null;

    do {
      const page: Awaited<
        ReturnType<Awaited<ReturnType<typeof member>>['platform']['tasks']['myTasks']>
      > = await (
        await member()
      ).platform.tasks.myTasks({ limit: 7, ...(cursor ? { cursor } : {}) });
      for (const item of page.items) {
        seen.push(item.id);
        keys.push(item.dueAt ?? '9999');
      }
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
    // Ascending by due date, with the undated tasks last.
    expect([...keys].sort()).toEqual(keys);
  });

  it('pages descending with the same completeness', async () => {
    await seedSixty();
    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const page = await (
        await member()
      ).platform.tasks.myTasks({
        limit: 9,
        sortDir: 'desc',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(new Set(seen).size).toBe(TOTAL);
  });

  it('pages by raised order too', async () => {
    await seedSixty();
    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const page = await (
        await member()
      ).platform.tasks.myTasks({
        limit: 11,
        sort: 'raised',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(new Set(seen).size).toBe(TOTAL);
  });
});

describe('myTasks — facets applied in SQL', () => {
  beforeEach(async () => {
    await raise([
      spec({ ref: 'it_one', lane: 'it', title: 'Order the laptop' }),
      spec({
        ref: 'overdue',
        lane: 'transport',
        title: 'Book the van',
        due: { mode: 'absolute', dueAt: '2020-01-01T09:00:00.000Z' },
      }),
      spec({ ref: 'blocked', lane: 'it', title: 'Hand over the keys', dependsOn: ['it_one'] }),
    ]);
  });

  it('defaults to the actionable set', async () => {
    const page = await (await member()).platform.tasks.myTasks({});
    expect(page.items.map((i) => i.status).sort()).toEqual(['blocked', 'open', 'open']);
  });

  it('filters by lane', async () => {
    const page = await (await member()).platform.tasks.myTasks({ lane: 'transport' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.title).toBe('Book the van');
  });

  it('filters by status', async () => {
    const page = await (await member()).platform.tasks.myTasks({ status: ['blocked'] });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.title).toBe('Hand over the keys');
  });

  it('computes overdue in SQL and filters on it', async () => {
    const page = await (await member()).platform.tasks.myTasks({ overdueOnly: true });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.overdue).toBe(true);

    const all = await (await member()).platform.tasks.myTasks({});
    expect(all.items.filter((i) => i.overdue)).toHaveLength(1);
  });

  it('searches titles case-insensitively, treating wildcards as text', async () => {
    expect(
      (await (await member()).platform.tasks.myTasks({ search: 'LAPTOP' })).items,
    ).toHaveLength(1);
    // A `%` in the search must match a literal percent, not everything.
    expect((await (await member()).platform.tasks.myTasks({ search: '%' })).items).toHaveLength(0);
  });

  it('filters by case', async () => {
    const otherCase = newUuidV7();
    await raise([spec({ ref: 'elsewhere', title: 'Another case' })], otherCase);

    const page = await (await member()).platform.tasks.myTasks({ streamId: otherCase });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.title).toBe('Another case');
  });

  it('reports how many dependencies still block a task', async () => {
    const page = await (await member()).platform.tasks.myTasks({ status: ['blocked'] });
    expect(page.items[0]!.blockedCount).toBe(1);
  });
});

describe('role resolution at read time (AC-D5, ON AC-5)', () => {
  it('shows a member exactly their roles’ tasks, and nobody else’s', async () => {
    await raise([spec({ ref: 'it_task' })]);
    const financeRoleId = await roleId('finance');
    await raise([spec({ ref: 'finance_task', assigneeRoleId: financeRoleId })]);

    const page = await (await member()).platform.tasks.myTasks({});
    expect(page.items.map((i) => i.title)).toEqual(['Task it_task']);
  });

  it('redirects a task list on a membership change, with zero writes to task rows', async () => {
    const [task] = await raise([spec({ ref: 'it_task' })]);
    const newcomer = await insertPerson('Newcomer');

    const before = await db
      .selectFrom('platform.task')
      .select('updated_at')
      .where('id', '=', task!.id)
      .executeTakeFirstOrThrow();
    expect((await (await callerFor(newcomer)).platform.tasks.myTasks({})).items).toHaveLength(0);

    // The only write is to `role_grant` — the task row is not touched at all.
    await grantsFor(newcomer, ['it']);

    expect((await (await callerFor(newcomer)).platform.tasks.myTasks({})).items).toHaveLength(1);
    const after = await db
      .selectFrom('platform.task')
      .select('updated_at')
      .where('id', '=', task!.id)
      .executeTakeFirstOrThrow();
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
  });

  it('stops showing work the moment a grant expires, with no new session', async () => {
    await raise([spec({ ref: 'it_task' })]);
    const leaver = await insertPerson('Leaver');
    await grantsFor(leaver, ['it']);
    expect((await (await callerFor(leaver)).platform.tasks.myTasks({})).items).toHaveLength(1);

    await db
      .updateTable('platform.role_grant')
      .set({ valid_until: new Date(Date.now() - 1000) })
      .where('person_id', '=', leaver)
      .execute();

    // Grants loaded fresh, but the window is evaluated in SQL either way.
    expect((await (await callerFor(leaver)).platform.tasks.myTasks({})).items).toHaveLength(0);
  });
});

describe('byId, claim, complete and cancel', () => {
  it('shows what blocks a task and what it unlocks', async () => {
    const [one, two] = await raise([
      spec({ ref: 'one' }),
      spec({ ref: 'two', dependsOn: ['one'], gates: ['verification'] }),
    ]);

    const detail = await caller().platform.tasks.byId({ taskId: two!.id });
    expect(detail.status).toBe('blocked');
    expect(detail.dependencies.map((d) => d.kind).sort()).toEqual(['gate', 'task']);
    expect(detail.dependencies.find((d) => d.kind === 'task')?.dependsOnTaskId).toBe(one!.id);

    const first = await caller().platform.tasks.byId({ taskId: one!.id });
    expect(first.unlocks.map((u) => u.id)).toEqual([two!.id]);
  });

  it('hides a task from someone with neither the role nor oversight', async () => {
    const [one] = await raise([spec({ ref: 'one' })]);
    const outsider = await insertPerson('Outsider');
    await grantsFor(outsider, ['employee']);

    await expect(
      (await callerFor(outsider)).platform.tasks.byId({ taskId: one!.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('tells a role member they may act, and an overseer they may not (without the role)', async () => {
    const [one] = await raise([spec({ ref: 'one' })]);
    const member = await insertPerson('IT Member');
    await grantsFor(member, ['it']);

    expect((await (await callerFor(member)).platform.tasks.byId({ taskId: one!.id })).canAct).toBe(
      true,
    );
    expect((await caller().platform.tasks.byId({ taskId: one!.id })).canAct).toBe(false);
  });

  it('completes through the procedure, unblocking the dependent', async () => {
    const [one, two] = await raise([
      spec({ ref: 'one' }),
      spec({ ref: 'two', dependsOn: ['one'] }),
    ]);
    const member = await insertPerson('IT Member');
    await grantsFor(member, ['it']);

    const result = await (
      await callerFor(member)
    ).platform.tasks.complete({
      taskId: one!.id,
      note: 'all set',
    });
    expect(result.status).toBe('done');
    expect(result.unblockedTaskIds).toEqual([two!.id]);
    expect(result.override).toBe(false);
  });

  it('refuses completion from outside the role, and permits an HR override', async () => {
    const [one] = await raise([spec({ ref: 'one' })]);
    const outsider = await insertPerson('Outsider');
    await grantsFor(outsider, ['employee']);

    await expect(
      (await callerFor(outsider)).platform.tasks.complete({ taskId: one!.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const hr = await insertPerson('HR');
    await grantsFor(hr, ['hr_user']);
    const result = await (await callerFor(hr)).platform.tasks.complete({ taskId: one!.id });
    expect(result.override).toBe(true);
  });

  it('reports a blocked completion as a conflict, in words a person can read', async () => {
    const [, two] = await raise([spec({ ref: 'one' }), spec({ ref: 'two', dependsOn: ['one'] })]);
    await expect(caller().platform.tasks.complete({ taskId: two!.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('depends on'),
    });
  });

  it('claims and releases as a role member, and refuses an outsider', async () => {
    const [one] = await raise([spec({ ref: 'one' })]);
    const member = await insertPerson('IT Member');
    await grantsFor(member, ['it']);
    const memberCaller = await callerFor(member);

    expect((await memberCaller.platform.tasks.claim({ taskId: one!.id })).claimedBy).toBe(member);
    expect((await memberCaller.platform.tasks.release({ taskId: one!.id })).claimedBy).toBeNull();

    const outsider = await insertPerson('Outsider');
    await grantsFor(outsider, ['employee']);
    await expect(
      (await callerFor(outsider)).platform.tasks.claim({ taskId: one!.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('restricts cancel and createManual to HR and administrators', async () => {
    const [one] = await raise([spec({ ref: 'one' })]);
    const member = await insertPerson('IT Member');
    await grantsFor(member, ['it']);
    const memberCaller = await callerFor(member);

    await expect(
      memberCaller.platform.tasks.cancel({ taskId: one!.id, reason: 'no' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      memberCaller.platform.tasks.createManual({
        streamType: CASE_TYPE,
        streamId: caseId,
        title: 'Mine now',
        assigneeRoleId: itRoleId,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const cancelled = await caller().platform.tasks.cancel({
      taskId: one!.id,
      reason: 'superseded',
    });
    expect(cancelled.status).toBe('cancelled');
  });

  it('creates a manual task through the same door, cycle check included', async () => {
    const [one] = await raise([spec({ ref: 'one' })]);
    const created = await caller().platform.tasks.createManual({
      streamType: CASE_TYPE,
      streamId: caseId,
      title: 'Chase the reference',
      lane: 'hr',
      assigneeRoleId: itRoleId,
      dependsOnTaskIds: [one!.id],
    });
    expect(created.status).toBe('blocked');

    await expect(
      caller().platform.tasks.createManual({
        streamType: CASE_TYPE,
        streamId: caseId,
        title: 'Impossible',
        assigneeRoleId: itRoleId,
        dependsOnTaskIds: [created.taskId],
        due: { mode: 'anchor_relative', anchorName: 'start_date', offsetDays: -1 },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('caseProgress (PL-015, AC-D4)', () => {
  it('counts per lane, matching direct SQL, with overdue computed the same way', async () => {
    const [it_one] = await raise([
      spec({ ref: 'it_one', lane: 'it' }),
      spec({ ref: 'it_two', lane: 'it', dependsOn: ['it_one'] }),
      spec({
        ref: 'transport_one',
        lane: 'transport',
        due: { mode: 'absolute', dueAt: '2020-01-01T09:00:00.000Z' },
      }),
      spec({ ref: 'gated', lane: 'transport', gates: ['verification'] }),
    ]);
    await caller().platform.tasks.complete({ taskId: it_one!.id });

    const progress = await caller().platform.tasks.caseProgress({
      streamType: CASE_TYPE,
      streamId: caseId,
    });

    const it = progress.lanes.find((l) => l.lane === 'it')!;
    expect(it).toMatchObject({ total: 2, done: 1, open: 1, blocked: 0, overdue: 0 });

    const transport = progress.lanes.find((l) => l.lane === 'transport')!;
    expect(transport).toMatchObject({ total: 2, open: 1, blocked: 1, overdue: 1 });

    // The dashboard's figures are the same SQL the table runs.
    const direct = await db
      .selectFrom('platform.task')
      .select(({ fn }) => fn.countAll<string>().as('total'))
      .where('stream_type', '=', CASE_TYPE)
      .where('stream_id', '=', caseId)
      .executeTakeFirstOrThrow();
    expect(progress.lanes.reduce((sum, l) => sum + l.total, 0)).toBe(Number(direct.total));
  });

  it('names the gate holding up the most work, and reports it open once it is', async () => {
    await raise([
      spec({ ref: 'gated_one', gates: ['verification'] }),
      spec({ ref: 'gated_two', gates: ['verification'] }),
    ]);

    const before = await caller().platform.tasks.caseProgress({
      streamType: CASE_TYPE,
      streamId: caseId,
    });
    expect(before.gates).toEqual([{ gateKey: 'verification', open: false, blockedTaskCount: 2 }]);
    expect(before.bottlenecks[0]).toMatchObject({
      kind: 'gate',
      ref: 'verification',
      blockedCount: 2,
    });

    await db.transaction().execute((trx) =>
      openGate(trx, {
        streamType: CASE_TYPE,
        streamId: caseId,
        gateKey: 'verification',
        actorPersonId: adminPersonId,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    const after = await caller().platform.tasks.caseProgress({
      streamType: CASE_TYPE,
      streamId: caseId,
    });
    expect(after.gates).toEqual([{ gateKey: 'verification', open: true, blockedTaskCount: 0 }]);
    expect(after.bottlenecks).toEqual([]);
  });

  it('lets someone with work in the case see it, and refuses a stranger', async () => {
    await raise([spec({ ref: 'one' })]);

    const member = await insertPerson('IT Member');
    await grantsFor(member, ['it']);
    await expect(
      (await callerFor(member)).platform.tasks.caseProgress({
        streamType: CASE_TYPE,
        streamId: caseId,
      }),
    ).resolves.toBeDefined();

    const stranger = await insertPerson('Stranger');
    await grantsFor(stranger, ['employee']);
    await expect(
      (await callerFor(stranger)).platform.tasks.caseProgress({
        streamType: CASE_TYPE,
        streamId: caseId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
