import { platformDemoPinged } from '@repo/domain';
import { consumeOnce } from '../lib/consume-once.js';
import { eventEnvelopeSchema } from '../relay/envelope.js';
import type { SubscriptionHandler } from '../types.js';

/** Subscription name — also the `event_consumption.consumer` key (§5.2). */
const CONSUMER = 'pilot-demo';

/**
 * Pilot consumer (core plan 02 §5.2): parse the envelope, re-validate the
 * payload against the registry (never trust the wire), then process exactly once
 * via `consumeOnce`. Redelivery is absorbed — a duplicate leaves one
 * `event_consumption` row and runs no side effect twice (AC-D4).
 */
export const pilotDemoHandler: SubscriptionHandler = async (message, { db, logger }) => {
  const envelope = eventEnvelopeSchema.parse(message.body);
  const payload = platformDemoPinged.payloadSchema.parse(envelope.payload);

  const ran = await consumeOnce(db, CONSUMER, envelope.id, async () => {
    logger.info('pilot-demo consumed', {
      eventId: envelope.id,
      correlationId: envelope.correlationId,
      note: payload.note,
    });
  });

  if (!ran) {
    logger.debug('pilot-demo duplicate ignored', { eventId: envelope.id });
  }
};
