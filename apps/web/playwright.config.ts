/* eslint-disable @repo/no-process-env -- Playwright config is tooling, not app code;
   E2E target is chosen by the runner via env, not @repo/env. */
import { defineConfig, devices } from '@playwright/test';

// Target the local `pnpm dev` server by default. Set E2E_BASE_URL (plus
// E2E_API_URL / E2E_MAILPIT_URL) to run against an already-running stack — e.g.
// the Docker compose stack — in which case Playwright does not boot its own
// server. The authenticated specs need E2E_API_URL + E2E_MAILPIT_URL to mint a
// session (see e2e/helpers/auth.ts).
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const external = Boolean(process.env.E2E_BASE_URL);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    // Signs in once and stores the session for the authenticated specs.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    // Unauthenticated specs (the login/redirect surface) — no stored session.
    { name: 'logged-out', testMatch: /login\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    // Authenticated specs reuse the stored admin session.
    {
      name: 'logged-in',
      testMatch: /(people|admin-config)\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/admin.json' },
    },
  ],
  ...(external
    ? {}
    : {
        webServer: {
          command: 'pnpm dev',
          port: 3000,
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }),
});
