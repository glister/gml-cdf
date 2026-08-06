import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, newUuidV7 } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import { CycleError } from '@repo/domain';
import { setConfig, tasksReminderNoDueDate, tasksDueTimeOfDay } from '@repo/config';
import {
  cancelTask,
  claimTask,
  completeTask,
  openGate,
  raiseTaskList,
  recomputeDueDates,
  releaseTask,
  TaskForbiddenError,
  TaskSpecError,
  REMINDER_ACTION_TYPE,
  type TaskListItem,
} from './tasks.js';
import { ROLE_KEYS, type RoleKey } from './constants.js';

/**
 * The engine services against real Postgres (core plan 08 §10).
 *
 * Everything asserted here is SQL or transaction behaviour — atomic raises,
 * unlock cascades, pre-satisfied gates, the `FOR UPDATE` serialisation — and a
 * mock database would prove none of it (ADR-0004).
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

const CASE_TYPE = 'platform.pilot_case';

let actorId: string;
let caseId: string;
let itRoleId: string;
let hrRoleId: string;

beforeEach(async () => {
  await truncateAll(db);
  await reseedRoles();
  actorId = await insertPerson('Engine Actor');
  caseId = newUuidV7();
  itRoleId = await roleId('it');
  hrRoleId = await roleId('hr_user');
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

async function grant(personId: string, roleIdValue: string): Promise<void> {
  await db
    .insertInto('platform.role_grant')
    .values({
      id: newUuidV7(),
      person_id: personId,
      role_id: roleIdValue,
      module: 'platform',
      valid_from: new Date('2020-01-01T00:00:00.000Z'),
      created_by: personId,
    })
    .execute();
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

async function raise(tasks: TaskListItem[], anchors: Record<string, string> = {}) {
  return db.transaction().execute((trx) =>
    raiseTaskList(trx, {
      streamType: CASE_TYPE,
      streamId: caseId,
      anchors,
      tasks,
      source: 'workflow',
      actorPersonId: actorId,
      correlationId: newUuidV7(),
      now: new Date(),
    }),
  );
}

async function statusOf(taskId: string): Promise<string> {
  const row = await db
    .selectFrom('platform.task')
    .select('status')
    .where('id', '=', taskId)
    .executeTakeFirstOrThrow();
  return row.status;
}

async function eventsFor(taskId: string) {
  return db
    .selectFrom('platform.domain_event')
    .select(['event_type', 'payload', 'stream_type', 'stream_id'])
    .where('stream_id', '=', taskId)
    .orderBy('recorded_at')
    .orderBy('id')
    .execute();
}

describe('raiseTaskList', () => {
  it('writes tasks, dependencies and one raised event each, in one transaction', async () => {
    const raised = await raise([
      spec({ ref: 'one', lane: 'it' }),
      spec({ ref: 'two', lane: 'it', dependsOn: ['one'] }),
    ]);

    expect(raised.map((t) => t.status)).toEqual(['open', 'blocked']);
    expect(await db.selectFrom('platform.task').selectAll().execute()).toHaveLength(2);
    expect(await db.selectFrom('platform.task_dependency').selectAll().execute()).toHaveLength(1);

    // The journal is append-only and survives `truncateAll`, so every assertion
    // about events is scoped to this test's own rows.
    const events = await db
      .selectFrom('platform.domain_event')
      .select('event_type')
      .where('event_type', '=', 'platform.task.raised')
      .where(
        'stream_id',
        'in',
        raised.map((t) => t.id),
      )
      .execute();
    expect(events).toHaveLength(2);
  });

  it('journals a task fact on the task row, with the case in the payload', async () => {
    const [one] = await raise([spec({ ref: 'one' })]);
    const [event] = await eventsFor(one!.id);

    expect(event!.stream_type).toBe('platform.task');
    expect(event!.stream_id).toBe(one!.id);
    expect(event!.payload).toMatchObject({ caseStreamType: CASE_TYPE, caseStreamId: caseId });
  });

  it('rolls back every row and event when the transaction fails part-way', async () => {
    const startedAt = new Date();
    await expect(
      db.transaction().execute(async (trx) => {
        await raiseTaskList(trx, {
          streamType: CASE_TYPE,
          streamId: caseId,
          anchors: {},
          tasks: [spec({ ref: 'one' }), spec({ ref: 'two' })],
          source: 'workflow',
          actorPersonId: actorId,
          correlationId: newUuidV7(),
          now: new Date(),
        });
        throw new Error('induced failure after the raise');
      }),
    ).rejects.toThrow('induced failure');

    expect(await db.selectFrom('platform.task').selectAll().execute()).toHaveLength(0);
    expect(
      await db
        .selectFrom('platform.domain_event')
        .selectAll()
        .where('event_type', 'like', 'platform.task%')
        .where('recorded_at', '>=', startedAt)
        .execute(),
    ).toHaveLength(0);
  });

  it('rejects a dependency cycle with no partial writes (AC-D2)', async () => {
    await expect(
      raise([spec({ ref: 'one', dependsOn: ['two'] }), spec({ ref: 'two', dependsOn: ['one'] })]),
    ).rejects.toThrow(CycleError);

    expect(await db.selectFrom('platform.task').selectAll().execute()).toHaveLength(0);
  });

  it('rejects a dependency on a ref that is not in the list', async () => {
    await expect(raise([spec({ ref: 'one', dependsOn: ['nowhere'] })])).rejects.toThrow(
      TaskSpecError,
    );
  });

  it('rejects a duplicate ref inside one list', async () => {
    await expect(raise([spec({ ref: 'one' }), spec({ ref: 'one' })])).rejects.toThrow(
      TaskSpecError,
    );
  });

  it('rejects a dependency on a task belonging to another case', async () => {
    const [elsewhere] = await db.transaction().execute((trx) =>
      raiseTaskList(trx, {
        streamType: CASE_TYPE,
        streamId: newUuidV7(),
        anchors: {},
        tasks: [spec({ ref: 'other' })],
        source: 'workflow',
        actorPersonId: actorId,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    await expect(raise([spec({ ref: 'mine', dependsOnTaskIds: [elsewhere!.id] })])).rejects.toThrow(
      TaskSpecError,
    );
  });

  it('resolves an anchor-relative due date and stores the spec beside it (AC-D1)', async () => {
    const [task] = await raise(
      [
        spec({
          ref: 'induction',
          due: { mode: 'anchor_relative', anchorName: 'start_date', offsetDays: -3 },
        }),
      ],
      { start_date: '2026-09-14' },
    );

    const row = await db
      .selectFrom('platform.task')
      .selectAll()
      .where('id', '=', task!.id)
      .executeTakeFirstOrThrow();
    expect(row.due_at?.toISOString()).toBe('2026-09-11T16:00:00.000Z');
    expect(row.anchor_name).toBe('start_date');
    expect(row.anchor_offset_days).toBe(-3);
  });

  it('creates a gated task blocked, and an ungated sibling open (AC-D3)', async () => {
    const raised = await raise([
      spec({ ref: 'it_setup', lane: 'it' }),
      spec({ ref: 'vehicle', lane: 'transport', gates: ['verification'] }),
    ]);
    expect(raised.map((t) => t.status)).toEqual(['open', 'blocked']);
  });

  it('creates a task gated on an already-open gate as open (AC-D3, late raise)', async () => {
    await db.transaction().execute((trx) =>
      openGate(trx, {
        streamType: CASE_TYPE,
        streamId: caseId,
        gateKey: 'verification',
        actorPersonId: actorId,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    const [late] = await raise([spec({ ref: 'late', gates: ['verification'] })]);
    expect(late!.status).toBe('open');

    const dependency = await db
      .selectFrom('platform.task_dependency')
      .selectAll()
      .where('task_id', '=', late!.id)
      .executeTakeFirstOrThrow();
    expect(dependency.satisfied_at).not.toBeNull();
  });

  it('does not block a manual task on a prerequisite that already finished', async () => {
    const [first] = await raise([spec({ ref: 'first' })]);
    await db.transaction().execute((trx) =>
      completeTask(trx, {
        taskId: first!.id,
        actorPersonId: actorId,
        allowOverride: true,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    const [second] = await raise([spec({ ref: 'second', dependsOnTaskIds: [first!.id] })]);
    expect(second!.status).toBe('open');
  });
});

describe('completeTask', () => {
  it('unblocks the dependent in the same transaction, with both events (AC-D2)', async () => {
    const [one, two] = await raise([
      spec({ ref: 'one' }),
      spec({ ref: 'two', dependsOn: ['one'] }),
    ]);

    const result = await db.transaction().execute((trx) =>
      completeTask(trx, {
        taskId: one!.id,
        actorPersonId: actorId,
        allowOverride: true,
        note: 'done and dusted',
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    expect(result.unblockedTaskIds).toEqual([two!.id]);
    expect(await statusOf(two!.id)).toBe('open');

    const oneEvents = (await eventsFor(one!.id)).map((e) => e.event_type);
    const twoEvents = (await eventsFor(two!.id)).map((e) => e.event_type);
    expect(oneEvents).toContain('platform.task.completed');
    expect(twoEvents).toContain('platform.task.unblocked');
  });

  it('leaves a task blocked while another prerequisite is outstanding', async () => {
    const [one, two, three] = await raise([
      spec({ ref: 'one' }),
      spec({ ref: 'two' }),
      spec({ ref: 'three', dependsOn: ['one', 'two'] }),
    ]);

    await db.transaction().execute((trx) =>
      completeTask(trx, {
        taskId: one!.id,
        actorPersonId: actorId,
        allowOverride: true,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );
    expect(await statusOf(three!.id)).toBe('blocked');

    await db.transaction().execute((trx) =>
      completeTask(trx, {
        taskId: two!.id,
        actorPersonId: actorId,
        allowOverride: true,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );
    expect(await statusOf(three!.id)).toBe('open');
  });

  it('refuses to complete a blocked task', async () => {
    const [, two] = await raise([spec({ ref: 'one' }), spec({ ref: 'two', dependsOn: ['one'] })]);

    await expect(
      db.transaction().execute((trx) =>
        completeTask(trx, {
          taskId: two!.id,
          actorPersonId: actorId,
          allowOverride: true,
          correlationId: newUuidV7(),
          now: new Date(),
        }),
      ),
    ).rejects.toThrow(/blocked/);
  });

  it('refuses an actor outside the assignee role with no override', async () => {
    const [one] = await raise([spec({ ref: 'one' })]);
    const outsider = await insertPerson('Outsider');

    await expect(
      db.transaction().execute((trx) =>
        completeTask(trx, {
          taskId: one!.id,
          actorPersonId: outsider,
          allowOverride: false,
          correlationId: newUuidV7(),
          now: new Date(),
        }),
      ),
    ).rejects.toThrow(TaskForbiddenError);
    expect(await statusOf(one!.id)).toBe('open');
  });

  it('lets a member of the assignee role complete it, and records no override', async () => {
    const [one] = await raise([spec({ ref: 'one' })]);
    const member = await insertPerson('IT Member');
    await grant(member, itRoleId);

    const result = await db.transaction().execute((trx) =>
      completeTask(trx, {
        taskId: one!.id,
        actorPersonId: member,
        allowOverride: false,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );
    expect(result.override).toBe(false);
  });

  it('records an HR override as an override, with on-behalf-of on the event', async () => {
    const [one] = await raise([spec({ ref: 'one' })]);
    const hr = await insertPerson('HR');
    await grant(hr, hrRoleId);
    const subject = await insertPerson('Subject');

    const result = await db.transaction().execute((trx) =>
      completeTask(trx, {
        taskId: one!.id,
        actorPersonId: hr,
        allowOverride: true,
        onBehalfOf: subject,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );
    expect(result.override).toBe(true);

    const event = await db
      .selectFrom('platform.domain_event')
      .selectAll()
      .where('event_type', '=', 'platform.task.completed')
      .where('stream_id', '=', one!.id)
      .executeTakeFirstOrThrow();
    expect(event.on_behalf_of).toBe(subject);
    expect(event.payload).toMatchObject({ override: true, noteProvided: false });
  });
});

describe('openGate', () => {
  it('opens all and only the tasks blocked on that gate (AC-D3)', async () => {
    const [gated, alsoGated, otherGate, ungated] = await raise([
      spec({ ref: 'gated', gates: ['verification'] }),
      spec({ ref: 'also_gated', gates: ['verification'] }),
      spec({ ref: 'other_gate', gates: ['references'] }),
      spec({ ref: 'ungated' }),
    ]);

    const result = await db.transaction().execute((trx) =>
      openGate(trx, {
        streamType: CASE_TYPE,
        streamId: caseId,
        gateKey: 'verification',
        actorPersonId: actorId,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    expect(result.unblockedTaskIds.sort()).toEqual([gated!.id, alsoGated!.id].sort());
    expect(await statusOf(otherGate!.id)).toBe('blocked');
    expect(await statusOf(ungated!.id)).toBe('open');
  });

  it('does not reach into another case', async () => {
    const otherCaseId = newUuidV7();
    const [mine] = await raise([spec({ ref: 'mine', gates: ['verification'] })]);
    const [theirs] = await db.transaction().execute((trx) =>
      raiseTaskList(trx, {
        streamType: CASE_TYPE,
        streamId: otherCaseId,
        anchors: {},
        tasks: [spec({ ref: 'theirs', gates: ['verification'] })],
        source: 'workflow',
        actorPersonId: actorId,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    await db.transaction().execute((trx) =>
      openGate(trx, {
        streamType: CASE_TYPE,
        streamId: caseId,
        gateKey: 'verification',
        actorPersonId: actorId,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    expect(await statusOf(mine!.id)).toBe('open');
    expect(await statusOf(theirs!.id)).toBe('blocked');
  });

  it('journals the gate on the case stream, and is a no-op when re-opened', async () => {
    const [gated] = await raise([spec({ ref: 'gated', gates: ['verification'] })]);
    const open = () =>
      db.transaction().execute((trx) =>
        openGate(trx, {
          streamType: CASE_TYPE,
          streamId: caseId,
          gateKey: 'verification',
          actorPersonId: actorId,
          correlationId: newUuidV7(),
          now: new Date(),
        }),
      );

    const first = await open();
    const second = await open();

    expect(first.unblockedTaskIds).toEqual([gated!.id]);
    expect(second.unblockedTaskIds).toEqual([]);
    expect(second.dependenciesSatisfied).toBe(0);

    const gateEvents = await db
      .selectFrom('platform.domain_event')
      .selectAll()
      .where('event_type', '=', 'platform.task.gate.opened')
      .where('stream_id', '=', caseId)
      .execute();
    expect(gateEvents).toHaveLength(2);
    expect(gateEvents[0]!.stream_type).toBe(CASE_TYPE);
  });
});

describe('cancelTask', () => {
  it('releases dependents rather than stranding them', async () => {
    const [one, two] = await raise([
      spec({ ref: 'one' }),
      spec({ ref: 'two', dependsOn: ['one'] }),
    ]);

    const result = await db.transaction().execute((trx) =>
      cancelTask(trx, {
        taskId: one!.id,
        reason: 'no longer needed',
        actorPersonId: actorId,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    expect(result.unblockedTaskIds).toEqual([two!.id]);
    expect(await statusOf(two!.id)).toBe('open');
    expect(await statusOf(one!.id)).toBe('cancelled');
  });

  it('does not resurrect a cancelled dependent when its prerequisite completes', async () => {
    const [one, two] = await raise([
      spec({ ref: 'one' }),
      spec({ ref: 'two', dependsOn: ['one'] }),
    ]);

    await db.transaction().execute((trx) =>
      cancelTask(trx, {
        taskId: two!.id,
        reason: 'not applicable',
        actorPersonId: actorId,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );
    await db.transaction().execute((trx) =>
      completeTask(trx, {
        taskId: one!.id,
        actorPersonId: actorId,
        allowOverride: true,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    expect(await statusOf(two!.id)).toBe('cancelled');
  });
});

describe('claim and release', () => {
  it('claims and releases without changing status, and journals both', async () => {
    const [one] = await raise([spec({ ref: 'one' })]);
    const member = await insertPerson('IT Member');
    await grant(member, itRoleId);

    await db.transaction().execute((trx) =>
      claimTask(trx, {
        taskId: one!.id,
        actorPersonId: member,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );
    expect(await statusOf(one!.id)).toBe('open');

    await db.transaction().execute((trx) =>
      releaseTask(trx, {
        taskId: one!.id,
        actorPersonId: member,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    const row = await db
      .selectFrom('platform.task')
      .selectAll()
      .where('id', '=', one!.id)
      .executeTakeFirstOrThrow();
    expect(row.claimed_by).toBeNull();
    expect(row.claimed_at).toBeNull();

    const types = (await eventsFor(one!.id)).map((e) => e.event_type);
    expect(types).toContain('platform.task.claimed');
    expect(types).toContain('platform.task.released');
  });

  it('does not stop another member of the role completing a claimed task', async () => {
    const [one] = await raise([spec({ ref: 'one' })]);
    const first = await insertPerson('First');
    const second = await insertPerson('Second');
    await grant(first, itRoleId);
    await grant(second, itRoleId);

    await db.transaction().execute((trx) =>
      claimTask(trx, {
        taskId: one!.id,
        actorPersonId: first,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    await expect(
      db.transaction().execute((trx) =>
        completeTask(trx, {
          taskId: one!.id,
          actorPersonId: second,
          allowOverride: false,
          correlationId: newUuidV7(),
          now: new Date(),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a claim from outside the assignee role', async () => {
    const [one] = await raise([spec({ ref: 'one' })]);
    const outsider = await insertPerson('Outsider');

    await expect(
      db.transaction().execute((trx) =>
        claimTask(trx, {
          taskId: one!.id,
          actorPersonId: outsider,
          correlationId: newUuidV7(),
          now: new Date(),
        }),
      ),
    ).rejects.toThrow(TaskForbiddenError);
  });
});

describe('recomputeDueDates', () => {
  it('moves anchor-relative tasks, leaves absolute ones, and journals the change (AC-D1)', async () => {
    const absoluteDue = '2026-10-01T09:00:00.000Z';
    const [relative, absolute] = await raise(
      [
        spec({
          ref: 'relative',
          due: { mode: 'anchor_relative', anchorName: 'start_date', offsetDays: -3 },
        }),
        spec({ ref: 'absolute', due: { mode: 'absolute', dueAt: absoluteDue } }),
      ],
      { start_date: '2026-09-14' },
    );

    const { changed } = await db.transaction().execute((trx) =>
      recomputeDueDates(trx, {
        streamType: CASE_TYPE,
        streamId: caseId,
        anchors: { start_date: '2026-09-21' },
        actorPersonId: actorId,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    expect(changed).toBe(1);
    const moved = await db
      .selectFrom('platform.task')
      .select('due_at')
      .where('id', '=', relative!.id)
      .executeTakeFirstOrThrow();
    expect(moved.due_at?.toISOString()).toBe('2026-09-18T16:00:00.000Z');

    const untouched = await db
      .selectFrom('platform.task')
      .select('due_at')
      .where('id', '=', absolute!.id)
      .executeTakeFirstOrThrow();
    expect(untouched.due_at?.toISOString()).toBe(absoluteDue);

    const event = await db
      .selectFrom('platform.domain_event')
      .selectAll()
      .where('event_type', '=', 'platform.task.due_recomputed')
      .where('stream_id', '=', relative!.id)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      fromDueAt: '2026-09-11T16:00:00.000Z',
      toDueAt: '2026-09-18T16:00:00.000Z',
    });
  });

  it('journals nothing when the recomputed date is the same instant', async () => {
    await raise(
      [
        spec({
          ref: 'relative',
          due: { mode: 'anchor_relative', anchorName: 'start_date', offsetDays: 0 },
        }),
      ],
      { start_date: '2026-09-14' },
    );

    const { changed } = await db.transaction().execute((trx) =>
      recomputeDueDates(trx, {
        streamType: CASE_TYPE,
        streamId: caseId,
        anchors: { start_date: '2026-09-14' },
        actorPersonId: actorId,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );
    expect(changed).toBe(0);
  });

  it('leaves completed tasks alone', async () => {
    const [done] = await raise(
      [
        spec({
          ref: 'done',
          due: { mode: 'anchor_relative', anchorName: 'start_date', offsetDays: 0 },
        }),
      ],
      { start_date: '2026-09-14' },
    );
    await db.transaction().execute((trx) =>
      completeTask(trx, {
        taskId: done!.id,
        actorPersonId: actorId,
        allowOverride: true,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    const { changed } = await db.transaction().execute((trx) =>
      recomputeDueDates(trx, {
        streamType: CASE_TYPE,
        streamId: caseId,
        anchors: { start_date: '2026-12-25' },
        actorPersonId: actorId,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );
    expect(changed).toBe(0);
  });

  it('ignores tasks whose anchor was not among those that moved', async () => {
    await raise(
      [
        spec({
          ref: 'other_anchor',
          due: { mode: 'anchor_relative', anchorName: 'review_date', offsetDays: 0 },
        }),
      ],
      { review_date: '2026-09-14' },
    );

    const { changed } = await db.transaction().execute((trx) =>
      recomputeDueDates(trx, {
        streamType: CASE_TYPE,
        streamId: caseId,
        anchors: { start_date: '2026-12-25' },
        actorPersonId: actorId,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );
    expect(changed).toBe(0);
  });
});

describe('reminders (PL-020, plan 10 contract)', () => {
  async function reminders(taskId: string) {
    return db
      .selectFrom('platform.scheduled_action')
      .selectAll()
      .where('action_type', '=', REMINDER_ACTION_TYPE)
      .where('subject_stream_id', '=', taskId)
      .execute();
  }

  it('schedules a first occurrence on raise, on the plan 10 payload shape', async () => {
    const [task] = await raise([
      spec({ ref: 'one', due: { mode: 'absolute', dueAt: '2026-10-01T16:00:00.000Z' } }),
    ]);

    const [reminder] = await reminders(task!.id);
    expect(reminder!.status).toBe('pending');
    expect(reminder!.due_at.toISOString()).toBe('2026-10-01T16:00:00.000Z');
    expect(reminder!.payload).toMatchObject({
      reminderKind: 'task.incomplete',
      sourceType: 'platform.task',
      sourceId: task!.id,
      cadenceRef: 'config:platform.tasks.reminder.cadence',
      occurrence: 1,
    });
  });

  it('cancels the chase in the transaction that completes the task (AC-D6)', async () => {
    const [task] = await raise([
      spec({ ref: 'one', due: { mode: 'absolute', dueAt: '2026-10-01T16:00:00.000Z' } }),
    ]);
    await db.transaction().execute((trx) =>
      completeTask(trx, {
        taskId: task!.id,
        actorPersonId: actorId,
        allowOverride: true,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    const [reminder] = await reminders(task!.id);
    expect(reminder!.status).toBe('cancelled');
  });

  it('cancels the chase when the task is cancelled', async () => {
    const [task] = await raise([
      spec({ ref: 'one', due: { mode: 'absolute', dueAt: '2026-10-01T16:00:00.000Z' } }),
    ]);
    await db.transaction().execute((trx) =>
      cancelTask(trx, {
        taskId: task!.id,
        reason: 'not needed',
        actorPersonId: actorId,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    const [reminder] = await reminders(task!.id);
    expect(reminder!.status).toBe('cancelled');
  });

  it('honours the no-due-date policy without a release (PL-029)', async () => {
    // Default `from_raise` chases an undated task…
    const [chased] = await raise([spec({ ref: 'chased' })]);
    expect(await reminders(chased!.id)).toHaveLength(1);

    // …and setting the key to `none` stops it for the next raise.
    await db.transaction().execute((trx) =>
      setConfig(trx, {
        def: tasksReminderNoDueDate,
        value: 'none',
        actorPersonId: actorId,
        correlationId: newUuidV7(),
      }),
    );
    const [unchased] = await raise([spec({ ref: 'unchased' })]);
    expect(await reminders(unchased!.id)).toHaveLength(0);
  });

  it('reschedules the chase when the due date is recomputed', async () => {
    const [task] = await raise(
      [
        spec({
          ref: 'one',
          due: { mode: 'anchor_relative', anchorName: 'start_date', offsetDays: 0 },
        }),
      ],
      { start_date: '2026-09-14' },
    );

    await db.transaction().execute((trx) =>
      recomputeDueDates(trx, {
        streamType: CASE_TYPE,
        streamId: caseId,
        anchors: { start_date: '2026-09-21' },
        actorPersonId: actorId,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    const rows = await reminders(task!.id);
    const pending = rows.filter((r) => r.status === 'pending');
    expect(rows.filter((r) => r.status === 'cancelled')).toHaveLength(1);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.due_at.toISOString()).toBe('2026-09-21T16:00:00.000Z');
  });
});

describe('configuration (PL-029)', () => {
  it('resolves the due time-of-day as-at the raise, with no release', async () => {
    await db.transaction().execute((trx) =>
      setConfig(trx, {
        def: tasksDueTimeOfDay,
        value: '09:00',
        actorPersonId: actorId,
        correlationId: newUuidV7(),
      }),
    );

    const [task] = await raise(
      [
        spec({
          ref: 'one',
          due: { mode: 'anchor_relative', anchorName: 'start_date', offsetDays: 0 },
        }),
      ],
      { start_date: '2026-09-14' },
    );

    const row = await db
      .selectFrom('platform.task')
      .select('due_at')
      .where('id', '=', task!.id)
      .executeTakeFirstOrThrow();
    expect(row.due_at?.toISOString()).toBe('2026-09-14T08:00:00.000Z');
  });
});

describe('journal discipline (ADR-0019)', () => {
  it('never puts a title, description or person name in a task payload', async () => {
    const [one, two] = await raise([
      spec({
        ref: 'one',
        title: 'Order the laptop for Jane Doe',
        description: 'Ask Jane about the keyboard layout',
      }),
      spec({ ref: 'two', dependsOn: ['one'], title: 'Set up the mailbox' }),
    ]);
    await db.transaction().execute((trx) =>
      completeTask(trx, {
        taskId: one!.id,
        actorPersonId: actorId,
        allowOverride: true,
        note: 'Ordered — Jane confirmed the layout',
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    const payloads = JSON.stringify(
      (
        await db
          .selectFrom('platform.domain_event')
          .select('payload')
          .where('stream_id', 'in', [one!.id, two!.id, caseId])
          .execute()
      ).map((row) => row.payload),
    );

    expect(payloads).not.toContain('Jane');
    expect(payloads).not.toContain('laptop');
    expect(payloads).not.toContain('mailbox');
    expect(payloads).not.toContain('keyboard');
    expect(payloads).toContain(two!.id);
  });

  it('reconstructs a task lifecycle from its events alone', async () => {
    const [one] = await raise([spec({ ref: 'one' })]);
    const member = await insertPerson('IT Member');
    await grant(member, itRoleId);

    await db.transaction().execute((trx) =>
      claimTask(trx, {
        taskId: one!.id,
        actorPersonId: member,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );
    await db.transaction().execute((trx) =>
      completeTask(trx, {
        taskId: one!.id,
        actorPersonId: member,
        allowOverride: false,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    expect((await eventsFor(one!.id)).map((e) => e.event_type)).toEqual([
      'platform.task.raised',
      'platform.task.claimed',
      'platform.task.completed',
    ]);
    expect(await statusOf(one!.id)).toBe('done');
  });
});
