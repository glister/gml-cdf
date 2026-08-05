import { mergeConfig } from 'vitest/config';
import { baseConfig, dbIntegrationConfig } from '@repo/vitest-config/vitest.config';

// Everything this package does is transactional SQL — row locks, append-only
// guards, partial unique indexes, `FOR UPDATE SKIP LOCKED`. None of it can be
// proven against a mock database (ADR-0004), so the suites run on real Postgres
// in their own database, isolated from turbo's other concurrent `test` tasks.
export default mergeConfig(baseConfig, dbIntegrationConfig('cdf_test_workflow'));
