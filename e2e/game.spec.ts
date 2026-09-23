import { expect, test, type Page } from '@playwright/test';

/** Creates a room, seats the host if the server did not, and returns the room URL. */
async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page).toHaveURL(/\/room\/[A-Z0-9]{6}$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Seats' })).toBeVisible({ timeout: 20_000 });
  const sit = page.getByRole('button', { name: 'Sit here' }).first();
  if (await sit.isVisible().catch(() => false)) await sit.click();
  await expect(page.getByRole('button', { name: 'Stand up' })).toBeVisible({ timeout: 10_000 });
  return page.url();
}

test('a 3-player room with bots plays a full hand', async ({ page }) => {
  test.setTimeout(300_000);
  await createRoom(page, 'Ada');

  await page.getByRole('button', { name: 'Fill with bots' }).click();
  const start = page.getByRole('button', { name: 'Start hand' });
  await expect(start).toBeEnabled({ timeout: 15_000 });
  await start.click();

  const result = page.getByTestId('result');
  const call = page.getByRole('button', { name: 'Call', exact: true });
  const rob = page.getByRole('button', { name: 'Rob', exact: true });
  const keep = page.getByRole('button', { name: 'Keep', exact: true });
  const bid = page.getByRole('button', { name: '1', exact: true });
  const hint = page.getByRole('button', { name: 'Hint', exact: true });
  const play = page.getByRole('button', { name: 'Play', exact: true });
  const pass = page.getByRole('button', { name: 'Pass', exact: true });

  const enabled = async (locator: typeof play) =>
    (await locator.isVisible().catch(() => false)) &&
    (await locator.isEnabled().catch(() => false));

  let finished = false;
  for (let step = 0; step < 600 && !finished; step++) {
    if (await result.isVisible().catch(() => false)) {
      finished = true;
      break;
    }
    if (await enabled(call)) {
      await call.click();
    } else if (await enabled(bid)) {
      await bid.click();
    } else if (await enabled(rob)) {
      // someone robbed: let them have it
      await pass.click();
    } else if (await enabled(keep)) {
      await keep.click();
    } else if (await enabled(play)) {
      await play.click();
    } else if (await enabled(hint)) {
      await hint.click();
      if (await enabled(play)) await play.click();
      else if (await enabled(pass)) await pass.click();
    } else if (await enabled(pass)) {
      await pass.click();
    }
    await page.waitForTimeout(250);
  }

  await expect(result).toBeVisible({ timeout: 30_000 });
  // "The Landlord wins" or "The Peasants win", whichever side went out first
  await expect(result.getByText(/^The (Landlord wins|Peasants win)/)).toBeVisible();
  await expect(page.getByText(/Final stake/)).toBeVisible();
});
