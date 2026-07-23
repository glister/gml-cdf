import { z } from 'zod';
import type { DomainEventRecord } from '@repo/db';
import type { ServiceBusMessage } from '@repo/service-bus';

/**
 * The wire contract for a relayed domain event (core plan 02 §5.2) — shared by
 * the relay (which builds it) and every subscriber (which parses it). Bumping
 * `envelopeVersion` is how the envelope shape itself evolves; per-event payload
 * evolution is carried by `schemaVersion` from the registry.
 */
export const EVENT_ENVELOPE_VERSION = 1;

export const eventEnvelopeSchema = z.object({
  envelopeVersion: z.literal(EVENT_ENVELOPE_VERSION),
  id: z.string(),
  kind: z.enum(['domain', 'admin', 'security']),
  streamType: z.string(),
  streamId: z.string(),
  eventType: z.string(),
  schemaVersion: z.number().int(),
  payload: z.unknown(),
  actorPersonId: z.string().nullable(),
  onBehalfOf: z.string().nullable(),
  correlationId: z.string(),
  causationId: z.string().nullable(),
  occurredAt: z.string(), // ISO-8601
  recordedAt: z.string(), // ISO-8601
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** timestamptz columns arrive from pg as `Date`; normalise to ISO-8601 strings. */
function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();
}

/**
 * Map a journal row to a Service Bus message. `messageId = id` enables broker
 * duplicate detection later; `subject`/`applicationProperties` let subscriptions
 * add SQL filters (e.g. by `streamType`) without parsing the body.
 */
export function toEnvelopeMessage(event: DomainEventRecord): ServiceBusMessage {
  const envelope: EventEnvelope = {
    envelopeVersion: EVENT_ENVELOPE_VERSION,
    id: event.id,
    kind: event.kind,
    streamType: event.stream_type,
    streamId: event.stream_id,
    eventType: event.event_type,
    schemaVersion: event.schema_version,
    payload: event.payload,
    actorPersonId: event.actor_person_id,
    onBehalfOf: event.on_behalf_of,
    correlationId: event.correlation_id,
    causationId: event.causation_id,
    occurredAt: toIso(event.occurred_at),
    recordedAt: toIso(event.recorded_at),
  };
  return {
    body: envelope,
    messageId: event.id,
    subject: event.event_type,
    correlationId: event.correlation_id,
    applicationProperties: { kind: event.kind, streamType: event.stream_type },
  };
}
