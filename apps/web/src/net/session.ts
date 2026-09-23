/**
 * The app-wide client instance, wired to the store. Pages import `client` from here.
 */
import type { ClientMessage } from '@landlord/protocol';

import { useStore } from '../store';
import { GameClient } from './client';

export const client = new GameClient({
  onMessage: (message) => useStore.getState().handleMessage(message),
  onStatus: (status) => useStore.getState().setStatus(status),
});

/** Opens the connection once (safe to call from every page). */
export function ensureConnected(): void {
  client.connect();
}

export function send(message: ClientMessage): boolean {
  return client.send(message);
}
