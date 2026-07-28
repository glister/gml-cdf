import { mergeConfig } from 'vitest/config';
import { baseConfig, dbIntegrationConfig } from '@repo/vitest-config/vitest.config';

// The identity sweep handlers run against a real Postgres; the other worker
// suites are mocked and don't connect. Isolated database so turbo's concurrent
// `test` tasks never collide.
export default mergeConfig(baseConfig, dbIntegrationConfig('cdf_test_worker'));
