import { baseConfig } from '@repo/vitest-config/vitest.config';
import { defineConfig, mergeConfig } from 'vitest/config';

// Node-environment logic tests only. React Native component testing is not wired
// yet (it needs a dedicated RN test preset) — add it when the first component
// test lands.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      passWithNoTests: true,
    },
  }),
);
