import type { Kysely } from 'kysely';
import type { DB } from '@repo/db';
import type { ServiceBus, ServiceBusReceivedMessage, ServiceBusReceiver } from '@repo/service-bus';
import type { Logger } from 'winston';
import { handlers } from './handlers/index.js';
import type { HandlerContext, SubscriptionHandler } from './types.js';

/** Minimal surface of a receiver needed to ack/nack — keeps tests trivial. */
export interface Completable {
  completeMessage(message: ServiceBusReceivedMessage): Promise<void>;
  abandonMessage(message: ServiceBusReceivedMessage): Promise<void>;
}

/**
 * Run one message through its handler: complete on success, abandon on throw.
 * Exported so the ack/nack semantics can be unit-tested without a live bus.
 */
export async function handleMessage(
  receiver: Completable,
  message: ServiceBusReceivedMessage,
  handler: SubscriptionHandler,
  ctx: HandlerContext,
): Promise<void> {
  try {
    await handler(message, ctx);
    await receiver.completeMessage(message);
  } catch (error) {
    ctx.logger.error('handler failed; abandoning message', {
      error: error instanceof Error ? error.message : String(error),
    });
    await receiver.abandonMessage(message);
  }
}

/** Open a receiver per registration and start pumping messages. */
export function startHandlers(
  sb: ServiceBus,
  logger: Logger,
  db: Kysely<DB>,
): ServiceBusReceiver[] {
  const ctx: HandlerContext = { logger, db };
  const receivers: ServiceBusReceiver[] = [];

  for (const registration of handlers) {
    const receiver = registration.subscription
      ? sb.subscription(registration.queue, registration.subscription)
      : sb.receiver(registration.queue);

    receiver.subscribe({
      processMessage: (message) => handleMessage(receiver, message, registration.handler, ctx),
      processError: async (args) => {
        logger.error('service bus error', {
          source: args.errorSource,
          error: args.error.message,
        });
      },
    });

    receivers.push(receiver);
    logger.info('handler started', {
      queue: registration.queue,
      subscription: registration.subscription,
    });
  }

  return receivers;
}

export async function stopHandlers(receivers: ServiceBusReceiver[]): Promise<void> {
  await Promise.all(receivers.map((receiver) => receiver.close()));
}
