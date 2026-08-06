import { mergeConfig } from 'vitest/config';
import { baseConfig, dbIntegrationConfig } from '@repo/vitest-config/vitest.config';

// The resolution suite runs against real Postgres — as-at window semantics and
// the close-only guard are SQL behaviour, and a mock database would prove
// nothing about either (ADR-0004). Its own database, so turbo's concurrent
// `test` tasks never collide.
export default mergeConfig(baseConfig, dbIntegrationConfig('cdf_test_config'));
