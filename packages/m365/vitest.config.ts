import { baseConfig } from '@repo/vitest-config/vitest.config';

// No database and no network: the adapter's tests drive it through an injected
// `fetch`, which is the reason it takes one (see `src/graph-client.ts`).
export default baseConfig;
