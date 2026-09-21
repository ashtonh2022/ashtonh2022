import { ENGINE_VERSION } from '@landlord/engine';
import { PROTOCOL_VERSION } from '@landlord/protocol';

import { consoleLogger } from './log';
import { startServer } from './server';

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const log = consoleLogger;
const port = envNumber('PORT', 8080);
const host = process.env.HOST?.trim() || '0.0.0.0';
const roomTtlMinutes = envNumber('ROOM_TTL_MINUTES', 120);

process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', reason);
});

startServer({ port, host, roomTtlMinutes, log })
  .then((server) => {
    log.info(
      `landlord server listening on http://${server.host}:${server.port} ` +
        `(engine ${ENGINE_VERSION}, protocol v${PROTOCOL_VERSION}, ` +
        `room ttl ${roomTtlMinutes} min, static: ${server.webDist})`,
    );
    let stopping = false;
    const shutdown = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      log.info(`${signal} received, shutting down`);
      server
        .close()
        .then(() => process.exit(0))
        .catch((err: unknown) => {
          log.error('shutdown failed', err);
          process.exit(1);
        });
      setTimeout(() => process.exit(0), 5_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch((err: unknown) => {
    log.error('failed to start', err);
    process.exit(1);
  });
