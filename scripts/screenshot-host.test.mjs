// Tests for the host set-up of scripts/screenshots.mjs:  node --test "scripts/*.test.mjs"
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { chromium } from '@playwright/test';

import { browserOptions, inviteLinkProblems, ORIGIN } from './screenshot-host.mjs';

test('the shots browse a public-looking origin with no port', () => {
  assert.equal(ORIGIN, 'http://landlord.example');
});

test('an invite link must read like a real deployment: no port, no localhost', () => {
  assert.deepEqual(inviteLinkProblems('http://landlord.example/room/C73K2P', 'C73K2P'), []);
  const withPort = inviteLinkProblems('http://landlord.example:8099/room/C73K2P', 'C73K2P');
  assert.ok(
    withPort.some((text) => text.includes('port 8099')),
    withPort.join('; '),
  );
  assert.notDeepEqual(inviteLinkProblems('http://localhost:5173/room/C73K2P', 'C73K2P'), []);
  assert.notDeepEqual(inviteLinkProblems('http://127.0.0.1/room/C73K2P', 'C73K2P'), []);
  assert.notDeepEqual(inviteLinkProblems('http://landlord.example/room/OTHER1', 'C73K2P'), []);
  assert.notDeepEqual(inviteLinkProblems('', 'C73K2P'), []);
});

test(
  'Chromium reaches a server on any port as the port-less origin (no port 80 needed)',
  { skip: existsSync(chromium.executablePath()) ? false : 'Chromium is not installed' },
  async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<title>mapped</title><p id="path">${req.url}</p>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    assert.notEqual(port, 80);
    const browser = await chromium.launch(browserOptions(port));
    try {
      const page = await browser.newPage();
      await page.goto(`${ORIGIN}/room/C73K2P`);
      assert.equal(await page.evaluate(() => location.origin), ORIGIN);
      assert.equal(await page.locator('#path').textContent(), '/room/C73K2P');
    } finally {
      await browser.close();
      server.close();
    }
  },
);
