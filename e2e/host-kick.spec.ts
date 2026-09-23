import { expect, test } from '@playwright/test';

import {
  closeAll,
  createRoom,
  fillWithBots,
  joinAndSit,
  openPlayer,
  passBiddingUntil,
  seatIndexOf,
  startHand,
} from './helpers';

test('the host kicks a player during play and a bot takes their seat', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await openPlayer(browser, 'Hazel');
  const guest = await openPlayer(browser, 'Ivo');
  const players = [host, guest];

  const url = await createRoom(host);
  await joinAndSit(guest, url);
  await fillWithBots(host);
  await startHand(host);

  // Get through the bidding to the play of the cards.
  const trick = host.page.getByTestId('centre').locator('.trick');
  await passBiddingUntil(players, () => trick.isVisible().catch(() => false));

  const seat = await seatIndexOf(host.page, guest.name);
  const panel = host.page.getByTestId(`seat-${seat}`);
  await expect(guest.page.getByRole('group', { name: 'Your hand' })).toBeVisible();

  // Cancel first: nothing happens.
  await panel.getByRole('button', { name: `Kick ${guest.name}` }).click();
  const dialog = host.page.getByRole('alertdialog');
  await expect(dialog).toContainText(`Kick ${guest.name}?`);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.locator('.opponent-name')).toHaveText(guest.name);

  await panel.getByRole('button', { name: `Kick ${guest.name}` }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Kick', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // The seat is played by a bot now and the hand goes on.
  await expect(panel.locator('.opponent-name')).toHaveText(/^Bot /, { timeout: 10_000 });
  await expect(panel.getByText('Bot', { exact: true })).toBeVisible();
  await expect(host.page.getByTestId('centre').locator('.trick')).toBeVisible();
  await expect(host.page.getByText(guest.name, { exact: true })).toHaveCount(0);

  // The kicked player is sent home, told why, and is no longer seated anywhere in the room.
  await expect(guest.page).toHaveURL(/\/$/, { timeout: 10_000 });
  await expect(guest.page.getByRole('button', { name: 'Create room' })).toBeVisible();
  const code = new URL(url).pathname.split('/').pop();
  const why = guest.page.getByText(`The host removed you from room ${code}.`, { exact: true });
  await expect(why).toBeVisible();
  // It stays until dismissed.
  await guest.page.waitForTimeout(1_000);
  await expect(why).toBeVisible();
  await guest.page
    .getByRole('alert')
    .filter({ has: why })
    .getByRole('button', { name: 'Dismiss' })
    .click();
  await expect(why).toHaveCount(0);

  await closeAll(players);
});
