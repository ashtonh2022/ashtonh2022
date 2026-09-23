import { expect, test } from '@playwright/test';

import {
  closeAll,
  createRoom,
  handIds,
  joinAndSit,
  openPlayer,
  pressForWhoeverIsOnTurn,
  startHand,
} from './helpers';

test('when everyone passes with Redeal on, new cards are dealt for the same hand', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const host = await openPlayer(browser, 'Hazel');
  const second = await openPlayer(browser, 'Ivo');
  const third = await openPlayer(browser, 'June');
  const players = [host, second, third];

  const url = await createRoom(host, async (page) => {
    await page.getByRole('button', { name: 'Redeal', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Redeal', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
  await joinAndSit(second, url);
  await joinAndSit(third, url);
  await expect(host.page.getByText('Redeal on all pass')).toBeVisible();
  await startHand(host);

  const before = await Promise.all(players.map(({ page }) => handIds(page, 17)));
  for (const { page } of players) {
    await expect(page.getByTestId('centre').getByText('Hand 1', { exact: true })).toBeVisible();
    await expect(page.getByText('Everyone passed. New cards were dealt.')).toHaveCount(0);
  }

  const passed = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const who = await pressForWhoeverIsOnTurn(players, 'Pass');
    passed.add(who.name);
  }
  expect(passed.size).toBe(3);

  for (const [index, { page }] of players.entries()) {
    await expect(page.getByRole('status').filter({ hasText: 'New cards were dealt' })).toHaveText(
      'Everyone passed. New cards were dealt.',
      { timeout: 10_000 },
    );
    const centre = page.getByTestId('centre');
    await expect(centre.getByText('Hand 1', { exact: true })).toBeVisible();
    await expect(centre.getByText('Hand 2', { exact: true })).toHaveCount(0);
    await expect
      .poll(async () => (await handIds(page, 17)).join(','), { timeout: 10_000 })
      .not.toBe(before[index]?.join(','));
    // the bidding log starts over for the new deal
    await expect(centre.getByRole('log')).not.toContainText('passed');
  }

  await closeAll(players);
});
