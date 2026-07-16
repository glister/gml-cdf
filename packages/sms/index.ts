import { createLogger, type Logger } from '@repo/logging';

/**
 * Twilio SMS — stubbed for now. Logs instead of sending so local/dev flows work
 * without credentials. Swap the stub body for the Twilio SDK when wiring real
 * sending; the interface stays the same.
 */

export interface SmsMessage {
  to: string;
  body: string;
}

export interface SmsClient {
  send(message: SmsMessage): Promise<{ id: string }>;
}

export interface CreateSmsClientOptions {
  logger?: Logger;
}

export function createSmsClient(options: CreateSmsClientOptions = {}): SmsClient {
  const logger = options.logger ?? createLogger({ service: 'sms' });

  return {
    async send({ to, body }) {
      logger.info('sms.send (stub — not actually sent)', { to, length: body.length });
      return { id: `stub-${to}` };
    },
  };
}
