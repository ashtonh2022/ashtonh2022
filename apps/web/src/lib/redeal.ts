import type { RoomView } from '@landlord/protocol';

/**
 * True when `next` is the first snapshot of a redeal: everyone passed, so the same hand number was
 * dealt again and the bidding restarted. Uses the server's `redealt` flag when it is sent, and
 * otherwise spots the restart itself (same hand number, bidding records reset).
 */
export function isRedeal(prev: RoomView | null, next: RoomView): boolean {
  const before = prev !== null && prev.code === next.code ? prev.hand : null;
  const hand = next.hand;
  if (prev === null || before === null || hand === null) return false;
  if (before.handNumber !== hand.handNumber || hand.phase !== 'bidding') return false;
  const restarted =
    before.phase === 'redeal' ||
    (before.phase === 'bidding' && hand.bidding.records.length < before.bidding.records.length);
  if (next.redealt === undefined) return restarted;
  return next.redealt && (prev.redealt !== true || restarted);
}
