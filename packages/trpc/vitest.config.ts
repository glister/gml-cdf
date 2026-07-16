import { mergeConfig, defineConfig } from 'vitest/config';
import { baseConfig } from '@repo/vitest-config/vitest.config';

export default mergeConfig(baseConfig, defineConfig({}));
