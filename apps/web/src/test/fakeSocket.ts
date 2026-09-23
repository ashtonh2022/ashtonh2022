/**
 * Test doubles for GameClient: a WebSocket and a page the test drives by hand, and an in-memory
 * storage.
 */
import type { ServerMessage } from '@landlord/protocol';

import type { PageEvent, PageLike, SocketLike, StorageLike } from '../net/client';

export class FakeSocket implements SocketLike {
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

  types(): unknown[] {
    return this.parsed().map((message) => message['type']);
  }
}

export class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  /** What a tab duplicated now, or opened now with window.open, starts with (sessionStorage). */
  copy(): MemoryStorage {
    const copy = new MemoryStorage();
    for (const [key, value] of this.map) copy.setItem(key, value);
    return copy;
  }
}

/** A browser page whose visibility and lifecycle events the test drives by hand. */
export class FakePage implements PageLike {
  hidden: boolean;
  private readonly listeners = new Map<PageEvent, Array<() => void>>();

  constructor(hidden = false) {
    this.hidden = hidden;
  }

  addEventListener(type: PageEvent, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  fire(type: PageEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  /** The tab goes to the background (or the phone to another app). */
  hide(): void {
    this.hidden = true;
    this.fire('visibilitychange');
  }

  show(): void {
    this.hidden = false;
    this.fire('visibilitychange');
  }
}
