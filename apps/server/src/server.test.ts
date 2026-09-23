import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { hint, type HandAction } from '@landlord/engine';
import type { ClientMessage, RoomView, ServerMessage } from '@landlord/protocol';

import { silentLogger, type Logger } from './log';
import { startServer, type RunningServer } from './server';

/** A real WebSocket client that can play a hand by itself from the snapshots it receives. */
class TestClient {
  readonly messages: ServerMessage[] = [];
  room: RoomView | null = null;
  welcome: Extract<ServerMessage, { type: 'welcome' }> | null = null;
  autoplay = false;
  private readonly acted = new Set<string>();
  private readonly waiters: Array<{ predicate: () => boolean; resolve: () => void }> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      this.messages.push(message);
      if (message.type === 'welcome') this.welcome = message;
      if (message.type === 'room_state') {
        this.room = message.room;
        if (this.autoplay) this.react(message.room);
      }
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate()) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    });
  }

  static async connect(
    port: number,
    name: string,
    headers: Record<string, string> = {},
  ): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const client = new TestClient(ws);
    client.send({ type: 'hello', protocol: 1, name });
    await client.waitFor(() => client.welcome !== null);
    return client;
  }

  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  get errors(): Array<Extract<ServerMessage, { type: 'error' }>> {
    return this.messages.filter(
      (m): m is Extract<ServerMessage, { type: 'error' }> => m.type === 'error',
    );
  }

  waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting (last room status: ${this.room?.status ?? 'none'})`));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  /** The decision policy from the task description, applied once per distinct snapshot. */
  private react(room: RoomView): void {
    const hand = room.hand;
    if (hand === null || room.status !== 'playing' || room.you.seat === null) return;
    const key = [
      hand.handNumber,
      hand.phase,
      hand.turn,
      hand.bidding.records.length,
      hand.history.length,
      hand.doubles.map((d) => (d === null ? '-' : d ? 'd' : 'k')).join(''),
    ].join('|');
    if (this.acted.has(key)) return;
    const legal = hand.legal;
    let action: HandAction | null = null;
    if (legal.canCall) action = { type: 'call' };
    else if (legal.canRob) action = { type: 'pass_bid' };
    else if (legal.bids.length > 0) action = { type: 'bid', value: legal.bids[0] as 1 | 2 | 3 };
    else if (legal.canPassBid) action = { type: 'pass_bid' };
    else if (legal.canDouble) action = { type: 'double', double: false };
    else if (legal.canPlay) {
      const suggestion = hint(hand.hand, hand.trick.current, hand.rules);
      if (suggestion !== null) {
        action = { type: 'play', cardIds: suggestion.cards.map((card) => card.id) };
      } else if (legal.canPass) {
        action = { type: 'pass' };
      }
    }
    if (action === null) return;
    this.acted.add(key);
    this.send({ type: 'hand_action', action });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

describe('server (real sockets)', () => {
  let server: RunningServer;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    server = await startServer({
      port: 0,
      host: '127.0.0.1',
      log: silentLogger,
      webDist: '/nonexistent/web/dist',
      heartbeatMs: 1000,
    });
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await server.close();
  });

  async function connect(name: string): Promise<TestClient> {
    const client = await TestClient.connect(server.port, name);
    clients.push(client);
    return client;
  }

  it('shows on /ip the address it counts you as, ignoring X-Forwarded-For with no trusted proxy', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/ip`, {
      headers: { 'x-forwarded-for': '198.51.100.9' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      ip: '127.0.0.1',
      limitKey: '127.0.0.1',
      trustProxy: 0,
      hops: ['198.51.100.9', '127.0.0.1'],
    });
  });

  it('answers /healthz and rejects other upgrade paths', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const missing = await fetch(`http://127.0.0.1:${server.port}/nothing.png`);
    expect(missing.status).toBe(404);

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/other`);
    await new Promise<void>((resolve) => {
      ws.once('error', () => resolve());
      ws.once('close', () => resolve());
    });
  });

  it('three players play a whole hand, then a spectator joins and sees no cards', async () => {
    const [ann, ben, cid] = await Promise.all([connect('Ann'), connect('Ben'), connect('Cid')]);
    const players = [ann, ben, cid] as TestClient[];
    ann.send({ type: 'create_room', rules: { turnSeconds: 5 } });
    await ann.waitFor(() => ann.room !== null);
    const code = ann.room?.code as string;
    expect(ann.room?.rules.turnSeconds).toBe(5);

    ben.send({ type: 'join_room', code });
    await ben.waitFor(() => ben.room !== null);
    ben.send({ type: 'sit', seat: 1 });
    await ben.waitFor(() => ben.room?.you.seat === 1);
    cid.send({ type: 'join_room', code });
    await cid.waitFor(() => cid.room !== null);
    cid.send({ type: 'sit', seat: 2 });
    await cid.waitFor(() => cid.room?.you.seat === 2);
    await ann.waitFor(() => ann.room?.seats.every((seat) => seat.playerId !== null) === true);

    for (const player of players) player.autoplay = true;
    ann.send({ type: 'start_hand' });
    await Promise.all(
      players.map((player) =>
        player.waitFor(() => player.room?.status === 'between_hands', 15_000),
      ),
    );

    for (const player of players) {
      expect(player.errors).toEqual([]);
      expect(player.room?.handNumber).toBe(1);
      expect(player.room?.deadline).toBeNull();
    }
    const scores = ann.room?.seats.map((seat) => seat.score) as number[];
    expect(scores.reduce((a, b) => a + b, 0)).toBe(0);
    expect(scores.some((score) => score !== 0)).toBe(true);
    const result = ann.room?.lastResult;
    expect(result).not.toBeNull();
    expect(ben.room?.lastResult).toEqual(result);
    expect(cid.room?.lastResult).toEqual(result);
    expect(result?.amounts).toEqual(scores);

    const dee = await connect('Dee');
    dee.send({ type: 'join_room', code });
    await dee.waitFor(() => dee.room !== null);
    expect(dee.room?.you.seat).toBeNull();
    expect(dee.room?.hand?.hand).toEqual([]);
    expect(dee.room?.hand?.seat).toBeNull();
    expect(dee.room?.status).toBe('between_hands');
    expect(dee.room?.spectators.map((s) => s.name)).toEqual(['Dee']);
    await ann.waitFor(() => ann.room?.spectators.length === 1);
  });

  it('answers garbage frames with bad_message instead of dropping the socket', async () => {
    const client = await connect('Eve');
    client.ws.send('nonsense');
    await client.waitFor(() => client.errors.length === 1);
    expect(client.errors[0]?.code).toBe('bad_message');
    client.ws.send(Buffer.from([1, 2, 3]));
    await client.waitFor(() => client.errors.length === 2);
    client.send({ type: 'ping' });
    await client.waitFor(() => client.messages.some((m) => m.type === 'pong'));
  });
});

/** Sends raw bytes to the server and resolves with everything it answers before closing. */
function rawRequest(port: number, text: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const socket = netConnect(port, '127.0.0.1', () => socket.write(text));
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      data += chunk;
    });
    socket.on('error', () => undefined);
    socket.on('close', () => resolve(data));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(`${data}<timeout>`);
    });
  });
}

/** A logger that remembers error-level lines. */
function recordingLogger(): Logger & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    info: () => undefined,
    warn: () => undefined,
    error: (message) => {
      errors.push(message);
    },
  };
}

describe('server hardening (real sockets)', () => {
  let server: RunningServer;
  let webDist: string;
  const log = recordingLogger();

  beforeAll(async () => {
    webDist = mkdtempSync(join(tmpdir(), 'landlord-web-'));
    mkdirSync(join(webDist, 'assets'));
    mkdirSync(join(webDist, 'audio'));
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>x</title>');
    writeFileSync(join(webDist, 'assets', 'index-abc123.js'), 'console.log(1)');
    writeFileSync(join(webDist, 'audio', 'bomb.wav'), 'RIFF');
    writeFileSync(join(webDist, 'audio', 'bomb.mp3'), 'ID3');
    writeFileSync(join(webDist, 'audio', 'bomb.ogg'), 'OggS');
    writeFileSync(join(webDist, 'manifest.webmanifest'), '{}');
    writeFileSync(join(webDist, 'favicon.ico'), 'ico');
    writeFileSync(join(webDist, 'logo.svg'), '<svg/>');
    server = await startServer({ port: 0, host: '127.0.0.1', log, webDist });
  });

  afterAll(async () => {
    await server.close();
    rmSync(webDist, { recursive: true, force: true });
  });

  const upgradeHeaders =
    'Host: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';

  it('survives malformed WebSocket upgrade requests (S1)', async () => {
    for (const target of ['//[', 'http://[/ws', 'http://a:99999/ws']) {
      const answer = await rawRequest(server.port, `GET ${target} HTTP/1.1\r\n${upgradeHeaders}`);
      expect(answer).toMatch(/^HTTP\/1\.1 400 /);
      const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(health.status).toBe(200);
    }
    // A well-formed upgrade still works afterwards.
    const ok = await rawRequest(server.port, `GET /ws HTTP/1.1\r\n${upgradeHeaders}`, 300);
    expect(ok).toMatch(/^HTTP\/1\.1 101 /);
  });

  it('answers malformed request targets with 400 and no error log (S10)', async () => {
    const percent = await fetch(`http://127.0.0.1:${server.port}/%`);
    expect(percent.status).toBe(400);
    const partial = await fetch(`http://127.0.0.1:${server.port}/%E0%A4%A`);
    expect(partial.status).toBe(400);
    const raw = await rawRequest(
      server.port,
      'GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
    );
    expect(raw).toMatch(/^HTTP\/1\.1 400 /);
    const index = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(index.status).toBe(200);
    expect(log.errors).toEqual([]);
  });

  it('caches only hashed /assets forever and serves audio and manifest types (S11)', async () => {
    const head = async (path: string): Promise<[string | null, string | null]> => {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'HEAD' });
      expect(response.status).toBe(200);
      return [response.headers.get('content-type'), response.headers.get('cache-control')];
    };
    expect(await head('/assets/index-abc123.js')).toEqual([
      'text/javascript; charset=utf-8',
      'public, max-age=31536000, immutable',
    ]);
    expect(await head('/audio/bomb.wav')).toEqual(['audio/wav', 'no-cache']);
    expect(await head('/audio/bomb.mp3')).toEqual(['audio/mpeg', 'no-cache']);
    expect(await head('/audio/bomb.ogg')).toEqual(['audio/ogg', 'no-cache']);
    expect(await head('/manifest.webmanifest')).toEqual(['application/manifest+json', 'no-cache']);
    expect(await head('/favicon.ico')).toEqual(['image/x-icon', 'no-cache']);
    expect(await head('/logo.svg')).toEqual(['image/svg+xml', 'no-cache']);
    expect(await head('/index.html')).toEqual(['text/html; charset=utf-8', 'no-cache']);
    expect(await head('/room/ABCDEF')).toEqual(['text/html; charset=utf-8', 'no-cache']);
  });
});

/** Opens a raw WebSocket from `ip` (sent as X-Forwarded-For); resolves with it or the HTTP status. */
function openFrom(port: number, ip: string): Promise<WebSocket | number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'X-Forwarded-For': ip } });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (req, res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    ws.once('error', reject);
  });
}

function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
    ws.close();
  });
}

describe('per-IP limits (real sockets)', () => {
  let server: RunningServer;
  const sockets: WebSocket[] = [];
  const clients: TestClient[] = [];

  beforeAll(async () => {
    // One trusted proxy: the last X-Forwarded-For entry is the client, so tests can be many IPs.
    server = await startServer({
      port: 0,
      host: '127.0.0.1',
      log: silentLogger,
      webDist: '/nonexistent/web/dist',
      trustProxy: 1,
      maxRoomCreatesPerIp: 2,
    });
  });

  afterAll(async () => {
    await Promise.all([...sockets.map(closeSocket), ...clients.map((client) => client.close())]);
    await server.close();
  });

  it('shows on /ip the hop the trusted proxy vouches for, not what the client wrote', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/ip`, {
      headers: { 'x-forwarded-for': '198.51.100.9, 203.0.113.7' },
    });
    expect(await response.json()).toEqual({
      ip: '203.0.113.7',
      limitKey: '203.0.113.7',
      trustProxy: 1,
      hops: ['198.51.100.9', '203.0.113.7', '127.0.0.1'],
    });
  });

  it('refuses the 21st WebSocket from one IP with 429 and frees a slot when one closes', async () => {
    const a = '203.0.113.10';
    for (let i = 0; i < 20; i++) {
      const ws = await openFrom(server.port, a);
      expect(ws).toBeInstanceOf(WebSocket);
      sockets.push(ws as WebSocket);
    }
    expect(await openFrom(server.port, a)).toBe(429);
    // What the client wrote before the proxy's entry does not make it someone else.
    expect(await openFrom(server.port, `198.51.100.99, ${a}`)).toBe(429);
    // Another IP is not affected.
    const b = await openFrom(server.port, '203.0.113.11');
    expect(b).toBeInstanceOf(WebSocket);
    sockets.push(b as WebSocket);

    await closeSocket(sockets.shift() as WebSocket);
    let again: WebSocket | number = 429;
    for (let attempt = 0; attempt < 50 && again === 429; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 20));
      again = await openFrom(server.port, a);
    }
    expect(again).toBeInstanceOf(WebSocket);
    sockets.push(again as WebSocket);
    expect(await openFrom(server.port, a)).toBe(429);
  });

  it('frees the slot of an upgrade whose handshake fails', async () => {
    const ip = '203.0.113.12';
    const badUpgrade =
      `GET /ws HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${ip}\r\n` +
      'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\r\n';
    for (let i = 0; i < 25; i++) {
      expect(await rawRequest(server.port, badUpgrade)).toMatch(/^HTTP\/1\.1 400 /);
    }
    const ws = await openFrom(server.port, ip);
    expect(ws).toBeInstanceOf(WebSocket);
    sockets.push(ws as WebSocket);
  });

  it('limits create_room per IP across connections (maxRoomCreatesPerIp)', async () => {
    const ip = { 'X-Forwarded-For': '203.0.113.20' };
    const [first, second, third] = await Promise.all([
      TestClient.connect(server.port, 'One', ip),
      TestClient.connect(server.port, 'Two', ip),
      TestClient.connect(server.port, 'Three', ip),
    ]);
    const elsewhere = await TestClient.connect(server.port, 'Four', {
      'X-Forwarded-For': '203.0.113.21',
    });
    clients.push(first as TestClient, second as TestClient, third as TestClient, elsewhere);
    for (const client of [first, second] as TestClient[]) {
      client.send({ type: 'create_room', rules: {} });
      await client.waitFor(() => client.room !== null);
    }
    const late = third as TestClient;
    late.send({ type: 'create_room', rules: {} });
    await late.waitFor(() => late.errors.length > 0);
    expect(late.errors[0]).toEqual({
      type: 'error',
      code: 'rate_limited',
      message: 'You are creating rooms too quickly. Try again in a few minutes.',
    });
    expect(late.room).toBeNull();
    elsewhere.send({ type: 'create_room', rules: {} });
    await elsewhere.waitFor(() => elsewhere.room !== null);
    expect(elsewhere.errors).toEqual([]);
  });
});
