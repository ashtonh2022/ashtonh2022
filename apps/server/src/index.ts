import { ENGINE_VERSION } from '@landlord/engine';
import { PROTOCOL_VERSION } from '@landlord/protocol';

import { ConfigError, readConfig, type EnvConfig } from './config';
import { consoleLogger } from './log';
import { startServer } from './server';

const log = consoleLogger;

let config: EnvConfig;
try {
  config = readConfig(process.env);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  // Refuse to start rather than run with settings nobody asked for (see readConfig).
  log.error(`invalid configuration, not starting:\n${err.message}`);
  process.exit(1);
}

process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', reason);
});

startServer({ ...config, log })
  .then((server) => {
    log.info(
      `landlord server listening on http://${server.host}:${server.port} ` +
        `(engine ${ENGINE_VERSION}, protocol v${PROTOCOL_VERSION}, ` +
        `room ttl ${config.roomTtlMinutes} min, max rooms ${config.maxRooms}, ` +
        `trust proxy ${server.trustProxy}, per IP: ${server.maxConnectionsPerIp} connections, ` +
        `${server.maxRoomCreatesPerIp} room creates per 10 min, static: ${server.webDist})`,
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
