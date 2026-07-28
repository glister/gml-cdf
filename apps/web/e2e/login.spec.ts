import { expect, test } from '@playwright/test';

test('unauthenticated visit redirects to the login page', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome to Connect' })).toBeVisible();
});

test('login page shows the two sign-in doors', async ({ page }) => {
  await page.goto('/login');
  // Employees — Entra / Microsoft work account.
  await expect(page.getByRole('button', { name: /Sign in with Microsoft/i })).toBeVisible();
  // Agency / external workers — email one-time passcode.
  await expect(page.getByPlaceholder('you@company.co.uk')).toBeVisible();
  await expect(page.getByRole('button', { name: /Email me a sign-in code/i })).toBeVisible();
});
