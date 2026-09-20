/**
 * Adversarial verification, round 1: three-player combination classification and comparison.
 * Spec: docs/RULES.md ("Combinations", "Bombs") and docs/ENGINE_API.md (combos.ts, rules.ts).
 * Failing tests document engine bugs for the fixer; passing tests are regression coverage.
 */
import { describe, expect, it } from 'vitest';

import type { Card, Combo, ComboType, RuleSettings } from '../types';
import { analyze, analyzeAs, beats, bombStrength, chainRanks, comboName } from '../combos';
import { findPlays } from '../plays';
import { createDeck, seededRng, shuffle } from '../cards';
import { DEFAULT_RULES, normalizeRules } from '../rules';
import { RULES_3P, cards, shape, withoutTwos } from '../test-helpers';

const ON = RULES_3P; // chainsThroughTwos on (the default)
const OFF = withoutTwos(RULES_3P);

interface Shape {
  type: ComboType;
  rank: number;
  length: number;
  size: number;
}

function sh(type: ComboType, rank: number, length: number, size: number): Shape {
  return { type, rank, length, size };
}

function read(spec: string, rules: RuleSettings = ON): ReturnType<typeof shape> {
  return shape(analyze(cards(spec), rules));
}

function combo(spec: string, rules: RuleSettings = ON): Combo {
  const result = analyze(cards(spec), rules);
  if (result === null) throw new Error(`"${spec}" is not a combination`);
  return result;
}

function ranksOf(set: readonly Card[]): number[] {
  return set.map((card) => card.rank);
}

function ids(set: readonly Card[]): string[] {
  return set.map((card) => card.id).sort();
}

// ---------------------------------------------------------------------------
// Independent reference classifier written straight from the RULES.md table (3 players).
// ---------------------------------------------------------------------------

const PRIORITY: Record<ComboType, number> = {
  rocket: 0,
  bomb: 1,
  airplane: 2,
  airplane_pair: 3,
  airplane_single: 4,
  single: 5,
  pair: 5,
  triple: 5,
  triple_single: 5,
  triple_pair: 5,
  straight: 5,
  pair_chain: 5,
  four_two_single: 5,
  four_two_pair: 5,
};

function refReadings(set: readonly Card[], rules: RuleSettings): Shape[] {
  const n = set.length;
  const counts = new Map<number, number>();
  for (const card of set) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  const cnt = (rank: number): number => counts.get(rank) ?? 0;
  const ranks = [...counts.keys()].sort((a, b) => a - b);
  const bothJokers = cnt(16) > 0 && cnt(17) > 0;
  const out: Shape[] = [];
  if (n === 0) return out;
  if (n === 2 && bothJokers) return [sh('rocket', 17, 1, 2)];
  if (ranks.length === 1) {
    const rank = ranks[0] as number;
    if (n === 1) out.push(sh('single', rank, 1, 1));
    if (n === 2) out.push(sh('pair', rank, 1, 2));
    if (n === 3) out.push(sh('triple', rank, 1, 3));
    if (n === 4 && rank <= 15) out.push(sh('bomb', rank, 1, 4));
    return out;
  }
  if (ranks.length === 2) {
    const [low, high] = ranks as [number, number];
    for (const [main, kicker] of [
      [low, high],
      [high, low],
    ] as Array<[number, number]>) {
      if (cnt(main) !== 3) continue;
      if (cnt(kicker) === 1) out.push(sh('triple_single', main, 1, 4));
      if (cnt(kicker) === 2) out.push(sh('triple_pair', main, 1, 5));
    }
  }
  for (const four of ranks) {
    if (cnt(four) !== 4 || four > 15 || bothJokers) continue;
    const others = ranks.filter((rank) => rank !== four);
    if (n === 6) out.push(sh('four_two_single', four, 1, 6));
    if (n === 8 && others.every((rank) => cnt(rank) % 2 === 0)) {
      out.push(sh('four_two_pair', four, 1, 8));
    }
  }
  const chain: number[] = chainRanks(rules);
  const position = (rank: number): number => chain.indexOf(rank);
  const consecutive = ranks.every(
    (rank, i) =>
      position(rank) >= 0 && (i === 0 || position(rank) === position(ranks[i - 1] as number) + 1),
  );
  const top = ranks[ranks.length - 1] as number;
  if (consecutive) {
    if (ranks.length >= 5 && ranks.every((rank) => cnt(rank) === 1)) {
      out.push(sh('straight', top, ranks.length, n));
    }
    if (ranks.length >= 3 && ranks.every((rank) => cnt(rank) === 2)) {
      out.push(sh('pair_chain', top, ranks.length, n));
    }
    if (ranks.length >= 2 && ranks.every((rank) => cnt(rank) === 3)) {
      out.push(sh('airplane', top, ranks.length, n));
    }
  }
  for (let length = 2; 3 * length < n; length++) {
    for (let start = 0; start + length <= chain.length; start++) {
      const window = chain.slice(start, start + length);
      if (!window.every((rank) => cnt(rank) === 3)) continue;
      const rest = ranks.filter((rank) => !window.includes(rank));
      if (rest.includes(16) && rest.includes(17)) continue;
      const restCards = n - 3 * length;
      const windowTop = window[window.length - 1] as number;
      if (restCards === length) out.push(sh('airplane_single', windowTop, length, n));
      if (restCards === 2 * length && rest.every((rank) => cnt(rank) % 2 === 0)) {
        out.push(sh('airplane_pair', windowTop, length, n));
      }
    }
  }
  return out;
}

function refAnalyze(set: readonly Card[], rules: RuleSettings): Shape | null {
  let best: Shape | null = null;
  for (const candidate of refReadings(set, rules)) {
    if (
      best === null ||
      PRIORITY[candidate.type] < PRIORITY[best.type] ||
      (PRIORITY[candidate.type] === PRIORITY[best.type] &&
        (candidate.length > best.length ||
          (candidate.length === best.length && candidate.rank > best.rank)))
    ) {
      best = candidate;
    }
  }
  return best;
}

function isBombLike(c: Combo): boolean {
  return c.type === 'bomb' || c.type === 'rocket';
}

/** RULES.md "Play" + "Bombs" for three players. */
function refBeats(candidate: Combo, current: Combo): boolean {
  const strength = (c: Combo): number => (c.type === 'rocket' ? 100 : c.rank);
  if (isBombLike(candidate) && isBombLike(current)) return strength(candidate) > strength(current);
  if (isBombLike(candidate)) return true;
  if (isBombLike(current)) return false;
  return (
    candidate.type === current.type &&
    candidate.length === current.length &&
    candidate.rank > current.rank
  );
}

// ---------------------------------------------------------------------------
// The combinations table, row by row
// ---------------------------------------------------------------------------

describe('combination table (3 players, chains through twos on)', () => {
  const rows: Array<[string, Shape | null]> = [
    ['7', sh('single', 7, 1, 1)],
    ['RJ', sh('single', 17, 1, 1)],
    ['9 9', sh('pair', 9, 1, 2)],
    ['BJ RJ', sh('rocket', 17, 1, 2)],
    ['Q Q Q', sh('triple', 12, 1, 3)],
    ['Q Q Q 3', sh('triple_single', 12, 1, 4)],
    ['2 2 2 RJ', sh('triple_single', 15, 1, 4)],
    ['Q Q Q 3 3', sh('triple_pair', 12, 1, 5)],
    ['Q Q Q 2 2', sh('triple_pair', 12, 1, 5)],
    ['Q Q Q BJ RJ', null],
    ['Q Q Q Q 3', null],
    ['3 4 5 6 7', sh('straight', 7, 5, 5)],
    ['3 4 5 6', null],
    ['3 3 4 4 5 5', sh('pair_chain', 5, 3, 6)],
    ['3 3 4 4', null],
    ['3 3 3 4 4 4', sh('airplane', 4, 2, 6)],
    ['3 3 3 4 4 4 5 6', sh('airplane_single', 4, 2, 8)],
    ['3 3 3 4 4 4 5 5', sh('airplane_single', 4, 2, 8)],
    ['3 3 3 4 4 4 5', null],
    ['3 3 3 4 4 4 5 6 7', null],
    ['3 3 3 4 4 4 5 5 6 6', sh('airplane_pair', 4, 2, 10)],
    ['3 3 3 4 4 4 5 5 5 6 6 7 7 8 8', sh('airplane_pair', 5, 3, 15)],
    ['6 6 6 6 3 4', sh('four_two_single', 6, 1, 6)],
    ['6 6 6 6 3 3', sh('four_two_single', 6, 1, 6)],
    ['6 6 6 6 RJ 3', sh('four_two_single', 6, 1, 6)],
    ['6 6 6 6 3 3 4 4', sh('four_two_pair', 6, 1, 8)],
    ['6 6 6 6 3 3 4 5', null],
    ['6 6 6 6', sh('bomb', 6, 1, 4)],
    ['2 2 2 2', sh('bomb', 15, 1, 4)],
    ['6 6 6 6 3', null],
    ['', null],
  ];
  for (const [spec, expected] of rows) {
    it(`reads "${spec || '(no cards)'}" as ${expected?.type ?? 'not a combination'}`, () => {
      expect(read(spec)).toEqual(expected);
    });
  }

  it('returns exactly the input cards with the main cards first and kickers last', () => {
    for (const [spec, expectedRanks] of [
      ['3 5 5 5', [5, 5, 5, 3]],
      ['A A 5 5 5', [5, 5, 5, 14, 14]],
      ['5 3 3 3 4 4 4 6', [4, 4, 4, 3, 3, 3, 6, 5]],
      ['4 5 3 3 3 3', [3, 3, 3, 3, 5, 4]],
      ['5 3 4 7 6', [7, 6, 5, 4, 3]],
      ['BJ RJ', [17, 16]],
    ] as Array<[string, number[]]>) {
      const set = cards(spec);
      const result = combo(spec);
      expect(ranksOf(result.cards), spec).toEqual(expectedRanks);
      expect(ids(result.cards), spec).toEqual(ids(set));
    }
  });
});

// ---------------------------------------------------------------------------
// Chains with the option on and off
// ---------------------------------------------------------------------------

describe('chains through twos and jokers', () => {
  it('chainRanks stops at A when off and runs to the red joker when on', () => {
    expect(chainRanks(OFF)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(chainRanks(ON)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('J Q K A 2 is a straight only when the option is on', () => {
    expect(read('J Q K A 2', ON)).toEqual(sh('straight', 15, 5, 5));
    expect(read('J Q K A 2', OFF)).toBeNull();
  });

  it('10 J Q K A is a straight either way', () => {
    expect(read('10 J Q K A', ON)).toEqual(sh('straight', 14, 5, 5));
    expect(read('10 J Q K A', OFF)).toEqual(sh('straight', 14, 5, 5));
  });

  it('K A 2 BJ RJ is a straight only when the option is on', () => {
    expect(read('K A 2 BJ RJ', ON)).toEqual(sh('straight', 17, 5, 5));
    expect(read('K A 2 BJ RJ', OFF)).toBeNull();
    expect(read('10 J Q K A 2 BJ RJ', ON)).toEqual(sh('straight', 17, 8, 8));
  });

  it('A 2 3 4 5 is never a straight', () => {
    expect(read('A 2 3 4 5', ON)).toBeNull();
    expect(read('A 2 3 4 5', OFF)).toBeNull();
  });

  it('never wraps around from the red joker (or the ace) back to 3', () => {
    for (const spec of ['2 BJ RJ 3 4', 'RJ 3 4 5 6', 'Q K A 2 3', 'BJ RJ 3 4 5', 'A A 2 2 3 3']) {
      expect(read(spec, ON), spec).toBeNull();
    }
    for (const spec of ['K A 3 4 5', 'Q K A 3 4', 'A A 3 3 4 4', 'A A A 3 3 3']) {
      expect(read(spec, OFF), spec).toBeNull();
    }
    expect(read('2 2 3 3 4 4', ON)).toBeNull();
    expect(read('2 2 2 3 3 3', ON)).toBeNull();
  });

  it('pair chains and airplanes follow the same option', () => {
    expect(read('K K A A 2 2', ON)).toEqual(sh('pair_chain', 15, 3, 6));
    expect(read('K K A A 2 2', OFF)).toBeNull();
    expect(read('Q Q K K A A', OFF)).toEqual(sh('pair_chain', 14, 3, 6));
    expect(read('A A A 2 2 2', ON)).toEqual(sh('airplane', 15, 2, 6));
    expect(read('A A A 2 2 2', OFF)).toBeNull();
    expect(read('K K K A A A', OFF)).toEqual(sh('airplane', 14, 2, 6));
    expect(read('A A 2 2 BJ RJ', ON)).toBeNull();
  });

  it('allows the longest straight the option permits', () => {
    expect(read('3 4 5 6 7 8 9 10 J Q K A', OFF)).toEqual(sh('straight', 14, 12, 12));
    expect(read('3 4 5 6 7 8 9 10 J Q K A 2', OFF)).toBeNull();
    expect(read('3 4 5 6 7 8 9 10 J Q K A 2 BJ RJ', ON)).toEqual(sh('straight', 17, 15, 15));
  });

  it('still allows 2s and jokers as kickers when chains stop at the ace', () => {
    expect(read('K K K A A A 2 BJ', OFF)).toEqual(sh('airplane_single', 14, 2, 8));
    expect(read('K K K A A A 2 2 BJ RJ', OFF)).toBeNull();
    expect(read('K K K A A A 2 2 BJ BJ', OFF)).toEqual(sh('airplane_pair', 14, 2, 10));
    expect(read('K K K 2 2', OFF)).toEqual(sh('triple_pair', 13, 1, 5));
  });
});

// ---------------------------------------------------------------------------
// Kickers
// ---------------------------------------------------------------------------

describe('kicker rules', () => {
  it('never lets a red joker and a black joker be kickers together', () => {
    for (const spec of [
      'Q Q Q BJ RJ',
      '6 6 6 6 BJ RJ',
      'Q Q Q K K K BJ RJ',
      'J J J Q Q Q K K K BJ RJ 3',
      '2 2 2 2 BJ RJ',
    ]) {
      expect(read(spec), spec).toBeNull();
    }
  });

  it('lets a single joker be a kicker anywhere a single is allowed', () => {
    expect(read('Q Q Q BJ')).toEqual(sh('triple_single', 12, 1, 4));
    expect(read('Q Q Q K K K BJ 3')).toEqual(sh('airplane_single', 13, 2, 8));
    expect(read('Q Q Q K K K RJ 2')).toEqual(sh('airplane_single', 13, 2, 8));
    expect(read('6 6 6 6 RJ 3')).toEqual(sh('four_two_single', 6, 1, 6));
    expect(read('6 6 6 6 BJ 2')).toEqual(sh('four_two_single', 6, 1, 6));
    expect(read('A A A 2 2 2 BJ 3')).toEqual(sh('airplane_single', 15, 2, 8));
  });

  it('never affects the comparison', () => {
    expect(beats(combo('4 4 4 3'), combo('3 3 3 RJ'), ON)).toBe(true);
    expect(beats(combo('3 3 3 RJ'), combo('4 4 4 3'), ON)).toBe(false);
    expect(beats(combo('4 4 4 3 3'), combo('3 3 3 2 2'), ON)).toBe(true);
    expect(beats(combo('4 4 4 4 3 5'), combo('3 3 3 3 2 RJ'), ON)).toBe(true);
    expect(beats(combo('4 4 4 4 3 3 5 5'), combo('3 3 3 3 A A 2 2'), ON)).toBe(true);
    expect(beats(combo('4 4 4 5 5 5 3 6'), combo('3 3 3 4 4 4 2 RJ'), ON)).toBe(true);
    expect(beats(combo('4 4 4 5 5 5 3 3 6 6'), combo('3 3 3 4 4 4 A A 2 2'), ON)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Airplane ambiguity and analyzeAs
// ---------------------------------------------------------------------------

describe('airplane ambiguity resolution and analyzeAs', () => {
  const FOUR_TRIPLES = '3 3 3 4 4 4 5 5 5 6 6 6';

  it('reads 333 444 555 666 as the longest plain airplane when leading', () => {
    expect(read(FOUR_TRIPLES)).toEqual(sh('airplane', 6, 4, 12));
  });

  it('answers an airplane + singles of length 3 with 333 444 555 666 using 333 as kickers', () => {
    const target = combo('4 4 4 5 5 5 6 6 6 3 7 8');
    expect(shape(target)).toEqual(sh('airplane_single', 6, 3, 12));
    const answer = analyzeAs(cards(FOUR_TRIPLES), ON, target);
    expect(shape(answer)).toEqual(sh('airplane_single', 6, 3, 12));
    expect(ranksOf(answer!.cards)).toEqual([6, 6, 6, 5, 5, 5, 4, 4, 4, 3, 3, 3]);
    expect(beats(answer!, combo('3 3 3 4 4 4 5 5 5 6 7 8'), ON)).toBe(true);
  });

  it('answers a plain airplane of length 4 with the plain reading', () => {
    const target = combo('7 7 7 8 8 8 9 9 9 10 10 10');
    expect(shape(analyzeAs(cards(FOUR_TRIPLES), ON, target))).toEqual(sh('airplane', 6, 4, 12));
  });

  it('picks the highest-ranked reading that matches the target type and length', () => {
    const target = combo('3 3 3 4 4 4 5 5 5 6 6 6 7 8 9 10');
    expect(shape(target)).toEqual(sh('airplane_single', 6, 4, 16));
    const answer = analyzeAs(cards('3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 8'), ON, target);
    expect(shape(answer)).toEqual(sh('airplane_single', 7, 4, 16));
    expect(
      ranksOf(answer!.cards)
        .slice(12)
        .sort((a, b) => a - b),
    ).toEqual([3, 3, 3, 8]);
  });

  it('falls back to analyze when no reading matches the target', () => {
    const shortAirplane = combo('3 3 3 4 4 4 5 6');
    expect(shape(analyzeAs(cards(FOUR_TRIPLES), ON, shortAirplane))).toEqual(
      sh('airplane', 6, 4, 12),
    );
    expect(shape(analyzeAs(cards('9 9 9 9'), ON, shortAirplane))).toEqual(sh('bomb', 9, 1, 4));
    expect(shape(analyzeAs(cards('BJ RJ'), ON, shortAirplane))).toEqual(sh('rocket', 17, 1, 2));
    expect(analyzeAs(cards('3 4'), ON, shortAirplane)).toBeNull();
    expect(analyzeAs(cards('3 3 3 4 4 4 BJ RJ'), ON, shortAirplane)).toBeNull();
  });

  it('prefers airplane + pairs over airplane + singles and singles-as-pairs stays singles', () => {
    expect(read('3 3 3 4 4 4 5 5 5 6 6 6 7 7 8 8 9 9 10 10')).toEqual(
      sh('airplane_pair', 6, 4, 20),
    );
    expect(read('3 3 3 4 4 4 5 5 5 6 6 6 7 7 8 8')).toEqual(sh('airplane_single', 6, 4, 16));
    expect(read('3 3 3 4 4 4 5 5 5 5')).toEqual(sh('airplane_pair', 4, 2, 10));
  });

  it('analyzeAs picks the highest four when four + two pairs can be read two ways', () => {
    const target = combo('5 5 5 5 6 6 7 7');
    expect(shape(analyzeAs(cards('3 3 3 3 4 4 4 4'), ON, target))).toEqual(
      sh('four_two_pair', 4, 1, 8),
    );
    expect(shape(analyzeAs(cards('3 3 3 3 8 8 8 8'), ON, target))).toEqual(
      sh('four_two_pair', 8, 1, 8),
    );
  });
});

// ---------------------------------------------------------------------------
// beats(): the full type / length / rank matrix against the reference
// ---------------------------------------------------------------------------

describe('beats', () => {
  const catalogue: Combo[] =
    `3 | K | 2 | BJ | RJ | 3 3 | 2 2 | 3 3 3 | A A A | 3 3 3 4 | A A A 3 | 3 3 3 4 4 | A A A 3 3 | 3 4 5 6 7 | 4 5 6 7 8 | 3 4 5 6 7 8 | J Q K A 2 | K A 2 BJ RJ | 3 3 4 4 5 5 | 4 4 5 5 6 6 | 3 3 4 4 5 5 6 6 | 3 3 3 4 4 4 | 4 4 4 5 5 5 | 3 3 3 4 4 4 5 5 5 | 3 3 3 4 4 4 5 6 | 4 4 4 5 5 5 3 6 | 3 3 3 4 4 4 5 5 5 6 7 8 | 3 3 3 4 4 4 5 5 6 6 | 4 4 4 5 5 5 3 3 6 6 | 3 3 3 3 4 5 | 4 4 4 4 3 5 | 3 3 3 3 4 4 5 5 | 4 4 4 4 3 3 5 5 | 3 3 3 3 | 4 4 4 4 | 2 2 2 2 | BJ RJ`
      .split(' | ')
      .map((spec) => combo(spec));

  it('agrees with the RULES.md comparison on every ordered pair of the catalogue', () => {
    const disagreements: string[] = [];
    for (const candidate of catalogue) {
      for (const current of catalogue) {
        if (beats(candidate, current, ON) !== refBeats(candidate, current)) {
          disagreements.push(
            `${comboName(candidate)} [${ranksOf(candidate.cards)}] on ${comboName(current)} [${ranksOf(current.cards)}]`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('never lets chains of different lengths beat each other', () => {
    expect(beats(combo('3 4 5 6 7 8'), combo('3 4 5 6 7'), ON)).toBe(false);
    expect(beats(combo('4 5 6 7 8'), combo('3 4 5 6 7 8'), ON)).toBe(false);
    expect(beats(combo('4 4 5 5 6 6 7 7'), combo('3 3 4 4 5 5'), ON)).toBe(false);
    expect(beats(combo('4 4 4 5 5 5 6 6 6'), combo('3 3 3 4 4 4'), ON)).toBe(false);
    expect(beats(combo('4 4 4 5 5 5 6 6 6 3 7 8'), combo('3 3 3 4 4 4 5 6'), ON)).toBe(false);
    expect(beats(combo('4 4 4 5 5 5 6 6 6 3 3 7 7 8 8'), combo('3 3 3 4 4 4 5 5 6 6'), ON)).toBe(
      false,
    );
  });

  it('lets a bomb beat every non-bomb whatever the ranks, and the rocket beat every bomb', () => {
    const nonBombs = catalogue.filter((c) => !isBombLike(c));
    const bomb3 = combo('3 3 3 3');
    const bomb2 = combo('2 2 2 2');
    const rocket = combo('BJ RJ');
    for (const current of nonBombs) {
      expect(beats(bomb3, current, ON), comboName(current)).toBe(true);
      expect(beats(rocket, current, ON), comboName(current)).toBe(true);
      expect(beats(current, bomb3, ON), comboName(current)).toBe(false);
      expect(beats(current, rocket, ON), comboName(current)).toBe(false);
    }
    expect(beats(bomb2, bomb3, ON)).toBe(true);
    expect(beats(bomb3, bomb2, ON)).toBe(false);
    expect(beats(bomb3, bomb3, ON)).toBe(false);
    expect(beats(rocket, bomb2, ON)).toBe(true);
    expect(beats(bomb2, rocket, ON)).toBe(false);
    expect(beats(rocket, rocket, ON)).toBe(false);
    expect(bombStrength(rocket, ON)).toBeGreaterThan(bombStrength(bomb2, ON));
    expect(bombStrength(bomb2, ON)).toBeGreaterThan(bombStrength(bomb3, ON));
    expect(bombStrength(combo('2'), ON)).toBe(0);
  });

  it('treats four + two as an ordinary combination, not a bomb', () => {
    expect(beats(combo('2 2 2 2 3 4'), combo('3 3 3 3'), ON)).toBe(false);
    expect(beats(combo('2 2 2 2 3 4'), combo('3'), ON)).toBe(false);
    expect(beats(combo('3 3 3 3'), combo('2 2 2 2 3 4'), ON)).toBe(true);
    expect(beats(combo('4 4 4 4 3 5'), combo('3 3 3 3 A 2'), ON)).toBe(true);
    expect(beats(combo('4 4 4 4 3 3 5 5'), combo('3 3 3 3 A 2'), ON)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// comboName
// ---------------------------------------------------------------------------

describe('comboName', () => {
  it('uses the display names ENGINE_API.md documents for its examples', () => {
    expect(comboName(combo('3 3 3 3'))).toBe('Bomb');
    expect(comboName(combo('BJ RJ'))).toBe('Rocket');
    expect(comboName(combo('3 3 3 4 4 4 5 5 6 6'))).toBe('Airplane + pairs');
    expect(comboName(combo('3 4 5 6 7'))).toBe('Straight of 5');
  });
});

// ---------------------------------------------------------------------------
// normalizeRules on garbage
// ---------------------------------------------------------------------------

describe('normalizeRules on garbage', () => {
  it('returns the defaults for null, strings, numbers and arrays', () => {
    for (const garbage of [null, undefined, 'call', '', 0, -1, [], [3], true]) {
      expect(normalizeRules(garbage), String(garbage)).toEqual(DEFAULT_RULES);
    }
  });

  it('falls back per field for wrong types and out-of-range values', () => {
    const normalized = normalizeRules({
      playerCount: 5,
      kittySize: 5,
      biddingMode: 'CALL',
      allPass: -1,
      doublingRound: 'true',
      kittyBonus: 1,
      firstBidder: null,
      chainsThroughTwos: 'no',
      turnSeconds: '60',
      extra: 'ignored',
    });
    expect(normalized).toEqual(DEFAULT_RULES);
    expect(Object.keys(normalized).sort()).toEqual(Object.keys(DEFAULT_RULES).sort());
    expect(normalizeRules({ playerCount: -3 }).playerCount).toBe(3);
    expect(normalizeRules({ playerCount: '4' }).playerCount).toBe(3);
    expect(normalizeRules({ playerCount: 4 }).playerCount).toBe(4);
  });

  it('snaps the kitty size to a valid option and clamps turnSeconds to 5..120', () => {
    const kitty: Array<[unknown, number]> = [
      [{ kittySize: 5 }, 3],
      [{ kittySize: -3 }, 3],
      [{ kittySize: Number.NaN }, 3],
      [{ kittySize: 12 }, 12],
      [{ kittySize: 8 }, 3],
      [{ playerCount: 4, kittySize: 5 }, 8],
      [{ playerCount: 4, kittySize: 3 }, 8],
      [{ playerCount: 4, kittySize: 4 }, 4],
      [{ playerCount: 5, kittySize: 16 }, 3],
    ];
    for (const [input, expected] of kitty) {
      expect(normalizeRules(input).kittySize, JSON.stringify(input)).toBe(expected);
    }
    const seconds: Array<[unknown, number]> = [
      [-30, 5],
      [0, 5],
      [121, 120],
      [90, 90],
      ['90', 30],
      [null, 30],
    ];
    for (const [turnSeconds, expected] of seconds) {
      expect(normalizeRules({ turnSeconds }).turnSeconds, String(turnSeconds)).toBe(expected);
    }
  });

  it('never throws and never returns a shared object', () => {
    const thrower = (): never => {
      throw new Error('boom');
    };
    const hostile = new Proxy({}, { get: thrower });
    expect(() => normalizeRules(hostile)).not.toThrow();
    expect(normalizeRules(hostile)).toEqual(DEFAULT_RULES);
    expect(normalizeRules(null)).not.toBe(DEFAULT_RULES);
  });
});

// ---------------------------------------------------------------------------
// Cross-check against the independent classifier on generated sets
// ---------------------------------------------------------------------------

describe('analyze against an independent RULES.md classifier', () => {
  const deck = createDeck(3);

  function check(set: Card[], rules: RuleSettings, mismatches: string[]): void {
    const engine = analyze(set, rules);
    const expected = refAnalyze(set, rules);
    const label = `${rules.chainsThroughTwos ? 'on' : 'off'} [${ranksOf(set).sort((a, b) => a - b)}]`;
    if (JSON.stringify(shape(engine)) !== JSON.stringify(expected)) {
      mismatches.push(
        `${label}: engine ${JSON.stringify(shape(engine))} vs ${JSON.stringify(expected)}`,
      );
    } else if (engine !== null) {
      if (ids(engine.cards).join() !== ids(set).join()) mismatches.push(`${label}: cards changed`);
      const size = engine.type === 'rocket' ? 2 : engine.type === 'bomb' ? 4 : engine.cards.length;
      if (engine.size !== size) mismatches.push(`${label}: size ${engine.size} != ${size}`);
    }
  }

  it('agrees on every leadable combination of random 17-card hands and on near misses', () => {
    const rng = seededRng('verify-combos-3p-round-1');
    const mismatches: string[] = [];
    let checked = 0;
    for (let i = 0; i < 40; i++) {
      const hand = shuffle(deck, rng).slice(0, 17);
      for (const rules of [ON, OFF]) {
        for (const play of findPlays(hand, null, rules)) {
          check(play.cards, rules, mismatches);
          const rest = deck.filter((card) => !play.cards.some((mine) => mine.id === card.id));
          const mutated = play.cards.slice();
          mutated[Math.floor(rng() * mutated.length)] = rest[
            Math.floor(rng() * rest.length)
          ] as Card;
          check(mutated, rules, mismatches);
          check([...play.cards, rest[Math.floor(rng() * rest.length)] as Card], rules, mismatches);
          checked += 3;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(mismatches).toEqual([]);
  });

  it('agrees on random subsets of the deck', () => {
    const rng = seededRng('verify-combos-3p-random-subsets');
    const mismatches: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const size = 1 + Math.floor(rng() * 10);
      check(shuffle(deck, rng).slice(0, size), ON, mismatches);
    }
    expect(mismatches).toEqual([]);
  });

  it('every answer findPlays offers re-reads through analyzeAs as itself and beats the target', () => {
    const rng = seededRng('verify-combos-3p-answers');
    const problems: string[] = [];
    for (let i = 0; i < 60; i++) {
      const shuffled = shuffle(deck, rng);
      const leads = findPlays(shuffled.slice(0, 17), null, ON);
      const target = leads[Math.floor(rng() * leads.length)];
      if (target === undefined) continue;
      for (const answer of findPlays(shuffled.slice(17, 37), target, ON)) {
        const reread = analyzeAs(answer.cards, ON, target);
        const label = `${comboName(target)} [${ranksOf(target.cards)}] <- [${ranksOf(answer.cards)}]`;
        if (JSON.stringify(shape(reread)) !== JSON.stringify(shape(answer))) {
          problems.push(`${label}: re-read as ${JSON.stringify(shape(reread))}`);
        } else if (!beats(reread as Combo, target, ON)) {
          problems.push(`${label}: does not beat`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
