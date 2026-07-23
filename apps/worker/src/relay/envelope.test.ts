import { describe, expect, it } from 'vitest';
import type { DomainEventRecord } from '@repo/db';
import { EVENT_ENVELOPE_VERSION, eventEnvelopeSchema, toEnvelopeMessage } from './envelope.js';

function makeEvent(overrides: Partial<DomainEventRecord> = {}): DomainEventRecord {
  return {
    id: '019018a0-0000-7000-8000-000000000001',
    kind: 'domain',
    stream_type: 'platform.demo',
    stream_id: '019018a0-0000-7000-8000-000000000002',
    event_type: 'platform.demo.pinged',
    payload: { note: 'hi' },
    schema_version: 1,
    actor_person_id: null,
    on_behalf_of: null,
    correlation_id: '019018a0-0000-7000-8000-000000000003',
    causation_id: null,
    occurred_at: new Date('2020-01-01T00:00:00.000Z'),
    recorded_at: new Date('2020-01-01T00:00:01.000Z'),
    published_at: null,
    ...overrides,
  } as DomainEventRecord;
}

describe('toEnvelopeMessage', () => {
  it('maps a journal row to the Service Bus message shape', () => {
    const event = makeEvent();
    const msg = toEnvelopeMessage(event);

    expect(msg.messageId).toBe(event.id);
    expect(msg.subject).toBe('platform.demo.pinged');
    expect(msg.correlationId).toBe(event.correlation_id);
    expect(msg.applicationProperties).toEqual({
      kind: 'domain',
      streamType: 'platform.demo',
    });
  });

  it('produces a body that satisfies the envelope schema, with ISO timestamps', () => {
    const msg = toEnvelopeMessage(makeEvent());
    const parsed = eventEnvelopeSchema.parse(msg.body);

    expect(parsed.envelopeVersion).toBe(EVENT_ENVELOPE_VERSION);
    expect(parsed.eventType).toBe('platform.demo.pinged');
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.payload).toEqual({ note: 'hi' });
    expect(parsed.occurredAt).toBe('2020-01-01T00:00:00.000Z');
    expect(parsed.recordedAt).toBe('2020-01-01T00:00:01.000Z');
    expect(parsed.causationId).toBeNull();
  });

  it('carries actor, on-behalf and causation when present', () => {
    const msg = toEnvelopeMessage(
      makeEvent({
        kind: 'security',
        actor_person_id: '019018a0-0000-7000-8000-00000000000a',
        on_behalf_of: '019018a0-0000-7000-8000-00000000000b',
        causation_id: '019018a0-0000-7000-8000-00000000000c',
      }),
    );
    const parsed = eventEnvelopeSchema.parse(msg.body);
    expect(parsed.kind).toBe('security');
    expect(parsed.actorPersonId).toBe('019018a0-0000-7000-8000-00000000000a');
    expect(parsed.onBehalfOf).toBe('019018a0-0000-7000-8000-00000000000b');
    expect(parsed.causationId).toBe('019018a0-0000-7000-8000-00000000000c');
    expect(msg.applicationProperties).toEqual({ kind: 'security', streamType: 'platform.demo' });
  });
});
