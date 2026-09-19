import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Locate the built web app. Works both from `dist/index.js` (bundled) and from
 * `src/index.ts` (via tsx): either way `../../web/dist` is `apps/web/dist`.
 * Falls back to `apps/web/dist` relative to the process cwd (repo root).
 */
export function resolveWebDist(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '../../web/dist'), resolve(process.cwd(), 'apps/web/dist')];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0]!;
}

export interface StaticHandler {
  (req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createStaticHandler(root: string): StaticHandler {
  const indexFile = join(root, 'index.html');

  async function send(res: ServerResponse, file: string, status = 200): Promise<boolean> {
    try {
      const info = await stat(file);
      if (!info.isFile()) return false;
      const body = await readFile(file);
      res.writeHead(status, {
        'content-type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': body.byteLength,
        'cache-control': file === indexFile ? 'no-cache' : 'public, max-age=31536000, immutable',
      });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  }

  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }

    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const file = resolve(root, `.${pathname}`);

    // Refuse anything that escapes the web root.
    if (file === root || file.startsWith(root + '/')) {
      if (await send(res, file)) return;
    }

    // SPA fallback: unknown extension-less routes get index.html.
    if (extname(pathname) === '' && (await send(res, indexFile))) return;

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  };
}
