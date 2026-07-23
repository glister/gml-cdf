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
 * A subscription handler processes one message. Return normally to complete the
 * message (acknowledge); throw to abandon it (redeliver / dead-letter per the
 * queue's policy).
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
