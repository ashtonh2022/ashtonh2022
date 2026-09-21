import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { botAction, seededRng, timeoutAction } from '@landlord/engine';
import type { ClientMessage, RoomView, ServerMessage } from '@landlord/protocol';

import type { Connection } from './connection';
import { Hub } from './hub';
import { silentLogger } from './log';
import type { Room } from './room';
import { DEFAULT_ROOM_TTL_MS } from './rooms';

type Hello = Extract<ClientMessage, { type: 'hello' }>;
type ErrorMessage = Extract<ServerMessage, { type: 'error' }>;

/** A connection with a recording transport; `hello` is sent on construction. */
class FakeClient {
  readonly sent: ServerMessage[] = [];
  readonly conn: Connection;
  closedByServer = false;

  constructor(
    readonly hub: Hub,
    hello: Partial<Omit<Hello, 'type'>> = {},
  ) {
    this.conn = hub.connect({
      send: (data) => {
        this.sent.push(JSON.parse(data) as ServerMessage);
      },
      close: () => {
        this.closedByServer = true;
      },
    });
    this.send({ type: 'hello', protocol: 1, ...hello });
  }

  send(message: ClientMessage | Record<string, unknown>): void {
    this.conn.receive(JSON.stringify(message));
  }

  get welcome(): Extract<ServerMessage, { type: 'welcome' }> {
    const message = this.sent.find((m) => m.type === 'welcome');
    if (message === undefined || message.type !== 'welcome') throw new Error('no welcome yet');
    return message;
  }

  get playerId(): string {
    return this.welcome.playerId;
  }

  get token(): string {
    return this.welcome.token;
  }

  /** The latest room snapshot this client received. */
  get room(): RoomView | null {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const message = this.sent[i];
      if (message?.type === 'room_state') return message.room;
    }
    return null;
  }

  get view(): RoomView {
    const room = this.room;
    if (room === null) throw new Error('no room_state yet');
    return room;
  }

  get errors(): ErrorMessage[] {
    return this.sent.filter((m): m is ErrorMessage => m.type === 'error');
  }

  get lastError(): ErrorMessage | null {
    return this.errors[this.errors.length - 1] ?? null;
  }

  count(type: ServerMessage['type']): number {
    return this.sent.filter((m) => m.type === type).length;
  }

  /** Simulates the socket dropping. */
  disconnect(): void {
    this.conn.handleClose();
  }
}

function createHub(seed = 'room-tests'): Hub {
  return new Hub({ random: seededRng(seed), log: silentLogger });
}

function roomOf(hub: Hub, client: FakeClient): Room {
  const room = hub.rooms.get(client.view.code);
  if (room === undefined) throw new Error('room not found');
  return room;
}

/** Advances fake time in steps until the predicate holds; returns the steps taken. */
function advanceUntil(predicate: () => boolean, step = 1600, maxSteps = 3000): number {
  for (let i = 0; i < maxSteps; i++) {
    if (predicate()) return i;
    vi.advanceTimersByTime(step);
  }
  throw new Error('condition never became true');
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Host creates a room, `guests` join and sit at seats 1.., remaining seats get bots. */
function table(
  hub: Hub,
  rules: Record<string, unknown> = {},
  guests = 0,
): { host: FakeClient; guests: FakeClient[]; room: Room } {
  const host = new FakeClient(hub, { name: 'Host' });
  host.send({ type: 'create_room', rules: { turnSeconds: 5, ...rules } });
  const code = host.view.code;
  const joined: FakeClient[] = [];
  for (let i = 0; i < guests; i++) {
    const guest = new FakeClient(hub, { name: `Guest ${i + 1}` });
    guest.send({ type: 'join_room', code });
    guest.send({ type: 'sit', seat: i + 1 });
    joined.push(guest);
  }
  host.send({ type: 'fill_bots' });
  return { host, guests: joined, room: roomOf(hub, host) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('identity', () => {
  it('mints a player with a default name and reattaches with the same credentials', () => {
    const hub = createHub();
    const first = new FakeClient(hub);
    expect(first.playerId).toMatch(/^[0-9a-f]{16}$/);
    expect(first.token).toMatch(/^[0-9a-f]{32}$/);
    expect(first.welcome.name).toMatch(/^Player \d{4}$/);
    expect(first.welcome.protocol).toBe(1);

    const again = new FakeClient(hub, { playerId: first.playerId, token: first.token });
    expect(again.playerId).toBe(first.playerId);
    expect(again.token).toBe(first.token);

    const impostor = new FakeClient(hub, { playerId: first.playerId, token: 'wrong' });
    expect(impostor.playerId).not.toBe(first.playerId);
    expect(hub.players.size).toBe(2);
  });

  it('cleans names and updates them everywhere with set_name', () => {
    const hub = createHub();
    const host = new FakeClient(hub, { name: '  Ann   Lee ' });
    expect(host.welcome.name).toBe('Ann Lee');
    host.send({ type: 'create_room', rules: {} });
    const guest = new FakeClient(hub, { name: 'Ben' });
    guest.send({ type: 'join_room', code: host.view.code });
    host.send({ type: 'set_name', name: 'Annie' });
    expect(host.view.you.name).toBe('Annie');
    expect(guest.view.seats[0]?.name).toBe('Annie');
    host.send({ type: 'set_name', name: '   ' });
    expect(host.lastError?.code).toBe('bad_message');
  });

  it('requires hello first and rejects garbage without crashing', () => {
    const hub = createHub();
    const transportMessages: ServerMessage[] = [];
    const conn = hub.connect({
      send: (data) => transportMessages.push(JSON.parse(data) as ServerMessage),
      close: () => undefined,
    });
    conn.receive(JSON.stringify({ type: 'ping' }));
    expect(transportMessages[0]).toMatchObject({ type: 'error', code: 'bad_message' });
    conn.receive('{not json');
    conn.receive(JSON.stringify({ type: 'teleport' }));
    conn.receive(Buffer.from('[]'));
    conn.receive(null);
    expect(transportMessages).toHaveLength(5);
    expect(transportMessages.every((m) => m.type === 'error' && m.code === 'bad_message')).toBe(
      true,
    );
    conn.receive(JSON.stringify({ type: 'hello', protocol: 1 }));
    expect(transportMessages[5]?.type).toBe('welcome');
    conn.receive(JSON.stringify({ type: 'ping' }));
    expect(transportMessages[6]?.type).toBe('pong');
  });

  it('closes connections that speak another protocol version', () => {
    const hub = createHub();
    const client = new FakeClient(hub, { protocol: 99 } as Partial<Omit<Hello, 'type'>>);
    expect(client.lastError?.code).toBe('bad_message');
    expect(client.closedByServer).toBe(true);
    expect(hub.connectionCount).toBe(0);
  });
});

describe('rooms', () => {
  it('create -> join -> sit -> fill_bots -> start, then bots finish the hand on the timers', () => {
    const hub = createHub();
    const host = new FakeClient(hub, { name: 'Host' });
    host.send({ type: 'create_room', rules: { turnSeconds: 5 } });
    const created = host.view;
    expect(created.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(created.status).toBe('lobby');
    expect(created.you).toEqual({ playerId: host.playerId, name: 'Host', seat: 0, isHost: true });
    expect(created.seats).toHaveLength(3);
    expect(created.hand).toBeNull();
    expect(created.rules.turnSeconds).toBe(5);

    const guest = new FakeClient(hub, { name: 'Guest' });
    guest.send({ type: 'join_room', code: created.code.toLowerCase() });
    expect(guest.view.you.seat).toBeNull();
    expect(guest.view.spectators).toEqual([{ playerId: guest.playerId, name: 'Guest' }]);
    guest.send({ type: 'sit', seat: 1 });
    expect(guest.view.you.seat).toBe(1);
    expect(host.view.seats[1]).toMatchObject({ playerId: guest.playerId, name: 'Guest' });
    expect(host.view.spectators).toEqual([]);

    host.send({ type: 'start_hand' });
    expect(host.lastError?.code).toBe('wrong_status');
    host.send({ type: 'fill_bots' });
    expect(host.view.seats[2]).toMatchObject({ isBot: true, name: 'Bot Ada', connected: true });

    host.send({ type: 'start_hand' });
    const playing = host.view;
    expect(playing.status).toBe('playing');
    expect(playing.handNumber).toBe(1);
    expect(playing.hand?.hand).toHaveLength(17);
    expect(playing.hand?.phase).toBe('bidding');
    expect(playing.deadline).toBe(Date.now() + 5000);
    expect(guest.view.hand?.hand).toHaveLength(17);
    expect(guest.view.hand?.hand).not.toEqual(playing.hand?.hand);

    advanceUntil(() => host.view.status === 'between_hands');
    const done = host.view;
    const scores = done.seats.map((seat) => seat.score);
    expect(sum(scores)).toBe(0);
    expect(scores.some((score) => score !== 0)).toBe(true);
    expect(done.lastResult).not.toBeNull();
    expect(done.lastResult?.amounts).toEqual(scores);
    expect(done.deadline).toBeNull();
    expect(done.hand?.phase).toBe('finished');
    expect(done.seats.filter((seat) => seat.ready)).toHaveLength(
      done.lastResult?.amounts.filter((amount) => amount > 0).length ?? -1,
    );
    expect(vi.getTimerCount()).toBe(0);

    // A second hand keeps the scores running.
    host.send({ type: 'start_hand' });
    expect(host.view.handNumber).toBe(2);
    advanceUntil(() => host.view.status === 'between_hands');
    expect(sum(host.view.seats.map((seat) => seat.score))).toBe(0);
    expect(host.view.handNumber).toBe(2);
  });

  it('plays a 4-player hand with a doubling round', () => {
    const hub = createHub('four');
    const { host, room } = table(hub, { playerCount: 4, doublingRound: true });
    expect(host.view.seats).toHaveLength(4);
    expect(host.view.rules.kittySize).toBe(8);
    host.send({ type: 'start_hand' });
    expect(host.view.hand?.hand).toHaveLength(25);

    advanceUntil(() => room.hand?.phase === 'doubling' || room.status === 'between_hands');
    expect(room.hand?.phase).toBe('doubling');
    expect(host.view.deadline).not.toBeNull();
    expect(host.view.hand?.legal.canDouble).toBe(true);
    host.send({ type: 'hand_action', action: { type: 'double', double: true } });
    expect(host.view.hand?.doubles[0]).toBe(true);
    advanceUntil(() => room.hand?.phase === 'playing');
    expect(room.hand?.doubles.every((choice) => choice !== null)).toBe(true);

    advanceUntil(() => host.view.status === 'between_hands');
    expect(sum(host.view.seats.map((seat) => seat.score))).toBe(0);
    expect(host.view.lastResult?.doubled[0]).toBe(true);
  });

  it('times out a connected human with timeoutAction', () => {
    const hub = createHub();
    const { host, room } = table(hub);
    host.send({ type: 'start_hand' });
    advanceUntil(() => room.hand?.turn === 0, 100);
    const before = room.hand;
    if (before === null) throw new Error('no hand');
    const expected = timeoutAction(before, 0);
    const deadline = host.view.deadline;
    if (deadline === null) throw new Error('no deadline');
    vi.advanceTimersByTime(deadline - Date.now() - 1);
    expect(room.hand).toBe(before);
    vi.advanceTimersByTime(1);
    expect(room.hand).not.toBe(before);
    const record = room.hand?.bidding.records[before.bidding.records.length];
    expect(record).toEqual({ seat: 0, action: expected.type === 'call' ? 'call' : 'pass' });
    expect(host.view.deadline).toBeGreaterThan(deadline);
  });

  it('lets the bot play a disconnected human at the deadline and resumes them on reconnect', () => {
    const hub = createHub();
    const { host, guests, room } = table(hub, {}, 1);
    const guest = guests[0] as FakeClient;
    host.send({ type: 'start_hand' });
    advanceUntil(() => room.hand?.turn === 0, 100);
    host.disconnect();
    expect(guest.view.seats[0]).toMatchObject({ playerId: host.playerId, connected: false });
    const before = room.hand;
    if (before === null) throw new Error('no hand');
    const expected = botAction(before, 0);
    const sentBefore = host.sent.length;
    vi.advanceTimersByTime(5000);
    expect(room.hand).not.toBe(before);
    expect(room.hand?.bidding.records[before.bidding.records.length]).toEqual({
      seat: 0,
      action: expected.type === 'call' ? 'call' : 'pass',
    });
    expect(room.seats[0]).toMatchObject({ playerId: host.playerId, isBot: false });
    expect(host.sent.length).toBe(sentBefore);

    const again = new FakeClient(hub, { playerId: host.playerId, token: host.token });
    expect(again.playerId).toBe(host.playerId);
    const view = again.view;
    expect(view.code).toBe(room.code);
    expect(view.you).toMatchObject({ seat: 0, isHost: true });
    expect(view.seats[0]?.connected).toBe(true);
    expect(view.hand?.hand.length).toBeGreaterThan(0);
    expect(guest.view.seats[0]?.connected).toBe(true);
    // Joining the room again is harmless and answers with room_state.
    const before2 = again.count('room_state');
    again.send({ type: 'join_room', code: room.code });
    expect(again.count('room_state')).toBe(before2 + 1);
    expect(again.view.you.seat).toBe(0);
  });

  it('passes the host role to the next connected human: seated first, then spectators', () => {
    const hub = createHub();
    const host = new FakeClient(hub, { name: 'Host' });
    host.send({ type: 'create_room', rules: {} });
    const code = host.view.code;
    const seated = new FakeClient(hub, { name: 'Seated' });
    seated.send({ type: 'join_room', code });
    seated.send({ type: 'sit', seat: 2 });
    const watcher = new FakeClient(hub, { name: 'Watcher' });
    watcher.send({ type: 'join_room', code });
    const sleeper = new FakeClient(hub, { name: 'Sleeper' });
    sleeper.send({ type: 'join_room', code });
    sleeper.send({ type: 'sit', seat: 1 });
    sleeper.disconnect();

    host.send({ type: 'leave_room' });
    expect(host.sent[host.sent.length - 1]).toEqual({ type: 'left_room' });
    expect(seated.view.hostId).toBe(seated.playerId);
    expect(seated.view.you.isHost).toBe(true);
    expect(seated.view.seats[0]?.playerId).toBeNull();
    expect(watcher.view.seats[2]?.isHost).toBe(true);

    seated.send({ type: 'leave_room' });
    expect(watcher.view.hostId).toBe(watcher.playerId);
    expect(watcher.view.you).toMatchObject({ seat: null, isHost: true });

    watcher.send({ type: 'leave_room' });
    expect(hub.rooms.size).toBe(1);
    const room = hub.rooms.get(code);
    expect(room?.hostId).toBe(sleeper.playerId);
    // Once nobody is left in it at all the room goes away.
    const back = new FakeClient(hub, { playerId: sleeper.playerId, token: sleeper.token });
    back.send({ type: 'leave_room' });
    expect(hub.rooms.size).toBe(0);
  });

  it('resizes seats when the host changes the player count', () => {
    const hub = createHub();
    const { host, guests } = table(hub, {}, 2);
    const extra = new FakeClient(hub, { name: 'Extra' });
    extra.send({ type: 'join_room', code: host.view.code });

    host.send({ type: 'update_rules', rules: { playerCount: 4 } });
    expect(host.view.seats).toHaveLength(4);
    expect(host.view.rules).toMatchObject({ playerCount: 4, kittySize: 8, turnSeconds: 5 });
    extra.send({ type: 'sit', seat: 3 });
    expect(extra.view.you.seat).toBe(3);

    host.send({ type: 'update_rules', rules: { turnSeconds: 12 } });
    expect(host.view.rules).toMatchObject({ playerCount: 4, kittySize: 8, turnSeconds: 12 });

    host.send({ type: 'update_rules', rules: { playerCount: 3, kittySize: 16 } });
    expect(host.view.seats).toHaveLength(3);
    expect(host.view.rules).toMatchObject({ playerCount: 3, kittySize: 3, turnSeconds: 12 });
    expect(extra.view.you.seat).toBeNull();
    expect(extra.view.spectators.map((s) => s.playerId)).toContain(extra.playerId);
    expect(host.view.seats.map((s) => s.playerId)).toEqual([
      host.playerId,
      guests[0]?.playerId,
      guests[1]?.playerId,
    ]);

    (guests[0] as FakeClient).send({ type: 'update_rules', rules: { playerCount: 4 } });
    expect(guests[0]?.lastError?.code).toBe('not_host');
    expect(host.view.seats).toHaveLength(3);
  });

  it('redeals when everyone passes and still finishes the hand', () => {
    let sawRedeal = false;
    for (let attempt = 0; attempt < 60 && !sawRedeal; attempt++) {
      const hub = createHub(`redeal-${attempt}`);
      const host = new FakeClient(hub, { name: 'Host' });
      host.send({ type: 'create_room', rules: { allPass: 'redeal', turnSeconds: 5 } });
      host.send({ type: 'stand' });
      host.send({ type: 'fill_bots' });
      host.send({ type: 'start_hand' });
      const room = roomOf(hub, host);
      const firstSeed = room.hand?.seed;
      advanceUntil(() => host.view.status === 'between_hands');
      expect(room.handNumber).toBe(1);
      expect(room.hand?.handNumber).toBe(1);
      expect(host.view.hand?.hand).toEqual([]);
      expect(sum(host.view.seats.map((seat) => seat.score))).toBe(0);
      if (room.hand?.seed !== firstSeed) sawRedeal = true;
    }
    expect(sawRedeal).toBe(true);
  });

  it('survives many hands in a row', () => {
    const hub = createHub('marathon');
    const { host } = table(hub, { firstBidder: 'rotate', kittyBonus: true });
    for (let hand = 1; hand <= 6; hand++) {
      host.send({ type: 'start_hand' });
      expect(host.view.status).toBe('playing');
      advanceUntil(() => host.view.status === 'between_hands');
      expect(host.view.handNumber).toBe(hand);
      expect(sum(host.view.seats.map((seat) => seat.score))).toBe(0);
    }
  });

  it('kicking during a hand converts the seat to a bot that keeps the score', () => {
    const hub = createHub();
    const { host, guests, room } = table(hub, {}, 1);
    const guest = guests[0] as FakeClient;
    (room.seats[1] as { score: number }).score = 7;
    host.send({ type: 'start_hand' });
    host.send({ type: 'kick', seat: 1 });
    expect(host.lastError).toBeNull();
    expect(guest.sent[guest.sent.length - 1]).toEqual({ type: 'left_room' });
    expect(host.view.seats[1]).toMatchObject({
      isBot: true,
      name: 'Bot Bo',
      playerId: 'bot-bo',
      score: 7,
    });
    guest.send({ type: 'sit', seat: 1 });
    expect(guest.lastError?.code).toBe('not_in_room');
    advanceUntil(() => host.view.status === 'between_hands');
    expect(host.view.seats[1]?.isBot).toBe(true);
    expect(sum(host.view.seats.map((seat) => seat.score))).toBe(7);
  });

  it('leaving during a hand converts the seat to a bot; disconnecting does not', () => {
    const hub = createHub();
    const { host, guests, room } = table(hub, {}, 1);
    const guest = guests[0] as FakeClient;
    host.send({ type: 'start_hand' });
    guest.disconnect();
    expect(room.seats[1]).toMatchObject({ playerId: guest.playerId, isBot: false });
    const back = new FakeClient(hub, { playerId: guest.playerId, token: guest.token });
    expect(back.view.you.seat).toBe(1);
    back.send({ type: 'leave_room' });
    expect(back.sent[back.sent.length - 1]).toEqual({ type: 'left_room' });
    expect(room.seats[1]).toMatchObject({ playerId: null, isBot: true });
    expect(host.view.seats[1]?.isBot).toBe(true);
    advanceUntil(() => host.view.status === 'between_hands');
  });

  it('kicks in the lobby make the player a spectator and remove bots', () => {
    const hub = createHub();
    const { host, guests } = table(hub, {}, 1);
    const guest = guests[0] as FakeClient;
    host.send({ type: 'kick', seat: 1 });
    expect(guest.view.you.seat).toBeNull();
    expect(guest.view.spectators.map((s) => s.playerId)).toEqual([guest.playerId]);
    host.send({ type: 'kick', seat: 2 });
    expect(host.view.seats[2]).toMatchObject({ playerId: null, isBot: false });
    host.send({ type: 'kick', seat: 0 });
    expect(host.lastError?.code).toBe('bad_message');
    guest.send({ type: 'kick', seat: 0 });
    expect(guest.lastError?.code).toBe('not_host');
  });

  it('shows spectators no cards and no kitty before it is revealed', () => {
    const hub = createHub();
    const host = new FakeClient(hub, { name: 'Host' });
    host.send({ type: 'create_room', rules: { turnSeconds: 5 } });
    host.send({ type: 'stand' });
    expect(host.view.you.seat).toBeNull();
    host.send({ type: 'fill_bots' });
    host.send({ type: 'start_hand' });
    const room = roomOf(hub, host);
    const state = room.hand;
    if (state === null) throw new Error('no hand');
    const view = host.view;
    expect(view.hand?.seat).toBeNull();
    expect(view.hand?.hand).toEqual([]);
    expect(view.hand?.kitty).toBeNull();
    expect(view.hand?.cardCounts).toEqual([17, 17, 17]);
    const json = JSON.stringify(view);
    for (const card of [...state.hands.flat(), ...state.kitty]) {
      expect(json).not.toContain(card.id);
    }
    advanceUntil(() => room.hand?.kittyRevealed === true);
    expect(host.view.hand?.kitty?.map((card) => card.id)).toEqual(
      room.hand?.kitty.map((card) => card.id),
    );
    expect(host.view.hand?.hand).toEqual([]);
  });

  it('reports engine rejections as not_your_turn / illegal_action', () => {
    const hub = createHub();
    const { host, guests, room } = table(hub, {}, 1);
    const guest = guests[0] as FakeClient;
    host.send({ type: 'hand_action', action: { type: 'call' } });
    expect(host.lastError?.code).toBe('wrong_status');
    host.send({ type: 'start_hand' });
    advanceUntil(() => room.hand?.turn === 0, 100);
    guest.send({ type: 'hand_action', action: { type: 'call' } });
    expect(guest.lastError?.code).toBe('not_your_turn');
    host.send({ type: 'hand_action', action: { type: 'play', cardIds: ['3-S-0'] } });
    expect(host.lastError?.code).toBe('illegal_action');
    expect(host.lastError?.message).toContain('bidding');
    host.send({ type: 'sit', seat: 2 });
    expect(host.lastError?.code).toBe('wrong_status');
    host.send({ type: 'add_bot', seat: 1 });
    expect(host.lastError?.code).toBe('wrong_status');
    const watcher = new FakeClient(hub, { name: 'Watcher' });
    watcher.send({ type: 'join_room', code: room.code });
    watcher.send({ type: 'hand_action', action: { type: 'call' } });
    expect(watcher.lastError?.code).toBe('not_seated');
  });

  it('answers lobby mistakes with the right error codes', () => {
    const hub = createHub();
    const host = new FakeClient(hub, { name: 'Host' });
    host.send({ type: 'sit', seat: 0 });
    expect(host.lastError?.code).toBe('not_in_room');
    host.send({ type: 'join_room', code: 'NOPE22' });
    expect(host.lastError?.code).toBe('room_not_found');
    host.send({ type: 'create_room', rules: {} });
    const guest = new FakeClient(hub, { name: 'Guest' });
    guest.send({ type: 'join_room', code: host.view.code });
    guest.send({ type: 'sit', seat: 0 });
    expect(guest.lastError?.code).toBe('seat_taken');
    guest.send({ type: 'stand' });
    expect(guest.lastError?.code).toBe('not_seated');
    guest.send({ type: 'fill_bots' });
    expect(guest.lastError?.code).toBe('not_host');
    guest.send({ type: 'sit', seat: 3 });
    expect(guest.lastError?.code).toBe('bad_message');
    host.send({ type: 'add_bot', seat: 0 });
    expect(host.lastError?.code).toBe('seat_taken');
    host.send({ type: 'remove_bot', seat: 1 });
    expect(host.lastError?.code).toBe('bad_message');
    guest.send({ type: 'leave_room' });
    guest.send({ type: 'leave_room' });
    expect(guest.sent[guest.sent.length - 1]).toEqual({ type: 'left_room' });
    expect(guest.errors.filter((e) => e.code === 'not_in_room')).toHaveLength(0);
  });

  it('broadcasts chat and emotes and rate limits them per player', () => {
    const hub = createHub();
    const { host, guests } = table(hub, {}, 1);
    const guest = guests[0] as FakeClient;
    for (let i = 1; i <= 5; i++) host.send({ type: 'chat', text: `  hello ${i}  ` });
    expect(host.count('chat')).toBe(5);
    expect(guest.count('chat')).toBe(5);
    const last = guest.sent[guest.sent.length - 1];
    expect(last).toMatchObject({
      type: 'chat',
      entry: { id: 5, playerId: host.playerId, name: 'Host', seat: 0, text: 'hello 5' },
    });
    host.send({ type: 'emote', emote: '🔥' });
    expect(host.lastError?.code).toBe('rate_limited');
    expect(guest.count('emote')).toBe(0);
    vi.advanceTimersByTime(5000);
    host.send({ type: 'emote', emote: '🔥' });
    expect(guest.sent[guest.sent.length - 1]).toEqual({
      type: 'emote',
      playerId: host.playerId,
      seat: 0,
      emote: '🔥',
    });
    // The guest has a limit of their own.
    guest.send({ type: 'chat', text: 'me too' });
    expect(guest.lastError).toBeNull();
    // The log keeps the last 50 entries.
    for (let i = 0; i < 60; i++) {
      if (i % 5 === 0) vi.advanceTimersByTime(5000);
      guest.send({ type: 'chat', text: `spam ${i}` });
    }
    host.send({ type: 'update_rules', rules: {} });
    expect(host.view.chat).toHaveLength(50);
    expect(host.view.chat[49]?.text).toBe('spam 59');
  });

  it('rate limits connections at 30 messages per 5 seconds', () => {
    const hub = createHub();
    const client = new FakeClient(hub);
    for (let i = 0; i < 29; i++) client.send({ type: 'ping' });
    expect(client.count('pong')).toBe(29);
    expect(client.errors).toHaveLength(0);
    client.send({ type: 'ping' });
    client.send({ type: 'ping' });
    expect(client.count('pong')).toBe(29);
    expect(client.errors).toHaveLength(1);
    expect(client.lastError?.code).toBe('rate_limited');
    vi.advanceTimersByTime(5001);
    client.send({ type: 'ping' });
    expect(client.count('pong')).toBe(30);
  });

  it('sweeps rooms nobody has been connected to for the TTL and clears their timers', () => {
    const hub = createHub();
    hub.start();
    expect(vi.getTimerCount()).toBe(1);
    const { host, room } = table(hub);
    host.send({ type: 'start_hand' });
    expect(vi.getTimerCount()).toBeGreaterThan(1);
    host.disconnect();
    expect(room.emptySince).toBe(Date.now());
    vi.advanceTimersByTime(DEFAULT_ROOM_TTL_MS - 60_000);
    expect(hub.rooms.size).toBe(1);
    expect(room.status).toBe('between_hands');
    vi.advanceTimersByTime(120_000);
    expect(hub.rooms.size).toBe(0);
    expect(room.isDestroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    // The player was forgotten too, so the old credentials no longer resolve.
    const back = new FakeClient(hub, { playerId: host.playerId, token: host.token });
    expect(back.playerId).not.toBe(host.playerId);
    expect(back.room).toBeNull();
    hub.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deletes a room mid-hand when it is swept and stops its bots', () => {
    const hub = createHub();
    const { host, room } = table(hub);
    host.send({ type: 'start_hand' });
    host.disconnect();
    vi.advanceTimersByTime(100);
    expect(hub.rooms.sweep(Date.now() + DEFAULT_ROOM_TTL_MS)).toEqual([room.code]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('moves a player who joins another room out of the first one', () => {
    const hub = createHub();
    const { host: hostA, room: roomA } = table(hub);
    const hostB = new FakeClient(hub, { name: 'B' });
    hostB.send({ type: 'create_room', rules: {} });
    hostA.send({ type: 'join_room', code: hostB.view.code });
    expect(hostA.view.code).toBe(hostB.view.code);
    expect(hostA.view.you.seat).toBeNull();
    expect(roomA.isDestroyed).toBe(true);
    expect(hub.rooms.size).toBe(1);
  });

  it('serves several connections of the same player', () => {
    const hub = createHub();
    const { host } = table(hub);
    const tab = new FakeClient(hub, { playerId: host.playerId, token: host.token });
    expect(tab.view.you.seat).toBe(0);
    host.send({ type: 'start_hand' });
    expect(tab.view.status).toBe('playing');
    expect(tab.view.hand?.hand).toEqual(host.view.hand?.hand);
    tab.disconnect();
    expect(host.view.seats[0]?.connected).toBe(true);
  });
});
