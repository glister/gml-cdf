import { createLogger as winstonCreateLogger, format, transports, type Logger } from 'winston';
import { parse, z } from '@repo/env';

export { initObservability } from './init.js';

const logEnvSchema = z.object({
  LOG_LEVEL: z.string().default('info'),
  NODE_ENV: z.string().default('development'),
});

export interface CreateLoggerOptions {
  /** Attached as `service` on every log line. */
  service?: string;
  /** Overrides LOG_LEVEL from the environment. */
  level?: string;
}

/**
 * The single logger factory for the monorepo. Everything logs through this —
 * never `console.log`. JSON in production (for OTel/HyperDX ingestion), pretty
 * and colorized in development.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const env = parse(logEnvSchema);
  const level = options.level ?? env.LOG_LEVEL;
  const isProd = env.NODE_ENV === 'production';

  return winstonCreateLogger({
    level,
    defaultMeta: options.service ? { service: options.service } : undefined,
    format: isProd
      ? format.combine(format.timestamp(), format.errors({ stack: true }), format.json())
      : format.combine(
          format.colorize(),
          format.timestamp({ format: 'HH:mm:ss.SSS' }),
          format.errors({ stack: true }),
          format.printf(({ level: lvl, message, timestamp, service, ...rest }) => {
            const svc = service ? ` [${String(service)}]` : '';
            const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
            return `${String(timestamp)}${svc} ${lvl}: ${String(message)}${extra}`;
          }),
        ),
    transports: [new transports.Console()],
  });
}

export type { Logger };
