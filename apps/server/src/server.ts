import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import { Hub } from './hub';
import { consoleLogger, type Logger } from './log';
import { DEFAULT_ROOM_TTL_MS } from './rooms';
import { createStaticHandler, resolveWebDist } from './static';

export interface ServerOptions {
  /** 0 picks a free port. Default 8080. */
  port?: number;
  /** Default 0.0.0.0. */
  host?: string;
  roomTtlMinutes?: number;
  /** Directory of the built web client; auto-detected when omitted. */
  webDist?: string;
  log?: Logger;
  /** WebSocket ping interval; sockets that miss a pong are terminated. Default 30 s. */
  heartbeatMs?: number;
  /** Most rooms held at once (see HubOptions.maxRooms). Default 500. */
  maxRooms?: number;
}

export interface RunningServer {
  port: number;
  host: string;
  webDist: string;
  hub: Hub;
  httpServer: Server;
  close(): Promise<void>;
}

/** The path of a request target, or null when it cannot be parsed (such as `//[`). */
export function requestPath(url: string | undefined): string | null {
  try {
    return new URL(url ?? '/', 'http://localhost').pathname;
  } catch {
    return null;
  }
}

/** Answers an upgrade request with a plain HTTP error and closes the socket. */
function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  // The raw socket has no error listener of its own once it is handed to 'upgrade'.
  socket.on('error', () => undefined);
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Boots the HTTP server (static client + /healthz) with the game hub attached at /ws. */
export function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const log = options.log ?? consoleLogger;
  const host = options.host ?? '0.0.0.0';
  const webDist = options.webDist ?? resolveWebDist();
  const serveStatic = createStaticHandler(webDist);
  const roomTtlMs =
    options.roomTtlMinutes !== undefined && Number.isFinite(options.roomTtlMinutes)
      ? Math.max(1, options.roomTtlMinutes) * 60 * 1000
      : DEFAULT_ROOM_TTL_MS;
  const maxRooms =
    options.maxRooms !== undefined && Number.isFinite(options.maxRooms)
      ? Math.max(1, Math.floor(options.maxRooms))
      : undefined;
  const hub = new Hub({ log, roomTtlMs, maxRooms });
  hub.start();

  const httpServer = createServer((req, res) => {
    try {
      const pathname = requestPath(req.url);
      if (pathname === null) {
        // An unparsable request target is the client's mistake: answer 400, nothing to log.
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Bad request');
        return;
      }
      if (pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      serveStatic(req, res).catch((err: unknown) => {
        log.error('static handler failed', err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    } catch (err) {
      log.error('request handler failed', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const alive = new WeakSet<WebSocket>();

  wss.on('connection', (socket) => {
    alive.add(socket);
    const connection = hub.connect({
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
    });
    socket.on('message', (data, isBinary) => connection.receive(isBinary ? null : data));
    socket.on('pong', () => alive.add(socket));
    socket.on('close', () => connection.handleClose());
    socket.on('error', (err) => {
      log.warn(`connection ${connection.id}: socket error`, err.message);
    });
  });

  // Nothing may throw out of this listener: an exception here would take the whole process down.
  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const pathname = requestPath(req.url);
      if (pathname === null) {
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
      }
      if (pathname !== '/ws') {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch (err) {
      log.warn('upgrade request failed', err);
      socket.destroy();
    }
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, options.heartbeatMs ?? 30_000);

  const close = (): Promise<void> => {
    clearInterval(heartbeat);
    hub.stop();
    for (const socket of wss.clients) socket.terminate();
    return new Promise((resolve) => {
      wss.close(() => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      });
    });
  };

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 8080, host, () => {
      httpServer.off('error', reject);
      const address = httpServer.address() as AddressInfo;
      resolve({ port: address.port, host, webDist, hub, httpServer, close });
    });
  });
}
