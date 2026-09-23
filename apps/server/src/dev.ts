/**
 * The server as `pnpm dev` runs it: index.ts with per-IP limits generous enough for development.
 * Behind the Vite dev server every browser, every tab and every e2e test reaches the server
 * through its proxy as 127.0.0.1, so the production defaults (docs/DEPLOY.md) would count them all
 * as one person: a couple of e2e runs would use up the room creations for ten minutes. Setting a
 * variable yourself still wins, to try the real limits.
 */
export const DEV_LIMITS: Readonly<Record<string, string>> = {
  MAX_CONNECTIONS_PER_IP: '1000',
  MAX_ROOM_CREATES_PER_IP: '1000',
};

for (const [name, value] of Object.entries(DEV_LIMITS)) {
  if (!process.env[name]?.trim()) process.env[name] = value;
}

// Imported only now: index.ts reads the environment as it loads.
await import('./index');
