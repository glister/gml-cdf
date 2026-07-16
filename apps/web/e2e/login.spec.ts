import { expect, test } from '@playwright/test';

test('unauthenticated visit redirects to the login page', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('login page shows the email step first', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByPlaceholder('you@example.com')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible();
});
