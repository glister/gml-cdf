import { mergeConfig, defineConfig } from 'vitest/config';
import { baseConfig, dbIntegrationConfig } from '@repo/vitest-config/vitest.config';

// The api suite drives Better Auth's HTTP endpoints against a real (isolated)
// Postgres — its own `cdf_test_api`, so it can't collide with the other packages'
// concurrent DB suites. `.env.test` sets TURNSTILE_SECRET_KEY (captcha active),
// which would gate OTP send and can't be verified without Cloudflare; blank it
// here so the invitation/OTP flow is exercisable (captcha enforcement is separate
// UAT — PL-044).
export default mergeConfig(
  baseConfig,
  mergeConfig(
    dbIntegrationConfig('cdf_test_api'),
    defineConfig({ test: { env: { TURNSTILE_SECRET_KEY: '' } } }),
  ),
);
