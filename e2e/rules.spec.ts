import { expect, test } from '@playwright/test';

test('the home page links to the rules in a new tab', async ({ page }) => {
  await page.goto('/');
  const link = page.getByRole('link', { name: 'How to play' });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(link).toHaveAttribute('href', '/rules');
});

test('the rules page renders RULES.md with the Bombs section', async ({ page }) => {
  await page.goto('/rules');
  await expect(page.getByRole('heading', { name: 'Bombs', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Combinations' })).toBeVisible();
  await expect(page.getByRole('table').first()).toBeVisible();
});
