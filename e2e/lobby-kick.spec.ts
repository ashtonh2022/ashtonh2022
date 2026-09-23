import { expect, test } from '@playwright/test';

import { closeAll, createRoom, joinAndSit, openPlayer } from './helpers';

const MOVED = 'The host moved you to the spectators. You can take a seat again when one is free.';

test('in the lobby the host kicks a seated player, who stays to watch and is told why', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const host = await openPlayer(browser, 'Juno');
  const guest = await openPlayer(browser, 'Kai');
  const players = [host, guest];

  const url = await createRoom(host);
  await joinAndSit(guest, url);
  const guestSeat = host.page.locator('.seat-card').filter({ hasText: guest.name });
  await expect(guestSeat).toHaveCount(1, { timeout: 10_000 });

  // In the lobby there is no confirmation: the seat is simply freed.
  await guestSeat.getByRole('button', { name: 'Kick', exact: true }).click();
  await expect(host.page.locator('.seat-card').filter({ hasText: guest.name })).toHaveCount(0, {
    timeout: 10_000,
  });
  const watching = host.page.getByRole('list', { name: 'Watching' });
  await expect(watching.getByText(guest.name, { exact: true })).toBeVisible();

  // The guest is still in the room, now watching, and knows why.
  const why = guest.page.getByText(MOVED, { exact: true });
  await expect(why).toBeVisible({ timeout: 10_000 });
  await expect(guest.page).toHaveURL(url);
  await expect(guest.page.getByText('You are watching', { exact: true })).toBeVisible();
  await expect(guest.page.getByRole('button', { name: 'Stand up' })).toHaveCount(0);
  await expect(guest.page.getByRole('button', { name: 'Sit here' }).first()).toBeEnabled();

  // It stays until dismissed.
  await guest.page.waitForTimeout(1_000);
  await expect(why).toBeVisible();
  await guest.page
    .getByRole('alert')
    .filter({ has: why })
    .getByRole('button', { name: 'Dismiss' })
    .click();
  await expect(why).toHaveCount(0);

  // Nothing keeps them from sitting down again.
  await guest.page.getByRole('button', { name: 'Sit here' }).first().click();
  await expect(guest.page.getByRole('button', { name: 'Stand up' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(host.page.locator('.seat-card').filter({ hasText: guest.name })).toHaveCount(1);

  await closeAll(players);
});
