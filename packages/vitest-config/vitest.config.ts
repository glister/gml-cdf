import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfig } from 'vitest/config';

const setupEnv = fileURLToPath(new URL('./setup-env.ts', import.meta.url));

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

export default baseConfig;
