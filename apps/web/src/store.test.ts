import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HandState } from '@landlord/engine';

const audio = vi.hoisted(() => ({ played: [] as string[] }));
vi.mock('./audio', () => ({
  isMuted: () => false,
  loadMuted: () => false,
  play: (name: string) => audio.played.push(name),
  playAll: (names: string[]) => audio.played.push(...names),
  setMuted: () => undefined,
}));

import { useStore } from './store';
import { act, firstBidderCalls, newHand, resetStore, roomView } from './test/fixtures';

function receive(state: HandState, seat = 0, extra = {}) {
  useStore.getState().handleMessage({ type: 'room_state', room: roomView(state, { seat, extra }) });
}

function lowestSingle(state: HandState, seat: number): string {
  const hand = [...(state.hands[seat] ?? [])].sort((a, b) => a.rank - b.rank);
  const card = hand[0];
  if (!card) throw new Error('empty hand');
  return card.id;
}

describe('store: selection across snapshots (W3)', () => {
  beforeEach(() => {
    resetStore();
    audio.played.length = 0;
  });

  it('keeps a selection made while waiting when another seat plays or passes', () => {
    let state = firstBidderCalls(newHand());
    expect(state.phase).toBe('playing');
    expect(state.turn).toBe(0);
    receive(state, 1);
    const mine = state.hands[1] ?? [];
    const picked = [mine[0]?.id ?? '', mine[1]?.id ?? ''];
    useStore.getState().setSelection(picked);

    state = act(state, 0, { type: 'play', cardIds: [lowestSingle(state, 0)] });
    receive(state, 1);
    expect(useStore.getState().selection).toEqual(picked);

    // seat 1 answers something else, seat 2 passes: the two picked cards are still in hand
    const answer = (state.hands[1] ?? []).find(
      (card) => !picked.includes(card.id) && card.rank > (state.trick.current?.rank ?? 0),
    );
    if (!answer) throw new Error('no answer');
    state = act(state, 1, { type: 'play', cardIds: [answer.id] });
    receive(state, 1);
    expect(useStore.getState().selection).toEqual(picked);
    state = act(state, 2, { type: 'pass' });
    receive(state, 1);
    expect(useStore.getState().selection).toEqual(picked);
  });

  it('drops only the selected cards that left the hand', () => {
    let state = firstBidderCalls(newHand());
    receive(state, 0);
    const played = lowestSingle(state, 0);
    const other = (state.hands[0] ?? []).find((card) => card.id !== played)?.id ?? '';
    useStore.getState().setSelection([played, other]);
    state = act(state, 0, { type: 'play', cardIds: [played] });
    receive(state, 0);
    expect(useStore.getState().selection).toEqual([other]);
  });

  it('resets the hint cycle when the trick changes and clears the selection on a new hand', () => {
    let state = firstBidderCalls(newHand());
    receive(state, 1);
    useStore.getState().setHintIndex(3);
    receive(state, 1);
    expect(useStore.getState().hintIndex).toBe(3);
    state = act(state, 0, { type: 'play', cardIds: [lowestSingle(state, 0)] });
    receive(state, 1);
    expect(useStore.getState().hintIndex).toBe(0);

    useStore.getState().setSelection([(state.hands[1] ?? [])[0]?.id ?? '']);
    receive(newHand({}, { seed: 'next', handNumber: 2 }), 1);
    expect(useStore.getState().selection).toEqual([]);
  });
});

describe('store: redeal (W11)', () => {
  beforeEach(() => {
    resetStore();
    audio.played.length = 0;
  });

  function twoPasses(): HandState {
    let state = newHand({ allPass: 'redeal' });
    state = act(state, 0, { type: 'pass_bid' });
    return act(state, 1, { type: 'pass_bid' });
  }

  it('detects a redeal without the server flag (same hand number, bidding restarted)', () => {
    receive(twoPasses(), 2);
    audio.played.length = 0;
    const redealt = newHand({ allPass: 'redeal' }, { seed: 'again', firstBidder: 1 });
    receive(redealt, 2);
    expect(useStore.getState().redealAt).not.toBeNull();
    expect(audio.played.filter((name) => name === 'deal')).toHaveLength(1);

    // the next broadcast of the same deal is not another redeal
    receive(act(redealt, 1, { type: 'pass_bid' }), 2);
    expect(audio.played.filter((name) => name === 'deal')).toHaveLength(1);
  });

  it('uses the server flag when present and plays the deal sound once', () => {
    receive(twoPasses(), 2, { redealt: false });
    audio.played.length = 0;
    const redealt = newHand({ allPass: 'redeal' }, { seed: 'again', firstBidder: 1 });
    receive(redealt, 2, { redealt: true });
    receive(redealt, 2, { redealt: true });
    expect(audio.played.filter((name) => name === 'deal')).toHaveLength(1);
  });
});
