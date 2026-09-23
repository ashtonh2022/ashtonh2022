import { describe, expect, it } from 'vitest';

import { DEFAULT_RULES, analyze, makeCard, type Card } from '@landlord/engine';

import { describeCombo, hintCycle, playableRanks, previewSelection } from './selection';

const c = (rank: Card['rank'], suit: Card['suit'] = 'S', deck: 0 | 1 = 0) =>
  makeCard(rank, suit, deck);

describe('previewSelection', () => {
  it('names a valid pair', () => {
    const preview = previewSelection([c(8, 'S'), c(8, 'H')], null, DEFAULT_RULES);
    expect(preview.legal).toBe(true);
    expect(preview.text).toBe('Pair of 8s');
  });

  it('rejects an invalid set', () => {
    const preview = previewSelection([c(8, 'S'), c(9, 'H')], null, DEFAULT_RULES);
    expect(preview.legal).toBe(false);
    expect(preview.combo).toBeNull();
    expect(preview.text).toBe('Not a valid play');
  });

  it('says when the selection does not beat the current combination', () => {
    const current = analyze([c(10, 'S'), c(10, 'H')], DEFAULT_RULES);
    expect(current).not.toBeNull();
    const preview = previewSelection([c(8, 'S'), c(8, 'H')], current, DEFAULT_RULES);
    expect(preview.legal).toBe(false);
    expect(preview.text).toBe("Doesn't beat the Pair");
  });

  it('is empty with no selection', () => {
    expect(previewSelection([], null, DEFAULT_RULES)).toEqual({
      text: '',
      legal: false,
      combo: null,
    });
  });

  it('describes chains, bombs and rockets', () => {
    const straight = analyze([c(3), c(4), c(5), c(6), c(7)], DEFAULT_RULES);
    expect(straight && describeCombo(straight)).toBe('Straight of 5 to 7');
    const bomb = analyze([c(13, 'S'), c(13, 'H'), c(13, 'D'), c(13, 'C')], DEFAULT_RULES);
    expect(bomb && describeCombo(bomb)).toBe('Bomb of Ks');
    const rocket = analyze([c(16, 'J'), c(17, 'J')], DEFAULT_RULES);
    expect(rocket && describeCombo(rocket)).toBe('Rocket');
  });
});

describe('playableRanks', () => {
  it('lists the ranks that appear in some legal answer', () => {
    const hand = [c(3, 'S'), c(9, 'S'), c(9, 'H'), c(14, 'S'), c(14, 'H')];
    const current = analyze([c(8, 'S'), c(8, 'H')], DEFAULT_RULES);
    const ranks = playableRanks(hand, current, DEFAULT_RULES);
    expect(ranks).not.toBeNull();
    expect([...(ranks ?? [])].sort((a, b) => a - b)).toEqual([9, 14]);
  });

  it('is null when leading', () => {
    expect(playableRanks([c(3)], null, DEFAULT_RULES)).toBeNull();
  });
});

describe('hintCycle', () => {
  it('starts with the engine hint and continues with every other play', () => {
    const hand = [c(3, 'S'), c(9, 'S'), c(9, 'H'), c(14, 'S'), c(14, 'H')];
    const current = analyze([c(8, 'S'), c(8, 'H')], DEFAULT_RULES);
    const cycle = hintCycle(hand, current, DEFAULT_RULES);
    expect(cycle.map((combo) => combo.rank)).toEqual([9, 14]);
  });

  it('is empty for an empty hand', () => {
    expect(hintCycle([], null, DEFAULT_RULES)).toEqual([]);
  });
});
