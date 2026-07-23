import { mergeConfig, defineConfig } from 'vitest/config';
import { baseConfig } from '@repo/vitest-config/vitest.config';

// Integration suites run against the real `cdf_test` Postgres and migrate it in
// `beforeAll`. `kysely` is inlined so its `FileMigrationProvider` loads migration
// files through Vite's `.js` → `.ts` remap (see packages/db/vitest.config.ts);
// `fileParallelism` is off because the suites share one database.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      fileParallelism: false,
      server: { deps: { inline: ['kysely'] } },
    },
  }),
);
