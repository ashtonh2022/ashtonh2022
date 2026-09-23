import {
  decodeClientMessage,
  encode,
  type ClientMessage,
  type ServerErrorCode,
  type ServerMessage,
} from '@landlord/protocol';

import type { Clock } from './clock';
import type { Logger } from './log';
import type { Player } from './players';

/** The socket as the connection sees it. `ws` sockets and test fakes both fit. */
export interface Transport {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ConnectionHandler {
  onMessage(connection: Connection, message: ClientMessage): void;
  onClose(connection: Connection): void;
}

/** Inbound messages allowed per connection in a sliding window. */
export const MESSAGE_LIMIT = 30;
export const MESSAGE_WINDOW_MS = 5_000;
/** Frames larger than this are rejected without being decoded (the protocol caps text at 8 KiB). */
export const MAX_FRAME_BYTES = 16 * 1024;
/** `hello` messages allowed on one connection; the next one closes it. */
export const HELLO_LIMIT = 3;
/** Rooms one connection may create in a sliding window. */
export const CREATE_ROOM_LIMIT = 3;
export const CREATE_ROOM_WINDOW_MS = 60_000;

let nextConnectionId = 1;

/**
 * One WebSocket. Decodes and validates every inbound frame with the protocol schemas, enforces
 * the `hello` handshake and a per-connection rate limit, and hands valid messages to the hub.
 * Nothing a client sends can throw out of `receive`.
 */
export class Connection {
  readonly id = nextConnectionId++;
  player: Player | null = null;
  /** `hello` messages received so far. */
  helloCount = 0;
  private readonly recent: number[] = [];
  private readonly roomsCreated: number[] = [];
  private limitNotified = false;
  private closed = false;

  constructor(
    private readonly transport: Transport,
    private readonly handler: ConnectionHandler,
    private readonly clock: Clock,
    private readonly log: Logger,
    /**
     * The key per-IP limits count this connection under (see clientIp.ts), worked out by
     * server.ts from the request; null for in-process transports, which have no IP.
     */
    readonly ip: string | null = null,
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  send(message: ServerMessage): void {
    if (this.closed) return;
    try {
      this.transport.send(encode(message));
    } catch (err) {
      this.log.warn(`connection ${this.id}: send failed`, err);
    }
  }

  error(code: ServerErrorCode, message: string): void {
    this.send({ type: 'error', code, message });
  }

  /** Feeds one inbound frame (string, Buffer, ArrayBuffer or Buffer[]; null for binary frames). */
  receive(raw: unknown): void {
    if (this.closed) return;
    try {
      if (!this.allow()) {
        if (!this.limitNotified) {
          this.limitNotified = true;
          this.error('rate_limited', 'too many messages, slow down');
        }
        return;
      }
      const text = toText(raw);
      const message = text === null ? null : decodeClientMessage(text);
      if (message === null) {
        this.error('bad_message', 'that is not a valid message');
        return;
      }
      if (this.player === null && message.type !== 'hello') {
        this.error('bad_message', 'send hello first');
        return;
      }
      this.handler.onMessage(this, message);
    } catch (err) {
      this.log.error(`connection ${this.id}: handler failed`, err);
      this.error('bad_message', 'the server could not process that message');
    }
  }

  /** Server-initiated close. The transport's close event then reaches `handleClose`. */
  terminate(code = 1000, reason = ''): void {
    if (this.closed) return;
    try {
      this.transport.close(code, reason);
    } catch (err) {
      this.log.warn(`connection ${this.id}: close failed`, err);
    }
    this.handleClose();
  }

  /** Called once the underlying socket is gone, whoever closed it. Idempotent. */
  handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.handler.onClose(this);
    } catch (err) {
      this.log.error(`connection ${this.id}: close handler failed`, err);
    }
  }

  /** Records a create_room when this connection is still under its limit; false otherwise. */
  allowRoomCreation(): boolean {
    const cutoff = this.clock.now() - CREATE_ROOM_WINDOW_MS;
    const times = this.roomsCreated;
    while (times.length > 0 && (times[0] as number) <= cutoff) times.shift();
    if (times.length >= CREATE_ROOM_LIMIT) return false;
    times.push(this.clock.now());
    return true;
  }

  private allow(): boolean {
    const now = this.clock.now();
    const cutoff = now - MESSAGE_WINDOW_MS;
    while (this.recent.length > 0 && (this.recent[0] as number) <= cutoff) this.recent.shift();
    if (this.recent.length >= MESSAGE_LIMIT) return false;
    this.recent.push(now);
    this.limitNotified = false;
    return true;
  }
}

function toText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.length > MAX_FRAME_BYTES ? null : raw;
  if (Buffer.isBuffer(raw)) return raw.length > MAX_FRAME_BYTES ? null : raw.toString('utf8');
  if (raw instanceof ArrayBuffer) {
    return raw.byteLength > MAX_FRAME_BYTES ? null : Buffer.from(raw).toString('utf8');
  }
  if (Array.isArray(raw) && raw.every((part) => Buffer.isBuffer(part))) {
    const joined = Buffer.concat(raw as Buffer[]);
    return joined.length > MAX_FRAME_BYTES ? null : joined.toString('utf8');
  }
  return null;
}
