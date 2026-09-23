import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RULES,
  cardsPerPlayer,
  defaultKittySize,
  kittySizeOptions,
  normalizeRules,
} from './rules';

describe('DEFAULT_RULES', () => {
  it('matches the defaults in RULES.md', () => {
    expect(DEFAULT_RULES).toEqual({
      playerCount: 3,
      kittySize: 3,
      biddingMode: 'call',
      allPass: 'force',
      doublingRound: false,
      kittyBonus: false,
      firstBidder: 'winner',
      chainsThroughTwos: true,
      turnSeconds: 30,
    });
  });
});

describe('kitty sizes', () => {
  it('offers the RULES.md options per player count', () => {
    expect(kittySizeOptions(3)).toEqual([3, 6, 9, 12]);
    expect(kittySizeOptions(4)).toEqual([4, 8, 12, 16]);
    expect(defaultKittySize(3)).toBe(3);
    expect(defaultKittySize(4)).toBe(8);
  });

  it('always divides the remaining cards evenly', () => {
    for (const playerCount of [3, 4] as const) {
      for (const kittySize of kittySizeOptions(playerCount)) {
        const rules = { ...DEFAULT_RULES, playerCount, kittySize };
        expect(Number.isInteger(cardsPerPlayer(rules))).toBe(true);
      }
    }
    expect(cardsPerPlayer(DEFAULT_RULES)).toBe(17);
    expect(cardsPerPlayer({ ...DEFAULT_RULES, kittySize: 12 })).toBe(14);
    expect(cardsPerPlayer({ ...DEFAULT_RULES, playerCount: 4, kittySize: 8 })).toBe(25);
    expect(cardsPerPlayer({ ...DEFAULT_RULES, playerCount: 4, kittySize: 16 })).toBe(23);
  });
});

describe('normalizeRules', () => {
  it('returns the defaults for anything that is not an object', () => {
    for (const garbage of [undefined, null, 42, 'rules', true, [], () => 1, Symbol('x'), 1n]) {
      expect(normalizeRules(garbage)).toEqual(DEFAULT_RULES);
    }
    expect(normalizeRules({})).toEqual(DEFAULT_RULES);
    expect(normalizeRules(Object.create(null))).toEqual(DEFAULT_RULES);
  });

  it('never throws, even on hostile objects', () => {
    const hostile = {
      get playerCount(): number {
        throw new Error('boom');
      },
    };
    expect(() => normalizeRules(hostile)).not.toThrow();
    expect(normalizeRules(hostile)).toEqual(DEFAULT_RULES);
  });

  it('keeps valid values and drops unknown keys', () => {
    const normalized = normalizeRules({
      playerCount: 4,
      kittySize: 12,
      biddingMode: 'points',
      allPass: 'redeal',
      doublingRound: true,
      kittyBonus: true,
      firstBidder: 'rotate',
      chainsThroughTwos: false,
      turnSeconds: 45,
      somethingElse: 'ignored',
    });
    expect(normalized).toEqual({
      playerCount: 4,
      kittySize: 12,
      biddingMode: 'points',
      allPass: 'redeal',
      doublingRound: true,
      kittyBonus: true,
      firstBidder: 'rotate',
      chainsThroughTwos: false,
      turnSeconds: 45,
    });
    expect('somethingElse' in normalized).toBe(false);
  });

  it('falls back to defaults for invalid enum and boolean values', () => {
    const normalized = normalizeRules({
      playerCount: 5,
      biddingMode: 'auction',
      allPass: 1,
      doublingRound: 'yes',
      kittyBonus: null,
      firstBidder: 'me',
      chainsThroughTwos: 0,
    });
    expect(normalized).toEqual(DEFAULT_RULES);
    expect(normalizeRules({ playerCount: '4' }).playerCount).toBe(3);
  });

  it('snaps the kitty size to a valid option for the player count', () => {
    expect(normalizeRules({ kittySize: 6 }).kittySize).toBe(6);
    expect(normalizeRules({ kittySize: 5 }).kittySize).toBe(3);
    expect(normalizeRules({ kittySize: '6' }).kittySize).toBe(3);
    expect(normalizeRules({ playerCount: 4 }).kittySize).toBe(8);
    expect(normalizeRules({ playerCount: 4, kittySize: 3 }).kittySize).toBe(8);
    expect(normalizeRules({ playerCount: 4, kittySize: 16 }).kittySize).toBe(16);
    expect(normalizeRules({ playerCount: 3, kittySize: 16 }).kittySize).toBe(3);
  });

  it('clamps turnSeconds to 5..120', () => {
    expect(normalizeRules({ turnSeconds: 1 }).turnSeconds).toBe(5);
    expect(normalizeRules({ turnSeconds: 5 }).turnSeconds).toBe(5);
    expect(normalizeRules({ turnSeconds: 120 }).turnSeconds).toBe(120);
    expect(normalizeRules({ turnSeconds: 9999 }).turnSeconds).toBe(120);
    expect(normalizeRules({ turnSeconds: -3 }).turnSeconds).toBe(5);
    expect(normalizeRules({ turnSeconds: Number.NaN }).turnSeconds).toBe(30);
    expect(normalizeRules({ turnSeconds: Number.POSITIVE_INFINITY }).turnSeconds).toBe(30);
    expect(normalizeRules({ turnSeconds: '60' }).turnSeconds).toBe(30);
  });

  it('returns a fresh object each time', () => {
    const a = normalizeRules(undefined);
    const b = normalizeRules(undefined);
    expect(a).not.toBe(b);
    expect(a).not.toBe(DEFAULT_RULES);
  });
});
