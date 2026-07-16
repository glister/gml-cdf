import { createLogger } from '@repo/logging';

// Server-only (used by the prod Node server). Never import into client code.
export const logger = createLogger({ service: 'web' });
