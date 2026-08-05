import { sql, type Kysely } from 'kysely';
import type { DB } from '@repo/db';
import { effectIdempotencyKey, effectMessageId, type EffectEnvelope } from './effects/types.js';

/**
 * The scheduler's SQL half (core plan 07 §5.5, WF-8) — claim the timers that are
 * due, hand them to a sender, mark them enqueued.
 *
 * It lives here rather than in `apps/worker` for the same reason
 * `relayOutboxBatch` lives in `@repo/db`: this is transactional SQL whose
 * correctness (`FOR UPDATE SKIP LOCKED`, the pending-guard on the stamp) can
 * only be proven against real Postgres, and keeping it in a package means the
 * worker's own suites stay pure orchestration with no database. The worker
 * composes it with the Service Bus sender and the loop.
 *
 * **Why a cron Job draining a table, rather than broker-scheduled messages.**
 * ADR-0013 chose DB-backed timers precisely so pending ones are queryable,
 * amendable and cancellable — none of which a broker's `scheduledEnqueueTime`
 * offers. The price is firing latency bounded by the cron cadence (~5 minutes),
 * which every Phase 1 cadence tolerates: they are all day-granular.
 *
 * **At-least-once, by construction.** Send happens inside the transaction that
 * stamps `enqueued`; a crash between the two rolls the stamp back and the next
 * run re-sends with the *same* deterministic `MessageId`. Duplicate detection
 * absorbs the common case and the handler's own idempotency guard absorbs the
 * rest. The opposite order — stamp then send — would lose timers outright,
 * which is the failure nobody notices until a reminder never arrives.
 */

/** One run claims at most this many rows per batch; the loop repeats until dry. */
export const SCHEDULER_BATCH_SIZE = 200;

export interface DueAction {
  id: string;
  actionType: string;
  envelope: EffectEnvelope;
  messageId: string;
}

/**
 * Claim one batch of due timers, send them, and stamp `enqueued` — all in one
 * transaction.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes overlapping runs safe: a second
 * scheduler replica (or a run that overlaps its predecessor because the previous
 * batch ran long) skips the locked rows rather than blocking on them or, worse,
 * double-picking them.
 *
 * Returns the number of rows enqueued; 0 means the queue is drained.
 */
export async function drainDueActions(
  db: Kysely<DB>,
  limit: number,
  send: (actions: DueAction[]) => Promise<void>,
  now?: Date,
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('platform.scheduled_action')
      .selectAll()
      .where('status', '=', 'pending')
      .where('due_at', '<=', now ?? sql<Date>`now()`)
      .orderBy('due_at')
      .orderBy('id')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();

    if (rows.length === 0) return 0;

    const actions: DueAction[] = rows.map((row) => {
      const source = { kind: 'scheduled_action' as const, scheduledActionId: row.id };
      const envelope: EffectEnvelope = {
        effect: row.action_type,
        params: {
          ...(row.payload as Record<string, never>),
          // Timers that fire a transition need the instance; carrying it here
          // rather than making every handler re-read the row keeps the built-in
          // `workflow.transition` handler a pure function of its envelope.
          ...(row.workflow_instance_id ? { workflowInstanceId: row.workflow_instance_id } : {}),
        },
        source,
        subject: {
          streamType: row.subject_stream_type ?? 'platform.scheduled_action',
          streamId: row.subject_stream_id ?? row.id,
        },
        // A timer's cascade is its own: the row id is a UUIDv7 and serves as the
        // correlation root for everything the firing goes on to cause.
        correlationId: effectIdempotencyKey(source),
      };
      return {
        id: row.id,
        actionType: row.action_type,
        envelope,
        messageId: effectMessageId(source, row.action_type),
      };
    });

    await send(actions);

    // Stamp only what is still pending — belt and braces against a cancel that
    // committed between the claim and here (it cannot, given the row lock, but
    // the predicate costs nothing and documents the invariant).
    await trx
      .updateTable('platform.scheduled_action')
      .set({ status: 'enqueued', enqueued_at: sql`now()` })
      .where(
        'id',
        'in',
        actions.map((a) => a.id),
      )
      .where('status', '=', 'pending')
      .execute();

    return actions.length;
  });
}

/**
 * Mark a scheduled action executed — **only if it is still `enqueued`**.
 *
 * This is the second and real idempotency layer for timer-sourced effects
 * (§5.4): duplicate detection has a finite window, but this UPDATE matches zero
 * rows on a re-delivery however late it arrives. Returns `true` the first time,
 * `false` on a duplicate, so a handler can decide in one round trip whether to
 * do its work.
 */
export async function markScheduledActionExecuted(
  db: Kysely<DB>,
  scheduledActionId: string,
): Promise<boolean> {
  const row = await db
    .updateTable('platform.scheduled_action')
    .set({ status: 'executed', executed_at: sql`now()` })
    .where('id', '=', scheduledActionId)
    .where('status', '=', 'enqueued')
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}
