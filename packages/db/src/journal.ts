import type { Insertable, Selectable, Transaction } from 'kysely';
import { eventDefinition, type EventPayload, type EventType } from '@repo/domain';
import { newUuidV7 } from './ids.js';
import type { DB, PlatformDomainEvent } from './types.js';

type DomainEventRecord = Selectable<PlatformDomainEvent>;
type NewDomainEvent = Insertable<PlatformDomainEvent>;

/**
 * `appendEvent` — the single choke point through which every module journals a
 * business fact (core plan 02 §5.1, ADR-0010). It appends one immutable
 * `platform.domain_event` row **inside the caller's transaction**, so "same
 * transaction as the state change" is a structural guarantee, not a convention:
 * the parameter is `Transaction<DB>`, so passing the root Kysely instance is a
 * type error.
 *
 * Package dependency direction is `@repo/db → @repo/domain` (both source-only;
 * the registry is pure data + Zod — ADR-0009).
 */

/**
 * The append-time payload-size cap (§6 `max_payload_bytes`). Keeps rows well
 * under the Service Bus Standard-tier 256 KB message limit and applies constant
 * pressure toward PII-minimal payloads (ADR-0019).
 */
export const MAX_PAYLOAD_BYTES = 65536;

/** Byte size of a payload once serialised to the JSON that lands in `jsonb`. */
export function payloadByteSize(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload ?? {}), 'utf8');
}

export interface AppendEventInput<T extends EventType = EventType> {
  /** Event class (§4.1). Defaults to `'domain'`. */
  kind?: 'domain' | 'admin' | 'security';
  /** `<module>.<entity>` of the subject record, e.g. `'platform.person'`. */
  streamType: string;
  /** PK (uuid) of the subject record. */
  streamId: string;
  /** A registered event type (literal union from the registry). */
  eventType: T;
  /** Payload, inferred from the registered strict Zod schema. */
  payload: EventPayload<T>;
  /** Acting person; `null` for system/unauthenticated actions. */
  actorPersonId?: string | null;
  /** HR acting for an employee (ADR-0011). */
  onBehalfOf?: string | null;
  /** Ties a user action to its cascade; from ctx (request) or inbound message. */
  correlationId: string;
  /** Id of the triggering event, if any (worker consumers set this). */
  causationId?: string | null;
  /** Business time; defaults to `now()` (DB default). */
  occurredAt?: Date;
}

/**
 * Append one journal row inside `trx` (ADR-0010 rule 1). Never opens or commits
 * a transaction — the caller's boundary is the atomicity guarantee, so a state
 * row and its event roll back together on failure.
 *
 * Throws **before insert** if `eventType` is unregistered, the payload fails its
 * strict schema, or the serialised payload exceeds `maxPayloadBytes`.
 *
 * `schema_version` comes from the registry, never from the caller;
 * `maxPayloadBytes` defaults to {@link MAX_PAYLOAD_BYTES} and is overridable for
 * tests and any future promotion to the config store (§6).
 */
export async function appendEvent<T extends EventType>(
  trx: Transaction<DB>,
  input: AppendEventInput<T>,
  maxPayloadBytes: number = MAX_PAYLOAD_BYTES,
): Promise<DomainEventRecord> {
  const def = eventDefinition(input.eventType);
  if (!def) {
    throw new Error(
      `unknown event type '${input.eventType}': register it in @repo/domain before emitting`,
    );
  }

  // Strict schema validation (throws a ZodError on unknown keys / bad shape).
  const payload = def.payloadSchema.parse(input.payload);

  const bytes = payloadByteSize(payload);
  if (bytes > maxPayloadBytes) {
    throw new Error(
      `event '${input.eventType}' payload is ${bytes} bytes, exceeding the ${maxPayloadBytes}-byte cap (ADR-0019)`,
    );
  }

  const values: NewDomainEvent = {
    id: newUuidV7(),
    kind: input.kind ?? 'domain',
    stream_type: input.streamType,
    stream_id: input.streamId,
    event_type: input.eventType,
    // Validated above; safe to store as jsonb. `payload` is a plain JSON object.
    payload: payload as NewDomainEvent['payload'],
    schema_version: def.schemaVersion,
    actor_person_id: input.actorPersonId ?? null,
    on_behalf_of: input.onBehalfOf ?? null,
    correlation_id: input.correlationId,
    causation_id: input.causationId ?? null,
    // `undefined` is omitted by Kysely, so the DB `now()` default applies.
    occurred_at: input.occurredAt,
  };

  return trx
    .insertInto('platform.domain_event')
    .values(values)
    .returningAll()
    .executeTakeFirstOrThrow();
}
