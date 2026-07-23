import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfig } from 'vitest/config';

const setupEnv = fileURLToPath(new URL('./setup-env.ts', import.meta.url));
const ensureDb = fileURLToPath(new URL('./ensure-db.ts', import.meta.url));

const coverageExclude = [
  '**/node_modules/**',
  '**/dist/**',
  '**/*.config.*',
  '**/types.ts',
  '**/*.d.ts',
];

/** Shared base: Node environment. */
export const baseConfig: UserConfig = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [setupEnv],
    coverage: {
      provider: 'v8',
      exclude: coverageExclude,
    },
  },
});

/** Browser/component base: jsdom environment. */
export const browserConfig: UserConfig = defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [setupEnv],
    coverage: {
      provider: 'v8',
      exclude: coverageExclude,
    },
  },
});

/**
 * Preset for a package whose suites hit a real Postgres. Each such package gets
 * its **own** database (`dbName`) so turbo's concurrent `test` tasks never
 * collide on a shared one — `ensure-db.ts` creates it if missing, and the
 * package's `beforeAll` migrates it. Also pins `fileParallelism` off (suites
 * share the one database) and inlines `kysely` so `FileMigrationProvider` loads
 * migrations through Vite's `.js` → `.ts` remap. Compose with `baseConfig`:
 *
 *   export default mergeConfig(baseConfig, dbIntegrationConfig('cdf_test_identity'))
 */
export function dbIntegrationConfig(dbName: string): UserConfig {
  return defineConfig({
    test: {
      env: { POSTGRES_DB: dbName },
      // Concatenated after baseConfig's setup-env, so creds are loaded first.
      setupFiles: [ensureDb],
      fileParallelism: false,
      server: { deps: { inline: ['kysely'] } },
    },
  });
}

export default baseConfig;
