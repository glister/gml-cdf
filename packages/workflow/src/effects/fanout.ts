import { z } from 'zod';
import type { DomainEventRecord } from '@repo/db';
import { effectMessageId, type EffectEnvelope, type EffectSource } from './types.js';

/**
 * Turning a journalled transition into effect messages (core plan 07 §5.4).
 *
 * A transition names the effects it causes; the runtime does **not** send them.
 * It writes them into the journal event's payload, inside the same transaction
 * as the state change, and the outbox relay — already reading that journal —
 * puts them on the queue. That is the whole point of routing effects through the
 * outbox: there is no moment at which a transition is committed but its
 * consequences have been lost, and no dual write to get wrong. A Service Bus
 * outage delays effects; it never desynchronises them.
 *
 * The mapping lives here rather than in `apps/worker` because the envelope is
 * this package's contract. The worker owns only the transport: it maps each
 * envelope to a `ServiceBusMessage` and sends it.
 */

/** The queue effect messages land on. A code constant, not a decision point. */
export const EFFECTS_QUEUE = 'effects';

/**
 * The minimum a payload must carry to be fanned out. Deliberately loose — this
 * is a structural test ("does this event carry effects?"), not a re-validation
 * of a payload the journal already validated against its registered schema.
 */
const effectList = z
  .array(z.object({ name: z.string().min(1), params: z.record(z.string(), z.json()).optional() }))
  .min(1);

const transitionPayload = z.object({
  transitionId: z.uuid(),
  instanceId: z.uuid(),
  subjectStreamType: z.string(),
  subjectStreamId: z.uuid(),
  effects: effectList,
});

/**
 * The second shape: **any** journalled event whose payload carries effects.
 *
 * Added by core plan 10, whose `platform.notification.requested` needs its
 * dispatch to ride the outbox for exactly the reason a transition's effects do —
 * so a committed fact can never lose its consequence to a broker outage — but
 * which has no workflow instance to hang on. The rule generalises cleanly: the
 * event id is the idempotency root, and the event's own stream is the subject,
 * so nothing notification-specific appears anywhere in the relay.
 *
 * Checked **after** the transition shape, so a transition keeps its richer
 * source (which carries the instance id handlers use) rather than being demoted
 * to a bare event.
 */
const eventPayload = z.object({ effects: effectList });

export interface EffectMessage {
  envelope: EffectEnvelope;
  /**
   * Deterministic (`t:{transitionId}:{effect}`), so the queue's duplicate
   * detection absorbs a replayed batch within its window. That is the first
   * idempotency layer only; each handler's own guard is the one that holds after
   * the window closes.
   */
  messageId: string;
}

/**
 * The effect messages an event implies — empty for the overwhelming majority of
 * journal rows, which carry no effects at all.
 */
export function effectMessagesFor(event: DomainEventRecord): EffectMessage[] {
  const transition = transitionPayload.safeParse(event.payload);
  if (transition.success) {
    const { transitionId, instanceId, subjectStreamType, subjectStreamId, effects } =
      transition.data;
    const source: EffectSource = { kind: 'transition', transitionId, instanceId };
    return toMessages(effects, source, event, {
      streamType: subjectStreamType,
      streamId: subjectStreamId,
    });
  }

  const carried = eventPayload.safeParse(event.payload);
  if (!carried.success) return [];

  const source: EffectSource = { kind: 'event', eventId: event.id };
  // The event's own stream is the subject: `platform.notification.requested` is
  // journalled on the notification row, and the notification id is exactly what
  // the dispatch handler needs.
  return toMessages(carried.data.effects, source, event, {
    streamType: event.stream_type,
    streamId: event.stream_id,
  });
}

function toMessages(
  effects: readonly { name: string; params?: Record<string, unknown> }[],
  source: EffectSource,
  event: DomainEventRecord,
  subject: { streamType: string; streamId: string },
): EffectMessage[] {
  return effects.map((effect) => ({
    envelope: {
      effect: effect.name,
      params: (effect.params ?? {}) as EffectEnvelope['params'],
      source,
      subject,
      // The causing event's correlation id, so a fact and everything it sets in
      // motion share one thread through the logs and the journal.
      correlationId: event.correlation_id,
    },
    messageId: effectMessageId(source, effect.name),
  }));
}

/** Every effect message a relayed batch implies, flattened. */
export function effectMessagesForBatch(events: DomainEventRecord[]): EffectMessage[] {
  return events.flatMap(effectMessagesFor);
}
