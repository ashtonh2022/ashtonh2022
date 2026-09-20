/**
 * Adversarial verification, round 1: four-player (two-deck) combinations.
 *
 * The reference functions below are written from docs/RULES.md and docs/ENGINE_API.md alone
 * (never from combos.ts / plays.ts) so that a disagreement means the engine strays from the spec,
 * not merely that two engine modules disagree with each other.
 */
import { describe, expect, it } from 'vitest';
import type { Card, Combo, ComboType, HandAction, HandState, RuleSettings } from '../types';
import { createDeck, seededRng, shuffle } from '../cards';
import { analyze, analyzeAs, beats, bombStrength, chainRanks } from '../combos';
import { findPlays, hint } from '../plays';
import { applyAction } from '../hand';
import {
  PASS,
  RULES_4P,
  cards,
  key,
  play,
  playingState,
  rejection,
  run,
  shape,
  step,
  withoutTwos,
} from '../test-helpers';

declare const performance: { now(): number };

const NO_TWOS_4P = withoutTwos(RULES_4P);

function combo(spec: string, rules: RuleSettings = RULES_4P): Combo {
  const read = analyze(cards(spec), rules);
  if (read === null) throw new Error(`"${spec}" is not a combo under these rules`);
  return read;
}

interface Reading {
  type: ComboType;
  rank: number;
  length: number;
  size: number;
}

const s = (type: ComboType, rank: number, length: number, size: number): Reading => ({
  type,
  rank,
  length,
  size,
});

const toReading = (c: Combo): Reading => s(c.type, c.rank, c.length, c.cards.length);
const keys = (plays: Combo[]): string[] => plays.map((p) => key(p.cards));
const plain = (plays: Combo[]): string[] =>
  keys(plays.filter((p) => p.type !== 'bomb' && p.type !== 'rocket'));
/** Space-separated rank keys as a list. */
const K = (list: string): string[] => list.split(' ');
const readShape = (spec: string, rules: RuleSettings = RULES_4P) =>
  shape(analyze(cards(spec), rules));
const passAll = (state: HandState, seats: number[]): HandState =>
  run(
    state,
    seats.map((seat): [number, HandAction] => [seat, PASS]),
  ).state;
/** The full two-deck pack plus narrow pools in which triples, bombs and jokers collide often. */
const narrowPools = (deck: Card[]): Card[][] => [
  deck,
  deck.filter((c) => c.rank <= 6 || c.rank >= 14),
  deck.filter((c) => c.rank <= 5 || c.rank >= 15),
  deck.filter((c) => c.rank >= 12),
];

// ---------------------------------------------------------------------------
// Reference implementation of RULES.md "Combinations", "Jokers" and "Bombs"
// ---------------------------------------------------------------------------

/** Every way RULES.md lets a set of cards be read (any order), independent of the engine. */
function refReadings(set: readonly Card[], rules: RuleSettings): Reading[] {
  const n = set.length;
  const byRank = new Map<number, number>();
  for (const card of set) byRank.set(card.rank, (byRank.get(card.rank) ?? 0) + 1);
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const count = (rank: number): number => byRank.get(rank) ?? 0;
  const black = count(16);
  const red = count(17);
  const out: Reading[] = [];
  const push = (type: ComboType, rank: number, length: number): void => {
    out.push(s(type, rank, length, n));
  };
  const chainTop = rules.chainsThroughTwos ? 17 : 14;
  const isRun = (window: number[]): boolean =>
    window.length > 0 &&
    window.every((rank) => rank >= 3 && rank <= chainTop) &&
    window.every((rank, i) => i === 0 || rank === (window[i - 1] as number) + 1);
  const mixesColours = (some: number[]): boolean => some.includes(16) && some.includes(17);

  // A red and a black joker played together are only ever a rocket (2, 3 or 4 jokers).
  if (n === 0) return out;
  if (black > 0 && red > 0 && black + red === n) {
    if (n <= 4) push('rocket', 17, 1);
    return out;
  }
  if (ranks.length === 1) {
    const rank = ranks[0] as number;
    if (n === 1) push('single', rank, 1);
    else if (n === 2) push('pair', rank, 1);
    else if (n === 3) push('triple', rank, 1);
    else if (n <= 8 && rank <= 15) push('bomb', rank, 1);
    return out;
  }
  if (ranks.length === 2) {
    for (const triple of ranks) {
      const kicker = ranks.find((rank) => rank !== triple) as number;
      if (count(triple) !== 3) continue;
      if (count(kicker) === 1) push('triple_single', triple, 1);
      if (count(kicker) === 2) push('triple_pair', triple, 1);
    }
  }
  for (const four of ranks) {
    if (count(four) !== 4 || four > 15) continue;
    const others = ranks.filter((rank) => rank !== four);
    if (mixesColours(others)) continue;
    const otherCards = others.reduce((sum, rank) => sum + count(rank), 0);
    if (otherCards === 2) push('four_two_single', four, 1);
    if (otherCards === 4 && others.every((rank) => count(rank) % 2 === 0)) {
      push('four_two_pair', four, 1);
    }
  }
  if (isRun(ranks)) {
    const top = ranks[ranks.length - 1] as number;
    if (n >= 5 && ranks.every((rank) => count(rank) === 1)) push('straight', top, n);
    if (ranks.length >= 3 && ranks.every((rank) => count(rank) === 2)) {
      push('pair_chain', top, ranks.length);
    }
    if (ranks.length >= 2 && ranks.every((rank) => count(rank) === 3)) {
      push('airplane', top, ranks.length);
    }
  }
  for (let i = 0; i < ranks.length; i++) {
    for (let j = i + 1; j < ranks.length; j++) {
      const window = ranks.slice(i, j + 1);
      if (!isRun(window) || !window.every((rank) => count(rank) === 3)) continue;
      const length = window.length;
      const top = window[length - 1] as number;
      const kickers = ranks.filter((rank) => !window.includes(rank));
      if (mixesColours(kickers)) continue;
      const kickerCards = kickers.reduce((sum, rank) => sum + count(rank), 0);
      if (kickerCards === length) push('airplane_single', top, length);
      if (kickerCards === 2 * length && kickers.every((rank) => count(rank) % 2 === 0)) {
        push('airplane_pair', top, length);
      }
    }
  }
  return out;
}

const REF_PRIORITY: Partial<Record<ComboType, number>> = {
  rocket: 0,
  bomb: 1,
  airplane: 2,
  airplane_pair: 3,
  airplane_single: 4,
};

/** RULES.md reading preference: longest plain airplane, then + pairs, then + singles. */
function refPrefer(a: Reading, b: Reading): boolean {
  const pa = REF_PRIORITY[a.type] ?? 9;
  const pb = REF_PRIORITY[b.type] ?? 9;
  if (pa !== pb) return pa < pb;
  if (a.length !== b.length) return a.length > b.length;
  return a.rank > b.rank;
}

function refAnalyze(set: readonly Card[], rules: RuleSettings): Reading | null {
  let best: Reading | null = null;
  for (const reading of refReadings(set, rules)) {
    if (best === null || refPrefer(reading, best)) best = reading;
  }
  return best;
}

/** RULES.md "Bombs", 4-player tiers, with plenty of room between tiers. */
const BOMB_TIER: Record<number, number> = { 4: 1000, 5: 3000, 6: 5000, 7: 6000, 8: 7000 };
const ROCKET_TIER: Record<number, number> = { 2: 2000, 3: 4000, 4: 8000 };

function refStrength(reading: Reading): number {
  if (reading.type === 'rocket') return ROCKET_TIER[reading.size] ?? 0;
  if (reading.type === 'bomb') return (BOMB_TIER[reading.size] ?? 0) + reading.rank;
  return 0;
}

function refBeats(candidate: Reading, current: Reading): boolean {
  const a = candidate.type === 'bomb' || candidate.type === 'rocket';
  const b = current.type === 'bomb' || current.type === 'rocket';
  if (a && b) return refStrength(candidate) > refStrength(current);
  if (a || b) return a;
  return (
    candidate.type === current.type &&
    candidate.length === current.length &&
    candidate.size === current.size &&
    candidate.rank > current.rank
  );
}

/** Rank keys of every subset of `hand` that is a legal lead / legal answer per the reference. */
function refPlays(hand: Card[], current: Reading | null, rules: RuleSettings): Set<string> {
  const found = new Set<string>();
  for (let mask = 1; mask < 1 << hand.length; mask++) {
    const subset = hand.filter((_, i) => (mask & (1 << i)) !== 0);
    const readings = refReadings(subset, rules);
    const legal =
      current === null ? readings.length > 0 : readings.some((r) => refBeats(r, current));
    if (legal) found.add(key(subset));
  }
  return found;
}

/** findPlays must equal the reference brute force, and every play must be a beating reading. */
function expectPlaysMatchReference(hand: Card[], current: Combo | null, rules: RuleSettings): void {
  const plays = findPlays(hand, current, rules);
  const target = current === null ? null : toReading(current);
  const expected = refPlays(hand, target, rules);
  const label = `${key(hand)} on ${current ? key(current.cards) : 'lead'} twos=${rules.chainsThroughTwos}`;
  expect(new Set(keys(plays)), label).toEqual(expected);
  expect(keys(plays).length, `no duplicates: ${label}`).toBe(expected.size);
  for (const play of plays) {
    expect(refReadings(play.cards, rules), `${label}: ${key(play.cards)}`).toContainEqual(
      toReading(play),
    );
    if (target === null) expect(toReading(play)).toEqual(refAnalyze(play.cards, rules));
    else expect(refBeats(toReading(play), target)).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

describe('createDeck(4)', () => {
  it('has 108 cards with unique ids, two of every card, marked deck 0 and 1', () => {
    const deck = createDeck(4);
    expect(deck).toHaveLength(108);
    expect(new Set(deck.map((c) => c.id)).size).toBe(108);
    expect(deck.filter((c) => c.deck === 0)).toHaveLength(54);
    expect(deck.filter((c) => c.deck === 1)).toHaveLength(54);
    for (const card of deck) {
      expect(card.id).toBe(`${card.rank}-${card.suit}-${card.deck}`);
      expect(card.suit === 'J').toBe(card.rank >= 16);
    }
    for (let rank = 3; rank <= 15; rank++) {
      expect(deck.filter((c) => c.rank === rank)).toHaveLength(8);
      for (const suit of ['S', 'H', 'D', 'C']) {
        expect(deck.filter((c) => c.rank === rank && c.suit === suit)).toHaveLength(2);
      }
    }
    expect(deck.filter((c) => c.rank === 16)).toHaveLength(2);
    expect(deck.filter((c) => c.rank === 17)).toHaveLength(2);
    expect(createDeck(4)).toEqual(deck);
  });

  it('chainRanks runs 3..RJ with the option on and 3..A with it off', () => {
    expect(chainRanks(RULES_4P)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(chainRanks(NO_TWOS_4P)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });
});

// ---------------------------------------------------------------------------
// analyze: two-deck specifics
// ---------------------------------------------------------------------------

describe('analyze: jokers with two decks', () => {
  it('reads same-colour joker pairs as pairs of rank 16 / 17 and never BJ+RJ as a pair', () => {
    expect(readShape('BJ BJ')).toEqual(s('pair', 16, 1, 2));
    expect(readShape('RJ RJ')).toEqual(s('pair', 17, 1, 2));
    expect(readShape('BJ RJ')).toEqual(s('rocket', 17, 1, 2));
    expect(beats(combo('RJ RJ'), combo('BJ BJ'), RULES_4P)).toBe(true);
    expect(beats(combo('BJ BJ'), combo('2 2'), RULES_4P)).toBe(true);
    expect(beats(combo('BJ BJ'), combo('RJ RJ'), RULES_4P)).toBe(false);
  });

  it('reads 2, 3 and 4 jokers as rockets only when both colours are present', () => {
    expect(readShape('BJ BJ RJ')).toEqual(s('rocket', 17, 1, 3));
    expect(readShape('BJ RJ RJ')).toEqual(s('rocket', 17, 1, 3));
    expect(readShape('BJ BJ RJ RJ')).toEqual(s('rocket', 17, 1, 4));
    expect(readShape('BJ RJ 3')).toBeNull();
    expect(readShape('BJ BJ RJ 3')).toBeNull();
  });

  it('accepts same-colour joker pairs and single jokers as kickers, never a red with a black', () => {
    expect(readShape('5 5 5 BJ BJ')).toEqual(s('triple_pair', 5, 1, 5));
    expect(readShape('5 5 5 RJ')).toEqual(s('triple_single', 5, 1, 4));
    expect(readShape('5 5 5 5 RJ RJ')).toEqual(s('four_two_single', 5, 1, 6));
    expect(readShape('5 5 5 5 BJ BJ 9 9')).toEqual(s('four_two_pair', 5, 1, 8));
    expect(readShape('5 5 5 6 6 6 BJ BJ')).toEqual(s('airplane_single', 6, 2, 8));
    expect(readShape('5 5 5 6 6 6 RJ RJ 3 3')).toEqual(s('airplane_pair', 6, 2, 10));
    expect(readShape('5 5 5 5 BJ RJ')).toBeNull();
    expect(readShape('5 5 5 5 BJ BJ RJ RJ')).toBeNull();
    expect(readShape('5 5 5 6 6 6 BJ RJ')).toBeNull();
    expect(readShape('5 5 5 6 6 6 7 7 7 BJ RJ 4')).toBeNull();
  });

  it('lets joker pairs extend pair chains and airplanes past the 2s when the option is on', () => {
    expect(readShape('2 2 BJ BJ RJ RJ')).toEqual(s('pair_chain', 17, 3, 6));
    expect(readShape('K K A A 2 2 BJ BJ RJ RJ')).toEqual(s('pair_chain', 17, 5, 10));
    expect(readShape('A A 2 2 BJ BJ')).toEqual(s('pair_chain', 16, 3, 6));
    expect(readShape('A A A 2 2 2')).toEqual(s('airplane', 15, 2, 6));
    expect(readShape('K A 2 BJ RJ')).toEqual(s('straight', 17, 5, 5));
    expect(readShape('2 2 BJ BJ RJ RJ', NO_TWOS_4P)).toBeNull();
    expect(readShape('A A A 2 2 2', NO_TWOS_4P)).toBeNull();
    expect(readShape('K A 2 BJ RJ', NO_TWOS_4P)).toBeNull();
    expect(readShape('BJ BJ RJ RJ 3 3')).toBeNull();
  });
});

describe('analyze: bombs and four-of-a-kind with two decks', () => {
  it('reads 4..8 of a kind as bombs of that size, 3333 44 as four + two, 333333 as a bomb', () => {
    for (let size = 4; size <= 8; size++) {
      expect(readShape(Array<string>(size).fill('7').join(' '))).toEqual(s('bomb', 7, 1, size));
    }
    expect(readShape('3 3 3 3 4 4')).toEqual(s('four_two_single', 3, 1, 6));
    expect(readShape('3 3 3 3 3 3')).toEqual(s('bomb', 3, 1, 6));
    expect(readShape('3 3 3 3 3 3 3 3')).toEqual(s('bomb', 3, 1, 8));
  });

  it('lets four of a kind serve as four single kickers or two pair kickers of another rank', () => {
    expect(readShape('3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 7')).toEqual(s('airplane_single', 6, 4, 16));
    expect(readShape('3 3 3 4 4 4 7 7 7 7')).toEqual(s('airplane_pair', 4, 2, 10));
    expect(readShape('3 3 3 4 4 4 5 5 5 5')).toEqual(s('airplane_pair', 4, 2, 10));
    expect(readShape('9 9 9 9 5 5 5 5')).toEqual(s('four_two_pair', 9, 1, 8));
  });

  it('does not read 3333 4444 as an airplane (with or without kickers)', () => {
    expect(readShape('3 3 3 3 4 4 4 4')?.type).not.toBe('airplane');
    expect(readShape('3 3 3 3 4 4 4 4')?.type).not.toBe('airplane_single');
    const asAnswer = analyzeAs(cards('3 3 3 3 4 4 4 4'), RULES_4P, combo('5 5 5 6 6 6 3 4'));
    expect(asAnswer?.type).not.toBe('airplane_single');
    expect(readShape('3 3 3 3 4 4 4 4 5 5 5 5')?.type ?? null).not.toBe('airplane_single');
  });

  it('agrees with the RULES.md reference reading on random two-deck sets', () => {
    const rng = seededRng('analyze-4p-reference');
    const deck = createDeck(4);
    const pools = narrowPools(deck);
    let legal = 0;
    for (let i = 0; i < 5000; i++) {
      const rules = i % 3 === 2 ? NO_TWOS_4P : RULES_4P;
      const pool = shuffle(pools[i % pools.length] as Card[], rng);
      const size = 1 + Math.floor(rng() * (i % 5 === 0 ? 16 : 12));
      const set = pool.slice(0, size);
      const expected = refAnalyze(set, rules);
      const actual = analyze(set, rules);
      expect(shape(actual), `analyze(${key(set)}) twos=${rules.chainsThroughTwos}`).toEqual(
        expected,
      );
      if (expected !== null) legal++;
      if (actual !== null) {
        expect(actual.size).toBe(actual.cards.length);
        expect(key(actual.cards)).toBe(key(set));
      }
    }
    expect(legal).toBeGreaterThan(400);
  });
});

// ---------------------------------------------------------------------------
// beats / bombStrength: the 8 tiers
// ---------------------------------------------------------------------------

describe('beats: 4-player bomb and rocket tiers', () => {
  const tiers: Array<[string, string]> = [
    ['4-bomb of 3s', '3 3 3 3'],
    ['4-bomb of 2s', '2 2 2 2'],
    ['2-rocket', 'BJ RJ'],
    ['5-bomb of 3s', '3 3 3 3 3'],
    ['5-bomb of 2s', '2 2 2 2 2'],
    ['3-rocket', 'BJ BJ RJ'],
    ['6-bomb of 3s', '3 3 3 3 3 3'],
    ['6-bomb of 2s', '2 2 2 2 2 2'],
    ['7-bomb of 3s', '3 3 3 3 3 3 3'],
    ['7-bomb of 2s', '2 2 2 2 2 2 2'],
    ['8-bomb of 3s', '3 3 3 3 3 3 3 3'],
    ['8-bomb of 2s', '2 2 2 2 2 2 2 2'],
    ['4-rocket', 'BJ BJ RJ RJ'],
  ];

  it('every stronger tier beats every weaker one and nothing beats itself', () => {
    for (let i = 0; i < tiers.length; i++) {
      for (let j = 0; j < tiers.length; j++) {
        const a = combo(tiers[i]![1]);
        const b = combo(tiers[j]![1]);
        expect(beats(a, b, RULES_4P), `${tiers[i]![0]} vs ${tiers[j]![0]}`).toBe(i > j);
      }
    }
    for (let i = 1; i < tiers.length; i++) {
      expect(bombStrength(combo(tiers[i]![1]), RULES_4P)).toBeGreaterThan(
        bombStrength(combo(tiers[i - 1]![1]), RULES_4P),
      );
    }
  });

  it('compares 4-card bombs by rank and beats every non-bomb with any bomb or rocket', () => {
    const labels = '3 4 5 6 7 8 9 10 J Q K A 2'.split(' ');
    const fourOf = (rank: number): Combo => combo(`${labels[rank - 3]} `.repeat(4));
    for (let rank = 3; rank < 15; rank++) {
      expect(beats(fourOf(rank + 1), fourOf(rank), RULES_4P), `${rank + 1} on ${rank}`).toBe(true);
      expect(beats(fourOf(rank), fourOf(rank + 1), RULES_4P), `${rank} on ${rank + 1}`).toBe(false);
      expect(beats(fourOf(rank), fourOf(rank), RULES_4P)).toBe(false);
    }
    const nonBombs = '3,2 2,RJ RJ,A A A,K A 2 BJ RJ,2 2 BJ BJ RJ RJ,3 3 3 3 4 4 4 4'.split(',');
    for (const [, spec] of tiers) {
      for (const other of nonBombs) {
        expect(beats(combo(spec), combo(other), RULES_4P), `${spec} on ${other}`).toBe(true);
        expect(beats(combo(other), combo(spec), RULES_4P), `${other} on ${spec}`).toBe(false);
      }
    }
    expect(beats(combo('3 3 3 3 4 4'), combo('2 2 2 2 3 3'), RULES_4P)).toBe(false);
    expect(beats(combo('4 4 4 4 3 3'), combo('3 3 3 3 2 2'), RULES_4P)).toBe(true);
  });

  it('agrees with the reference on every pair of a mixed set of combos', () => {
    const specs = [
      ...tiers.map(([, spec]) => spec),
      ...['7 7 7 7', '3', 'BJ', 'RJ', '2 2', 'BJ BJ', 'RJ RJ', '5 5 5', '5 5 5 BJ', '5 5 5 BJ BJ'],
      ...['6 6 6 RJ RJ', '3 4 5 6 7', 'K A 2 BJ RJ', '3 3 4 4 5 5', 'A A 2 2 BJ BJ'],
      ...['2 2 BJ BJ RJ RJ', '3 3 3 4 4 4', 'A A A 2 2 2', '3 3 3 4 4 4 5 6', '3 3 3 4 4 4 BJ BJ'],
      ...'3 3 3 4 4 4 5 5 6 6,3 3 3 3 4 4,3 3 3 3 BJ BJ,3 3 3 3 4 4 5 5,3 3 3 3 4 4 4 4'.split(','),
    ];
    const all = specs.map((spec) => combo(spec));
    for (const a of all) {
      for (const b of all) {
        expect(beats(a, b, RULES_4P), `${key(a.cards)} on ${key(b.cards)}`).toBe(
          refBeats(toReading(a), toReading(b)),
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// analyzeAs
// ---------------------------------------------------------------------------

describe('analyzeAs with two decks', () => {
  it('reads 333 444 555 666 as whatever airplane form answers the trick', () => {
    const twelve = cards('3 3 3 4 4 4 5 5 5 6 6 6');
    const onSingles = analyzeAs(twelve, RULES_4P, combo('7 7 7 8 8 8 9 9 9 3 4 5'));
    expect(shape(onSingles)).toEqual(s('airplane_single', 6, 3, 12));
    expect(beats(onSingles!, combo('3 3 3 4 4 4 5 5 5 7 8 9'), RULES_4P)).toBe(true);
    expect(beats(onSingles!, combo('4 4 4 5 5 5 6 6 6 7 8 9'), RULES_4P)).toBe(false);
    const onPlain = analyzeAs(twelve, RULES_4P, combo('3 3 3 4 4 4 5 5 5 6 6 6'));
    expect(shape(onPlain)).toEqual(s('airplane', 6, 4, 12));
    expect(shape(analyzeAs(twelve, RULES_4P, combo('3 3 3 4 4 4')))).toEqual(shape(onPlain));
  });

  it('picks the four + two pairs reading of 3333 4444 that beats the trick', () => {
    const eight = cards('3 3 3 3 4 4 4 4');
    const read = analyzeAs(eight, RULES_4P, combo('3 3 3 3 5 5 6 6'));
    expect(shape(read)).toEqual(s('four_two_pair', 4, 1, 8));
    expect(beats(read!, combo('3 3 3 3 5 5 6 6'), RULES_4P)).toBe(true);
    expect(analyzeAs(eight, RULES_4P, combo('BJ RJ'))?.type).toBe('four_two_pair');
  });
});

// ---------------------------------------------------------------------------
// findPlays: dedupe, completeness and soundness against the reference
// ---------------------------------------------------------------------------

describe('findPlays with two decks', () => {
  it('lists each rank structure once however many suits and decks could form it', () => {
    const hand = cards('3 3 3 3 3 3 3 3 BJ BJ RJ RJ');
    const leads = findPlays(hand, null, RULES_4P);
    const ofType = (type: ComboType): Combo[] => leads.filter((p) => p.type === type);
    expect(keys(leads)).toEqual([...new Set(keys(leads))]);
    expect(ofType('single').map((p) => p.rank)).toEqual([3, 16, 17]);
    expect(ofType('pair').map((p) => p.rank)).toEqual([3, 16, 17]);
    expect(ofType('triple').map((p) => p.rank)).toEqual([3]);
    expect(ofType('bomb').map((p) => p.size)).toEqual([4, 5, 6, 7, 8]);
    expect(keys(ofType('rocket'))).toEqual(K('16,17 16,16,17 16,17,17 16,16,17,17'));
    expect(keys(ofType('triple_single'))).toEqual(['3,3,3,16', '3,3,3,17']);
    expect(keys(ofType('triple_pair'))).toEqual(['3,3,3,16,16', '3,3,3,17,17']);
    expect(keys(ofType('four_two_single'))).toEqual(['3,3,3,3,16,16', '3,3,3,3,17,17']);
    expect(ofType('four_two_pair')).toEqual([]);
    expect(ofType('pair_chain')).toEqual([]);
    expect(leads).toHaveLength(3 + 3 + 1 + 5 + 4 + 2 + 2 + 2);
    for (const p of leads) expect(p.cards.every((c) => hand.includes(c))).toBe(true);
  });

  it('answers with the tiers: 5-bombs beat a 2-rocket, 3-rockets beat 5-bombs, 4-bombs never do', () => {
    const hand = cards('3 3 3 3 3 A A A A 2 2 2 2 2 2 BJ BJ RJ RJ 4');
    expect(keys(findPlays(hand, combo('BJ RJ'), RULES_4P))).toEqual(
      K('3,3,3,3,3 15,15,15,15,15 16,16,17 16,17,17 15,15,15,15,15,15 16,16,17,17'),
    );
    expect(keys(findPlays(hand, combo('2 2 2 2 2'), RULES_4P))).toEqual(
      K('16,16,17 16,17,17 15,15,15,15,15,15 16,16,17,17'),
    );
    const onFour = keys(findPlays(hand, combo('K K K K'), RULES_4P));
    expect(onFour[0]).toBe('14,14,14,14');
    expect(onFour).toContain('16,17');
    expect(onFour).not.toContain('3,3,3,3');
    expect(keys(findPlays(hand, combo('2 2 2 2 2 2'), RULES_4P))).toEqual(['16,16,17,17']);
    expect(findPlays(hand, combo('BJ BJ RJ RJ'), RULES_4P)).toEqual([]);
    expect(shape(hint(hand, combo('BJ RJ'), RULES_4P))).toEqual(s('bomb', 3, 1, 5));
  });

  it('builds pair chains, airplanes and four + two from ranks held in duplicate, once each', () => {
    const hand = cards('3 3 3 3 4 4 4 4 5 5 5 5 2 2 BJ BJ RJ RJ');
    const leads = findPlays(hand, null, RULES_4P);
    const ofType = (type: ComboType): string[] => keys(leads.filter((p) => p.type === type));
    expect(ofType('pair_chain')).toEqual(['3,3,4,4,5,5', '15,15,16,16,17,17']);
    expect(ofType('airplane')).toEqual(['3,3,3,4,4,4', '4,4,4,5,5,5', '3,3,3,4,4,4,5,5,5']);
    expect(ofType('straight')).toEqual([]);
    expect(ofType('four_two_pair')).toContain('3,3,3,3,4,4,4,4');
    expect(ofType('four_two_pair')).toContain('3,3,3,3,15,15,16,16');
    expect(ofType('four_two_pair')).not.toContain('3,3,3,3,16,16,17,17');
    expect(ofType('four_two_single')).not.toContain('3,3,3,3,16,17');
    expect(plain(findPlays(hand, combo('A A 2 2 BJ BJ'), RULES_4P))).toEqual(['15,15,16,16,17,17']);
    expect(plain(findPlays(hand, combo('3 3 4 4 5 5'), RULES_4P))).toEqual(['15,15,16,16,17,17']);
    expect(plain(findPlays(hand, combo('2 2 BJ BJ RJ RJ'), RULES_4P))).toEqual([]);
    expect(plain(findPlays(hand, combo('3 3 3 4 4 4'), RULES_4P))).toEqual(['4,4,4,5,5,5']);
    expect(plain(findPlays(hand, combo('3 3 3 4 4 4 5 5 5'), RULES_4P))).toEqual([]);
    expect(plain(findPlays(hand, combo('3 3 3 4 4 4 5 5 5 6 6 6'), RULES_4P))).toEqual([]);
    // 3333 4444 is four + two pairs of rank 4, so only 5555 + two pairs can answer it.
    const onFourTwoPair = plain(findPlays(hand, combo('3 3 3 3 4 4 4 4'), RULES_4P));
    expect(onFourTwoPair).toHaveLength(11);
    expect(onFourTwoPair[0]).toBe('3,3,3,3,5,5,5,5');
    expect(onFourTwoPair).toContain('4,4,4,4,5,5,5,5');
    expect(onFourTwoPair).not.toContain('3,3,3,3,4,4,4,4');
    // Answers of rank 4 come before rank 5, each group in ascending rank structure.
    const onRankThree = plain(findPlays(hand, combo('3 3 3 3 4 4 5 5'), RULES_4P));
    expect(onRankThree).toHaveLength(21);
    expect(onRankThree.slice(0, 3)).toEqual(K('3,3,3,3,4,4,4,4 3,3,4,4,4,4,5,5 3,3,4,4,4,4,15,15'));
    expect(onRankThree[10]).toBe('3,3,3,3,5,5,5,5');
    expect(onRankThree[20]).toBe('5,5,5,5,15,15,17,17');
    const onAirplaneSingles = plain(findPlays(hand, combo('3 3 3 4 4 4 6 7'), RULES_4P));
    expect(onAirplaneSingles).toEqual(
      K(
        '3,3,4,4,4,5,5,5 3,4,4,4,5,5,5,15 3,4,4,4,5,5,5,16 3,4,4,4,5,5,5,17 4,4,4,5,5,5,15,15',
      ).concat(K('4,4,4,5,5,5,15,16 4,4,4,5,5,5,15,17 4,4,4,5,5,5,16,16 4,4,4,5,5,5,17,17')),
    );
  });

  it('matches the reference brute force for every lead and answer on random small hands', () => {
    const rng = seededRng('findPlays-4p-reference');
    const deck = createDeck(4);
    const pools = narrowPools(deck);
    let checked = 0;
    for (let i = 0; i < 240; i++) {
      const rules = i % 4 === 3 ? NO_TWOS_4P : RULES_4P;
      const pool = shuffle(pools[i % pools.length] as Card[], rng);
      const hand = pool.slice(0, 4 + Math.floor(rng() * 7));
      const others = pool.slice(hand.length, hand.length + 10);
      const leads = findPlays(others, null, rules);
      const currents: Array<Combo | null> = [null];
      for (let k = 0; k < 3 && leads.length > 0; k++) {
        currents.push(leads[Math.floor(rng() * leads.length)] as Combo);
      }
      for (const current of currents) {
        expectPlaysMatchReference(hand, current, rules);
        checked += findPlays(hand, current, rules).length;
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it('matches the reference brute force on hand-crafted 12-14 card hands rich in triples', () => {
    const hands = [
      '3 3 3 4 4 4 5 5 5 6 6 6 7 7',
      '3 3 3 3 4 4 4 4 5 5 5 BJ BJ RJ',
      '5 5 5 6 6 6 7 7 7 7 8 8 BJ RJ',
      'A A A 2 2 2 BJ BJ RJ RJ 3 3 4 4',
      'Q Q Q K K K A A A 2 2 2 BJ RJ',
      '3 3 3 4 4 4 5 5 5 5 5 5 6 6',
    ];
    const currents = [
      null,
      ...['3 3 3 4 4 4 6 7', '3 3 3 4 4 4 5 5 5 6 7 8', '3 3 3 4 4 4 5 5 6 6', '3 3 4 4 5 5'],
      ...[
        '3 3 3 3 4 4 5 5',
        '3 3 3 3 4 4',
        '3 3 3 4 4 4',
        '3 4 5 6 7',
        '3 3 3 4 4',
        '3 3 3 3',
        'BJ RJ',
      ],
    ].map((spec) => (spec === null ? null : combo(spec)));
    for (const spec of hands) {
      for (const rules of [RULES_4P, NO_TWOS_4P]) {
        for (const current of currents) expectPlaysMatchReference(cards(spec), current, rules);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// End to end: the state machine applies the two-deck rules
// ---------------------------------------------------------------------------

describe('applyAction in a 4-player hand', () => {
  it('accepts joker pairs on pairs, orders bombs by rank, rejects a single on a bomb', () => {
    const state = playingState({
      hands: ['2 2 5 5 5 5 9', 'BJ BJ 6', 'RJ RJ 7', '3 3 3 3 3 8'],
      landlord: 0,
    });
    const s1 = step(state, 0, play('2 2', state.hands[0]!)).state;
    const s2 = step(s1, 1, play('BJ BJ', s1.hands[1]!)).state;
    expect(shape(s2.trick.current)).toEqual(s('pair', 16, 1, 2));
    expect(rejection(applyAction(s2, 2, play('7', s2.hands[2]!)))).toBe('does_not_beat');
    const s3 = step(s2, 2, play('RJ RJ', s2.hands[2]!)).state;
    expect(shape(s3.trick.current)).toEqual(s('pair', 17, 1, 2));
    expect(rejection(applyAction(s3, 3, play('3 3 3 3 3 8', s3.hands[3]!)))).toBe('invalid_combo');
    const s4 = step(s3, 3, play('3 3 3 3', s3.hands[3]!)).state;
    expect(s4.bombsPlayed).toBe(1);
    const s5 = step(s4, 0, play('5 5 5 5', s4.hands[0]!)).state;
    expect(s5.bombsPlayed).toBe(2);
    expect(rejection(applyAction(s5, 1, play('6', s5.hands[1]!)))).toBe('does_not_beat');
    const s6 = passAll(s5, [1, 2, 3]);
    expect(s6.turn).toBe(0);
    expect(s6.trick.current).toBeNull();
  });

  it('applies the tiers: a 4-bomb cannot answer a 2-rocket, a 5-bomb can, a 2-rocket cannot re-answer', () => {
    const state = playingState({
      hands: ['BJ RJ 4', '3 3 3 3 6', '5 5 5 5 5 7', 'BJ RJ 8'],
      landlord: 0,
    });
    const s1 = step(state, 0, play('BJ RJ', state.hands[0]!)).state;
    expect(shape(s1.trick.current)).toEqual(s('rocket', 17, 1, 2));
    expect(rejection(applyAction(s1, 1, play('3 3 3 3', s1.hands[1]!)))).toBe('does_not_beat');
    const s2 = step(s1, 1, PASS).state;
    const s3 = step(s2, 2, play('5 5 5 5 5', s2.hands[2]!)).state;
    expect(shape(s3.trick.current)).toEqual(s('bomb', 5, 1, 5));
    expect(rejection(applyAction(s3, 3, play('BJ RJ', s3.hands[3]!)))).toBe('does_not_beat');
    const s4 = passAll(s3, [3, 0, 1]);
    expect(s4.turn).toBe(2);
    expect(s4.bombsPlayed).toBe(2);
  });

  it('reads an answer as the airplane form that beats the trick (two decks share the ranks)', () => {
    const state = playingState({
      hands: ['3 3 3 4 4 4 5 5 5 6 6 6', '3 3 3 4 4 4 K 9 10 J', 'K', 'A'],
      landlord: 1,
    });
    const t1 = step(state, 1, play('3 3 3 4 4 4 9 10', state.hands[1]!)).state;
    expect(shape(t1.trick.current)).toEqual(s('airplane_single', 4, 2, 8));
    expect(rejection(applyAction(t1, 2, play('K', t1.hands[2]!)))).toBe('does_not_beat');
    const t2 = passAll(t1, [2, 3]);
    const hand = t2.hands[0]!;
    expect(rejection(applyAction(t2, 0, play('3 3 3 4 4 4 5 6', hand)))).toBe('does_not_beat');
    expect(rejection(applyAction(t2, 0, play('3 3 3 4 4 4 5 5 5 6 6 6', hand)))).toBe(
      'does_not_beat',
    );
    const t3 = step(t2, 0, play('5 5 5 6 6 6 3 4', hand)).state;
    expect(shape(t3.trick.current)).toEqual(s('airplane_single', 6, 2, 8));
    expect(t3.hands[0]).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe('findPlays performance on 33-card hands', () => {
  it('enumerates every lead of random and triple-heavy 33-card hands in well under 50 ms', () => {
    const deck = createDeck(4);
    findPlays(deck.slice(0, 33), null, RULES_4P);
    const timings: number[] = [];
    for (let i = 0; i < 12; i++) {
      const hand = shuffle(deck, seededRng(`perf-4p-${i}`)).slice(0, 33);
      const start = performance.now();
      const plays = findPlays(hand, null, RULES_4P);
      timings.push(performance.now() - start);
      expect(plays.length).toBeGreaterThan(0);
    }
    timings.sort((a, b) => a - b);
    const report = timings.map((t) => t.toFixed(1)).join(' ');
    expect(timings[Math.floor(timings.length / 2)], `median of ${report}`).toBeLessThan(50);
    expect(timings[timings.length - 1], `slowest of ${report}`).toBeLessThan(150);

    const heavy = cards('3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 8 8 8 9 9 9 10 10 10 J J J Q Q Q K K K A');
    const start = performance.now();
    const plays = findPlays(heavy, null, RULES_4P);
    const elapsed = performance.now() - start;
    expect(plays.length).toBeGreaterThan(5000);
    expect(elapsed, `triple-heavy hand took ${elapsed.toFixed(1)} ms`).toBeLessThan(150);
    const answerStart = performance.now();
    findPlays(heavy, combo('3 3 3 4 4 4 5 5 5 6 7 8'), RULES_4P);
    findPlays(heavy, combo('3 3 3 4 4 4 5 5 6 6'), RULES_4P);
    expect(performance.now() - answerStart).toBeLessThan(50);
  });
});
