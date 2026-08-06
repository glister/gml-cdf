import { effectEnvelopeSchema, requireEffect, UnknownEffectError } from '@repo/workflow';
import { ACCESS_EXPIRY_SWEEP_SUBJECT, runAccessExpirySweep } from './identity-access-expiry.js';
import { DUPLICATE_SCAN_SUBJECT, runDuplicateScan } from './identity-duplicate-scan.js';
import { PoisonMessageError, type SubscriptionHandler } from '../types.js';

/**
 * The `effects` queue consumer (core plan 07 §5.4, WF-7).
 *
 * One competing-consumer queue carries everything the platform does *after* a
 * fact is committed: the effects a transition fanned out via the relay, and the
 * timers the scheduler drained. This handler is only a dispatcher — it resolves
 * the effect name in `@repo/workflow`'s registry and hands over. That is what
 * lets plans 08/09/10 add `tasks.*`, `approval.*` and `notification.*` handlers
 * without touching the worker.
 *
 * ## Two message shapes, deliberately
 *
 * The normal shape is an **effect envelope** in the body, carrying the
 * deterministic idempotency root every handler keys on.
 *
 * The second is a bare command with only a `subject` — plan 03's daily identity
 * sweeps, enqueued by their own ACA cron Job. They pre-date this mechanism and
 * are dispatched by subject into the same behaviours, so plan 03's job keeps
 * working untouched while dispatch is unified here. When those sweeps migrate
 * onto `scheduled_action` rows, this branch goes away and nothing else changes.
 *
 * ## Failure semantics
 *
 * - Handler throws ⇒ message abandoned ⇒ Service Bus redelivers with backoff up
 *   to `max_delivery_count`, then dead-letters. Right for transient failures.
 * - **Unknown effect ⇒ dead-letter immediately.** No amount of redelivery
 *   conjures a handler, and ten futile retries only delay the alert on the DLQ.
 * - Each effect is its own message, so one poison effect never blocks its
 *   siblings — which is exactly why a transition's effects are not batched.
 */
const sweeps: Record<string, SubscriptionHandler> = {
  [ACCESS_EXPIRY_SWEEP_SUBJECT]: (_message, ctx) => runAccessExpirySweep(ctx),
  [DUPLICATE_SCAN_SUBJECT]: (_message, ctx) => runDuplicateScan(ctx),
};

export const effectsHandler: SubscriptionHandler = async (message, ctx) => {
  const envelope = effectEnvelopeSchema.safeParse(message.body);

  if (!envelope.success) {
    // Not an effect envelope — the legacy sweep-command shape (see above).
    const sweep = sweeps[message.subject ?? ''];
    if (sweep) {
      await sweep(message, ctx);
      return;
    }
    throw new PoisonMessageError(
      `unrecognised message on the effects queue (subject '${message.subject ?? '(none)'}'): neither an effect envelope nor a known sweep command`,
    );
  }

  const { effect, source } = envelope.data;
  let handler;
  try {
    handler = requireEffect(effect);
  } catch (error) {
    if (error instanceof UnknownEffectError) {
      throw new PoisonMessageError(
        `no handler registered for effect '${effect}' — register it with registerEffect() in the owning plan's package`,
      );
    }
    throw error;
  }

  await handler(envelope.data, ctx);
  ctx.logger.info('effect executed', { effect, source: source.kind });
};
