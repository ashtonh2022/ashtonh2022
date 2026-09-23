import { expect, test, type Page } from '@playwright/test';

import {
  actionButton,
  closeAll,
  createRoom,
  fillWithBots,
  joinAndSit,
  openPlayer,
  passBiddingUntil,
  startHand,
} from './helpers';

function doublingStatus(page: Page) {
  return page.getByTestId('centre').getByRole('status').filter({ hasText: 'Doubling round' });
}

test('the doubling round counts only the seats that are still deciding', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await openPlayer(browser, 'Hazel');
  const guest = await openPlayer(browser, 'Ivo');
  const players = [host, guest];

  const url = await createRoom(host, async (page) => {
    const toggle = page.getByRole('switch', { name: 'Doubling round' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  });
  await joinAndSit(guest, url);
  await fillWithBots(host);
  await expect(host.page.getByText('Bot', { exact: true })).toBeVisible();
  await startHand(host);

  await passBiddingUntil(players, async () =>
    doublingStatus(host.page)
      .isVisible()
      .catch(() => false),
  );

  // The bot decides after 0.7-1.5 s; both humans are still deciding.
  for (const { page } of players) {
    await expect(doublingStatus(page)).toContainText('Waiting for 2 players', { timeout: 10_000 });
    await expect(actionButton(page, 'Keep')).toBeEnabled();
  }

  await actionButton(host.page, 'Keep').click();
  await expect(host.page.getByRole('region', { name: 'Your hand' })).toContainText('You kept');
  await expect(actionButton(host.page, 'Keep')).toHaveCount(0);

  // The other human sees exactly one seat left: their own.
  await expect(doublingStatus(guest.page)).toContainText('Waiting for 1 player', {
    timeout: 5_000,
  });
  await expect(doublingStatus(host.page)).toContainText('Waiting for 1 player');
  await expect(actionButton(guest.page, 'Double')).toBeEnabled();

  // Once the last seat decides the round is over and play starts.
  await actionButton(guest.page, 'Double').click();
  for (const { page } of players) {
    await expect(doublingStatus(page)).toHaveCount(0, { timeout: 5_000 });
  }

  await closeAll(players);
});
