import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

/** One person at the table: their own browser context (own identity in localStorage) and page. */
export interface Player {
  name: string;
  context: BrowserContext;
  page: Page;
}

/**
 * Opens the home page in a fresh context and sets the player's name. Waits for the server's
 * welcome first (it fills in a default name), so the typed name is not overwritten by it.
 */
export async function openPlayer(
  browser: Browser,
  name: string,
  viewport?: { width: number; height: number },
): Promise<Player> {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  await page.goto('/');
  const input = page.getByLabel('Your name');
  await expect(input).not.toHaveValue('', { timeout: 20_000 });
  await input.fill(name);
  await input.blur();
  return { name, context, page };
}

export async function closeAll(players: Player[]): Promise<void> {
  await Promise.all(players.map((player) => player.context.close()));
}

/**
 * Creates a room from the home page. `configure` sets options on the host's rule form before
 * "Create room" is clicked. Returns the room URL (the share link).
 */
export async function createRoom(
  host: Player,
  configure?: (page: Page) => Promise<void>,
): Promise<string> {
  const { page } = host;
  if (configure) await configure(page);
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page).toHaveURL(/\/room\/[A-Z0-9]{6}$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Seats' })).toBeVisible({ timeout: 20_000 });
  const sit = page.getByRole('button', { name: 'Sit here' }).first();
  if (await sit.isVisible().catch(() => false)) await sit.click();
  await expect(page.getByRole('button', { name: 'Stand up' })).toBeVisible({ timeout: 10_000 });
  return page.url();
}

/** Opens the share link and takes the first free seat. */
export async function joinAndSit(player: Player, url: string): Promise<void> {
  const { page } = player;
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Seats' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Sit here' }).first().click();
  await expect(page.getByRole('button', { name: 'Stand up' })).toBeVisible({ timeout: 10_000 });
}

export async function fillWithBots(host: Player): Promise<void> {
  await host.page.getByRole('button', { name: 'Fill with bots' }).click();
}

export async function startHand(host: Player): Promise<void> {
  const start = host.page.getByRole('button', { name: 'Start hand' });
  await expect(start).toBeEnabled({ timeout: 15_000 });
  await start.click();
}

/** The cards in the player's own hand. */
export function handCards(page: Page): Locator {
  return page.getByRole('group', { name: 'Your hand' }).locator('[data-card-id]');
}

/** Card ids of the player's hand, once it holds `count` cards. */
export async function handIds(page: Page, count: number): Promise<string[]> {
  await expect(handCards(page)).toHaveCount(count, { timeout: 20_000 });
  return handCards(page).evaluateAll((cards) =>
    cards.map((card) => card.getAttribute('data-card-id') ?? ''),
  );
}

/** A bidding or play button of the action bar, e.g. "Pass" or "Call". */
export function actionButton(page: Page, name: string): Locator {
  return page.getByRole('button', { name, exact: true });
}

async function isEnabled(locator: Locator): Promise<boolean> {
  return (
    (await locator.isVisible().catch(() => false)) && (await locator.isEnabled().catch(() => false))
  );
}

/**
 * Waits until one of `players` may press `name` (it is their turn), presses it and waits for the
 * button to go away, so the next call sees the next decision. Returns who pressed it.
 */
export async function pressForWhoeverIsOnTurn(
  players: Player[],
  name: string,
  timeoutMs = 20_000,
): Promise<Player> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    for (const player of players) {
      const button = actionButton(player.page, name);
      if (await isEnabled(button)) {
        await button.click();
        await button.waitFor({ state: 'hidden', timeout: 10_000 });
        return player;
      }
    }
    await players[0]?.page.waitForTimeout(150);
  }
  throw new Error(`nobody could press "${name}" within ${timeoutMs} ms`);
}

/** The seat panel (`seat-N` test id) that shows `name`, from `page`'s point of view. */
export async function seatIndexOf(page: Page, name: string): Promise<number> {
  const panel = page
    .getByTestId(/^seat-\d$/)
    .filter({ has: page.locator('.opponent-name', { hasText: new RegExp(`^${name}$`) }) });
  await expect(panel).toHaveCount(1, { timeout: 10_000 });
  const testId = await panel.getAttribute('data-testid');
  return Number(testId?.replace('seat-', ''));
}

/**
 * Plays humans through the bidding by passing whenever it is their turn (a bot or the forced
 * last bidder ends up Landlord) until `done` holds.
 */
export async function passBiddingUntil(
  players: Player[],
  done: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await done()) return;
    for (const player of players) {
      const pass = actionButton(player.page, 'Pass');
      // only bidding shows Pass without Play next to it
      const bidding = !(await actionButton(player.page, 'Play')
        .isVisible()
        .catch(() => false));
      if (bidding && (await isEnabled(pass))) {
        await pass.click();
        // a bot may hand the turn straight back (a rob), so this may see it again: do not insist
        await pass.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
      }
    }
    await players[0]?.page.waitForTimeout(200);
  }
  throw new Error(`bidding did not finish within ${timeoutMs} ms`);
}
