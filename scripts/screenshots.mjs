// Regenerates the screenshots in docs/screenshots from the production build.
//
//   pnpm build && pnpm screenshots
//
// Starts the built server itself on a free port and points Chromium's resolver at it for
// http://landlord.example (port included, see screenshot-host.mjs), so the invite link in the shots
// reads like a real deployment's (http://landlord.example/room/CODE): no localhost, no port. Seats
// are filled with bots. Fails when the invite link, a horizontal overflow or the 4-player action
// bar looks wrong.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { browserOptions, inviteLinkProblems, ORIGIN } from './screenshot-host.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = join(ROOT, 'apps/server/dist/index.js');
const WEB_INDEX = join(ROOT, 'apps/web/dist/index.html');
const OUT = join(ROOT, 'docs/screenshots');

const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 800 };
const MOBILE_4P = { width: 375, height: 740 };
/** Rooms to try for a deal that makes a good table shot (bots bid too, so it takes luck). */
const MAIN_ATTEMPTS = 15;
const FOUR_PLAYER_ATTEMPTS = 25;
/** The bidding log lingers this long after the Landlord is chosen (store.ts). */
const BIDDING_LOG_MS = 4_300;

const problems = [];
const log = (...parts) => console.log('[screenshots]', ...parts);
const problem = (text) => {
  problems.push(text);
  console.error('[screenshots] PROBLEM:', text);
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Starts the built server on a port the system picks; resolves with the process and its port once
 * it listens, rejects when it does not.
 */
function startServer() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: '0',
        HOST: '127.0.0.1',
        // Every browser here is one IP; retries for a good deal create a few rooms.
        MAX_ROOM_CREATES_PER_IP: '1000',
        MAX_CONNECTIONS_PER_IP: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not start within 15 s:\n${output}`));
    }, 15_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const listening = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (listening !== null) {
        clearTimeout(timer);
        resolvePromise({ child, port: Number(listening[1]) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server did not start (exit ${code}):\n${output.trim()}`));
    });
  });
}

function stopServer(child) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolvePromise();
    const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => {
      clearTimeout(force);
      resolvePromise();
    });
    child.kill('SIGTERM');
  });
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const button = (page, name) => page.getByRole('button', { name, exact: true });

async function enabled(locator) {
  return (
    (await locator.isVisible().catch(() => false)) && (await locator.isEnabled().catch(() => false))
  );
}

/** Keeps the latest room_state the page received on `page.room`. */
function watch(page, label) {
  page.room = null;
  page.on('websocket', (socket) =>
    socket.on('framereceived', (frame) => {
      try {
        const message = JSON.parse(frame.payload);
        if (message.type === 'room_state') page.room = message.room;
      } catch {
        // not JSON: ignore
      }
    }),
  );
  page.on('pageerror', (error) => problem(`${label}: page error ${error}`));
  page.on('console', (message) => {
    if (message.type() === 'error') log(`${label}: console error ${message.text().slice(0, 200)}`);
  });
}

async function openHome(browser, viewport, label) {
  const mobile = viewport.width < 600;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  watch(page, label);
  await page.goto(`${ORIGIN}/`);
  const name = page.getByLabel('Your name');
  await name.fill('Ada');
  await name.blur();
  await page.getByText('Connecting...').waitFor({ state: 'hidden', timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

async function createRoom(page) {
  await button(page, 'Create room').click();
  await page.waitForURL(/\/room\/[A-Z0-9]{6}$/, { timeout: 15_000 });
  await button(page, 'Stand up').waitFor({ timeout: 15_000 });
}

async function fillAndStart(page) {
  await button(page, 'Fill with bots').click();
  const start = button(page, 'Start hand');
  await start.waitFor();
  for (let i = 0; i < 50 && !(await start.isEnabled()); i++) await page.waitForTimeout(200);
  await start.click();
}

/** The invite link must read like a real deployment's: the public host, no port, no localhost. */
async function checkInviteLink(page, label) {
  const code = new URL(page.url()).pathname.split('/').pop();
  const link = await page.getByTestId('share-url').inputValue();
  for (const text of inviteLinkProblems(link, code)) problem(`${label}: ${text}`);
  log(`${label}: invite link ${link}`);
}

/** Flags anything wider than the viewport and buttons drawn over each other. */
async function checkLayout(page, label) {
  const found = await page.evaluate(() => {
    const width = window.innerWidth;
    const wide = [...document.querySelectorAll('body *')]
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.right > width + 1;
      })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
    const controls = [...document.querySelectorAll('button:not(.card), a.button, input')].filter(
      (el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden',
    );
    const overlaps = [];
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i].getBoundingClientRect();
        const b = controls[j].getBoundingClientRect();
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (
          x > 1 &&
          y > 1 &&
          !controls[i].contains(controls[j]) &&
          !controls[j].contains(controls[i])
        ) {
          overlaps.push(
            `${controls[i].textContent.trim().slice(0, 16)} / ${controls[j].textContent.trim().slice(0, 16)}`,
          );
        }
      }
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      width,
      wide,
      overlaps,
    };
  });
  if (found.scrollWidth > found.width) {
    problem(`${label}: page is ${found.scrollWidth}px wide in a ${found.width}px viewport`);
  }
  if (found.wide.length > 0) problem(`${label}: overflows the viewport: ${found.wide.join(', ')}`);
  if (found.overlaps.length > 0)
    problem(`${label}: overlapping controls: ${found.overlaps.join('; ')}`);
}

async function shoot(page, file, label) {
  await page.waitForTimeout(250);
  await checkLayout(page, label);
  await page.screenshot({ path: join(OUT, file) });
  log(`wrote docs/screenshots/${file}`);
}

/**
 * Bids for the Landlord seat (call mode: Call, else Rob) and plays until it is our turn to answer
 * a bot's play with cards to spare. False when the deal went another way (a bot became Landlord,
 * or the hand ended first), so the caller tries a new room.
 */
async function playToAFollowTurn(page) {
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    const room = page.room;
    const hand = room?.hand;
    const me = room?.you.seat;
    if (hand && hand.landlord !== null && hand.landlord !== me) return false;
    if (hand?.phase === 'finished') return false;
    if (
      hand?.phase === 'playing' &&
      hand.turn === me &&
      hand.legal.canPlay &&
      hand.trick.current !== null &&
      hand.trick.currentSeat !== me &&
      hand.history.length >= 2
    ) {
      if (hand.hand.length < 13) return false;
      return true;
    }
    if (await enabled(button(page, 'Call'))) await button(page, 'Call').click();
    else if (await enabled(button(page, 'Rob'))) await button(page, 'Rob').click();
    else if (hand?.phase === 'playing' && hand.turn === me && hand.trick.current === null) {
      // our lead: play whatever the hint suggests
      if (await enabled(button(page, 'Hint'))) {
        await button(page, 'Hint').click();
        if (await enabled(button(page, 'Play'))) await button(page, 'Play').click();
      }
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function mainShots(browser, viewport, suffix) {
  for (let attempt = 1; attempt <= MAIN_ATTEMPTS; attempt++) {
    const label = `${suffix} (attempt ${attempt})`;
    const { context, page } = await openHome(browser, viewport, label);
    try {
      if (attempt === 1) await shoot(page, `home-${suffix}.png`, `home-${suffix}`);
      await createRoom(page);
      await button(page, 'Add bot').first().click();
      await page.getByText('Bot Ada').first().waitFor();
      await checkInviteLink(page, `lobby-${suffix}`);
      if (attempt === 1) await shoot(page, `lobby-${suffix}.png`, `lobby-${suffix}`);
      await fillAndStart(page);
      if (!(await playToAFollowTurn(page))) {
        log(`table-${suffix}: not our deal as Landlord, trying a new room`);
        continue;
      }
      await page
        .locator('.bidding-log')
        .waitFor({ state: 'hidden', timeout: BIDDING_LOG_MS + 2_000 })
        .catch(() => undefined);
      // select a hint so the preview line and the raised cards show
      if (await enabled(button(page, 'Hint'))) await button(page, 'Hint').click();
      if (!(await enabled(button(page, 'Play')))) {
        log(`table-${suffix}: nothing beats this play, trying a new room`);
        continue;
      }
      await shoot(page, `table-${suffix}.png`, `table-${suffix}`);
      return;
    } finally {
      await context.close();
    }
  }
  problem(`table-${suffix}: no suitable deal in ${MAIN_ATTEMPTS} rooms`);
}

/** 4 players, points bidding: bid 3 when asked, which makes us Landlord with 25 + 8 cards. */
async function fourPlayerShot(browser) {
  for (let attempt = 1; attempt <= FOUR_PLAYER_ATTEMPTS; attempt++) {
    const label = `table-4p-mobile (attempt ${attempt})`;
    const { context, page } = await openHome(browser, MOBILE_4P, label);
    try {
      await button(page, '4 players').click();
      await button(page, 'Points').click();
      await createRoom(page);
      await checkInviteLink(page, label);
      await fillAndStart(page);
      const until = Date.now() + 30_000;
      while (Date.now() < until && page.room?.hand?.phase !== 'playing') {
        if (await enabled(button(page, '3'))) await button(page, '3').click();
        await page.waitForTimeout(150);
      }
      const room = page.room;
      if (room?.hand?.landlord !== room?.you.seat || room?.hand?.hand.length !== 33) {
        log(`${label}: a bot became Landlord, trying a new room`);
        continue;
      }
      await page.waitForTimeout(BIDDING_LOG_MS);
      if (await enabled(button(page, 'Hint'))) await button(page, 'Hint').click();
      // scrolled down to the hand, as a player on a phone would be
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const bar = await page.locator('.action-bar').boundingBox();
      if (bar === null || bar.y < 0 || bar.y + bar.height > MOBILE_4P.height) {
        problem(`table-4p-mobile: the action bar is not fully on screen (${JSON.stringify(bar)})`);
      }
      const count = await page
        .getByRole('group', { name: 'Your hand' })
        .locator('[data-card-id]')
        .count();
      if (count !== 33) problem(`table-4p-mobile: the hand shows ${count} cards, expected 33`);
      await shoot(page, 'table-4p-mobile.png', 'table-4p-mobile');
      return;
    } finally {
      await context.close();
    }
  }
  problem(`table-4p-mobile: never became Landlord in ${FOUR_PLAYER_ATTEMPTS} rooms`);
}

// ---------------------------------------------------------------------------

if (!existsSync(SERVER_ENTRY) || !existsSync(WEB_INDEX)) {
  console.error('[screenshots] no production build found: run `pnpm build` first.');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const server = await startServer();
log(`server on 127.0.0.1:${server.port}, browsing ${ORIGIN}`);
// Interrupted: take the server down too.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.child.kill('SIGTERM');
    process.exit(1);
  });
}

let browser;
try {
  browser = await chromium.launch(browserOptions(server.port));
  await mainShots(browser, MOBILE, 'mobile');
  await mainShots(browser, DESKTOP, 'desktop');
  await fourPlayerShot(browser);
} catch (error) {
  problem(String(error?.stack ?? error));
} finally {
  await browser?.close();
  await stopServer(server.child);
}

if (problems.length > 0) {
  console.error(`[screenshots] ${problems.length} problem(s), see above.`);
  process.exit(1);
}
log('done');
