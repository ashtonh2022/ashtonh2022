import { describe, expect, it } from 'vitest';

import type { Card, HandState, RuleSettings } from './types';
import { makeCard } from './cards';
import { createHand } from './hand';
import { currentStake, kittyBonusMultiplier, settle } from './scoring';
import { RULES_3P, RULES_4P, cards, dealSpecs, withoutTwos } from './test-helpers';

const BONUS_3P: RuleSettings = { ...RULES_3P, kittyBonus: true };
const BONUS_4P: RuleSettings = { ...RULES_4P, kittyBonus: true };

/** Cards of one rank each in rotating suits, so a run is never all one suit. */
function mixed(spec: string): Card[] {
  const suits = ['S', 'H', 'D', 'C'] as const;
  return cards(spec).map((card, index) =>
    card.suit === 'J' ? card : makeCard(card.rank, suits[index % 4] as 'S', card.deck),
  );
}

function suited(spec: string): Card[] {
  return cards(spec).map((card) =>
    card.suit === 'J' ? card : makeCard(card.rank, 'H', card.deck),
  );
}

describe('kittyBonusMultiplier', () => {
  it('is 1 whenever the option is off', () => {
    for (const kitty of [cards('BJ RJ 5'), cards('5 5 5'), suited('3 4 5'), cards('3 4 BJ')]) {
      expect(kittyBonusMultiplier(kitty, RULES_3P)).toBe(1);
      expect(kittyBonusMultiplier(kitty, RULES_4P)).toBe(1);
    }
    expect(kittyBonusMultiplier([], BONUS_3P)).toBe(1);
  });

  it('triples for both joker colours, three of a kind and a same-suit run', () => {
    expect(kittyBonusMultiplier(cards('BJ RJ 5'), BONUS_3P)).toBe(3);
    expect(kittyBonusMultiplier(cards('RJ 9 BJ'), BONUS_3P)).toBe(3);
    expect(kittyBonusMultiplier(cards('5 5 5'), BONUS_3P)).toBe(3);
    expect(kittyBonusMultiplier(cards('2 2 2'), BONUS_3P)).toBe(3);
    expect(kittyBonusMultiplier(suited('3 4 5'), BONUS_3P)).toBe(3);
    expect(kittyBonusMultiplier(suited('9 10 J Q K A'), { ...BONUS_3P, kittySize: 6 })).toBe(3);
    expect(kittyBonusMultiplier(cards('7 7 7 3 4 8 10 Q'), BONUS_4P)).toBe(3);
    expect(kittyBonusMultiplier(cards('RJ RJ BJ 3 4 8 10 Q'), BONUS_4P)).toBe(3);
  });

  it('doubles for a mixed-suit run or exactly one joker', () => {
    expect(kittyBonusMultiplier(mixed('3 4 5'), BONUS_3P)).toBe(2);
    expect(kittyBonusMultiplier(mixed('5 3 4'), BONUS_3P)).toBe(2);
    expect(kittyBonusMultiplier(mixed('Q K A'), BONUS_3P)).toBe(2);
    expect(kittyBonusMultiplier(mixed('9 10 J Q K A'), { ...BONUS_3P, kittySize: 6 })).toBe(2);
    expect(kittyBonusMultiplier(cards('3 8 BJ'), BONUS_3P)).toBe(2);
    expect(kittyBonusMultiplier(cards('3 8 RJ'), BONUS_3P)).toBe(2);
    expect(kittyBonusMultiplier(cards('RJ 3 4 5 8 9 J K'), BONUS_4P)).toBe(2);
  });

  it('runs follow the room chain rule for 2s and jokers', () => {
    expect(kittyBonusMultiplier(mixed('K A 2'), BONUS_3P)).toBe(2);
    expect(kittyBonusMultiplier(mixed('A 2 BJ'), BONUS_3P)).toBe(2);
    expect(kittyBonusMultiplier(mixed('K A 2'), withoutTwos(BONUS_3P))).toBe(1);
    expect(kittyBonusMultiplier(mixed('Q K A'), withoutTwos(BONUS_3P))).toBe(2);
    expect(kittyBonusMultiplier(suited('Q K A'), withoutTwos(BONUS_3P))).toBe(3);
  });

  it('gives nothing for anything else, including same-colour joker pairs', () => {
    expect(kittyBonusMultiplier(mixed('3 4 6'), BONUS_3P)).toBe(1);
    expect(kittyBonusMultiplier(cards('3 3 4'), BONUS_3P)).toBe(1);
    expect(kittyBonusMultiplier(suited('3 3 4'), BONUS_3P)).toBe(1);
    expect(kittyBonusMultiplier(cards('BJ BJ 3 5 7 9 J K'), BONUS_4P)).toBe(1);
    expect(kittyBonusMultiplier(cards('3 3 4 4 5 5 6 6'), BONUS_4P)).toBe(1);
    expect(kittyBonusMultiplier(mixed('3 4'), BONUS_3P)).toBe(1);
  });

  it('applies only the highest applicable bonus', () => {
    expect(kittyBonusMultiplier(mixed('2 BJ RJ'), BONUS_3P)).toBe(3);
    expect(kittyBonusMultiplier(cards('5 5 5 BJ 3 8 10 Q'), BONUS_4P)).toBe(3);
    expect(kittyBonusMultiplier(mixed('3 4 BJ'), BONUS_3P)).toBe(2);
  });
});

interface FinishedOptions {
  rules?: RuleSettings;
  landlord: number;
  winner: number;
  playCounts: number[];
  bombs?: number;
  robs?: number;
  base?: number;
  doubles?: boolean[];
  kitty?: string;
}

/** A hand in which `winner` has just played their last card, with the given tallies. */
function finished(opts: FinishedOptions): HandState {
  const rules = opts.rules ?? (opts.playCounts.length === 4 ? RULES_4P : RULES_3P);
  const seatCount = rules.playerCount;
  const specs: string[] = [];
  for (let seat = 0; seat < seatCount; seat++) specs.push(seat === opts.winner ? '' : '3 4');
  const hands = dealSpecs(specs);
  const state = createHand({ rules, seed: 'settle', handNumber: 1, firstBidder: 0 });
  return {
    ...state,
    phase: 'finished',
    turn: -1,
    hands,
    kitty: opts.kitty === undefined ? state.kitty : cards(opts.kitty),
    kittyRevealed: true,
    landlord: opts.landlord,
    base: opts.base ?? 1,
    bidding: { ...state.bidding, robs: opts.robs ?? 0 },
    doubles: opts.doubles ?? new Array<boolean>(seatCount).fill(false),
    playCounts: opts.playCounts,
    bombsPlayed: opts.bombs ?? 0,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe('settle', () => {
  it('doubles the stake per rob, per bomb and for a spring (call mode)', () => {
    const result = settle(
      finished({ landlord: 0, winner: 0, playCounts: [6, 0, 0], robs: 1, bombs: 2 }),
    );
    expect(result).toEqual({
      winnerSide: 'landlord',
      landlord: 0,
      winnerSeat: 0,
      base: 1,
      robs: 1,
      bombs: 2,
      spring: 'spring',
      kittyBonus: 1,
      stake: 16,
      doubled: [false, false, false],
      amounts: [32, -16, -16],
    });
    expect(sum(result.amounts)).toBe(0);
  });

  it('is not a spring once any peasant has played', () => {
    const result = settle(
      finished({ landlord: 0, winner: 0, playCounts: [6, 1, 0], robs: 1, bombs: 2 }),
    );
    expect(result.spring).toBeNull();
    expect(result.stake).toBe(8);
    expect(result.amounts).toEqual([16, -8, -8]);
  });

  it('doubles for an anti-spring when the landlord only led once', () => {
    const anti = settle(finished({ landlord: 0, winner: 1, playCounts: [1, 3, 2] }));
    expect(anti.winnerSide).toBe('peasants');
    expect(anti.winnerSeat).toBe(1);
    expect(anti.spring).toBe('anti_spring');
    expect(anti.stake).toBe(2);
    expect(anti.amounts).toEqual([-4, 2, 2]);
    const normal = settle(finished({ landlord: 0, winner: 1, playCounts: [2, 3, 2] }));
    expect(normal.spring).toBeNull();
    expect(normal.amounts).toEqual([-2, 1, 1]);
    const peasantsWinAfterNoLead = settle(
      finished({ landlord: 2, winner: 0, playCounts: [4, 2, 0] }),
    );
    expect(peasantsWinAfterNoLead.spring).toBeNull();
  });

  it('uses the winning bid as the base and applies doubles per peasant', () => {
    const rules: RuleSettings = { ...RULES_3P, biddingMode: 'points', doublingRound: true };
    const landlordWins = settle(
      finished({
        rules,
        landlord: 0,
        winner: 0,
        playCounts: [5, 2, 1],
        base: 3,
        doubles: [true, true, false],
      }),
    );
    expect(landlordWins.base).toBe(3);
    expect(landlordWins.stake).toBe(3);
    expect(landlordWins.doubled).toEqual([true, true, false]);
    expect(landlordWins.amounts).toEqual([18, -12, -6]);
    const peasantsWin = settle(
      finished({
        rules,
        landlord: 0,
        winner: 2,
        playCounts: [5, 2, 3],
        base: 3,
        doubles: [true, true, false],
      }),
    );
    expect(peasantsWin.amounts).toEqual([-18, 12, 6]);
    const onlyPeasant = settle(
      finished({
        rules,
        landlord: 0,
        winner: 0,
        playCounts: [5, 2, 3],
        base: 3,
        doubles: [false, false, true],
      }),
    );
    expect(onlyPeasant.amounts).toEqual([9, -3, -6]);
    const bidTwoWithBomb = settle(
      finished({ rules, landlord: 1, winner: 1, playCounts: [2, 5, 3], base: 2, bombs: 1 }),
    );
    expect(bidTwoWithBomb.stake).toBe(4);
    expect(bidTwoWithBomb.amounts).toEqual([-4, 8, -4]);
  });

  it('settles four-player hands between the landlord and three peasants', () => {
    const landlordWins = settle(
      finished({ landlord: 1, winner: 1, playCounts: [2, 6, 3, 1], base: 2, bombs: 1 }),
    );
    expect(landlordWins.stake).toBe(4);
    expect(landlordWins.amounts).toEqual([-4, 12, -4, -4]);
    const peasantsWin = settle(
      finished({
        rules: { ...RULES_4P, doublingRound: true },
        landlord: 1,
        winner: 3,
        playCounts: [2, 6, 3, 4],
        base: 1,
        bombs: 2,
        doubles: [true, false, false, true],
      }),
    );
    expect(peasantsWin.stake).toBe(4);
    expect(peasantsWin.amounts).toEqual([8, -20, 4, 8]);
    expect(sum(peasantsWin.amounts)).toBe(0);
    const spring = settle(finished({ landlord: 3, winner: 3, playCounts: [0, 0, 0, 7], robs: 2 }));
    expect(spring.spring).toBe('spring');
    expect(spring.stake).toBe(8);
    expect(spring.amounts).toEqual([-8, -8, -8, 24]);
  });

  it('multiplies by the kitty bonus only when the option is on', () => {
    const on = settle(
      finished({
        rules: BONUS_3P,
        landlord: 0,
        winner: 0,
        playCounts: [4, 1, 1],
        kitty: 'BJ RJ 5',
      }),
    );
    expect(on.kittyBonus).toBe(3);
    expect(on.stake).toBe(3);
    expect(on.amounts).toEqual([6, -3, -3]);
    const off = settle(
      finished({ landlord: 0, winner: 0, playCounts: [4, 1, 1], kitty: 'BJ RJ 5' }),
    );
    expect(off.kittyBonus).toBe(1);
    expect(off.amounts).toEqual([2, -1, -1]);
    const everything = settle(
      finished({
        rules: { ...BONUS_3P, doublingRound: true },
        landlord: 2,
        winner: 2,
        playCounts: [0, 0, 5],
        robs: 1,
        bombs: 1,
        kitty: '3 8 RJ',
        doubles: [false, true, true],
      }),
    );
    expect(everything.stake).toBe(1 * 2 * 2 * 2 * 2);
    expect(everything.amounts).toEqual([-32, -64, 96]);
  });

  it('refuses to settle a hand without a landlord or a winner', () => {
    const state = createHand({ rules: RULES_3P, seed: 'x', handNumber: 1, firstBidder: 0 });
    expect(() => settle(state)).toThrow(/landlord/);
    expect(() => settle({ ...state, landlord: 0 })).toThrow(/gone out/);
  });
});

describe('currentStake', () => {
  it('multiplies the base by robs and bombs, adding the kitty bonus once revealed', () => {
    const state = createHand({ rules: BONUS_3P, seed: 'stake', handNumber: 1, firstBidder: 0 });
    expect(currentStake(state)).toBe(1);
    const bid = { ...state, bidding: { ...state.bidding, robs: 2 }, bombsPlayed: 1 };
    expect(currentStake(bid)).toBe(8);
    const revealed = { ...bid, kittyRevealed: true, kitty: cards('BJ RJ 5') };
    expect(currentStake(revealed)).toBe(24);
    expect(currentStake({ ...revealed, rules: RULES_3P })).toBe(8);
    expect(currentStake({ ...revealed, base: 3, bidding: state.bidding, bombsPlayed: 0 })).toBe(9);
  });
});
