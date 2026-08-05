import type { DomainEventRecord } from '@repo/db';
import { effectMessagesForBatch, EFFECTS_QUEUE } from '@repo/workflow';
import type { ServiceBusMessage } from '@repo/service-bus';

/**
 * The transport half of effect fan-out (core plan 07 §5.4, §12.2 Q1).
 *
 * `@repo/workflow` decides *what* to send — it owns the envelope contract and
 * reads `payload.effects` off a journalled transition. This module only turns
 * each envelope into a Service Bus message, which keeps the relay's knowledge of
 * workflows to exactly nothing.
 *
 * The relay's contract for a workflow event: send one message per effect to the
 * `effects` queue, publish the event to `domain-events`, then stamp
 * `published_at` — all inside the relay's transaction, so a failure at any point
 * replays the lot. Every reader downstream is idempotent, which is what makes
 * replay safe.
 */
export { EFFECTS_QUEUE };

export function effectServiceBusMessages(events: DomainEventRecord[]): ServiceBusMessage[] {
  return effectMessagesForBatch(events).map(({ envelope, messageId }) => ({
    body: envelope,
    messageId,
    subject: envelope.effect,
    correlationId: envelope.correlationId,
    applicationProperties: {
      effect: envelope.effect,
      streamType: envelope.subject.streamType,
    },
  }));
}
