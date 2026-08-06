import type { Kysely } from 'kysely';
import type { DB } from '@repo/db';
import type { ServiceBus, ServiceBusReceivedMessage, ServiceBusReceiver } from '@repo/service-bus';
import type { Logger } from 'winston';
import { handlers } from './handlers/index.js';
import { PoisonMessageError, type HandlerContext, type SubscriptionHandler } from './types.js';

/** Minimal surface of a receiver needed to ack/nack — keeps tests trivial. */
export interface Completable {
  completeMessage(message: ServiceBusReceivedMessage): Promise<void>;
  abandonMessage(message: ServiceBusReceivedMessage): Promise<void>;
  deadLetterMessage(
    message: ServiceBusReceivedMessage,
    options?: { deadLetterReason?: string; deadLetterErrorDescription?: string },
  ): Promise<void>;
}

/**
 * Run one message through its handler: complete on success, abandon on throw —
 * except for a {@link PoisonMessageError}, which dead-letters immediately
 * because redelivery cannot help (core plan 07 §5.4).
 *
 * Exported so the ack/nack/dead-letter semantics can be unit-tested without a
 * live bus.
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
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof PoisonMessageError) {
      ctx.logger.error('poison message; dead-lettering', { error: detail });
      await receiver.deadLetterMessage(message, {
        deadLetterReason: 'PoisonMessage',
        deadLetterErrorDescription: detail,
      });
      return;
    }
    ctx.logger.error('handler failed; abandoning message', { error: detail });
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
