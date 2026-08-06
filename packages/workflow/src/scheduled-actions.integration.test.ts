import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, newUuidV7 } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import { demoRequestV1 } from '@repo/domain';
import { DEMO_SUBJECT_STREAM_TYPE } from './demo.js';
import { startWorkflow } from './runtime.js';
import {
  cancelScheduledAction,
  cancelScheduledActions,
  dueAtFor,
  rescheduleAction,
  scheduleAction,
} from './scheduled-actions.js';
import { drainDueActions, markScheduledActionExecuted, type DueAction } from './scheduler.js';
import { eventsFor, grant, insertPerson, reseedRoles } from './test-helpers.js';

/**
 * Timers: the write path, the scheduler's claim, and the crash window
 * (core plan 07 §10 — T-S1…T-S5).
 *
 * `FOR UPDATE SKIP LOCKED` and the pending-guards on every mutation are the
 * whole design here, and neither is observable without a real database and two
 * genuinely concurrent connections (ADR-0004).
 *
 * T-S6 (keyset paging of `listScheduledActions`) belongs to the tRPC procedure
 * and lives with it in `@repo/trpc`.
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

let actor: string;
let correlationId: string;

beforeEach(async () => {
  await truncateAll(db);
  await reseedRoles();
  actor = await insertPerson('Timer Admin');
  await grant(actor, 'administrator');
  correlationId = newUuidV7();
});

const MINUTE = 60_000;

/** A standalone timer, not attached to any workflow. */
async function timer(dueAt: Date, actionType = 'notification.reminder') {
  return db.transaction().execute((trx) =>
    scheduleAction(trx, {
      dueAt,
      actionType,
      payload: { note: 'x' },
      source: 'manual',
      createdBy: actor,
      correlationId,
    }),
  );
}

/** Collect what a drain would send, without a bus. */
function collector() {
  const sent: DueAction[] = [];
  return {
    sent,
    send: async (actions: DueAction[]) => {
      sent.push(...actions);
    },
  };
}

describe('dueAtFor — lead times, fixed and configured', () => {
  const anchor = new Date('2026-08-05T09:00:00.000Z');

  it('applies a fixed amount in the declared unit', () => {
    expect(dueAtFor(anchor, { unit: 'days', amount: 7 }, {}).toISOString()).toBe(
      '2026-08-12T09:00:00.000Z',
    );
    expect(dueAtFor(anchor, { unit: 'minutes', amount: 90 }, {}).toISOString()).toBe(
      '2026-08-05T10:30:00.000Z',
    );
  });

  it('reads a configured lead time from the resolved values', () => {
    expect(
      dueAtFor(
        anchor,
        { unit: 'hours', configRef: 'config:platform.workflow.demo.expiry_hours' },
        { 'platform.workflow.demo.expiry_hours': 12 },
      ).toISOString(),
    ).toBe('2026-08-05T21:00:00.000Z');
  });

  it('refuses to schedule at a guessed instant when the key did not resolve', () => {
    // Substituting a default here would put a business deadline at a time nobody
    // chose, and nothing downstream would ever notice (ADR-0016 fail-fast).
    expect(() =>
      dueAtFor(anchor, { unit: 'hours', configRef: 'config:platform.missing.key' }, {}),
    ).toThrow(/did not resolve to a number/);
  });
});

describe('T-S1 — the scheduler claims only pending rows that are actually due', () => {
  it('leaves future, cancelled and already-enqueued rows alone', async () => {
    const now = new Date();
    const due = await timer(new Date(now.getTime() - MINUTE));
    const exactlyNow = await timer(now);
    await timer(new Date(now.getTime() + 10 * MINUTE)); // not yet
    const cancelled = await timer(new Date(now.getTime() - MINUTE));
    await db
      .transaction()
      .execute((trx) =>
        cancelScheduledAction(trx, { id: cancelled.id, reason: 'not wanted', correlationId }),
      );

    const { sent, send } = collector();
    const count = await drainDueActions(db, 100, send, now);

    expect(count).toBe(2);
    expect(sent.map((a) => a.id).sort()).toEqual([due.id, exactlyNow.id].sort());

    const after = await db
      .selectFrom('platform.scheduled_action')
      .select(['id', 'status'])
      .execute();
    const byId = new Map(after.map((r) => [r.id, r.status]));
    expect(byId.get(due.id)).toBe('enqueued');
    expect(byId.get(cancelled.id)).toBe('cancelled');
  });

  it('returns 0 when nothing is due', async () => {
    await timer(new Date(Date.now() + 60 * MINUTE));
    const { send } = collector();
    expect(await drainDueActions(db, 100, send)).toBe(0);
  });
});

describe('T-S2 — two concurrent drains never double-pick a row', () => {
  it('splits the due rows between them, with no overlap and none lost', async () => {
    const now = new Date();
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push((await timer(new Date(now.getTime() - (i + 1) * MINUTE))).id);
    }

    const a = collector();
    const b = collector();
    // Genuinely concurrent: each `drainDueActions` opens its own transaction and
    // takes its own connection from the pool, which is what `SKIP LOCKED` needs
    // in order to mean anything.
    const [countA, countB] = await Promise.all([
      drainDueActions(db, 4, a.send, now),
      drainDueActions(db, 4, b.send, now),
    ]);

    const claimed = [...a.sent, ...b.sent].map((x) => x.id);
    expect(countA + countB).toBe(8);
    expect(new Set(claimed).size).toBe(8);
    expect(claimed.sort()).toEqual([...ids].sort());
  });
});

describe('T-S3 — the crash window re-sends with the same MessageId', () => {
  it('rolls the enqueued stamp back on a send failure, then re-sends identically', async () => {
    const now = new Date();
    const row = await timer(new Date(now.getTime() - MINUTE));

    const firstAttempt: string[] = [];
    await expect(
      drainDueActions(
        db,
        10,
        async (actions) => {
          firstAttempt.push(...actions.map((a) => a.messageId));
          // The crash: the message went out, the stamp never committed.
          throw new Error('bus unavailable');
        },
        now,
      ),
    ).rejects.toThrow('bus unavailable');

    const stillPending = await db
      .selectFrom('platform.scheduled_action')
      .select('status')
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(stillPending.status).toBe('pending');

    const { sent, send } = collector();
    await drainDueActions(db, 10, send, now);

    // Deterministic id, so the broker's duplicate detection collapses the two
    // sends into one delivery — the first idempotency layer (§5.5).
    expect(sent.map((a) => a.messageId)).toEqual(firstAttempt);
    expect(sent[0]?.messageId).toBe(`sa:${row.id}`);
  });
});

describe('T-S4 — cancelling prevents the timer from ever firing', () => {
  it('cancels a pending timer, journals it, and the drain skips it', async () => {
    const now = new Date();
    const row = await timer(new Date(now.getTime() - MINUTE));

    const cancelled = await db.transaction().execute((trx) =>
      cancelScheduledAction(trx, {
        id: row.id,
        reason: 'no longer required',
        actorPersonId: actor,
        correlationId,
      }),
    );
    expect(cancelled).toBe(true);

    const events = await eventsFor('platform.scheduled_action', row.id);
    expect(events.map((e) => e.event_type)).toEqual([
      'platform.scheduled_action.scheduled',
      'platform.scheduled_action.cancelled',
    ]);
    expect(events[1]?.payload).toMatchObject({ reason: 'no longer required' });

    const { send } = collector();
    expect(await drainDueActions(db, 10, send, now)).toBe(0);
  });

  it('cancelling twice is a no-op the second time, with no second event', async () => {
    const row = await timer(new Date(Date.now() + MINUTE));
    const cancel = () =>
      db
        .transaction()
        .execute((trx) => cancelScheduledAction(trx, { id: row.id, reason: 'x', correlationId }));

    expect(await cancel()).toBe(true);
    expect(await cancel()).toBe(false);
    expect(await eventsFor('platform.scheduled_action', row.id)).toHaveLength(2);
  });

  it('bulk cancel refuses to run without a selector', async () => {
    await expect(
      db
        .transaction()
        .execute((trx) => cancelScheduledActions(trx, { reason: 'everything', correlationId })),
    ).rejects.toThrow(/needs a selector/);
  });

  it("bulk cancel by subject drops exactly that subject's pending timers", async () => {
    const subject = { streamType: 'platform.demo_request', streamId: newUuidV7() };
    const other = { streamType: 'platform.demo_request', streamId: newUuidV7() };
    const mine = await db.transaction().execute((trx) =>
      scheduleAction(trx, {
        dueAt: new Date(Date.now() + MINUTE),
        actionType: 'notification.reminder',
        subject,
        source: 'system',
        correlationId,
      }),
    );
    const theirs = await db.transaction().execute((trx) =>
      scheduleAction(trx, {
        dueAt: new Date(Date.now() + MINUTE),
        actionType: 'notification.reminder',
        subject: other,
        source: 'system',
        correlationId,
      }),
    );

    const count = await db
      .transaction()
      .execute((trx) => cancelScheduledActions(trx, { subject, reason: 'closed', correlationId }));

    expect(count).toBe(1);
    const rows = await db
      .selectFrom('platform.scheduled_action')
      .select(['id', 'status'])
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(mine.id)).toBe('cancelled');
    expect(byId.get(theirs.id)).toBe('pending');
  });
});

describe('T-S5 — rescheduling moves a pending timer, and only a pending one', () => {
  it('moves due_at and journals the change', async () => {
    const row = await timer(new Date('2026-09-01T09:00:00.000Z'));
    const moved = new Date('2026-09-08T09:00:00.000Z');

    expect(
      await db
        .transaction()
        .execute((trx) =>
          rescheduleAction(trx, { id: row.id, dueAt: moved, actorPersonId: actor, correlationId }),
        ),
    ).toBe(true);

    const after = await db
      .selectFrom('platform.scheduled_action')
      .select('due_at')
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(after.due_at.toISOString()).toBe(moved.toISOString());

    const events = await eventsFor('platform.scheduled_action', row.id);
    expect(events.map((e) => e.event_type)).toEqual([
      'platform.scheduled_action.scheduled',
      'platform.scheduled_action.rescheduled',
    ]);
    expect(events[1]?.payload).toMatchObject({
      fromDueAt: '2026-09-01T09:00:00.000Z',
      toDueAt: moved.toISOString(),
    });
  });

  it('refuses to reschedule a timer that has already fired', async () => {
    const now = new Date();
    const row = await timer(new Date(now.getTime() - MINUTE));
    const { send } = collector();
    await drainDueActions(db, 10, send, now);
    expect(await markScheduledActionExecuted(db, row.id)).toBe(true);

    expect(
      await db.transaction().execute((trx) =>
        rescheduleAction(trx, {
          id: row.id,
          dueAt: new Date(now.getTime() + 60 * MINUTE),
          correlationId,
        }),
      ),
    ).toBe(false);
  });
});

describe('markScheduledActionExecuted — the generic second idempotency layer', () => {
  it('succeeds once and refuses every re-delivery thereafter', async () => {
    const now = new Date();
    const row = await timer(new Date(now.getTime() - MINUTE));
    const { send } = collector();
    await drainDueActions(db, 10, send, now);

    expect(await markScheduledActionExecuted(db, row.id)).toBe(true);
    expect(await markScheduledActionExecuted(db, row.id)).toBe(false);

    const after = await db
      .selectFrom('platform.scheduled_action')
      .select(['status', 'executed_at'])
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('executed');
    expect(after.executed_at).not.toBeNull();
  });

  it('will not mark a timer executed that was never enqueued', async () => {
    const row = await timer(new Date(Date.now() + 60 * MINUTE));
    expect(await markScheduledActionExecuted(db, row.id)).toBe(false);
  });
});

describe('a workflow timer carries what the transition handler needs', () => {
  it('drains with the instance id, the action and the state it expects', async () => {
    const person = await insertPerson('Starter');
    await grant(person, 'administrator');
    const past = new Date(Date.now() - 100 * 3_600_000);
    const { instance } = await db.transaction().execute((trx) =>
      startWorkflow(trx, {
        workflowKey: demoRequestV1.key,
        subject: { streamType: DEMO_SUBJECT_STREAM_TYPE, streamId: newUuidV7() },
        actorPersonId: person,
        // Started long enough ago that its 72-hour timer is already due.
        now: past,
        correlationId,
      }),
    );

    const { sent, send } = collector();
    expect(await drainDueActions(db, 10, send)).toBe(1);
    expect(sent[0]?.envelope).toMatchObject({
      effect: 'workflow.transition',
      params: {
        action: 'expire',
        expectedState: 'pending',
        workflowInstanceId: instance.id,
      },
      source: { kind: 'scheduled_action' },
    });
  });
});
