import { mergeConfig } from 'vitest/config';
import { baseConfig, dbIntegrationConfig } from '@repo/vitest-config/vitest.config';

// Procedure suites run against this package's own test database (keyset/merge/
// transition correctness needs real SQL); offline suites (keyset.test.ts) don't
// connect. Isolated so turbo's concurrent `test` tasks never collide.
export default mergeConfig(baseConfig, dbIntegrationConfig('cdf_test_trpc'));
