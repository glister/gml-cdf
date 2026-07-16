import type { SubscriptionHandler } from '../types.js';

/** Example handler: logs the message body. */
export const helloWorldHandler: SubscriptionHandler = async (message, { logger }) => {
  logger.info('hello-world message received', { body: message.body });
};
