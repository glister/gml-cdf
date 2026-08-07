import { z } from 'zod';
import { recordConsumptionOnce } from '@repo/db';
import { effectIdempotencyKey, registerEffect, type EffectHandler } from '@repo/workflow';
import {
  cancelApprovalsForInstance,
  openApprovalRequest,
  ApprovalConflictError,
} from './approvals.js';

/**
 * The approval engine's workflow effects (core plan 09 §5.5, ADR-0013).
 *
 * A definition's transition **into** an awaiting-approval state names
 * `approval.open`; the runtime commits, the outbox relay fans the effect onto
 * the `effects` queue, and the worker dispatches here. The sign-off is therefore
 * sought **after** the state change that called for it, and can never be split
 * from it by a broker outage (plan 07 §5.4).
 *
 * The other half of the loop is *not* an effect: when the decisive decision
 * arrives, `decideApproval` fires the pending transition **inside its own
 * transaction** (§5.5) via `executeTransitionIn`. The asymmetry is deliberate.
 * Opening a request is a consequence of a state change and can safely follow it;
 * a decision and the case move it authorises are one fact, and an approval whose
 * case never advanced is precisely the failure this engine exists to prevent.
 *
 * ## Why these live in `@repo/trpc`
 *
 * They wrap the engine services, and those are here — the shape core plan 08
 * established and the set overview's 2026-08-05 reconciliation records.
 * `@repo/trpc` imports `@repo/workflow`, so handlers beside the runtime (as plan
 * 07's own `demo.*` effects are) would be a cycle. Registration happens at
 * module load, so the API and the worker see one registry.
 */

/** Effect-registry names, exported so a conformance test can assert them. */
export const APPROVAL_EFFECTS = {
  open: 'approval.open',
  cancel: 'approval.cancel',
} as const;

/**
 * `approval.open` parameters.
 *
 * Ids and names only (ADR-0019) — no context values ride the queue that were not
 * already on the transition. `action` is the runtime action the decisive
 * approval will fire; omitting it makes the request a pure sign-off that records
 * a decision without moving the case, which is legitimate for a definition whose
 * next step is a timer.
 */
const openParams = z.object({
  action: z.string().min(1).max(100).optional(),
  /**
   * PII-minimal facts for threshold rules and warning providers. Scalars only,
   * exactly as the `context` column requires — a queue message that could carry
   * a nested structure could carry a profile row.
   */
  context: z
    .record(
      z.string().min(1).max(100),
      z.union([z.string().max(200), z.number(), z.boolean(), z.null()]),
    )
    .optional(),
});

/**
 * Open a sign-off against the transition's subject.
 *
 * **Doubly idempotent, and both halves earn their place.** The claim ledger
 * (`recordConsumptionOnce`) stops a redelivered message doing the work twice;
 * the `approval_request_one_pending_per_subject` index stops two *different*
 * messages — a retry after a claim that rolled back, say — from opening two
 * requests for one record. The second is caught and swallowed as a no-op rather
 * than dead-lettered: a pending request for this subject already exists, which
 * is exactly the state the effect was asking for.
 */
export const openApprovalEffect: EffectHandler = async (envelope, { db, logger }) => {
  const params = openParams.parse(envelope.params);
  const now = new Date();
  const instanceId = envelope.source.kind === 'transition' ? envelope.source.instanceId : null;

  await db.transaction().execute(async (trx) => {
    const first = await recordConsumptionOnce(
      trx,
      `effect:${APPROVAL_EFFECTS.open}`,
      effectIdempotencyKey(envelope.source),
    );
    if (!first) {
      logger.info('approval.open: duplicate delivery ignored', {
        subjectType: envelope.subject.streamType,
      });
      return;
    }

    try {
      const result = await openApprovalRequest(trx, {
        subjectType: envelope.subject.streamType,
        subjectId: envelope.subject.streamId,
        context: params.context ?? {},
        workflowInstanceId: instanceId,
        workflowAction: params.action ?? null,
        // No person behind a queued effect: the actor is on the transition that
        // caused it, and the journal event carries the correlation id back to it.
        requestedBy: null,
        correlationId: envelope.correlationId,
        now,
      });

      logger.info('approval.open: opened', {
        subjectType: envelope.subject.streamType,
        autoApproved: result.autoApproved,
        notified: result.notified.length,
      });
    } catch (error) {
      if (error instanceof ApprovalConflictError) {
        logger.info('approval.open: a request is already pending for this subject', {
          subjectType: envelope.subject.streamType,
        });
        return;
      }
      throw error;
    }
  });
};

/**
 * `approval.cancel` — withdraw whatever sign-off this case was waiting on.
 *
 * Declared on a transition that abandons a case mid-approval, so a request never
 * outlives the thing it was about: a leave booking cancelled while its approval
 * is pending must not leave a manager with a decision to make about nothing.
 *
 * **Declared, not automatic.** The runtime cancels an instance's pending
 * *timers* on a terminal transition, and it would have been possible to hang
 * approval cancellation off the same hook — but `@repo/workflow` cannot import
 * this package, and more importantly not every terminal transition should do
 * this: `approve` and `reject` are terminal too, and by the time they run the
 * request is already decided. Naming it on the transitions that mean it keeps
 * the definition honest about what it does (ADR-0013).
 *
 * Idempotent twice over: the claim ledger stops a redelivery, and
 * `cancelApprovalsForInstance` only ever matches rows still `pending`.
 */
export const cancelApprovalEffect: EffectHandler = async (envelope, { db, logger }) => {
  const instanceId = envelope.source.kind === 'transition' ? envelope.source.instanceId : null;
  if (instanceId === null) {
    // A timer or manual source has no instance to cancel approvals for. Not an
    // error — a definition that declared it there simply has nothing to do.
    logger.info('approval.cancel: no workflow instance on this effect source');
    return;
  }

  await db.transaction().execute(async (trx) => {
    const first = await recordConsumptionOnce(
      trx,
      `effect:${APPROVAL_EFFECTS.cancel}`,
      effectIdempotencyKey(envelope.source),
    );
    if (!first) {
      logger.info('approval.cancel: duplicate delivery ignored', { instanceId });
      return;
    }

    const cancelled = await cancelApprovalsForInstance(trx, {
      workflowInstanceId: instanceId,
      actorPersonId: null,
      correlationId: envelope.correlationId,
      now: new Date(),
    });
    logger.info('approval.cancel: withdrew pending requests', { instanceId, cancelled });
  });
};

registerEffect(APPROVAL_EFFECTS.open, openApprovalEffect);
registerEffect(APPROVAL_EFFECTS.cancel, cancelApprovalEffect);
