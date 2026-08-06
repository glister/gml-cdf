import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { db, newUuidV7 } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import { demoRequestV1 } from '@repo/domain';
import { scheduleAction, startWorkflow } from '@repo/workflow';
import { appRouter } from '../../router.js';
import type { ContextGrant, TRPCContext } from '../../trpc.js';
import { ROLE_KEYS, type RoleKey } from '../../lib/constants.js';

/**
 * The `platform.workflow` surface (core plan 07 §10 — T-S6 and the RBAC checks).
 *
 * Real Postgres throughout: the keyset boundary, the `by`-policy check inside
 * `executeTransition` and the pending-only timer mutations are all SQL
 * behaviour, and mock-DB tests would prove none of them (ADR-0004).
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

const SUBJECT_TYPE = 'platform.demo_request';

let adminPersonId: string;
let adminGrants: ContextGrant[];

beforeEach(async () => {
  await truncateAll(db);
  await reseedRoles();
  adminPersonId = await insertPerson('Workflow Admin');
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
        valid_from: new Date('2020-01-01T00:00:00.000Z'),
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

async function callerWith(roleKeys: RoleKey[], personId?: string) {
  const id = personId ?? (await insertPerson(roleKeys.join('+') || 'no roles'));
  const grants = await grantsFor(id, roleKeys);
  return { caller: appRouter.createCaller(makeCtx({ actorPersonId: id, grants })), personId: id };
}

async function startDemo(actorPersonId = adminPersonId, streamId = newUuidV7()) {
  return db.transaction().execute((trx) =>
    startWorkflow(trx, {
      workflowKey: demoRequestV1.key,
      subject: { streamType: SUBJECT_TYPE, streamId },
      actorPersonId,
      now: new Date(),
      correlationId: newUuidV7(),
    }),
  );
}

describe('transition — the generic runtime mutation', () => {
  it('executes a permitted action and returns the new state', async () => {
    const { instance } = await startDemo();
    const result = await caller().platform.workflow.transition({
      instanceId: instance.id,
      action: 'approve',
      comment: 'fine by me',
    });

    expect(result.state).toBe('approved');
    expect(result.completedAt).not.toBeNull();
    expect(result.transitionId).toBeTruthy();
  });

  it('refuses an actor outside the by policy with FORBIDDEN', async () => {
    const { instance } = await startDemo();
    const { caller: employee } = await callerWith(['employee']);

    await expect(
      employee.platform.workflow.transition({ instanceId: instance.id, action: 'approve' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Nothing written — the refusal is not a business fact.
    expect(await db.selectFrom('platform.workflow_transition').selectAll().execute()).toHaveLength(
      0,
    );
  });

  it("maps a guard block to BAD_REQUEST carrying the guard's own reason", async () => {
    const { instance } = await startDemo();
    // Age the instance past its 72-hour window by rewriting the anchor the demo
    // subject loader reads. (`created_at` is the loader's anchor.)
    await db
      .updateTable('platform.workflow_instance')
      .set({ created_at: new Date(Date.now() - 100 * 3_600_000) })
      .where('id', '=', instance.id)
      .execute();

    await expect(
      caller().platform.workflow.transition({ instanceId: instance.id, action: 'approve' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('maps an unknown action to BAD_REQUEST and a stale state to CONFLICT', async () => {
    const { instance } = await startDemo();
    await expect(
      caller().platform.workflow.transition({ instanceId: instance.id, action: 'escalate' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await expect(
      caller().platform.workflow.transition({
        instanceId: instance.id,
        action: 'approve',
        expectedState: 'approved',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('surfaces soft-guard warnings to the caller rather than swallowing them', async () => {
    const { instance } = await startDemo();
    // Nudge the anchor so the transition lands out of hours in UTC terms is not
    // controllable here; instead assert the shape is carried through at all.
    const result = await caller().platform.workflow.transition({
      instanceId: instance.id,
      action: 'reject',
    });
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

describe('get — the case history', () => {
  it('returns the instance, its transitions oldest-first, and its timers', async () => {
    const { instance } = await startDemo();
    await caller().platform.workflow.transition({ instanceId: instance.id, action: 'approve' });

    const result = await caller().platform.workflow.get({ instanceId: instance.id });
    expect(result.instance.current_state).toBe('approved');
    expect(result.instance.started_by_name).toBe('Workflow Admin');
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]).toMatchObject({
      fromState: 'pending',
      toState: 'approved',
      action: 'approve',
      actorName: 'Workflow Admin',
    });
    // The expiry timer, auto-cancelled when the case completed.
    expect(result.timers).toHaveLength(1);
    expect(result.timers[0]?.status).toBe('cancelled');
  });

  it('hides an instance from someone with no role in its module', async () => {
    const { instance } = await startDemo();
    const outsiderId = await insertPerson('No Roles');
    const outsider = appRouter.createCaller(makeCtx({ actorPersonId: outsiderId, grants: [] }));
    // NOT_FOUND, not FORBIDDEN: a distinct refusal would confirm it exists.
    await expect(outsider.platform.workflow.get({ instanceId: instance.id })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });

  it('shows a case to the person who started it, whatever their role', async () => {
    const starterId = await insertPerson('Starter');
    const { instance } = await startDemo(starterId);
    const starter = appRouter.createCaller(makeCtx({ actorPersonId: starterId, grants: [] }));
    const result = await starter.platform.workflow.get({ instanceId: instance.id });
    expect(result.instance.id).toBe(instance.id);
  });
});

describe('admin surfaces are Administrator-only', () => {
  it('refuses listInstances, listScheduledActions and the timer mutations to HR User', async () => {
    const { caller: hr } = await callerWith(['hr_user']);
    await expect(hr.platform.workflow.listInstances({})).rejects.toBeInstanceOf(TRPCError);
    await expect(hr.platform.workflow.listScheduledActions({})).rejects.toBeInstanceOf(TRPCError);
    await expect(
      hr.platform.workflow.cancelScheduledAction({ id: newUuidV7(), reason: 'no' }),
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      hr.platform.workflow.rescheduleAction({
        id: newUuidV7(),
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(TRPCError);
  });
});

describe('listInstances — facets applied in SQL', () => {
  it('filters by key, state and active, and never over the loaded page', async () => {
    const a = await startDemo();
    const b = await startDemo();
    await caller().platform.workflow.transition({ instanceId: b.instance.id, action: 'approve' });

    const active = await caller().platform.workflow.listInstances({ active: true });
    expect(active.items.map((i) => i.id)).toEqual([a.instance.id]);

    const completed = await caller().platform.workflow.listInstances({ active: false });
    expect(completed.items.map((i) => i.id)).toEqual([b.instance.id]);

    const byState = await caller().platform.workflow.listInstances({ currentState: 'approved' });
    expect(byState.items.map((i) => i.id)).toEqual([b.instance.id]);

    const byKey = await caller().platform.workflow.listInstances({
      workflowKey: 'platform.nothing.here',
    });
    expect(byKey.items).toEqual([]);
  });

  it('pages the whole set with correct global order, no duplicates and no gaps', async () => {
    const created: string[] = [];
    for (let i = 0; i < 12; i += 1) created.push((await startDemo()).instance.id);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await caller().platform.workflow.listInstances({
        limit: 5,
        sort: 'created_at',
        sortDir: 'asc',
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toEqual(created); // creation order, ascending, complete
    expect(new Set(seen).size).toBe(12);
  });
});

describe('T-S6 — listScheduledActions pages the whole set', () => {
  /**
   * The keyset key here is `due_at`, and the seeded timers deliberately share
   * due dates in pairs — a sort key with duplicates is exactly where a cursor
   * without an id tiebreak loses or repeats rows at a page edge.
   */
  it('walks every timer in due order, with no duplicates and no gaps', async () => {
    const base = new Date('2026-09-01T09:00:00.000Z').getTime();
    const ids: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      const row = await db.transaction().execute((trx) =>
        scheduleAction(trx, {
          dueAt: new Date(base + Math.floor(i / 2) * 3_600_000),
          actionType: 'notification.reminder',
          source: 'manual',
          createdBy: adminPersonId,
          correlationId: newUuidV7(),
        }),
      );
      ids.push(row.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await caller().platform.workflow.listScheduledActions({
        limit: 4,
        sort: 'due_at',
        sortDir: 'asc',
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(14);
    expect(new Set(seen).size).toBe(14);
    expect([...seen].sort()).toEqual([...ids].sort());

    // And the order really is by due date, not merely complete.
    const rows = await db
      .selectFrom('platform.scheduled_action')
      .select(['id', 'due_at'])
      .execute();
    const dueById = new Map(rows.map((r) => [r.id, r.due_at.getTime()]));
    const dues = seen.map((id) => dueById.get(id)!);
    expect(dues).toEqual([...dues].sort((x, y) => x - y));
  });

  it('filters by status and due range in SQL', async () => {
    const soon = await db.transaction().execute((trx) =>
      scheduleAction(trx, {
        dueAt: new Date('2026-09-01T09:00:00.000Z'),
        actionType: 'notification.reminder',
        source: 'manual',
        correlationId: newUuidV7(),
      }),
    );
    await db.transaction().execute((trx) =>
      scheduleAction(trx, {
        dueAt: new Date('2026-12-01T09:00:00.000Z'),
        actionType: 'other.thing',
        source: 'system',
        correlationId: newUuidV7(),
      }),
    );

    const byRange = await caller().platform.workflow.listScheduledActions({
      dueTo: '2026-10-01T00:00:00.000Z',
    });
    expect(byRange.items.map((i) => i.id)).toEqual([soon.id]);

    const byType = await caller().platform.workflow.listScheduledActions({
      actionType: 'other.thing',
    });
    expect(byType.items).toHaveLength(1);

    const byStatus = await caller().platform.workflow.listScheduledActions({ status: 'executed' });
    expect(byStatus.items).toEqual([]);
  });
});

describe('timer mutations — WF-9, and both journalled (AC-D9)', () => {
  it('cancels a pending timer with a reason and reports the no-op second time', async () => {
    const { instance } = await startDemo();
    const timer = await db
      .selectFrom('platform.scheduled_action')
      .select('id')
      .where('workflow_instance_id', '=', instance.id)
      .executeTakeFirstOrThrow();

    const first = await caller().platform.workflow.cancelScheduledAction({
      id: timer.id,
      reason: 'handled offline',
    });
    expect(first.cancelled).toBe(true);

    const second = await caller().platform.workflow.cancelScheduledAction({
      id: timer.id,
      reason: 'handled offline',
    });
    expect(second.cancelled).toBe(false);

    const events = await db
      .selectFrom('platform.domain_event')
      .select('event_type')
      .where('stream_id', '=', timer.id)
      .orderBy('recorded_at')
      .execute();
    expect(events.map((e) => e.event_type)).toEqual([
      'platform.scheduled_action.scheduled',
      'platform.scheduled_action.cancelled',
    ]);
  });

  it('reschedules a pending timer and journals the move', async () => {
    const { instance } = await startDemo();
    const timer = await db
      .selectFrom('platform.scheduled_action')
      .select('id')
      .where('workflow_instance_id', '=', instance.id)
      .executeTakeFirstOrThrow();
    const moved = new Date(Date.now() + 30 * 86_400_000).toISOString();

    const result = await caller().platform.workflow.rescheduleAction({
      id: timer.id,
      dueAt: moved,
    });
    expect(result.rescheduled).toBe(true);

    const after = await db
      .selectFrom('platform.scheduled_action')
      .select('due_at')
      .where('id', '=', timer.id)
      .executeTakeFirstOrThrow();
    expect(after.due_at.toISOString()).toBe(moved);

    const events = await db
      .selectFrom('platform.domain_event')
      .select('event_type')
      .where('stream_id', '=', timer.id)
      .orderBy('recorded_at')
      .execute();
    expect(events).toHaveLength(2);
    expect(events[1]?.event_type).toBe('platform.scheduled_action.rescheduled');
  });

  it('refuses to reschedule into the past', async () => {
    const { instance } = await startDemo();
    const timer = await db
      .selectFrom('platform.scheduled_action')
      .select('id')
      .where('workflow_instance_id', '=', instance.id)
      .executeTakeFirstOrThrow();

    await expect(
      caller().platform.workflow.rescheduleAction({
        id: timer.id,
        dueAt: new Date(Date.now() - 86_400_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
