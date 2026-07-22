import { mergeConfig, defineConfig } from 'vitest/config';
import { baseConfig } from '@repo/vitest-config/vitest.config';

// Integration suites here run against one real Postgres (`cdf_test`). The
// migration round-trip drops/recreates schemas, so files must not run
// concurrently against the shared database.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: { fileParallelism: false },
  }),
);
