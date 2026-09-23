import { expect, test } from '@playwright/test';

import {
  actionButton,
  closeAll,
  createRoom,
  handCards,
  joinAndSit,
  openPlayer,
  pressForWhoeverIsOnTurn,
  startHand,
} from './helpers';

test('when the first two bidders pass, the last one is made Landlord without a click', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const host = await openPlayer(browser, 'Hazel');
  const second = await openPlayer(browser, 'Ivo');
  const third = await openPlayer(browser, 'June');
  const players = [host, second, third];

  const url = await createRoom(host, async (page) => {
    // "Force last bidder" is the default; press it anyway so the test does not rely on that
    await page.getByRole('button', { name: 'Force last bidder', exact: true }).click();
  });
  await joinAndSit(second, url);
  await joinAndSit(third, url);
  await expect(host.page.getByText('Force last bidder')).toBeVisible();
  await startHand(host);

  const first = await pressForWhoeverIsOnTurn(players, 'Pass');
  const next = await pressForWhoeverIsOnTurn(
    players.filter((player) => player !== first),
    'Pass',
  );
  const last = players.find((player) => player !== first && player !== next);
  if (!last) throw new Error('no third player');

  // Well inside the 30 s turn timer, so this is not a timeout acting for them.
  const line = `Everyone else passed, so ${last.name} is the Landlord`;
  await Promise.all(
    players.map(({ page }) =>
      expect(page.getByTestId('centre').getByRole('log')).toContainText(line, { timeout: 5_000 }),
    ),
  );
  const lastHand = last.page.getByRole('region', { name: 'Your hand' });
  await expect(lastHand.getByText('Landlord')).toBeVisible();
  // the Landlord picked up the kitty and leads the first trick
  await expect(handCards(last.page)).toHaveCount(20);
  await expect(last.page.getByTestId('centre').getByText('Your lead')).toBeVisible();
  // the forced bidder was never asked to decide
  await expect(actionButton(last.page, 'Call')).toHaveCount(0);
  for (const other of [first, next]) {
    await expect(other.page.getByTestId('centre').getByText(`${last.name} leads`)).toBeVisible();
  }

  await closeAll(players);
});
