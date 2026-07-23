import { mergeConfig, defineConfig } from 'vitest/config';
import { baseConfig } from '@repo/vitest-config/vitest.config';

// Integration suites here run against one real Postgres (`cdf_test`). The
// migration round-trip drops/recreates schemas, so files must not run
// concurrently against the shared database.
//
// `kysely` is inlined so its `FileMigrationProvider` loads migration files
// through Vite's transform pipeline rather than Node's native ESM loader. Node
// 23's type-stripping resolves a `.js` specifier only to a literal `.js` file,
// so a migration importing the documented `../migration-helpers.js` helper
// (a `.ts` source) fails under native resolution; Vite remaps `.js` → `.ts`
// (as `tsx` does for `pnpm migrate`), keeping the migration-helper convention
// working in tests.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      fileParallelism: false,
      server: { deps: { inline: ['kysely'] } },
    },
  }),
);
