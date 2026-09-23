/**
 * The one WebSocket to the game server. Sends `hello` on every open with the identity persisted
 * in localStorage, persists what `welcome` returns, reconnects with backoff (1 s doubling up to
 * 10 s) and re-joins the current room after a reconnect. Messages sent before the server has
 * welcomed us are queued and flushed right after, except actions on the room itself (see
 * LIVE_ONLY): a click made against a table that may be out of date is dropped rather than
 * replayed later. For the same reason the status is 'open' only once the server has welcomed us,
 * not as soon as the socket opens.
 *
 * The name the player typed is the source of truth: it is persisted at once, goes out with the
 * next hello, and a change made after a hello went out is sent with set_name when the welcome
 * arrives instead of being replaced by the name in the welcome.
 *
 * Every hello also carries the id of this browser tab (see claimTabId): the server tells each tab
 * that was in a room about a kick from it once, and a tab is done with once it has said something
 * after being told. So a kick (left_room, reason 'kicked') or a notice is acknowledged with a ping
 * at once, rather than whenever the next keepalive goes out.
 *
 * Everything environment-specific (socket constructor, storage, URL) is injectable for tests.
 */
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@landlord/protocol';

/**
 * 'open' once the server has welcomed us on the current socket; until then 'connecting', or
 * 'reconnecting' when an earlier socket had been welcomed.
 */
export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';

export interface Identity {
  playerId?: string;
  token?: string;
  name?: string;
}

export const IDENTITY_KEY = 'landlord.identity';
/** sessionStorage key of this tab's id */
export const TAB_KEY = 'landlord.tab';
const TAB_ID = /^[0-9a-f]{16}$/;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The page events claimTabId follows (visibilitychange is the document's). */
export type PageEvent = 'pagehide' | 'pageshow' | 'visibilitychange';

/** The subset of the browser page (window and document) claimTabId uses, so tests can fake it. */
export interface PageLike {
  /** true while the page is not visible (document.visibilityState 'hidden') */
  readonly hidden: boolean;
  addEventListener(type: PageEvent, listener: () => void): void;
}

/** The subset of the WebSocket API the client uses (so tests can pass a fake). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface ClientOptions {
  url?: string;
  createSocket?: (url: string) => SocketLike;
  storage?: StorageLike | null;
  /** where the tab id is kept (see claimTabId); sessionStorage by default */
  tabStorage?: StorageLike | null;
  /** the page whose visibility and lifecycle claimTabId follows; the browser's by default */
  page?: PageLike | null;
  onMessage?: (message: ServerMessage) => void;
  onStatus?: (status: ConnectionStatus) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  pingIntervalMs?: number;
  /** how long typing must pause before a name change is sent (see setName) */
  nameDelayMs?: number;
}

const SOCKET_OPEN = 1;
const MAX_QUEUE = 20;
const NAME_DELAY_MS = 400;

/**
 * Messages aimed at the room as the player last saw it: a seat by its index, the hand on the table,
 * the host starting the next hand. They are sent while connected or not at all. After a reconnect
 * the room may have moved on (somebody else in that seat, a hand already under way), so a replay
 * could kick the wrong person or play into another trick.
 */
const LIVE_ONLY: ReadonlySet<ClientMessage['type']> = new Set<ClientMessage['type']>([
  'hand_action',
  'sit',
  'stand',
  'add_bot',
  'remove_bot',
  'fill_bots',
  'kick',
  'start_hand',
  'update_rules',
]);

export function defaultSocketUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${location.host}/ws`;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function defaultTabStorage(): StorageLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** 16 random lowercase hex characters. */
function newTabId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function defaultPage(): PageLike | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  return {
    get hidden() {
      return document.visibilityState === 'hidden';
    },
    addEventListener(type, listener) {
      if (type === 'visibilitychange') document.addEventListener(type, listener);
      else window.addEventListener(type, listener);
    },
  };
}

/** The tab id kept in `storage`: null when there is none, undefined when it cannot be read. */
function storedTabId(storage: StorageLike | null): string | null | undefined {
  if (!storage) return undefined;
  try {
    const stored = storage.getItem(TAB_KEY);
    return stored !== null && TAB_ID.test(stored) ? stored : null;
  } catch {
    return undefined;
  }
}

/** This page's tab id when the storage cannot keep one (see claimTabId). */
let pageTabId: string | null = null;

/**
 * The id of this browser tab, taken by this page. It is kept in `storage` (sessionStorage, which
 * is per tab and survives reloads) and made on first use. But a tab the browser duplicates, or one
 * the page opens with window.open, starts with a copy of that storage: two live pages with one id
 * would be one tab to the server, so when one heard about a kick the other would not be told and
 * would walk back into the room. So while the page is in view the id is taken out of `storage`,
 * and a copy made then has no id and makes its own. It is put back whenever the page may go away
 * without another word: on pagehide (a reload, leaving the page, closing the tab) and while the
 * page is hidden (a tab in the background may be discarded, and is loaded again when shown), so
 * the next page of this tab finds it.
 *
 * When there is no storage or it throws, an id is kept in memory for the page's lifetime instead.
 */
export function claimTabId(storage: StorageLike | null, page: PageLike | null): string {
  const stored = storedTabId(storage);
  if (!storage || stored === undefined) {
    pageTabId ??= newTabId();
    return pageTabId;
  }
  const id = stored ?? newTabId();
  /** true from pagehide until the page is shown again (the back/forward cache) */
  let gone = false;
  const update = (): void => {
    try {
      if (gone || !page || page.hidden) storage.setItem(TAB_KEY, id);
      else storage.removeItem(TAB_KEY);
    } catch {
      // storage unavailable: the next page of this tab makes an id of its own
    }
  };
  page?.addEventListener('visibilitychange', update);
  page?.addEventListener('pagehide', () => {
    gone = true;
    update();
  });
  page?.addEventListener('pageshow', () => {
    gone = false;
    update();
  });
  update();
  return id;
}

export function loadIdentity(storage: StorageLike | null): Identity {
  if (!storage) return {};
  try {
    const raw = storage.getItem(IDENTITY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    const identity: Identity = {};
    if (typeof record['playerId'] === 'string') identity.playerId = record['playerId'];
    if (typeof record['token'] === 'string') identity.token = record['token'];
    if (typeof record['name'] === 'string') identity.name = record['name'];
    return identity;
  } catch {
    return {};
  }
}

export function saveIdentity(storage: StorageLike | null, identity: Identity): void {
  if (!storage) return;
  try {
    storage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // storage unavailable: the player will simply get a fresh identity next time
  }
}

function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof (parsed as { type?: unknown }).type !== 'string') return null;
    return parsed as ServerMessage;
  } catch {
    return null;
  }
}

export class GameClient {
  status: ConnectionStatus = 'connecting';
  identity: Identity;
  /** true once the current connection has been welcomed by the server */
  welcomed = false;

  private readonly url: string;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly storage: StorageLike | null;
  private readonly tabStorage: StorageLike | null;
  private readonly page: PageLike | null;
  /** this tab's id, taken by the first connect (see claimTabId) */
  private tabId: string | null = null;
  private readonly onMessage: (message: ServerMessage) => void;
  private readonly onStatus: (status: ConnectionStatus) => void;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly pingIntervalMs: number;
  private readonly nameDelayMs: number;

  private socket: SocketLike | null = null;
  private started = false;
  private stopped = false;
  private everWelcomed = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private roomCode: string | null = null;
  private queue: ClientMessage[] = [];
  private nameTimer: ReturnType<typeof setTimeout> | null = null;
  /** setName was called after the current socket's hello went out */
  private nameChangedSinceHello = false;
  /** the name the server has for us as far as we know: the welcome's, then each one we sent */
  private serverName: string | null = null;

  constructor(options: ClientOptions = {}) {
    this.url = options.url ?? defaultSocketUrl();
    this.createSocket =
      options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.tabStorage = options.tabStorage === undefined ? defaultTabStorage() : options.tabStorage;
    this.page = options.page === undefined ? defaultPage() : options.page;
    this.onMessage = options.onMessage ?? (() => undefined);
    this.onStatus = options.onStatus ?? (() => undefined);
    this.minBackoffMs = options.minBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 10_000;
    this.pingIntervalMs = options.pingIntervalMs ?? 25_000;
    this.nameDelayMs = options.nameDelayMs ?? NAME_DELAY_MS;
    this.identity = loadIdentity(this.storage);
  }

  /** Opens the connection (idempotent). */
  connect(): void {
    if (this.started && !this.stopped) return;
    this.started = true;
    this.stopped = false;
    // As early as possible: a copy of the tab made before then would share its id.
    this.tabId ??= claimTabId(this.tabStorage, this.page);
    this.open();
  }

  /** Closes the connection and stops reconnecting. */
  disconnect(): void {
    this.stopped = true;
    this.clearTimers();
    this.clearNameTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onopen = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
  }

  /**
   * Sends a message, or queues it until the server has welcomed us. Returns true when the message
   * went out immediately. LIVE_ONLY messages are never queued: they were aimed at the room the
   * player saw, and after a reconnect it may be somewhere else entirely.
   */
  send(message: ClientMessage): boolean {
    if (this.socket && this.socket.readyState === SOCKET_OPEN && this.welcomed) {
      this.socket.send(JSON.stringify(message));
      return true;
    }
    if (LIVE_ONLY.has(message.type)) return false;
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push(message);
    return false;
  }

  /** Remembers the room to (re)join after every welcome and joins it now when possible. */
  joinRoom(code: string | null): void {
    this.roomCode = code;
    if (code === null) {
      this.queue = this.queue.filter((message) => message.type !== 'join_room');
      return;
    }
    if (this.welcomed) this.send({ type: 'join_room', code });
  }

  get currentRoomCode(): string | null {
    return this.roomCode;
  }

  /**
   * The player typed a name (call it on every change). It is persisted at once, so the next hello
   * carries it, and sent to the server once typing pauses for `nameDelayMs` (or at flushName).
   * Typed after a hello went out, it replaces the name in the welcome that answers that hello.
   */
  setName(name: string): void {
    this.identity = { ...this.identity, name: name.trim() };
    saveIdentity(this.storage, this.identity);
    this.nameChangedSinceHello = true;
    this.clearNameTimer();
    this.nameTimer = setTimeout(() => this.flushName(), this.nameDelayMs);
  }

  /**
   * Sends a name change still waiting for typing to pause, e.g. before creating or joining a room.
   * Before the welcome there is nothing to do: the welcome sends it (see handleMessage).
   */
  flushName(): void {
    this.clearNameTimer();
    const name = this.identity.name ?? '';
    if (name.length === 0 || !this.welcomed || name === this.serverName) return;
    if (this.send({ type: 'set_name', name })) this.serverName = name;
  }

  private open(): void {
    if (this.stopped) return;
    this.clearTimers();
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.welcomed = false;
    socket.onopen = () => this.handleOpen(socket);
    socket.onmessage = (event) => this.handleMessage(socket, event.data);
    socket.onclose = () => this.handleClose(socket);
    socket.onerror = () => undefined;
  }

  private handleOpen(socket: SocketLike): void {
    if (socket !== this.socket) return;
    // Not 'open' yet: until the welcome, clicks on the room would be dropped (see send).
    const { playerId, token, name } = this.identity;
    this.nameChangedSinceHello = false;
    this.tabId ??= claimTabId(this.tabStorage, this.page);
    const hello: ClientMessage = {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      ...(playerId ? { playerId } : {}),
      ...(token ? { token } : {}),
      ...(name ? { name } : {}),
      tab: this.tabId,
    };
    socket.send(JSON.stringify(hello));
    if (this.pingIntervalMs > 0) {
      this.pingTimer = setInterval(() => {
        if (this.socket === socket && socket.readyState === SOCKET_OPEN && this.welcomed) {
          socket.send(JSON.stringify({ type: 'ping' }));
        }
      }, this.pingIntervalMs);
    }
  }

  private handleMessage(socket: SocketLike, data: unknown): void {
    if (socket !== this.socket) return;
    const message = parseServerMessage(data);
    if (!message) return;
    if (message.type === 'welcome') {
      // A name typed after the hello went out (sent or still waiting for typing to pause) is
      // newer than the one the server answered with: keep it and tell the server.
      const typed = this.identity.name ?? '';
      const keepTyped = this.nameChangedSinceHello && typed.length > 0;
      this.identity = {
        playerId: message.playerId,
        token: message.token,
        name: keepTyped ? typed : message.name,
      };
      saveIdentity(this.storage, this.identity);
      this.welcomed = true;
      this.everWelcomed = true;
      this.attempts = 0;
      this.serverName = message.name;
      // Before anything else, so a room joined or created next shows the typed name.
      if (keepTyped) this.flushName();
      if (this.roomCode) {
        socket.send(JSON.stringify({ type: 'join_room', code: this.roomCode }));
      }
      const pending = this.queue.filter(
        (queued) => queued.type !== 'join_room' || queued.code !== this.roomCode,
      );
      this.queue = [];
      for (const queued of pending) socket.send(JSON.stringify(queued));
      this.onMessage(message);
      this.setStatus('open');
      return;
    }
    const kicked = message.type === 'left_room' && message.reason === 'kicked';
    // Kicked from the room we rejoin on every welcome: stop, or the next welcome walks us back in.
    // (A player kicked while away hears it just before the welcome, see the server's Hub.hello.)
    if (kicked && (message.code === undefined || message.code === this.roomCode)) {
      this.roomCode = null;
    }
    // Tell the server it arrived, so this tab is not told again (the server has had our hello by
    // now, so this may go out before the welcome).
    if ((kicked || message.type === 'notice') && socket.readyState === SOCKET_OPEN) {
      socket.send(JSON.stringify({ type: 'ping' }));
    }
    this.onMessage(message);
  }

  private handleClose(socket: SocketLike): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.welcomed = false;
    this.queue = this.queue.filter((message) => !LIVE_ONLY.has(message.type));
    this.clearTimers();
    if (this.stopped) return;
    this.setStatus(this.everWelcomed ? 'reconnecting' : 'connecting');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** this.attempts);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearNameTimer(): void {
    if (this.nameTimer) {
      clearTimeout(this.nameTimer);
      this.nameTimer = null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }
}
