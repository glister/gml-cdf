import { describe, expect, it } from 'vitest';
import { createCloudStorage } from './index.js';

// Uses AZURE_STORAGE_* from .env.test (UseDevelopmentStorage=true). Constructing
// the client does not connect, so this validates env parsing + wiring without
// the Azurite emulator running.
describe('createCloudStorage', () => {
  it('constructs against the dev storage connection string', () => {
    const storage = createCloudStorage();
    expect(typeof storage.uploadBuffer).toBe('function');
    expect(typeof storage.generateSasUrl).toBe('function');
    expect(storage.container.containerName).toBe('uploads');
  });
});
