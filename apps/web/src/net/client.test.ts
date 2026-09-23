import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROTOCOL_VERSION, type ServerMessage } from '@landlord/protocol';

import { GameClient, IDENTITY_KEY, type SocketLike, type StorageLike } from './client';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message: ServerMessage | Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  parsed(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const welcome: ServerMessage = {
  type: 'welcome',
  playerId: 'p1',
  token: 't1',
  name: 'Ada',
  protocol: PROTOCOL_VERSION,
};

describe('GameClient', () => {
  const sockets: FakeSocket[] = [];
  let storage: MemoryStorage;
  const createSocket = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    storage = new MemoryStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends hello on open, parses welcome and persists the identity', () => {
    const onMessage = vi.fn();
    const onStatus = vi.fn();
    const client = new GameClient({
      url: 'ws://test/ws',
      createSocket,
      storage,
      onMessage,
      onStatus,
      pingIntervalMs: 0,
    });
    expect(client.status).toBe('connecting');
    client.connect();
    const socket = sockets[0];
    expect(socket).toBeDefined();
    if (!socket) return;

    socket.open();
    expect(client.status).toBe('open');
    expect(onStatus).toHaveBeenCalledWith('open');
    expect(socket.parsed()[0]).toEqual({ type: 'hello', protocol: PROTOCOL_VERSION });

    socket.receive({ type: 'hello' }); // the stub server's greeting is ignored
    socket.receive(welcome);
    expect(client.welcomed).toBe(true);
    expect(onMessage).toHaveBeenCalledWith(welcome);
    expect(JSON.parse(storage.getItem(IDENTITY_KEY) ?? '{}')).toEqual({
      playerId: 'p1',
      token: 't1',
      name: 'Ada',
    });
    expect(client.identity).toEqual({ playerId: 'p1', token: 't1', name: 'Ada' });
    client.disconnect();
  });

  it('queues messages until welcomed and sends them afterwards', () => {
    const client = new GameClient({
      url: 'ws://test/ws',
      createSocket,
      storage,
      pingIntervalMs: 0,
    });
    client.connect();
    expect(client.send({ type: 'create_room', rules: {} })).toBe(false);
    const socket = sockets[0];
    if (!socket) throw new Error('no socket');
    socket.open();
    socket.receive(welcome);
    expect(socket.parsed().map((m) => m['type'])).toEqual(['hello', 'create_room']);
    expect(client.send({ type: 'ping' })).toBe(true);
    client.disconnect();
  });

  it('reconnects with backoff, resends hello with the identity and rejoins the room', () => {
    const client = new GameClient({
      url: 'ws://test/ws',
      createSocket,
      storage,
      pingIntervalMs: 0,
    });
    client.connect();
    const first = sockets[0];
    if (!first) throw new Error('no socket');
    first.open();
    first.receive(welcome);
    client.joinRoom('ABC123');
    expect(first.parsed().at(-1)).toEqual({ type: 'join_room', code: 'ABC123' });

    first.drop();
    expect(client.status).toBe('reconnecting');
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    const second = sockets[1];
    if (!second) throw new Error('no second socket');
    second.open();
    expect(client.status).toBe('open');
    expect(second.parsed()[0]).toEqual({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      playerId: 'p1',
      token: 't1',
      name: 'Ada',
    });
    second.receive(welcome);
    expect(second.parsed()[1]).toEqual({ type: 'join_room', code: 'ABC123' });

    // a welcome resets the backoff: 1 s again, then it doubles while attempts keep failing
    second.drop();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(3);
    sockets[2]?.drop();
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4);
    sockets[3]?.drop();
    vi.advanceTimersByTime(3999);
    expect(sockets).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(5);
    expect(client.status).toBe('reconnecting');
    client.disconnect();
  });

  it('never replays a hand_action clicked while the socket was down (W4)', () => {
    const client = new GameClient({
      url: 'ws://test/ws',
      createSocket,
      storage,
      pingIntervalMs: 0,
    });
    client.connect();
    const first = sockets[0];
    if (!first) throw new Error('no socket');
    first.open();
    first.receive(welcome);
    client.joinRoom('ABC123');

    first.drop();
    expect(client.status).toBe('reconnecting');
    // the table still shows the last snapshot; the player clicks Pass and sends a chat line
    expect(client.send({ type: 'hand_action', action: { type: 'pass' } })).toBe(false);
    expect(client.send({ type: 'chat', text: 'brb' })).toBe(false);

    vi.advanceTimersByTime(1000);
    const second = sockets[1];
    if (!second) throw new Error('no second socket');
    second.open();
    second.receive(welcome);
    expect(second.parsed().map((m) => m['type'])).toEqual(['hello', 'join_room', 'chat']);
    client.disconnect();
  });

  it('drops hand_actions still queued when the connection closes (W4)', () => {
    const client = new GameClient({
      url: 'ws://test/ws',
      createSocket,
      storage,
      pingIntervalMs: 0,
    });
    client.connect();
    const first = sockets[0];
    if (!first) throw new Error('no socket');
    first.open();
    // opened but not welcomed yet: nothing may be sent for the game
    client.send({ type: 'hand_action', action: { type: 'pass_bid' } });
    first.drop();
    vi.advanceTimersByTime(1000);
    const second = sockets[1];
    if (!second) throw new Error('no second socket');
    second.open();
    second.receive(welcome);
    expect(second.parsed().map((m) => m['type'])).toEqual(['hello']);
    client.disconnect();
  });

  it('never replays a seat or host action clicked while the socket was down', () => {
    const client = new GameClient({
      url: 'ws://test/ws',
      createSocket,
      storage,
      pingIntervalMs: 0,
    });
    client.connect();
    const first = sockets[0];
    if (!first) throw new Error('no socket');
    first.open();
    first.receive(welcome);
    client.joinRoom('ABC123');

    first.drop();
    // These act on the room as the player last saw it: by the time the socket is back, seat 1 may
    // hold somebody else and the host's hand may already have started.
    const stale = [
      { type: 'kick', seat: 1 },
      { type: 'remove_bot', seat: 2 },
      { type: 'add_bot', seat: 2 },
      { type: 'fill_bots' },
      { type: 'start_hand' },
      { type: 'sit', seat: 1 },
      { type: 'stand' },
      { type: 'update_rules', rules: { turnSeconds: 10 } },
    ] as const;
    for (const message of stale) expect(client.send(message)).toBe(false);
    expect(client.send({ type: 'leave_room' })).toBe(false);

    vi.advanceTimersByTime(1000);
    const second = sockets[1];
    if (!second) throw new Error('no second socket');
    second.open();
    second.receive(welcome);
    expect(second.parsed().map((m) => m['type'])).toEqual(['hello', 'join_room', 'leave_room']);
    client.disconnect();
  });

  it('still queues a room to create until the first welcome', () => {
    const client = new GameClient({
      url: 'ws://test/ws',
      createSocket,
      storage,
      pingIntervalMs: 0,
    });
    client.connect();
    expect(client.send({ type: 'ping' })).toBe(false);
    expect(client.send({ type: 'create_room', rules: {} })).toBe(false);
    expect(client.send({ type: 'start_hand' })).toBe(false);
    const socket = sockets[0];
    if (!socket) throw new Error('no socket');
    socket.open();
    socket.receive(welcome);
    expect(socket.parsed().map((m) => m['type'])).toEqual(['hello', 'ping', 'create_room']);
    client.disconnect();
  });

  it('loads a persisted identity and setName persists the name', () => {
    storage.setItem(IDENTITY_KEY, JSON.stringify({ playerId: 'p9', token: 't9', name: 'Zed' }));
    const client = new GameClient({
      url: 'ws://test/ws',
      createSocket,
      storage,
      pingIntervalMs: 0,
    });
    expect(client.identity).toEqual({ playerId: 'p9', token: 't9', name: 'Zed' });
    client.setName('  Yan ');
    expect(JSON.parse(storage.getItem(IDENTITY_KEY) ?? '{}')).toEqual({
      playerId: 'p9',
      token: 't9',
      name: 'Yan',
    });
  });
});
