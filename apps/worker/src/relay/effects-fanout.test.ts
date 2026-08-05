import { describe, expect, it } from 'vitest';
import type { DomainEventRecord } from '@repo/db';
import { effectMessagesFor, effectMessagesForBatch } from './effects-fanout.js';

/**
 * Effect fan-out on the relay (core plan 07 §5.4, §12.2 Q1).
 *
 * Q1 asked whether plan 02's relay could accommodate multi-destination sends
 * before stamping `published_at`. It can, and these tests pin the mapping that
 * makes it work: which events carry effects, what envelope each becomes, and the
 * deterministic `MessageId` duplicate detection keys on.
 */

const TRANSITION_ID = '019fd3c4-0000-7000-8000-000000000001';
const INSTANCE_ID = '019fd3c4-0000-7000-8000-000000000002';
const SUBJECT_ID = '019fd3c4-0000-7000-8000-000000000003';
const CORRELATION_ID = '019fd3c4-0000-7000-8000-000000000004';

function event(payload: unknown, overrides: Partial<DomainEventRecord> = {}): DomainEventRecord {
  return {
    id: '019fd3c4-0000-7000-8000-00000000000a',
    kind: 'domain',
    stream_type: 'platform.workflow_instance',
    stream_id: INSTANCE_ID,
    event_type: 'platform.workflow_instance.transitioned',
    payload: payload as DomainEventRecord['payload'],
    schema_version: 1,
    actor_person_id: null,
    on_behalf_of: null,
    correlation_id: CORRELATION_ID,
    causation_id: null,
    occurred_at: new Date('2026-08-05T12:00:00.000Z'),
    recorded_at: new Date('2026-08-05T12:00:00.000Z'),
    published_at: null,
    ...overrides,
  } as DomainEventRecord;
}

const transitionPayload = {
  transitionId: TRANSITION_ID,
  instanceId: INSTANCE_ID,
  workflowKey: 'platform.demo.request',
  definitionVersion: 1,
  subjectStreamType: 'platform.demo_request',
  subjectStreamId: SUBJECT_ID,
  from: 'pending',
  to: 'approved',
  action: 'approve',
  guardWarnings: [],
  effects: [
    { name: 'demo.recordOutcome', params: { outcome: 'approved' } },
    { name: 'tasks.raiseList', params: { listKey: 'onboarding' } },
  ],
  completed: true,
};

describe('effectMessagesFor', () => {
  it('produces one message per effect, with a deterministic MessageId', () => {
    const messages = effectMessagesFor(event(transitionPayload));

    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.messageId)).toEqual([
      `t:${TRANSITION_ID}:demo.recordOutcome`,
      `t:${TRANSITION_ID}:tasks.raiseList`,
    ]);
    // One message each is what lets a poison effect dead-letter without taking
    // its siblings with it (§5.4).
    expect(messages[0]?.subject).toBe('demo.recordOutcome');
  });

  it('builds an envelope carrying the idempotency root, the subject and the correlation', () => {
    const [first] = effectMessagesFor(event(transitionPayload));
    expect(first?.body).toEqual({
      effect: 'demo.recordOutcome',
      params: { outcome: 'approved' },
      source: { kind: 'transition', transitionId: TRANSITION_ID, instanceId: INSTANCE_ID },
      subject: { streamType: 'platform.demo_request', streamId: SUBJECT_ID },
      correlationId: CORRELATION_ID,
    });
  });

  it('carries the subject from the payload, not the stream — so an emits override works too', () => {
    // An `emits` override journals on the subject's own stream, so `stream_id`
    // is the subject and `instanceId` only exists in the payload. Reading both
    // from the payload makes the mapping identical either way.
    const [first] = effectMessagesFor(
      event(transitionPayload, {
        stream_type: 'hr.leave_booking',
        stream_id: SUBJECT_ID,
        event_type: 'hr.leave_booking.approved',
      }),
    );
    expect(first?.body).toMatchObject({
      source: { instanceId: INSTANCE_ID },
      subject: { streamType: 'platform.demo_request', streamId: SUBJECT_ID },
    });
  });

  it('ignores every event that carries no effects', () => {
    expect(effectMessagesFor(event({ ...transitionPayload, effects: [] }))).toEqual([]);
    expect(
      effectMessagesFor(
        event(
          { note: 'hello' },
          { event_type: 'platform.demo.pinged', stream_type: 'platform.demo' },
        ),
      ),
    ).toEqual([]);
  });

  it('flattens a batch, so one relay tick sends every effect it implies', () => {
    const messages = effectMessagesForBatch([
      event(transitionPayload),
      event({ note: 'unrelated' }),
      event({ ...transitionPayload, effects: [{ name: 'notification.send' }] }),
    ]);
    expect(messages).toHaveLength(3);
    // An effect with no params still gets an envelope with an empty object, so
    // handlers never have to distinguish "absent" from "empty".
    expect(messages[2]?.body).toMatchObject({ effect: 'notification.send', params: {} });
  });
});
