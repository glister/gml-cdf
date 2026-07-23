import { mergeConfig } from 'vitest/config';
import { baseConfig, dbIntegrationConfig } from '@repo/vitest-config/vitest.config';

// Integration suites run against this package's own `cdf_test` database. The
// migration round-trip drops/recreates schemas (destructive), so this database
// must stay exclusive to @repo/db — other packages get their own via
// `dbIntegrationConfig` (see packages/vitest-config/vitest.config.ts).
export default mergeConfig(baseConfig, dbIntegrationConfig('cdf_test'));
