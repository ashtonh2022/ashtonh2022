import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import { clientIpKey, DEFAULT_TRUST_PROXY } from './clientIp';
import { DEFAULT_MAX_ROOM_CREATES_PER_IP, Hub } from './hub';
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
  /**
   * Reverse proxies in front of the server, which decides whose X-Forwarded-For entries are
   * believed (see clientIp.ts). 0 ignores the header. Default 0.
   */
  trustProxy?: number;
  /** Open WebSockets allowed per client IP (an IPv6 /64 counts as one IP). Default 20. */
  maxConnectionsPerIp?: number;
  /** create_room allowed per client IP per 10 minutes (see HubOptions). Default 10. */
  maxRoomCreatesPerIp?: number;
}

/**
 * Open WebSockets allowed per IP unless configured otherwise (env MAX_CONNECTIONS_PER_IP).
 * Generous, because friends behind one home or campus network share an address.
 */
export const DEFAULT_MAX_CONNECTIONS_PER_IP = 20;

export interface RunningServer {
  port: number;
  host: string;
  webDist: string;
  hub: Hub;
  httpServer: Server;
  /** The per-IP settings in force, after defaults and clamping. */
  trustProxy: number;
  maxConnectionsPerIp: number;
  maxRoomCreatesPerIp: number;
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

/** A whole number of at least `min`, or undefined when `value` is missing or not a number. */
function wholeAtLeast(value: number | undefined, min: number): number | undefined {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(min, Math.floor(value))
    : undefined;
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
  const maxRooms = wholeAtLeast(options.maxRooms, 1);
  const trustProxy = wholeAtLeast(options.trustProxy, 0) ?? DEFAULT_TRUST_PROXY;
  const maxConnectionsPerIp =
    wholeAtLeast(options.maxConnectionsPerIp, 1) ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
  const maxRoomCreatesPerIp =
    wholeAtLeast(options.maxRoomCreatesPerIp, 1) ?? DEFAULT_MAX_ROOM_CREATES_PER_IP;
  const hub = new Hub({ log, roomTtlMs, maxRooms, maxRoomCreatesPerIp });
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
  /** Sockets per IP key from their upgrade request until they close, handshake or not. */
  const openPerIp = new Map<string, number>();

  const accept = (socket: WebSocket, ip: string): void => {
    alive.add(socket);
    const connection = hub.connect(
      {
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
      },
      ip,
    );
    socket.on('message', (data, isBinary) => connection.receive(isBinary ? null : data));
    socket.on('pong', () => alive.add(socket));
    socket.on('close', () => connection.handleClose());
    socket.on('error', (err) => {
      log.warn(`connection ${connection.id}: socket error`, err.message);
    });
  };

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
      // Already gone: its 'close' may have fired, so it must not take a slot it would never free.
      if (socket.destroyed) return;
      const ip = clientIpKey(req.headers['x-forwarded-for'], req.socket.remoteAddress, trustProxy);
      const open = openPerIp.get(ip) ?? 0;
      if (open >= maxConnectionsPerIp) {
        rejectUpgrade(socket, 429, 'Too Many Requests');
        return;
      }
      // The slot is taken before the handshake (so parallel upgrades cannot overshoot) and freed
      // when the raw socket closes, which covers failed handshakes as well as closed WebSockets.
      openPerIp.set(ip, open + 1);
      socket.once('close', () => {
        const left = (openPerIp.get(ip) ?? 1) - 1;
        if (left > 0) openPerIp.set(ip, left);
        else openPerIp.delete(ip);
      });
      wss.handleUpgrade(req, socket, head, (ws) => accept(ws, ip));
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
      resolve({
        port: address.port,
        host,
        webDist,
        hub,
        httpServer,
        trustProxy,
        maxConnectionsPerIp,
        maxRoomCreatesPerIp,
        close,
      });
    });
  });
}
