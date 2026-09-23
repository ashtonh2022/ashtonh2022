import { expect, test } from '@playwright/test';

test('a friend opens the share link, sits down and both players see each other', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await pageA.goto('/');
  await pageA.getByLabel('Your name').fill('Ada');
  await pageA.getByRole('button', { name: 'Create room' }).click();
  await expect(pageA).toHaveURL(/\/room\/[A-Z0-9]{6}$/, { timeout: 20_000 });
  await expect(pageA.getByRole('heading', { name: 'Seats' })).toBeVisible({ timeout: 20_000 });
  const sitA = pageA.getByRole('button', { name: 'Sit here' }).first();
  if (await sitA.isVisible().catch(() => false)) await sitA.click();
  await expect(pageA.getByRole('button', { name: 'Stand up' })).toBeVisible({ timeout: 10_000 });

  const shareUrl = await pageA.getByTestId('share-url').inputValue();
  expect(shareUrl).toBe(pageA.url());

  await pageB.goto('/');
  const nameB = pageB.getByLabel('Your name');
  await nameB.fill('Bo');
  await nameB.blur();
  await pageB.goto(shareUrl);
  await expect(pageB.getByRole('heading', { name: 'Seats' })).toBeVisible({ timeout: 20_000 });
  await pageB.getByRole('button', { name: 'Sit here' }).first().click();
  await expect(pageB.getByRole('button', { name: 'Stand up' })).toBeVisible({ timeout: 10_000 });

  for (const page of [pageA, pageB]) {
    const seats = page.getByRole('list').filter({ has: page.getByText('Ada', { exact: true }) });
    await expect(seats.getByText('Ada', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await expect(seats.getByText('Bo', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  }

  await contextA.close();
  await contextB.close();
});
