import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

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

  // It got through, so reloading the home page does not bring it back: a kick the server has
  // left to tell comes before the welcome, so once connected it would already show.
  await guest.page.reload();
  await expect(guest.page.getByRole('button', { name: 'Create room' })).toBeVisible();
  await expect(guest.page.getByText('Connecting...', { exact: true })).toHaveCount(0, {
    timeout: 10_000,
  });
  await guest.page.waitForTimeout(1_000);
  await expect(why).toHaveCount(0);
  await expect(guest.page.getByText(/The host removed you/)).toHaveCount(0);

  await closeAll(players);
});

/** Routes the page's game sockets through the test, so they can be cut and kept from coming back. */
async function cuttable(page: Page): Promise<{ cut: () => Promise<void>; restore: () => void }> {
  let blocked = false;
  let live: Array<{ ws: WebSocketRoute; server: WebSocketRoute }> = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (blocked) {
      void ws.close();
      return;
    }
    live.push({ ws, server: ws.connectToServer() });
  });
  return {
    cut: async () => {
      blocked = true;
      for (const { ws, server } of live) {
        await server.close().catch(() => undefined);
        await ws.close().catch(() => undefined);
      }
      live = [];
    },
    restore: () => {
      blocked = false;
    },
  };
}

test('a copy of the room page the player opened is told about a kick too', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await openPlayer(browser, 'Hazel');
  const guest = await openPlayer(browser, 'Ivo');
  const players = [host, guest];
  const url = await createRoom(host);
  const code = new URL(url).pathname.split('/').pop();
  const removed = `The host removed you from room ${code}.`;

  const first = await cuttable(guest.page);
  await joinAndSit(guest, url);
  // The page opens itself again: the copy starts with the sessionStorage of the first page.
  const [copyPage] = await Promise.all([
    guest.context.waitForEvent('page'),
    guest.page.evaluate((href) => void window.open(href), url),
  ]);
  const copy = await cuttable(copyPage);
  // Reloaded, so that its socket goes through the route too.
  await copyPage.reload();
  await expect(copyPage.getByRole('heading', { name: 'Seats' })).toBeVisible({ timeout: 20_000 });

  await fillWithBots(host);
  await startHand(host);
  // Both lose the connection, and the host kicks the player meanwhile.
  await first.cut();
  await copy.cut();
  const seat = await seatIndexOf(host.page, guest.name);
  const panel = host.page.getByTestId(`seat-${seat}`);
  await panel.getByRole('button', { name: `Kick ${guest.name}` }).click();
  await host.page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Kick', exact: true })
    .click();
  await expect(panel.locator('.opponent-name')).toHaveText(/^Bot /, { timeout: 10_000 });

  // The first page comes back and hears about it.
  first.restore();
  await expect(guest.page).toHaveURL(/\/$/, { timeout: 20_000 });
  await expect(guest.page.getByText(removed, { exact: true })).toBeVisible();
  await guest.page.waitForTimeout(500);
  // Then the copy: it is told too, rather than walking back into the room.
  copy.restore();
  await expect(copyPage).toHaveURL(/\/$/, { timeout: 20_000 });
  await expect(copyPage.getByText(removed, { exact: true })).toBeVisible();
  await host.page.waitForTimeout(1_000);
  await expect(host.page.getByText(guest.name, { exact: true })).toHaveCount(0);

  await closeAll(players);
});
