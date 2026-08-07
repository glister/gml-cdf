import { z } from 'zod';

/**
 * The effect-message envelope (core plan 07 §5.4) — the wire contract between
 * the two producers onto the `effects` queue (the outbox relay, and the
 * scheduler draining due timers) and the worker that executes them.
 *
 * Its most important field is `source`. Delivery is at-least-once end to end, so
 * **every handler must tolerate re-delivery**, and `source` is the deterministic
 * idempotency root it keys that on: a transition id, or a scheduled-action id.
 * Both are UUIDv7 values that already exist in the database before the message
 * is ever sent, which is what makes "did I already do this?" a primary-key
 * lookup rather than a guess.
 *
 * The Service Bus `MessageId` is derived from the same root, so broker duplicate
 * detection catches the common case within its window — but that is only the
 * first layer. The window expires; the handler's own guard does not.
 */

export const effectSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('transition'),
    transitionId: z.uuid(),
    instanceId: z.uuid(),
  }),
  z.object({
    kind: z.literal('scheduled_action'),
    scheduledActionId: z.uuid(),
  }),
  /**
   * A journal event that carried effects but was not a workflow transition —
   * added by core plan 10 (`platform.notification.requested`), whose dispatch
   * has to ride the outbox for the same atomicity reason a transition's effects
   * do, without a workflow instance existing to hang it on.
   *
   * The event id is as good an idempotency root as a transition id and for the
   * same reason: it is a UUIDv7 that exists in the database before any message
   * is sent, so "did I already do this?" is a primary-key lookup.
   */
  z.object({
    kind: z.literal('event'),
    eventId: z.uuid(),
  }),
]);

export type EffectSource = z.infer<typeof effectSourceSchema>;

export const effectEnvelopeSchema = z.object({
  /** Registry name, e.g. `'demo.recordOutcome'`, `'workflow.transition'`. */
  effect: z.string().min(1),
  /** Ids-only parameters (ADR-0019) — never subject profile data. */
  params: z.record(z.string(), z.json()).default({}),
  source: effectSourceSchema,
  /** What the effect is about, named as the journal names streams (ADR-0021). */
  subject: z.object({ streamType: z.string(), streamId: z.uuid() }),
  /** The causing journal event's `correlation_id`, so the cascade stays traceable. */
  correlationId: z.uuid(),
});

export type EffectEnvelope = z.infer<typeof effectEnvelopeSchema>;

/**
 * The deterministic `MessageId` for an effect message.
 *
 * A transition may fan out several effects, so its id alone would not be unique
 * — the effect name completes it. A scheduled action carries exactly one effect,
 * so its id is enough (and re-sending after a crash between send and stamp must
 * produce the *same* id, which is what T-S3 asserts).
 */
export function effectMessageId(source: EffectSource, effect: string): string {
  switch (source.kind) {
    case 'transition':
      return `t:${source.transitionId}:${effect}`;
    case 'scheduled_action':
      return `sa:${source.scheduledActionId}`;
    case 'event':
      // Like a transition, one event may carry several effects, so the name
      // completes the id.
      return `e:${source.eventId}:${effect}`;
  }
}

/**
 * The idempotency root a handler keys its "have I already done this?" check on.
 * A UUID, so it slots straight into `platform.event_consumption` and into
 * deterministic child-row ids.
 */
export function effectIdempotencyKey(source: EffectSource): string {
  switch (source.kind) {
    case 'transition':
      return source.transitionId;
    case 'scheduled_action':
      return source.scheduledActionId;
    case 'event':
      return source.eventId;
  }
}
