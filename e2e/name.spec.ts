import { expect, test } from '@playwright/test';

import { closeAll, createRoom, openPlayer } from './helpers';

test('a friend who opens the share link names themselves right away and everyone sees it', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const host = await openPlayer(browser, 'Lin');
  const url = await createRoom(host);

  // A brand-new browser goes straight to the share link and types a name as soon as it can.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  const nameField = page.getByLabel('Your name');
  await nameField.fill('Mo');
  await page.getByRole('button', { name: 'Sit here' }).first().click();
  await expect(page.getByRole('button', { name: 'Stand up' })).toBeVisible({ timeout: 10_000 });
  await expect(nameField).toHaveValue('Mo');

  // The host sees the typed name in the seat list, not the server's default "Player NNNN".
  const seatNames = host.page.locator('.seat-name');
  await expect(seatNames.filter({ hasText: /^Mo$/ })).toHaveCount(1, { timeout: 10_000 });
  await expect(seatNames.filter({ hasText: /^Player \d+$/ })).toHaveCount(0);
  await expect(page.locator('.seat-you .seat-name')).toHaveText('Mo');

  // It sticks: after a reload the room still knows them as Mo.
  await page.reload();
  await expect(page.locator('.seat-you .seat-name')).toHaveText('Mo', { timeout: 20_000 });
  await expect(host.page.locator('.seat-name').filter({ hasText: /^Mo$/ })).toHaveCount(1);

  await context.close();
  await closeAll([host]);
});

test('a name typed on the home page before the server has answered is the one others see', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const host = await openPlayer(browser, 'Nia');
  const url = await createRoom(host);
  const code = new URL(url).pathname.split('/').pop() ?? '';

  // Hold back everything the server says until the name is typed, so its welcome (carrying a
  // default "Player NNNN") arrives after the typing, whatever the timing on this machine.
  const context = await browser.newContext();
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.routeWebSocket(/\/ws$/, (page) => {
    const server = page.connectToServer();
    server.onMessage(async (message) => {
      await released;
      page.send(message);
    });
  });
  const page = await context.newPage();
  await page.goto('/');
  const nameField = page.getByLabel('Your name');
  await nameField.fill('Oli');
  await nameField.blur();
  await expect(page.getByText('Connecting...')).toBeVisible();
  release();
  await expect(page.getByText('Connecting...')).toHaveCount(0, { timeout: 10_000 });
  await expect(nameField).toHaveValue('Oli');

  await page.getByLabel('Room code').fill(code);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.getByRole('button', { name: 'Sit here' }).first().click();
  await expect(page.getByRole('button', { name: 'Stand up' })).toBeVisible({ timeout: 10_000 });

  const seatNames = host.page.locator('.seat-name');
  await expect(seatNames.filter({ hasText: /^Oli$/ })).toHaveCount(1, { timeout: 10_000 });
  await expect(seatNames.filter({ hasText: /^Player \d+$/ })).toHaveCount(0);

  await context.close();
  await closeAll([host]);
});
