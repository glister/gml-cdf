import { test as setup } from '@playwright/test';
import { signInAsAdmin } from './helpers/auth';

// Authenticate ONCE per run and persist the session, so the authenticated specs
// reuse it (one OTP send per run — the OTP-send endpoint is itself rate-limited).
const authFile = 'e2e/.auth/admin.json';

setup('authenticate as admin', async ({ page, context }) => {
  await signInAsAdmin(context.request);
  // Touch an authenticated route so the session cookie is exercised, then persist.
  await page.goto('/admin/people');
  await page.waitForURL('**/admin/people');
  await context.storageState({ path: authFile });
});
