import { expect, test } from '@playwright/test';

import {
  closeAll,
  createRoom,
  fillWithBots,
  handIds,
  joinAndSit,
  openPlayer,
  seatIndexOf,
  startHand,
} from './helpers';

test('a player who reloads mid-hand gets the same seat and the same cards back', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const host = await openPlayer(browser, 'Hazel');
  const guest = await openPlayer(browser, 'Ivo');
  const players = [host, guest];

  const url = await createRoom(host);
  await joinAndSit(guest, url);
  await fillWithBots(host);
  await startHand(host);

  // Nobody acts for the humans, so the guest's 17 cards cannot change during the reload.
  const before = await handIds(guest.page, 17);
  const seat = await seatIndexOf(host.page, guest.name);
  const opponentsBefore = await guest.page
    .getByTestId(/^seat-\d$/)
    .evaluateAll((panels) => panels.map((panel) => panel.getAttribute('data-testid')).sort());

  await guest.page.reload();

  await expect(guest.page).toHaveURL(url);
  await expect(guest.page.getByRole('group', { name: 'Your hand' })).toBeVisible({
    timeout: 20_000,
  });
  expect(await handIds(guest.page, 17)).toEqual(before);
  const opponentsAfter = await guest.page
    .getByTestId(/^seat-\d$/)
    .evaluateAll((panels) => panels.map((panel) => panel.getAttribute('data-testid')).sort());
  expect(opponentsAfter).toEqual(opponentsBefore);
  expect(opponentsAfter).not.toContain(`seat-${seat}`);

  // The host sees them back in the same seat, connected, and no bot took it over.
  const panel = host.page.getByTestId(`seat-${seat}`);
  await expect(panel.locator('.opponent-name')).toHaveText(guest.name);
  await expect(panel.getByRole('img', { name: 'Disconnected' })).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(panel.getByText('Bot', { exact: true })).toHaveCount(0);

  await closeAll(players);
});
