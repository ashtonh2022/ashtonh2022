import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
    // Every player in every spec reaches the server from 127.0.0.1 through the Vite proxy. `pnpm
    // dev` itself runs the server with per-IP limits that allow for that (apps/server/src/dev.ts),
    // so a dev server that is already running, and reused here, has them too.
  },
});
