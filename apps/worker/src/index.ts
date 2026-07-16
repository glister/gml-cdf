import { createServiceBus } from '@repo/service-bus';
import { parse, z } from '@repo/env';
import { logger } from './logger.js';
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
  const receivers = startHandlers(sb, logger);
  logger.info('worker started', { handlers: receivers.length });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('worker shutting down', { signal });
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
