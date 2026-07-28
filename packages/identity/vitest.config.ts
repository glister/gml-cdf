import { mergeConfig } from 'vitest/config';
import { baseConfig, dbIntegrationConfig } from '@repo/vitest-config/vitest.config';

// Real-Postgres integration suite: its own database so it never collides with
// other packages' suites under turbo's concurrent `test` tasks.
export default mergeConfig(baseConfig, dbIntegrationConfig('cdf_test_identity'));
