import { mergeConfig, defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { browserConfig } from '@repo/vitest-config/vitest.config';

export default mergeConfig(
  browserConfig,
  defineConfig({
    plugins: [tsconfigPaths()],
    test: {
      exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
      setupFiles: ['./src/test-setup.ts'],
    },
  }),
);
