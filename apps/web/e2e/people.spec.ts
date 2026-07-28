import { expect, test } from '@playwright/test';

// Runs in the `logged-in` project, which reuses the stored admin session
// (see auth.setup.ts + playwright.config.ts). Needs a running stack — set
// E2E_BASE_URL / E2E_API_URL / E2E_MAILPIT_URL to point at it.

test('admin people list renders inside the app shell', async ({ page }) => {
  await page.goto('/admin/people');
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Add a person/i })).toBeVisible();
  // The seeded admin appears as a person row.
  await expect(page.getByText('Admin User')).toBeVisible();
});

test('duplicate review queue renders; Review opens the merge dialog when a pair exists', async ({
  page,
}) => {
  await page.goto('/admin/people/duplicates');
  await expect(page.getByRole('heading', { name: 'Possible duplicates' })).toBeVisible();

  const review = page.getByRole('button', { name: 'Review' }).first();
  if (await review.count()) {
    // A pair is present — Review opens the record-level merge dialog with the
    // always-on safeguarding guarantee.
    await review.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Merge duplicate records')).toBeVisible();
    await expect(dialog.getByText(/Safeguarding flags always survive/i)).toBeVisible();
  } else {
    // No live pair — the empty state renders.
    await expect(page.getByText('No possible duplicates')).toBeVisible();
  }
});
