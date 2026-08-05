import { expect, test } from '@playwright/test';

// Runs in the `logged-in` project, which reuses the stored admin session
// (see auth.setup.ts + playwright.config.ts). Needs a running stack — set
// E2E_BASE_URL / E2E_API_URL / E2E_MAILPIT_URL to point at it.

const PILOT_KEY = 'platform.identity.external_access_default_days';

/**
 * Core plan 06 test 10-T10: the AC-D1 loop end to end — an Administrator changes
 * a registered decision point through the UI, the change is immediately visible
 * with its actor and timestamp, and a reset returns it to the shipped default.
 * No code change, no build, no deployment anywhere in it.
 *
 * The test leaves the key on its default, so it is safe to re-run; it asserts
 * *a new version appears* rather than "version 2", because a shared dev database
 * may already carry earlier changes.
 */
test('an administrator changes a decision point and resets it, all audited', async ({ page }) => {
  // --- The browser lists registered keys, defaults marked as such ----------
  await page.goto('/admin/config');
  await expect(page.getByRole('heading', { name: 'Configuration' })).toBeVisible();

  const row = page.getByRole('link', { name: `Open ${PILOT_KEY}` });
  await expect(row).toBeVisible();
  await row.click();

  // --- The key's own screen ------------------------------------------------
  await expect(page.getByRole('heading', { name: 'external_access_default_days' })).toBeVisible();
  const valueField = page.getByLabel('Value');
  await expect(valueField).toBeVisible();

  // Whatever it is now is what the editor shows — the field's initial value is
  // the value in force, never a stale one.
  const before = await valueField.inputValue();
  const next = before === '45' ? '60' : '45';

  await valueField.fill(next);
  await page.getByRole('button', { name: 'Save change' }).click();

  // --- The change is in force, attributed, and in the history (PL-030) -----
  await expect(page.getByText(/Version \d+, set by Admin User/)).toBeVisible();
  await expect(page.getByText('Default', { exact: true })).toHaveCount(0);

  const history = page.getByRole('table').last();
  await expect(history.getByText(next, { exact: true }).first()).toBeVisible();
  await expect(history.getByText('Admin User').first()).toBeVisible();

  // --- Reset returns the shipped default ----------------------------------
  await page.getByRole('button', { name: 'Reset to default' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Reset to the shipped default?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Reset to default' }).click();

  await expect(page.getByText('No value has been set')).toBeVisible();
  // The default badge is back, and the history still holds every version —
  // a reset closes a window, it never deletes one.
  await expect(page.getByText('Default', { exact: true }).first()).toBeVisible();
  await expect(history.getByText(next, { exact: true }).first()).toBeVisible();
});

test('the browser filters server-side and explains why keys cannot be added', async ({ page }) => {
  await page.goto('/admin/config');

  await page.getByLabel('Search configuration').fill('external access');
  await expect(page.getByRole('link', { name: `Open ${PILOT_KEY}` })).toBeVisible();

  await page.getByLabel('Search configuration').fill('no such decision point');
  await expect(page.getByText('No decision points match these filters.')).toBeVisible();

  await expect(page.getByText('Why there is no “add a key” button')).toBeVisible();
});
