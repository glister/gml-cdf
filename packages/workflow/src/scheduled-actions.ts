import type { Selectable, Transaction } from 'kysely';
import { appendEvent, newUuidV7, type DB, type PlatformScheduledAction } from '@repo/db';
import { isConfiguredDelay, type DelaySpec, type JsonObject, type ScheduleRef } from '@repo/domain';

/**
 * The `platform.scheduled_action` write path (core plan 07 §5.2, WF-8/WF-9) —
 * the single door through which every timer in the platform is created,
 * amended and cancelled (ADR-0022).
 *
 * Each function takes a `Transaction<DB>`, so a timer and the journal event that
 * explains it commit together, and so a transition can create its timers in the
 * same transaction as the state change that warranted them (ADR-0010). There is
 * no `db`-taking variant on purpose: a timer created outside the transaction of
 * the fact that caused it can outlive a rollback, and the resulting orphan fires
 * days later against a case that never happened.
 *
 * Cancellation and rescheduling are **no-ops on anything but a pending row**,
 * and say so in their return value rather than throwing. A timer that has
 * already fired cannot be recalled, and a redelivered cancel must not raise —
 * the caller is usually a terminal transition sweeping up after itself, and it
 * has no way to know whether the scheduler got there first.
 */

export type ScheduledActionRecord = Selectable<PlatformScheduledAction>;

const MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

/**
 * Compute a timer's due instant from an anchor and a declared delay.
 *
 * `config` holds the already-resolved decision-point values keyed by qualified
 * name — the runtime resolves them as-at the anchor, so a lead time that was
 * changed yesterday applies to timers created today and leaves yesterday's
 * where they are. A configured delay that failed to resolve to a number throws:
 * silently substituting a default would schedule a business deadline at a time
 * nobody chose (ADR-0016 fail-fast).
 */
export function dueAtFor(
  anchor: Date,
  delay: DelaySpec,
  config: Readonly<Record<string, unknown>>,
): Date {
  let amount: unknown;
  if (isConfiguredDelay(delay)) {
    const name = delay.configRef.slice('config:'.length);
    amount = config[name];
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new Error(
        `timer lead time '${delay.configRef}' did not resolve to a number — refusing to schedule at a guessed instant`,
      );
    }
  } else {
    amount = delay.amount;
  }
  return new Date(anchor.getTime() + (amount as number) * MS[delay.unit]);
}

export interface ScheduleActionInput {
  dueAt: Date;
  /** An effect-registry name — a timer is a deferred effect. */
  actionType: string;
  /** Ids and parameters only (ADR-0019). */
  payload?: JsonObject;
  subject?: { streamType: string; streamId: string } | null;
  workflowInstanceId?: string | null;
  /** Who created it: a workflow definition, an administrator, or the system. */
  source: ScheduledActionRecord['source'];
  createdBy?: string | null;
  correlationId: string;
}

/**
 * Create one timer and journal `platform.scheduled_action.scheduled`.
 *
 * The row's `id` is generated app-side and doubles as the Service Bus
 * `MessageId` (`sa:{id}`), so duplicate detection is available from the moment
 * the row exists rather than being invented at send time.
 */
export async function scheduleAction(
  trx: Transaction<DB>,
  input: ScheduleActionInput,
): Promise<ScheduledActionRecord> {
  const id = newUuidV7();
  const row = await trx
    .insertInto('platform.scheduled_action')
    .values({
      id,
      due_at: input.dueAt,
      action_type: input.actionType,
      payload: JSON.stringify(input.payload ?? {}) as never,
      subject_stream_type: input.subject?.streamType ?? null,
      subject_stream_id: input.subject?.streamId ?? null,
      workflow_instance_id: input.workflowInstanceId ?? null,
      source: input.source,
      created_by: input.createdBy ?? null,
      updated_by: input.createdBy ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendEvent(trx, {
    streamType: 'platform.scheduled_action',
    streamId: id,
    eventType: 'platform.scheduled_action.scheduled',
    payload: {
      actionType: input.actionType,
      dueAt: input.dueAt.toISOString(),
      workflowInstanceId: input.workflowInstanceId ?? null,
      subjectStreamType: input.subject?.streamType ?? null,
      subjectStreamId: input.subject?.streamId ?? null,
      source: input.source,
    },
    actorPersonId: input.createdBy ?? null,
    correlationId: input.correlationId,
  });

  return row;
}

/** The built-in effect that fires a workflow action when a timer comes due. */
export const WORKFLOW_TRANSITION_EFFECT = 'workflow.transition';

/**
 * Create every timer a definition's `schedule`/`initialSchedule` declares.
 *
 * Timers that fire a transition are stamped with `expectedState` — the state
 * being entered as the timer is created. That single field is what makes a stale
 * timer harmless: if a human decides before the deadline, the case has moved on,
 * the optimistic check fails, and the firing is a recorded no-op instead of
 * dragging a settled case backwards (§5.4, AC-D7). The runtime knows the state;
 * the definition author should not have to remember to say it.
 */
export async function scheduleRefs(
  trx: Transaction<DB>,
  refs: readonly ScheduleRef[],
  common: {
    anchor: Date;
    config: Readonly<Record<string, unknown>>;
    subject: { streamType: string; streamId: string };
    workflowInstanceId: string;
    /** The state the instance is entering as these timers are created. */
    enteringState: string;
    createdBy: string | null;
    correlationId: string;
  },
): Promise<ScheduledActionRecord[]> {
  const created: ScheduledActionRecord[] = [];
  for (const ref of refs) {
    const params =
      ref.actionType === WORKFLOW_TRANSITION_EFFECT
        ? { expectedState: common.enteringState, ...ref.params }
        : ref.params;
    created.push(
      await scheduleAction(trx, {
        dueAt: dueAtFor(common.anchor, ref.delay, common.config),
        actionType: ref.actionType,
        payload: params,
        subject: common.subject,
        workflowInstanceId: common.workflowInstanceId,
        source: 'workflow',
        createdBy: common.createdBy,
        correlationId: common.correlationId,
      }),
    );
  }
  return created;
}

export interface CancelScheduledActionInput {
  id: string;
  reason: string;
  actorPersonId?: string | null;
  correlationId: string;
}

/**
 * Cancel one pending timer. Returns `false` when there was nothing pending to
 * cancel — already executed, already cancelled, or never existed. **No event is
 * emitted in that case**: an event asserting a cancellation that did not happen
 * would be noise in the audit trail and in the reporting feed.
 */
export async function cancelScheduledAction(
  trx: Transaction<DB>,
  input: CancelScheduledActionInput,
): Promise<boolean> {
  // Guard on `status = 'pending'` inside the UPDATE, not in a prior SELECT: that
  // makes "cancel only if still pending" one atomic step, so a cancel racing the
  // scheduler's claim cannot both win.
  const row = await trx
    .updateTable('platform.scheduled_action')
    .set({
      status: 'cancelled',
      cancelled_at: new Date(),
      cancel_reason: input.reason,
      updated_by: input.actorPersonId ?? null,
    })
    .where('id', '=', input.id)
    .where('status', '=', 'pending')
    .returning(['id', 'action_type', 'workflow_instance_id'])
    .executeTakeFirst();

  if (!row) return false;

  await appendEvent(trx, {
    streamType: 'platform.scheduled_action',
    streamId: row.id,
    eventType: 'platform.scheduled_action.cancelled',
    payload: {
      actionType: row.action_type,
      reason: input.reason,
      workflowInstanceId: row.workflow_instance_id,
    },
    actorPersonId: input.actorPersonId ?? null,
    correlationId: input.correlationId,
  });

  return true;
}

export interface CancelScheduledActionsInput {
  workflowInstanceId?: string;
  subject?: { streamType: string; streamId: string };
  actionType?: string;
  reason: string;
  actorPersonId?: string | null;
  correlationId: string;
}

/**
 * Cancel every pending timer matching the given selector — the "a human got
 * there before the chaser" sweep a terminal transition performs on itself
 * (§5.2 step 6), and the one an administrator triggers for a whole subject.
 *
 * At least one selector is required: an unfiltered bulk cancel would silently
 * empty the platform's entire timer queue.
 */
export async function cancelScheduledActions(
  trx: Transaction<DB>,
  input: CancelScheduledActionsInput,
): Promise<number> {
  if (!input.workflowInstanceId && !input.subject && !input.actionType) {
    throw new Error(
      'cancelScheduledActions needs a selector (workflowInstanceId, subject or actionType) — an unfiltered cancel would empty the timer queue',
    );
  }

  let query = trx
    .selectFrom('platform.scheduled_action')
    .select('id')
    .where('status', '=', 'pending');
  if (input.workflowInstanceId) {
    query = query.where('workflow_instance_id', '=', input.workflowInstanceId);
  }
  if (input.subject) {
    query = query
      .where('subject_stream_type', '=', input.subject.streamType)
      .where('subject_stream_id', '=', input.subject.streamId);
  }
  if (input.actionType) query = query.where('action_type', '=', input.actionType);

  const pending = await query.execute();

  let cancelled = 0;
  for (const { id } of pending) {
    // One at a time through the single-row path, so each cancellation gets its
    // own journal event and the trail says exactly which timers were dropped.
    const done = await cancelScheduledAction(trx, {
      id,
      reason: input.reason,
      actorPersonId: input.actorPersonId,
      correlationId: input.correlationId,
    });
    if (done) cancelled += 1;
  }
  return cancelled;
}

export interface RescheduleActionInput {
  id: string;
  dueAt: Date;
  actorPersonId?: string | null;
  correlationId: string;
}

/**
 * Move a pending timer's due date. Returns `false` if it was not pending —
 * a fired timer cannot be un-fired, and a cancelled one is not resurrected by
 * giving it a new date.
 */
export async function rescheduleAction(
  trx: Transaction<DB>,
  input: RescheduleActionInput,
): Promise<boolean> {
  const before = await trx
    .selectFrom('platform.scheduled_action')
    .select(['id', 'action_type', 'due_at', 'workflow_instance_id'])
    .where('id', '=', input.id)
    .where('status', '=', 'pending')
    .forUpdate()
    .executeTakeFirst();

  if (!before) return false;

  await trx
    .updateTable('platform.scheduled_action')
    .set({ due_at: input.dueAt, updated_by: input.actorPersonId ?? null })
    .where('id', '=', input.id)
    .where('status', '=', 'pending')
    .execute();

  await appendEvent(trx, {
    streamType: 'platform.scheduled_action',
    streamId: before.id,
    eventType: 'platform.scheduled_action.rescheduled',
    payload: {
      actionType: before.action_type,
      fromDueAt: before.due_at.toISOString(),
      toDueAt: input.dueAt.toISOString(),
      workflowInstanceId: before.workflow_instance_id,
    },
    actorPersonId: input.actorPersonId ?? null,
    correlationId: input.correlationId,
  });

  return true;
}
