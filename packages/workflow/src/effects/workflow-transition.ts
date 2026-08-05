import { z } from 'zod';
import { markScheduledActionExecuted } from '../scheduler.js';
import { executeTransition } from '../runtime.js';
import { registerEffect, type EffectHandler } from './registry.js';
import { WORKFLOW_TRANSITION_EFFECT } from '../scheduled-actions.js';

/**
 * `workflow.transition` — the built-in effect that lets a timer drive a case
 * forward (core plan 07 §5.4, WF-8).
 *
 * It is what turns "expire this request after 72 hours", "chase the fit note on
 * day 7" and "close the probation review window" into definitions rather than
 * bespoke jobs: a `schedule` ref on a transition, and this handler on the far
 * side of the queue.
 *
 * ## Why a stale firing is a no-op and not an error
 *
 * A timer says what should happen *if nothing else does first*. Usually
 * something else does: someone approves the request, the fit note arrives, the
 * review happens. The timer still fires, because cancellation and firing race by
 * nature, and the honest answer then is "nothing to do" — not a failure, not a
 * retry, and emphatically not dragging a settled case backwards.
 *
 * `expectedState` (stamped when the timer was created) makes that a single
 * optimistic check: the runtime returns `CONFLICT`, and this handler records it
 * and completes the message. Redelivery is equally harmless, because the second
 * attempt sees the same moved-on state.
 */

const paramsSchema = z.object({
  workflowInstanceId: z.uuid(),
  action: z.string().min(1),
  /** The state the instance was in when the timer was created. */
  expectedState: z.string().optional(),
});

export const workflowTransitionEffect: EffectHandler = async (envelope, { db, logger }) => {
  const params = paramsSchema.parse(envelope.params);
  const scheduledActionId =
    envelope.source.kind === 'scheduled_action' ? envelope.source.scheduledActionId : null;

  const result = await executeTransition(db, {
    instanceId: params.workflowInstanceId,
    action: params.action,
    // A timer has no person behind it. `{ system: true }` transitions are the
    // only ones it may take, and the runtime enforces that.
    actorPersonId: null,
    ...(params.expectedState === undefined ? {} : { expectedState: params.expectedState }),
    now: new Date(),
    correlationId: envelope.correlationId,
  });

  if (result.ok) {
    logger.info('workflow.transition effect executed', {
      instanceId: params.workflowInstanceId,
      action: params.action,
      to: result.instance.current_state,
    });
  } else if (result.code === 'CONFLICT' || result.code === 'NOT_FOUND') {
    // Superseded, already fired, or the instance is gone. Expected, not
    // exceptional: log it and complete the message.
    logger.info('workflow.transition effect superseded — no-op', {
      instanceId: params.workflowInstanceId,
      action: params.action,
      code: result.code,
      detail: result.detail,
    });
  } else {
    // GUARD_BLOCKED / FORBIDDEN / UNKNOWN_ACTION are definition or configuration
    // problems: retrying will not fix them, so complete the message and leave a
    // record loud enough to be alerted on rather than dead-lettering silently.
    logger.error('workflow.transition effect refused', {
      instanceId: params.workflowInstanceId,
      action: params.action,
      code: result.code,
      detail: result.detail,
    });
  }

  // Stamp the timer executed regardless of outcome: it *did* fire, and "fired
  // and found nothing to do" is still fired. Guarded on `status = 'enqueued'`,
  // so a redelivery matches zero rows — the generic second idempotency layer
  // behind the `expectedState` check above (§5.4).
  if (scheduledActionId) await markScheduledActionExecuted(db, scheduledActionId);
};

registerEffect(WORKFLOW_TRANSITION_EFFECT, workflowTransitionEffect);
