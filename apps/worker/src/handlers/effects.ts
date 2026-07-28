import { ACCESS_EXPIRY_SWEEP_SUBJECT, runAccessExpirySweep } from './identity-access-expiry.js';
import { DUPLICATE_SCAN_SUBJECT, runDuplicateScan } from './identity-duplicate-scan.js';
import type { SubscriptionHandler } from '../types.js';

/**
 * The `effects` queue carries scheduled sweep **commands** (not domain events);
 * an ACA cron Job enqueues them daily (task 9.3-8). It is a single
 * competing-consumer queue, so one receiver dispatches by the message `subject`
 * to the right behaviour. When plan 07's `scheduled_action` mechanism lands, the
 * enqueue side migrates onto it; this dispatcher is unchanged.
 */
export const effectsHandler: SubscriptionHandler = async (message, ctx) => {
  switch (message.subject) {
    case ACCESS_EXPIRY_SWEEP_SUBJECT:
      await runAccessExpirySweep(ctx);
      return;
    case DUPLICATE_SCAN_SUBJECT:
      await runDuplicateScan(ctx);
      return;
    default:
      // Unknown command — complete it (don't dead-letter a message we simply
      // don't own) but record it, so a misrouted subject is visible.
      ctx.logger.warn('effects: unknown command subject', { subject: message.subject });
  }
};
