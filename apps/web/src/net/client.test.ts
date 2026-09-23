import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROTOCOL_VERSION, type ServerMessage } from '@landlord/protocol';

import { FakePage, FakeSocket, MemoryStorage } from '../test/fakeSocket';
import { GameClient, IDENTITY_KEY, TAB_KEY } from './client';

/** Every hello carries the tab id, whatever it is (see 'GameClient: the tab id'). */
const anyTab = expect.stringMatching(/^[0-9a-f]{16}$/);

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
    // the socket is open but the server has not accepted us yet
    expect(client.status).toBe('connecting');
    expect(onStatus).not.toHaveBeenCalled();
    expect(socket.parsed()[0]).toEqual({ type: 'hello', protocol: PROTOCOL_VERSION, tab: anyTab });

    socket.receive({ type: 'hello' }); // the stub server's greeting is ignored
    socket.receive(welcome);
    expect(client.welcomed).toBe(true);
    expect(client.status).toBe('open');
    expect(onStatus).toHaveBeenCalledWith('open');
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
    // still reconnecting until the server welcomes us on the new socket
    expect(client.status).toBe('reconnecting');
    expect(second.parsed()[0]).toEqual({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      playerId: 'p1',
      token: 't1',
      name: 'Ada',
      tab: anyTab,
    });
    second.receive(welcome);
    expect(client.status).toBe('open');
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

describe('GameClient: the connection counts as open only after the welcome', () => {
  const sockets: FakeSocket[] = [];
  const createSocket = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function socketAt(index: number): FakeSocket {
    const socket = sockets[index];
    if (!socket) throw new Error(`no socket ${index}`);
    return socket;
  }

  it('stays connecting while the socket is open but the server has not welcomed us', () => {
    const statuses: string[] = [];
    const client = new GameClient({
      url: 'ws://test/ws',
      createSocket,
      storage: new MemoryStorage(),
      onStatus: (status) => statuses.push(status),
      pingIntervalMs: 0,
    });
    client.connect();
    expect(client.status).toBe('connecting');
    socketAt(0).open();
    expect(client.status).toBe('connecting');
    expect(statuses).toEqual([]);
    socketAt(0).receive(welcome);
    expect(client.status).toBe('open');
    expect(statuses).toEqual(['open']);
    client.disconnect();
  });

  it('stays reconnecting after a drop until the new socket is welcomed', () => {
    const statuses: string[] = [];
    const client = new GameClient({
      url: 'ws://test/ws',
      createSocket,
      storage: new MemoryStorage(),
      onStatus: (status) => statuses.push(status),
      pingIntervalMs: 0,
    });
    client.connect();
    socketAt(0).open();
    socketAt(0).receive(welcome);
    socketAt(0).drop();
    expect(client.status).toBe('reconnecting');
    vi.advanceTimersByTime(1000);
    socketAt(1).open();
    expect(client.status).toBe('reconnecting');
    socketAt(1).receive(welcome);
    expect(client.status).toBe('open');
    expect(statuses).toEqual(['open', 'reconnecting', 'open']);
    client.disconnect();
  });

  it('is still connecting when a first socket closes before any welcome', () => {
    const client = new GameClient({
      url: 'ws://test/ws',
      createSocket,
      storage: new MemoryStorage(),
      pingIntervalMs: 0,
    });
    client.connect();
    socketAt(0).open();
    socketAt(0).drop();
    expect(client.status).toBe('connecting');
    client.disconnect();
  });
});

describe('GameClient: the name the player typed wins over the welcome', () => {
  const sockets: FakeSocket[] = [];
  let storage: MemoryStorage;
  const createSocket = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const serverDefault: ServerMessage = { ...welcome, name: 'Player 1234' };

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    storage = new MemoryStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function connected(): { client: GameClient; socket: FakeSocket } {
    const client = new GameClient({
      url: 'ws://test/ws',
      createSocket,
      storage,
      pingIntervalMs: 0,
    });
    client.connect();
    const socket = sockets[0];
    if (!socket) throw new Error('no socket');
    return { client, socket };
  }

  function stored(): unknown {
    return JSON.parse(storage.getItem(IDENTITY_KEY) ?? '{}');
  }

  it.each([
    ['still waiting for typing to pause', 0],
    ['already flushed to the client', 400],
  ])('keeps a name typed after the hello went out (%s) and sends it', (_label, waitMs) => {
    const { client, socket } = connected();
    socket.open();
    expect(socket.parsed()[0]).toEqual({ type: 'hello', protocol: PROTOCOL_VERSION, tab: anyTab });
    client.setName('Bob');
    vi.advanceTimersByTime(waitMs);
    socket.receive(serverDefault);
    expect(socket.parsed()).toEqual([
      { type: 'hello', protocol: PROTOCOL_VERSION, tab: anyTab },
      { type: 'set_name', name: 'Bob' },
    ]);
    expect(client.identity).toEqual({ playerId: 'p1', token: 't1', name: 'Bob' });
    expect(stored()).toEqual({ playerId: 'p1', token: 't1', name: 'Bob' });
    // the change is delivered: nothing more goes out when the typing pause would have ended
    vi.advanceTimersByTime(1000);
    expect(socket.types()).toEqual(['hello', 'set_name']);
    client.disconnect();
  });

  it('sends the typed name before a room queued before the welcome is created', () => {
    const { client, socket } = connected();
    socket.open();
    client.setName('Bob');
    client.flushName();
    client.send({ type: 'ping' });
    client.send({ type: 'create_room', rules: {} });
    socket.receive(serverDefault);
    expect(socket.types()).toEqual(['hello', 'set_name', 'ping', 'create_room']);
    client.disconnect();
  });

  it('puts a name typed before the socket opened into the hello', () => {
    const { client, socket } = connected();
    client.setName('Bob');
    socket.open();
    expect(socket.parsed()[0]).toEqual({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      name: 'Bob',
      tab: anyTab,
    });
    socket.receive({ ...welcome, name: 'Bob' });
    expect(socket.types()).toEqual(['hello']);
    expect(stored()).toEqual({ playerId: 'p1', token: 't1', name: 'Bob' });
    client.disconnect();
  });

  it("adopts the server's name when nothing was typed", () => {
    const { client, socket } = connected();
    socket.open();
    socket.receive(serverDefault);
    expect(socket.types()).toEqual(['hello']);
    expect(client.identity.name).toBe('Player 1234');
    expect(stored()).toEqual({ playerId: 'p1', token: 't1', name: 'Player 1234' });
    client.disconnect();
  });

  it("keeps a returning player's stored name", () => {
    storage.setItem(IDENTITY_KEY, JSON.stringify({ playerId: 'p1', token: 't1', name: 'Zed' }));
    const { client, socket } = connected();
    socket.open();
    expect(socket.parsed()[0]).toEqual({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      playerId: 'p1',
      token: 't1',
      name: 'Zed',
      tab: anyTab,
    });
    socket.receive({ ...welcome, name: 'Zed' });
    expect(socket.types()).toEqual(['hello']);
    expect(stored()).toEqual({ playerId: 'p1', token: 't1', name: 'Zed' });
    client.disconnect();
  });

  it('sends a name change once typing pauses after the welcome', () => {
    const { client, socket } = connected();
    socket.open();
    socket.receive(serverDefault);
    client.setName('B');
    client.setName('Bo');
    vi.advanceTimersByTime(399);
    expect(socket.types()).toEqual(['hello']);
    vi.advanceTimersByTime(1);
    expect(socket.parsed().slice(1)).toEqual([{ type: 'set_name', name: 'Bo' }]);
    // flushing again with nothing new sends nothing
    client.flushName();
    expect(socket.types()).toEqual(['hello', 'set_name']);
    client.disconnect();
  });
});

describe('GameClient: a room the host kicked the player from is not rejoined', () => {
  const sockets: FakeSocket[] = [];
  const createSocket = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function socketAt(index: number): FakeSocket {
    const socket = sockets[index];
    if (!socket) throw new Error(`no socket ${index}`);
    return socket;
  }

  function makeClient(): GameClient {
    const client = new GameClient({
      url: 'ws://test/ws',
      createSocket,
      storage: new MemoryStorage(),
      pingIntervalMs: 0,
    });
    client.connect();
    return client;
  }

  it('does not walk back into it when the kick is reported before the welcome', () => {
    // Kicked while away: the server tells the player on their next hello, before welcoming them.
    const client = makeClient();
    client.joinRoom('ABCDEF');
    socketAt(0).open();
    socketAt(0).receive({ type: 'left_room', reason: 'kicked', code: 'ABCDEF' });
    socketAt(0).receive(welcome);
    // Only the acknowledgement: no join_room.
    expect(socketAt(0).types()).toEqual(['hello', 'ping']);
    expect(client.currentRoomCode).toBeNull();
    client.disconnect();
  });

  it('does not rejoin it after a reconnect when kicked while connected', () => {
    const client = makeClient();
    socketAt(0).open();
    socketAt(0).receive(welcome);
    client.joinRoom('ABCDEF');
    expect(socketAt(0).types()).toEqual(['hello', 'join_room']);
    socketAt(0).receive({ type: 'left_room', reason: 'kicked', code: 'ABCDEF' });
    socketAt(0).drop();
    vi.advanceTimersByTime(1000);
    socketAt(1).open();
    socketAt(1).receive(welcome);
    expect(socketAt(1).types()).toEqual(['hello']);
    client.disconnect();
  });

  it('still rejoins after a plain leave or a kick from another room', () => {
    const client = makeClient();
    client.joinRoom('ABCDEF');
    socketAt(0).open();
    socketAt(0).receive({ type: 'left_room', reason: 'kicked', code: 'OTHER1' });
    socketAt(0).receive({ type: 'left_room', reason: 'left', code: 'ABCDEF' });
    socketAt(0).receive({ type: 'left_room' });
    socketAt(0).receive(welcome);
    // The kick from the other room is acknowledged, and this one is rejoined.
    expect(socketAt(0).parsed().slice(1)).toEqual([
      { type: 'ping' },
      { type: 'join_room', code: 'ABCDEF' },
    ]);
    client.disconnect();
  });
});

describe('GameClient: the tab id', () => {
  const sockets: FakeSocket[] = [];
  const createSocket = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const TAB_ID = /^[0-9a-f]{16}$/;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function socketAt(index: number): FakeSocket {
    const socket = sockets[index];
    if (!socket) throw new Error(`no socket ${index}`);
    return socket;
  }

  /** A client for a page of a tab whose sessionStorage is `tabStorage`, connected. */
  function makeClient(tabStorage: MemoryStorage | null, page = new FakePage()): GameClient {
    const client = new GameClient({
      url: 'ws://test/ws',
      createSocket,
      storage: new MemoryStorage(),
      tabStorage,
      page,
      pingIntervalMs: 0,
    });
    client.connect();
    return client;
  }

  function helloTab(socket: FakeSocket): unknown {
    const hello = socket.parsed()[0];
    expect(hello?.['type']).toBe('hello');
    return hello?.['tab'];
  }

  it('is made once, sent in every hello and handed to the next page of the tab, reloads included', () => {
    const session = new MemoryStorage();
    const page = new FakePage();
    const client = makeClient(session, page);
    socketAt(0).open();
    const tab = helloTab(socketAt(0));
    expect(tab).toMatch(TAB_ID);
    socketAt(0).receive(welcome);

    // The socket comes back: same tab.
    socketAt(0).drop();
    vi.advanceTimersByTime(1000);
    socketAt(1).open();
    expect(helloTab(socketAt(1))).toBe(tab);

    // The page reloads: it leaves the id in sessionStorage for the next page of the tab.
    page.fire('pagehide');
    expect(session.getItem(TAB_KEY)).toBe(tab);
    client.disconnect();
    const reloaded = makeClient(session);
    socketAt(2).open();
    expect(helloTab(socketAt(2))).toBe(tab);
    reloaded.disconnect();

    // Another tab has a sessionStorage of its own, and so an id of its own.
    const other = makeClient(new MemoryStorage());
    socketAt(3).open();
    expect(helloTab(socketAt(3))).toMatch(TAB_ID);
    expect(helloTab(socketAt(3))).not.toBe(tab);
    other.disconnect();
  });

  it('gives a copy of the tab made while the page is in view an id of its own', () => {
    const session = new MemoryStorage();
    // A tab that has been reloaded before: its id is in its sessionStorage.
    session.setItem(TAB_KEY, '0123456789abcdef');
    const client = makeClient(session);
    socketAt(0).open();
    expect(helloTab(socketAt(0))).toBe('0123456789abcdef');

    // The tab is duplicated, or the page opens itself again with window.open: the new page starts
    // with a copy of the sessionStorage.
    const copy = makeClient(session.copy());
    socketAt(1).open();
    expect(helloTab(socketAt(1))).toMatch(TAB_ID);
    expect(helloTab(socketAt(1))).not.toBe('0123456789abcdef');

    // Each keeps its own.
    socketAt(0).drop();
    vi.advanceTimersByTime(1000);
    socketAt(2).open();
    expect(helloTab(socketAt(2))).toBe('0123456789abcdef');
    client.disconnect();
    copy.disconnect();
  });

  it('leaves the id in sessionStorage while the page is hidden, where it may be discarded', () => {
    const session = new MemoryStorage();
    const page = new FakePage();
    const client = makeClient(session, page);
    socketAt(0).open();
    const tab = helloTab(socketAt(0));
    expect(session.getItem(TAB_KEY)).toBeNull();
    // In the background the browser may discard the page without a pagehide, and load it again
    // when the tab is shown.
    page.hide();
    expect(session.getItem(TAB_KEY)).toBe(tab);
    page.show();
    expect(session.getItem(TAB_KEY)).toBeNull();
    // Back from the back/forward cache after a pagehide: in view again.
    page.fire('pagehide');
    expect(session.getItem(TAB_KEY)).toBe(tab);
    page.fire('pageshow');
    expect(session.getItem(TAB_KEY)).toBeNull();
    client.disconnect();

    // A page loaded in the background (session restore, a tab opened behind this one).
    const background = makeClient(session, new FakePage(true));
    expect(session.getItem(TAB_KEY)).toMatch(TAB_ID);
    background.disconnect();
  });

  it('keeps one id in memory for the page when sessionStorage throws', () => {
    const broken = new MemoryStorage();
    broken.getItem = () => {
      throw new Error('SecurityError');
    };
    broken.setItem = () => {
      throw new Error('SecurityError');
    };
    const client = makeClient(broken);
    socketAt(0).open();
    const tab = helloTab(socketAt(0));
    expect(tab).toMatch(TAB_ID);
    socketAt(0).drop();
    vi.advanceTimersByTime(1000);
    socketAt(1).open();
    expect(helloTab(socketAt(1))).toBe(tab);
    client.disconnect();
  });
});

describe('GameClient: a kick or a notice is acknowledged at once', () => {
  const sockets: FakeSocket[] = [];
  const createSocket = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function connected(): { client: GameClient; socket: FakeSocket } {
    const client = new GameClient({
      url: 'ws://test/ws',
      createSocket,
      storage: new MemoryStorage(),
      tabStorage: new MemoryStorage(),
      // No keepalive: every ping here is an acknowledgement.
      pingIntervalMs: 0,
    });
    client.connect();
    const socket = sockets[0];
    if (!socket) throw new Error('no socket');
    socket.open();
    return { client, socket };
  }

  it('pings when kicked, before or after the welcome', () => {
    const { client, socket } = connected();
    // Kicked while away: the server says so before it welcomes us.
    socket.receive({ type: 'left_room', reason: 'kicked', code: 'ABCDEF' });
    expect(socket.types()).toEqual(['hello', 'ping']);
    socket.receive(welcome);
    client.joinRoom('OTHER1');
    socket.receive({ type: 'left_room', reason: 'kicked', code: 'OTHER1' });
    expect(socket.types()).toEqual(['hello', 'ping', 'join_room', 'ping']);
    client.disconnect();
  });

  it('pings on a notice', () => {
    const { client, socket } = connected();
    socket.receive(welcome);
    socket.receive({ type: 'notice', notice: 'moved_to_spectators', code: 'ABCDEF' });
    expect(socket.types()).toEqual(['hello', 'ping']);
    client.disconnect();
  });

  it('does not ping on a plain leave', () => {
    const { client, socket } = connected();
    socket.receive(welcome);
    socket.receive({ type: 'left_room', reason: 'left', code: 'ABCDEF' });
    socket.receive({ type: 'left_room' });
    expect(socket.types()).toEqual(['hello']);
    client.disconnect();
  });
});
