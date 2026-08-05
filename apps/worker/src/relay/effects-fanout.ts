import { z } from 'zod';
import type { DomainEventRecord } from '@repo/db';
import { effectMessageId, type EffectEnvelope } from '@repo/workflow';
import type { ServiceBusMessage } from '@repo/service-bus';

/**
 * Effect fan-out on the relay (core plan 07 §5.4, WF-6 → WF-7).
 *
 * A transition names the effects it causes; the runtime does **not** send them.
 * It writes them into the journal event's payload inside the same transaction as
 * the state change, and this — the relay, already reading that journal — is what
 * puts them on the queue. That is the whole point of routing them through the
 * outbox: there is no moment at which a transition is committed but its
 * consequences have been lost, and no dual write to get wrong. A Service Bus
 * outage delays effects; it never desynchronises them.
 *
 * The relay's contract for a workflow event is therefore: send one message per
 * effect to the `effects` queue, publish the event to `domain-events`, then
 * stamp `published_at` — all inside the relay's transaction, so a failure at any
 * point replays the lot. Every reader downstream is idempotent, which is what
 * makes replay safe (§12.2 Q1, confirmed in build).
 */

/** The queue effect messages land on. A code constant, not a decision point. */
export const EFFECTS_QUEUE = 'effects';

/**
 * The minimum a payload must carry to be fanned out. Deliberately loose — this
 * is a structural test ("does this event carry effects?"), not a re-validation
 * of a payload the journal already validated against its registered schema.
 */
const effectCarryingPayload = z.object({
  transitionId: z.uuid(),
  instanceId: z.uuid(),
  subjectStreamType: z.string(),
  subjectStreamId: z.uuid(),
  effects: z
    .array(z.object({ name: z.string().min(1), params: z.record(z.string(), z.json()).optional() }))
    .min(1),
});

/**
 * The effect messages an event implies — empty for the overwhelming majority of
 * journal rows, which carry no effects at all.
 *
 * `MessageId` is deterministic (`t:{transitionId}:{effect}`), so the `effects`
 * queue's duplicate detection absorbs a replayed batch within its window. That
 * is the first idempotency layer only; the handlers' own guards are the one that
 * holds after the window closes.
 */
export function effectMessagesFor(event: DomainEventRecord): ServiceBusMessage[] {
  const parsed = effectCarryingPayload.safeParse(event.payload);
  if (!parsed.success) return [];

  const { transitionId, instanceId, subjectStreamType, subjectStreamId, effects } = parsed.data;
  const source = { kind: 'transition' as const, transitionId, instanceId };

  return effects.map((effect) => {
    const envelope: EffectEnvelope = {
      effect: effect.name,
      params: effect.params ?? {},
      source,
      subject: { streamType: subjectStreamType, streamId: subjectStreamId },
      // The causing event's correlation id, so a transition and everything it
      // sets in motion share one thread through the logs and the journal.
      correlationId: event.correlation_id,
    };
    return {
      body: envelope,
      messageId: effectMessageId(source, effect.name),
      subject: effect.name,
      correlationId: event.correlation_id,
      applicationProperties: { effect: effect.name, streamType: subjectStreamType },
    };
  });
}

/** Every effect message a relayed batch implies, flattened. */
export function effectMessagesForBatch(events: DomainEventRecord[]): ServiceBusMessage[] {
  return events.flatMap(effectMessagesFor);
}
