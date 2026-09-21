import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { hint, type HandAction } from '@landlord/engine';
import type { ClientMessage, RoomView, ServerMessage } from '@landlord/protocol';

import { silentLogger } from './log';
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

  static async connect(port: number, name: string): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
