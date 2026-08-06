import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@repo/logging';
import type { ServiceBusReceivedMessage } from '@repo/service-bus';
import {
  effectMessageId,
  registerEffect,
  unregisterEffectForTests,
  type EffectEnvelope,
  type EffectHandler,
} from '@repo/workflow';
import { effectsHandler } from './effects.js';
import { PoisonMessageError, type HandlerContext } from '../types.js';

/**
 * The `effects` queue dispatcher (core plan 07 §10 — T-W1, T-W2).
 *
 * Deliberately database-free: this file tests *dispatch* — does the right
 * handler get the right envelope, and what happens when there is no handler.
 * The idempotency contract (T-W3) is a property of each handler's own
 * transaction, so it is proven where it can be, against real Postgres, in
 * `@repo/workflow`'s end-to-end slice.
 */

const ctx: HandlerContext = {
  logger: createLogger({ service: 'worker-test', level: 'silent' }),
  db: {} as HandlerContext['db'],
};

const source = {
  kind: 'transition' as const,
  transitionId: '019fd3c4-0000-7000-8000-000000000001',
  instanceId: '019fd3c4-0000-7000-8000-000000000002',
};

function envelope(effect: string): EffectEnvelope {
  return {
    effect,
    params: { outcome: 'approved' },
    source,
    subject: {
      streamType: 'platform.demo_request',
      streamId: '019fd3c4-0000-7000-8000-000000000003',
    },
    correlationId: '019fd3c4-0000-7000-8000-000000000004',
  };
}

function message(body: unknown, subject?: string): ServiceBusReceivedMessage {
  return { body, subject } as ServiceBusReceivedMessage;
}

afterEach(() => unregisterEffectForTests('test.dispatch'));

describe('T-W1 — dispatch by effect name', () => {
  it('hands the parsed envelope to the registered handler', async () => {
    const handler = vi.fn<EffectHandler>(async () => {});
    registerEffect('test.dispatch', handler);

    await effectsHandler(message(envelope('test.dispatch')), ctx);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      effect: 'test.dispatch',
      params: { outcome: 'approved' },
      source: { kind: 'transition', transitionId: source.transitionId },
    });
  });

  it('a handler that throws propagates, so the message is abandoned for retry (T-W4)', async () => {
    registerEffect('test.dispatch', async () => {
      throw new Error('transient');
    });
    await expect(effectsHandler(message(envelope('test.dispatch')), ctx)).rejects.toThrow(
      'transient',
    );
  });
});

describe('T-W2 — an unknown effect dead-letters without retrying', () => {
  it('throws PoisonMessageError for an unregistered effect name', async () => {
    await expect(
      effectsHandler(message(envelope('nobody.registeredThis')), ctx),
    ).rejects.toBeInstanceOf(PoisonMessageError);
  });

  it('throws PoisonMessageError for a body that is neither envelope nor sweep command', async () => {
    await expect(
      effectsHandler(message({ nonsense: true }, 'unknown.subject'), ctx),
    ).rejects.toBeInstanceOf(PoisonMessageError);
  });
});

describe('the deterministic MessageId duplicate detection keys on', () => {
  it('distinguishes sibling effects of one transition but repeats across re-sends', () => {
    expect(effectMessageId(source, 'demo.recordOutcome')).toBe(
      `t:${source.transitionId}:demo.recordOutcome`,
    );
    expect(effectMessageId(source, 'tasks.raiseList')).not.toBe(
      effectMessageId(source, 'demo.recordOutcome'),
    );
    expect(effectMessageId({ kind: 'scheduled_action', scheduledActionId: 'abc' }, 'x')).toBe(
      'sa:abc',
    );
  });
});
