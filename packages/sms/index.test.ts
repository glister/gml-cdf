import { describe, expect, it } from 'vitest';
import { createSmsClient } from './index.js';

describe('createSmsClient (stub)', () => {
  it('resolves with a deterministic id and does not throw', async () => {
    const client = createSmsClient();
    const result = await client.send({ to: '+15550001111', body: 'hello' });
    expect(result.id).toContain('+15550001111');
  });
});
