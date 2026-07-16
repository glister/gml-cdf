import { describe, expect, it } from 'vitest';
import { createServiceBus } from './index.js';

// The emulator's fixed dev connection string. Constructing the client does not
// open a network connection, so this validates wiring without the emulator.
const EMULATOR =
  'Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;';

describe('createServiceBus', () => {
  it('constructs from a connection string and exposes helpers', async () => {
    const sb = createServiceBus({ connectionString: EMULATOR });
    expect(typeof sb.send).toBe('function');
    expect(typeof sb.receiver).toBe('function');
    expect(typeof sb.subscription).toBe('function');
    await sb.close();
  });
});
