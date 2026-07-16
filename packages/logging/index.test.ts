import { describe, expect, it } from 'vitest';
import { createLogger } from './index.js';

describe('createLogger', () => {
  it('honors an explicit level override', () => {
    const logger = createLogger({ level: 'debug', service: 'test' });
    expect(logger.level).toBe('debug');
  });

  it('defaults level from LOG_LEVEL (error in .env.test)', () => {
    const logger = createLogger();
    expect(logger.level).toBe('error');
  });

  it('does not throw when logging', () => {
    const logger = createLogger({ level: 'silent' });
    expect(() => logger.info('hello', { foo: 'bar' })).not.toThrow();
  });
});
