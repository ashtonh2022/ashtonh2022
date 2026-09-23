import type { RoomView } from '@landlord/protocol';

import type { SoundName } from '../audio';
import { isRedeal } from './redeal';

/**
 * Sounds to play when `next` replaces `prev` in the store. The client never diffs events to stay
 * correct (snapshots are authoritative); this is only for feedback.
 */
export function soundsForSnapshot(prev: RoomView | null, next: RoomView): SoundName[] {
  const sounds: SoundName[] = [];
  const hand = next.hand;
  if (!hand) return sounds;
  const before = prev && prev.code === next.code ? prev.hand : null;
  const mySeat = next.you.seat;

  const newDeal =
    !before ||
    before.handNumber !== hand.handNumber ||
    (before.phase !== 'bidding' && hand.phase === 'bidding') ||
    isRedeal(prev, next);
  if (newDeal) sounds.push('deal');

  if (before && before.landlord === null && hand.landlord !== null) sounds.push('landlord');

  if (
    before &&
    before.handNumber === hand.handNumber &&
    hand.history.length > before.history.length
  ) {
    const last = hand.history[hand.history.length - 1];
    if (last) {
      if (last.combo === null) sounds.push('pass');
      else if (last.combo.type === 'rocket') sounds.push('rocket');
      else if (last.combo.type === 'bomb') sounds.push('bomb');
      else sounds.push('play');
    }
  }

  const finishedNow = hand.phase === 'finished' && (!before || before.phase !== 'finished');
  if (finishedNow && hand.result) {
    if (mySeat !== null) {
      const iAmLandlord = hand.result.landlord === mySeat;
      const iWon = (hand.result.winnerSide === 'landlord') === iAmLandlord;
      sounds.push(iWon ? 'win' : 'lose');
    }
    if (hand.result.spring) sounds.push('spring');
  }

  if (
    mySeat !== null &&
    (hand.phase === 'bidding' || hand.phase === 'playing') &&
    hand.turn === mySeat &&
    (!before || before.turn !== mySeat || before.phase !== hand.phase)
  ) {
    sounds.push('your-turn');
  }

  return sounds;
}
