import { db } from '@repo/db';
import { createServiceBus } from '@repo/service-bus';
import { parse, z } from '@repo/env';
import { logger } from './logger.js';
import { startOutboxRelay } from './relay/outbox-relay.js';
import { startHandlers, stopHandlers } from './registry.js';

const env = parse(
  z.object({
    SERVICE_BUS_CONNECTION_STRING: z.string().min(1),
    VITEST: z.string().optional(),
  }),
);

export function start(): void {
  const sb = createServiceBus({
    connectionString: env.SERVICE_BUS_CONNECTION_STRING,
    logger,
  });
  const receivers = startHandlers(sb, logger, db);
  // The outbox relay polls the journal and publishes unpublished rows to the
  // domain-events topic (core plan 02 §5.2). It is a poller, so the worker runs
  // with minReplicas = 1 (Terraform).
  const relay = startOutboxRelay({ db, sb, logger });
  logger.info('worker started', { handlers: receivers.length, relay: true });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('worker shutting down', { signal });
    await relay.stop();
    await stopHandlers(receivers);
    await sb.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Boot unless we're under test (which imports the module for unit testing).
if (!env.VITEST) {
  start();
}
