import {
  ServiceBusClient,
  type ServiceBusMessage,
  type ServiceBusReceiver,
  type ServiceBusSender,
} from '@azure/service-bus';
import { createLogger, type Logger } from '@repo/logging';

/**
 * Thin helpers over the Azure Service Bus SDK. The connection string is passed
 * in by the caller (worker/api read it from `@repo/env`), so this package stays
 * decoupled from the env boundary. Locally it points at the Service Bus
 * emulator's fixed dev connection string; in prod, a real namespace string.
 */

export interface CreateServiceBusOptions {
  connectionString: string;
  logger?: Logger;
}

export interface ServiceBus {
  readonly client: ServiceBusClient;
  /** A cached-free sender for a queue or topic. Caller must close it. */
  sender(queueOrTopic: string): ServiceBusSender;
  /** Send a single message, opening and closing a sender for the call. */
  send(queueOrTopic: string, body: unknown, extra?: Partial<ServiceBusMessage>): Promise<void>;
  /** Receiver for a queue. */
  receiver(queue: string): ServiceBusReceiver;
  /** Receiver for a topic subscription. */
  subscription(topic: string, subscription: string): ServiceBusReceiver;
  close(): Promise<void>;
}

export function createServiceBus({
  connectionString,
  logger = createLogger({ service: 'service-bus' }),
}: CreateServiceBusOptions): ServiceBus {
  const client = new ServiceBusClient(connectionString);

  return {
    client,
    sender(queueOrTopic) {
      return client.createSender(queueOrTopic);
    },
    async send(queueOrTopic, body, extra) {
      const sender = client.createSender(queueOrTopic);
      try {
        await sender.sendMessages({ body, ...extra });
        logger.debug('service-bus.sent', { destination: queueOrTopic });
      } finally {
        await sender.close();
      }
    },
    receiver(queue) {
      return client.createReceiver(queue);
    },
    subscription(topic, subscription) {
      return client.createReceiver(topic, subscription);
    },
    async close() {
      await client.close();
    },
  };
}

export { ServiceBusClient };
export type {
  ServiceBusMessage,
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
  ServiceBusSender,
} from '@azure/service-bus';
