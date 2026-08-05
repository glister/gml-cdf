import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@repo/logging';
import type { ServiceBusReceivedMessage } from '@repo/service-bus';
import { type Completable, handleMessage } from './registry.js';
import { PoisonMessageError, type HandlerContext } from './types.js';

const ctx: HandlerContext = {
  logger: createLogger({ service: 'worker-test', level: 'silent' }),
  db: {} as HandlerContext['db'], // these tests exercise ack/nack, not the DB
};
const message = { body: { hello: 'world' } } as ServiceBusReceivedMessage;

function fakeReceiver(): Completable & {
  completeMessage: ReturnType<typeof vi.fn>;
  abandonMessage: ReturnType<typeof vi.fn>;
  deadLetterMessage: ReturnType<typeof vi.fn>;
} {
  return {
    completeMessage: vi.fn(async () => {}),
    abandonMessage: vi.fn(async () => {}),
    deadLetterMessage: vi.fn(async () => {}),
  };
}

describe('handleMessage', () => {
  it('completes the message when the handler succeeds', async () => {
    const receiver = fakeReceiver();
    await handleMessage(receiver, message, async () => {}, ctx);
    expect(receiver.completeMessage).toHaveBeenCalledOnce();
    expect(receiver.abandonMessage).not.toHaveBeenCalled();
  });

  it('abandons the message when the handler throws', async () => {
    const receiver = fakeReceiver();
    await handleMessage(
      receiver,
      message,
      async () => {
        throw new Error('boom');
      },
      ctx,
    );
    expect(receiver.abandonMessage).toHaveBeenCalledOnce();
    expect(receiver.completeMessage).not.toHaveBeenCalled();
  });

  it('dead-letters immediately on a poison message, rather than retrying', async () => {
    // T-W2 (core plan 07 §10). Redelivering a message whose handler does not
    // exist cannot help, and burning ten deliveries only delays the DLQ alert.
    const receiver = fakeReceiver();
    await handleMessage(
      receiver,
      message,
      async () => {
        throw new PoisonMessageError("no handler registered for effect 'nope.missing'");
      },
      ctx,
    );
    expect(receiver.deadLetterMessage).toHaveBeenCalledOnce();
    expect(receiver.deadLetterMessage.mock.calls[0]?.[1]).toMatchObject({
      deadLetterReason: 'PoisonMessage',
    });
    expect(receiver.abandonMessage).not.toHaveBeenCalled();
    expect(receiver.completeMessage).not.toHaveBeenCalled();
  });
});
