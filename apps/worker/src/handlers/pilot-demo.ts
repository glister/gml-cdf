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

  // **A topic subscription receives everything the topic carries.** This one has
  // no SQL filter (`docker/servicebus/Config.json`), so it sees every relayed
  // journal event — tasks, approvals, notifications, config changes — and only
  // one of them is its own. Parsing another event's payload against
  // `platform.demo.pinged` throws, the message is abandoned, and it retries to
  // the dead-letter queue: a stream of red in the log for events that were
  // relayed perfectly correctly.
  //
  // Ignoring what is not ours is the honest semantic for an unfiltered
  // subscription, and completing the message is what stops it cycling. Found
  // when core plan 10's first notification event was relayed; it had been true
  // of every task and approval event since plan 08.
  if (envelope.eventType !== platformDemoPinged.type) {
    logger.debug('pilot-demo: not our event type', { eventType: envelope.eventType });
    return;
  }

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
