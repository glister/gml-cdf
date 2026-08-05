import { z } from 'zod';
import { appendEvent, recordConsumptionOnce } from '@repo/db';
import { demoRequestV1 } from '@repo/domain';
import { effectIdempotencyKey } from './effects/types.js';
import { registerEffect, type EffectHandler } from './effects/registry.js';
import { registerSubjectLoader } from './subjects.js';

/**
 * The runtime-side half of the pilot `platform.demo.request` shape (core plan 07
 * §4.3) — its subject loader and its one effect.
 *
 * The demo exists to prove the whole loop **without HR**: start → timer
 * scheduled → config-resolved approval with a soft warning → effect fanned onto
 * the queue → re-delivery executed once → pending timer auto-cancelled. Plans
 * 08, 09 and 10 are built against this runtime before any of them can
 * demonstrate it, so something has to.
 *
 * It is deliberately self-contained: the subject is a synthetic stream with no
 * table behind it (`subject_stream_type`/`_id` carry no foreign key, precisely
 * so a workflow can be about anything), and the loader derives everything a
 * guard needs from the instance row itself.
 */

/** The synthetic subject stream the demo shape runs against. */
export const DEMO_SUBJECT_STREAM_TYPE = 'platform.demo_request';

/**
 * The demo's subject loader. `startedAt` is the instance's own creation instant,
 * which is the anchor `demo.notExpired` measures the configured window from.
 *
 * A real loader reads the subject's table — a leave booking, an absence, an
 * onboarding case. The shape of the contract is the same either way: the loader
 * fetches, the guard decides, and the guard never sees a database handle.
 */
registerSubjectLoader(demoRequestV1.key, (_trx, instance) =>
  Promise.resolve({ startedAt: instance.created_at }),
);

const outcomeParams = z.object({ outcome: z.enum(['approved', 'rejected', 'expired']) });

/**
 * `demo.recordOutcome` — the demonstration effect, and the reference
 * implementation of the idempotency contract every registered effect owes.
 *
 * The pattern to copy is the whole body: **claim first, then act, in one
 * transaction.** `recordConsumptionOnce` inserts `(consumer, source id)` with
 * `ON CONFLICT DO NOTHING` and reports whether this delivery was the first. On a
 * re-delivery it inserts nothing, returns `false`, and the handler returns
 * having done nothing — so the message can be delivered any number of times and
 * exactly one business fact exists (AC-D6).
 *
 * The claim and the fact share a transaction, so a crash between them cannot
 * leave the effect marked done but unperformed.
 *
 * `platform.event_consumption` is reused as the claim ledger rather than a new
 * table: it exists to record "this consumer has handled this id" and that is
 * exactly what is wanted here. The `effect:` prefix on `consumer` keeps effect
 * claims from colliding with topic-subscription dedupe rows.
 */
export const demoRecordOutcomeEffect: EffectHandler = async (envelope, { db, logger }) => {
  const { outcome } = outcomeParams.parse(envelope.params);
  const idempotencyKey = effectIdempotencyKey(envelope.source);

  await db.transaction().execute(async (trx) => {
    const first = await recordConsumptionOnce(trx, 'effect:demo.recordOutcome', idempotencyKey);
    if (!first) {
      logger.info('demo.recordOutcome: duplicate delivery ignored', { idempotencyKey });
      return;
    }

    await appendEvent(trx, {
      streamType: 'platform.workflow_instance',
      streamId:
        envelope.source.kind === 'transition'
          ? envelope.source.instanceId
          : envelope.subject.streamId,
      eventType: 'platform.workflow_instance.demo_outcome_recorded',
      payload: { outcome },
      // A timer-driven outcome has no person behind it; a human decision's
      // actor is already on the transition that caused this effect.
      actorPersonId: null,
      correlationId: envelope.correlationId,
    });
  });
};

registerEffect('demo.recordOutcome', demoRecordOutcomeEffect);
