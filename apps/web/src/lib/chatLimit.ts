/**
 * The server accepts at most CHAT_LIMIT chat messages and emotes per player in any CHAT_WINDOW_MS
 * (apps/server/src/room.ts). The client mirrors it so a message is held back instead of rejected.
 */
export const CHAT_LIMIT = 5;
export const CHAT_WINDOW_MS = 5_000;
/** a little slack for the time the messages spend on the wire */
const MARGIN_MS = 250;

/** The send times that still count against the limit at `now`. */
export function recentSends(sentAt: readonly number[], now: number): number[] {
  return sentAt.filter((at) => now - at < CHAT_WINDOW_MS + MARGIN_MS);
}

/** Epoch ms when the next message may be sent, or null when one may be sent now. */
export function chatBlockedUntil(sentAt: readonly number[], now: number): number | null {
  const recent = recentSends(sentAt, now);
  if (recent.length < CHAT_LIMIT) return null;
  const oldest = recent[recent.length - CHAT_LIMIT] ?? now;
  return oldest + CHAT_WINDOW_MS + MARGIN_MS;
}
