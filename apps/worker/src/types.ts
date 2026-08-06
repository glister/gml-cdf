import type { Kysely } from 'kysely';
import type { DB } from '@repo/db';
import type { ServiceBusReceivedMessage } from '@repo/service-bus';
import type { Logger } from 'winston';

export interface HandlerContext {
  logger: Logger;
  /** The shared Kysely instance; consumers dedupe and journal through it (§5.2). */
  db: Kysely<DB>;
}

/**
 * Thrown by a handler for a message no amount of redelivery will fix — an
 * unknown effect name, an unparseable body. The registry **dead-letters** it
 * immediately rather than abandoning it (core plan 07 §5.4): retrying a message
 * whose handler does not exist burns the delivery count and delays the alert on
 * the dead-letter queue, which is the thing anyone would actually want to see.
 */
export class PoisonMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoisonMessageError';
  }
}

/**
 * A subscription handler processes one message. Return normally to complete the
 * message (acknowledge); throw to abandon it (redeliver / dead-letter per the
 * queue's policy); throw {@link PoisonMessageError} to dead-letter it at once.
 */
export type SubscriptionHandler = (
  message: ServiceBusReceivedMessage,
  ctx: HandlerContext,
) => Promise<void>;

export interface HandlerRegistration {
  /** Queue name, or the topic name when `subscription` is set. */
  queue: string;
  /** If set, `queue` is treated as a topic and this is its subscription. */
  subscription?: string;
  handler: SubscriptionHandler;
}
