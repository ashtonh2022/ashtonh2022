/**
 * Adversarial verification, round 1: three-player combination classification and comparison.
 * Spec: docs/RULES.md ("Combinations", "Bombs") and docs/ENGINE_API.md (combos.ts, rules.ts).
 * Failing tests document engine bugs for the fixer; passing tests are regression coverage.
 */
import { describe, expect, it } from 'vitest';

import type { Card, Combo, ComboType, RuleSettings } from '../types';
import { analyze, analyzeAs, beats, bombStrength, chainRanks, comboName } from '../combos';
import { decompose, findPlays, hint, lowestSingle } from '../plays';
import { createDeck, seededRng, shuffle } from '../cards';
import { DEFAULT_RULES, normalizeRules } from '../rules';
import { RULES_3P, cards, key, shape, withoutTwos } from '../test-helpers';

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

// ---------------------------------------------------------------------------
// Round 2: what the first pass did not look at. Kicker corner cases, the longest chains, the
// bomb/four+two boundary, analyzeAs against bombs, every display name, decompose/hint/findPlays
// with bombs and rockets, and brute force over full 17- and 20-card three-player hands.
// ---------------------------------------------------------------------------

describe('round 2', () => {
  const deck = createDeck(3);

  /** ranks of a combo's cards, ascending (its rank-structure identity) */
  const ranksAsc = (c: Combo): number[] => ranksOf(c.cards).sort((a, b) => a - b);

  const sig = (c: Combo | null): string => JSON.stringify(shape(c));

  /**
   * Visits one subset of `hand` per distinct rank structure (the first k cards of every rank),
   * optionally only those whose size is in `sizes`. That is the identity findPlays deduplicates by.
   */
  function forEachStructure(hand: Card[], sizes: number[] | null, visit: (subset: Card[]) => void) {
    const byRank = new Map<number, Card[]>();
    for (const card of hand) byRank.set(card.rank, [...(byRank.get(card.rank) ?? []), card]);
    const buckets = [...byRank.values()];
    const largest = sizes === null ? hand.length : Math.max(...sizes);
    const chosen: Card[] = [];
    const recurse = (index: number): void => {
      if (index === buckets.length) {
        if (chosen.length > 0 && (sizes === null || sizes.includes(chosen.length))) {
          visit(chosen.slice());
        }
        return;
      }
      const bucket = buckets[index] as Card[];
      for (let take = 0; take <= bucket.length; take++) {
        if (chosen.length + take > largest) break;
        chosen.push(...bucket.slice(0, take));
        recurse(index + 1);
        chosen.length -= take;
      }
    };
    recurse(0);
  }

  /** Every legal play of `hand` on `current` by rank key, through analyze / analyzeAs + beats. */
  function bruteForce(
    hand: Card[],
    current: Combo | null,
    rules: RuleSettings,
  ): Map<string, Combo> {
    const out = new Map<string, Combo>();
    // an answer has the current's size, or is a bomb (4 cards) or the rocket (2 cards)
    forEachStructure(hand, current === null ? null : [current.cards.length, 4, 2], (subset) => {
      const c = current === null ? analyze(subset, rules) : analyzeAs(subset, rules, current);
      if (c === null || (current !== null && !beats(c, current, rules))) return;
      out.set(key(subset), c);
    });
    return out;
  }

  function comparePlays(hand: Card[], current: Combo | null, rules: RuleSettings): string[] {
    const label = `[${key(hand)}] on ${current === null ? 'lead' : `${comboName(current)} ${sig(current)}`} (twos ${rules.chainsThroughTwos ? 'on' : 'off'})`;
    const problems: string[] = [];
    const plays = findPlays(hand, current, rules);
    const expected = bruteForce(hand, current, rules);
    const keys = plays.map((play) => key(play.cards));
    if (new Set(keys).size !== keys.length) problems.push(`${label}: duplicate rank structures`);
    for (const k of expected.keys()) {
      if (!keys.includes(k))
        problems.push(`${label}: findPlays misses [${k}] ${sig(expected.get(k) ?? null)}`);
    }
    const handIds = new Set(ids(hand));
    let lastRank = 0;
    let lastBomb = 0;
    let seenBomb = false;
    for (const play of plays) {
      const at = `${label}: ${comboName(play)} [${key(play.cards)}]`;
      const want = expected.get(key(play.cards));
      if (want === undefined) problems.push(`${at} is not a legal play`);
      else if (sig(want) !== sig(play))
        problems.push(`${at} reads as ${sig(want)} not ${sig(play)}`);
      if (new Set(ids(play.cards)).size !== play.cards.length)
        problems.push(`${at} repeats a card`);
      if (!play.cards.every((card) => handIds.has(card.id))) problems.push(`${at} not in hand`);
      if (isBombLike(play)) {
        const strength = bombStrength(play, rules);
        if (strength < lastBomb) problems.push(`${at} bombs not weakest first`);
        lastBomb = strength;
        seenBomb = true;
      } else {
        if (seenBomb) problems.push(`${at} listed after a bomb`);
        if (current !== null && play.rank < lastRank) problems.push(`${at} not weakest first`);
        lastRank = play.rank;
      }
    }
    return problems;
  }

  const randomHand = (rng: () => number, size: number): Card[] => shuffle(deck, rng).slice(0, size);

  /** A hand rich in consecutive triples and fours, so airplanes, kickers and bombs come up. */
  function clumpy(rng: () => number, size: number): Card[] {
    const byRank = new Map<number, Card[]>();
    for (const card of deck) byRank.set(card.rank, [...(byRank.get(card.rank) ?? []), card]);
    const pool: Card[] = [];
    const start = 3 + Math.floor(rng() * 10);
    const span = 2 + Math.floor(rng() * 4);
    for (let rank = start; rank < start + span; rank++) {
      const roll = rng();
      const count = roll < 0.15 ? 2 : roll < 0.75 ? 3 : 4;
      pool.push(...shuffle(byRank.get(rank) ?? [], rng).slice(0, count));
    }
    const taken = new Set(ids(pool));
    const rest = shuffle(
      deck.filter((card) => !taken.has(card.id)),
      rng,
    );
    return shuffle([...pool, ...rest].slice(0, size), rng);
  }

  // ---- classification corner cases ---------------------------------------------------------

  describe('kicker corner cases the table implies', () => {
    it('reads four + two singles whose kickers are a pair of another rank, kickers last', () => {
      expect(read('6 6 6 6 3 3')).toEqual(sh('four_two_single', 6, 1, 6));
      expect(read('6 6 6 6 2 2')).toEqual(sh('four_two_single', 6, 1, 6));
      expect(ranksOf(combo('3 3 6 6 6 6').cards)).toEqual([6, 6, 6, 6, 3, 3]);
      expect(ranksOf(combo('3 6 6 RJ 6 6').cards)).toEqual([6, 6, 6, 6, 17, 3]);
    });

    it('never reads four + two singles as four + two pairs when answering pairs', () => {
      const target = combo('5 5 5 5 3 3 4 4');
      const answer = analyzeAs(cards('6 6 6 6 3 3'), ON, target);
      expect(shape(answer)).toEqual(sh('four_two_single', 6, 1, 6));
      expect(beats(answer as Combo, target, ON)).toBe(false);
    });

    it('never reads a triple with two singles of different ranks as triple + pair', () => {
      expect(read('3 3 3 4 5')).toBeNull();
      expect(read('3 3 3 A 2')).toBeNull();
      expect(read('2 2 2 BJ 3')).toBeNull();
      expect(analyzeAs(cards('3 3 3 4 5'), ON, combo('2 2 2 6 6'))).toBeNull();
      expect(analyzeAs(cards('3 3 3 4 5'), ON, combo('2 2 2 6'))).toBeNull();
    });

    it('never lets a kicker share a rank with one of the triples or the four', () => {
      for (const spec of [
        '3 3 3 4 4 4 3 3 5 5',
        '3 3 3 4 4 4 4 4 5 5',
        '3 3 3 4 4 4 4 5',
        '3 3 3 3 4 4 4 5 5',
        '3 3 3 4 4 4 5 5 5 5 6 6',
        '3 3 3 3 4 4 4 4 5 5 5 5 6 6 6 6',
        '3 3 3 3 4 4 4 4 5 5 5 5',
        '6 6 6 6 6 3',
        '6 6 6 6 6 6 3 3',
      ]) {
        expect(read(spec), spec).toBeNull();
      }
    });

    it('tells airplanes of length 2 apart from triples with kickers card by card', () => {
      const rows: Array<[string, Shape | null]> = [
        ['3 3 3 4 4 4', sh('airplane', 4, 2, 6)],
        ['3 3 3 4 4 4 5', null],
        ['3 3 3 4 4 4 5 6', sh('airplane_single', 4, 2, 8)],
        ['3 3 3 4 4 4 5 5', sh('airplane_single', 4, 2, 8)],
        ['3 3 3 4 4 4 7 7', sh('airplane_single', 4, 2, 8)],
        ['3 3 3 4 4 4 5 5 6', null],
        ['3 3 3 4 4 4 5 6 7', null],
        ['3 3 3 4 4 4 5 5 6 6', sh('airplane_pair', 4, 2, 10)],
        ['3 3 3 4 4 4 5 5 6 6 7', null],
        ['3 3 3 4 4 4 5 5 5 6 7 8', sh('airplane_single', 5, 3, 12)],
        ['3 3 3 4 4 4 5 5 5 6 6 7 7 8', null],
        ['3 3 3 4 4 4 5 5 5 6 6 7 7 8 8', sh('airplane_pair', 5, 3, 15)],
        ['3 3 3 4 4 4 5 5 5 6', null],
        ['3 3 3 4 4 4 7 7 7', null],
        ['3 3 3 5 5 5', null],
        ['3 3 3 5 5 5 4 6', null],
        ['3 3 3 5 5 5 6 6', null],
        ['3 3 3 4 4 4 5 5 5 5', sh('airplane_pair', 4, 2, 10)],
        ['3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 7', sh('airplane_single', 6, 4, 16)],
      ];
      for (const [spec, expected] of rows) expect(read(spec), spec).toEqual(expected);
    });

    it('puts the kickers of an airplane last, highest kicker first', () => {
      expect(ranksOf(combo('5 3 3 3 4 4 4 6').cards)).toEqual([4, 4, 4, 3, 3, 3, 6, 5]);
      expect(ranksOf(combo('6 6 3 3 3 4 4 4 5 5').cards)).toEqual([4, 4, 4, 3, 3, 3, 6, 6, 5, 5]);
      expect(ranksOf(combo('RJ 3 3 3 4 4 4 2').cards)).toEqual([4, 4, 4, 3, 3, 3, 17, 15]);
    });
  });

  describe('the longest chains', () => {
    const run = (from: number, to: number, copies: number): string =>
      Array.from({ length: to - from + 1 }, (_, i) => {
        const label = [
          '3',
          '4',
          '5',
          '6',
          '7',
          '8',
          '9',
          '10',
          'J',
          'Q',
          'K',
          'A',
          '2',
          'BJ',
          'RJ',
        ][from + i - 3] as string;
        return Array.from({ length: copies }, () => label).join(' ');
      }).join(' ');

    it('reads straights of 12 (3..A) with the option on or off, 13, 14 and 15 only when on', () => {
      expect(read(run(3, 14, 1), ON)).toEqual(sh('straight', 14, 12, 12));
      expect(read(run(3, 14, 1), OFF)).toEqual(sh('straight', 14, 12, 12));
      expect(read(run(3, 15, 1), ON)).toEqual(sh('straight', 15, 13, 13));
      expect(read(run(3, 15, 1), OFF)).toBeNull();
      expect(read(run(3, 16, 1), ON)).toEqual(sh('straight', 16, 14, 14));
      expect(read(run(3, 16, 1), OFF)).toBeNull();
      expect(read(run(3, 17, 1), ON)).toEqual(sh('straight', 17, 15, 15));
      expect(read(run(3, 17, 1), OFF)).toBeNull();
      expect(read(run(4, 17, 1), ON)).toEqual(sh('straight', 17, 14, 14));
      expect(read(run(4, 15, 1), OFF)).toBeNull();
      expect(read(run(4, 14, 1), OFF)).toEqual(sh('straight', 14, 11, 11));
    });

    it('reads pair chains of 12 (3..A) either way and 13 (3..2) only when on', () => {
      expect(read(run(3, 14, 2), ON)).toEqual(sh('pair_chain', 14, 12, 24));
      expect(read(run(3, 14, 2), OFF)).toEqual(sh('pair_chain', 14, 12, 24));
      expect(read(run(3, 15, 2), ON)).toEqual(sh('pair_chain', 15, 13, 26));
      expect(read(run(3, 15, 2), OFF)).toBeNull();
      expect(read(run(4, 15, 2), ON)).toEqual(sh('pair_chain', 15, 12, 24));
      expect(read(run(4, 15, 2), OFF)).toBeNull();
      expect(read(run(4, 14, 2), OFF)).toEqual(sh('pair_chain', 14, 11, 22));
    });

    it('reads airplanes of 12 (3..A) either way and 13 (3..2) only when on', () => {
      expect(read(run(3, 14, 3), ON)).toEqual(sh('airplane', 14, 12, 36));
      expect(read(run(3, 14, 3), OFF)).toEqual(sh('airplane', 14, 12, 36));
      expect(read(run(3, 15, 3), ON)).toEqual(sh('airplane', 15, 13, 39));
      expect(read(run(3, 15, 3), OFF)).toBeNull();
    });

    it('compares the longest chains by their top card and never across lengths', () => {
      expect(beats(combo(run(4, 15, 1)), combo(run(3, 14, 1)), ON)).toBe(true);
      expect(beats(combo(run(3, 14, 1)), combo(run(4, 15, 1)), ON)).toBe(false);
      expect(beats(combo(run(3, 15, 1)), combo(run(3, 14, 1)), ON)).toBe(false);
      expect(beats(combo(run(4, 15, 2)), combo(run(3, 14, 2)), ON)).toBe(true);
      expect(beats(combo(run(3, 15, 2)), combo(run(3, 14, 2)), ON)).toBe(false);
      expect(beats(combo(run(4, 17, 1)), combo(run(3, 16, 1)), ON)).toBe(true);
      expect(comboName(combo(run(3, 14, 1)))).toBe('Straight of 12');
      expect(comboName(combo(run(3, 17, 1)))).toBe('Straight of 15');
      expect(comboName(combo(run(3, 14, 2)))).toBe('Pair chain of 12');
      expect(comboName(combo(run(3, 15, 3)))).toBe('Airplane of 13');
    });

    it('offers no straight answer to 3..A when chains stop at the ace, and 4..2 when they do not', () => {
      const current = combo(run(3, 14, 1));
      const hand = cards(`${run(4, 15, 1)} 3 3 3 3`);
      expect(findPlays(hand, current, OFF).map((p) => p.type)).toEqual(['bomb']);
      expect(findPlays(hand, current, ON).map((p) => shape(p))).toEqual([
        sh('straight', 15, 12, 12),
        sh('bomb', 3, 1, 4),
      ]);
    });
  });

  describe('K A 2 straights with the option off', () => {
    it('reads nothing that runs past the ace when chains stop there', () => {
      for (const spec of ['9 10 J Q K A 2', '10 J Q K A 2', 'Q K A 2 BJ', 'J Q K A 2 BJ RJ']) {
        expect(read(spec, OFF), spec).toBeNull();
        expect(read(spec, ON), spec).not.toBeNull();
      }
      for (const spec of ['K A 2 3 4', 'A 2 BJ RJ 3', 'K A 2 3 4 5 6', '2 BJ RJ 3 4']) {
        expect(read(spec, OFF), spec).toBeNull();
        expect(read(spec, ON), spec).toBeNull();
      }
      expect(read('Q K A 2 BJ', ON)).toEqual(sh('straight', 16, 5, 5));
      expect(read('9 10 J Q K A 2', ON)).toEqual(sh('straight', 15, 7, 7));
    });

    it('finds no straight through the 2 for a hand that only has one when the option is off', () => {
      const current = combo('3 4 5 6 7');
      expect(findPlays(cards('J Q K A 2'), current, OFF)).toEqual([]);
      expect(findPlays(cards('J Q K A 2'), current, ON).map((p) => shape(p))).toEqual([
        sh('straight', 15, 5, 5),
      ]);
      expect(hint(cards('J Q K A 2 BJ RJ'), current, OFF)?.type).toBe('rocket');
      expect(hint(cards('J Q K A 2 BJ RJ'), current, ON)?.type).toBe('straight');
      expect(findPlays(cards('K A 2 BJ RJ'), null, OFF).map((p) => p.type)).not.toContain(
        'straight',
      );
    });
  });

  describe('analyzeAs when the target is a bomb or a rocket', () => {
    const bomb5 = combo('5 5 5 5');
    const rocket = combo('BJ RJ');

    it('reads bombs, rockets and everything else exactly as analyze would', () => {
      for (const target of [bomb5, rocket]) {
        expect(shape(analyzeAs(cards('9 9 9 9'), ON, target))).toEqual(sh('bomb', 9, 1, 4));
        expect(shape(analyzeAs(cards('3 3 3 3'), ON, target))).toEqual(sh('bomb', 3, 1, 4));
        expect(shape(analyzeAs(cards('BJ RJ'), ON, target))).toEqual(sh('rocket', 17, 1, 2));
        expect(shape(analyzeAs(cards('3 3 3 3 4 5'), ON, target))).toEqual(
          sh('four_two_single', 3, 1, 6),
        );
        expect(shape(analyzeAs(cards('3 3 3 3 4 4 4 4'), ON, target))).toEqual(
          sh('four_two_pair', 4, 1, 8),
        );
        expect(shape(analyzeAs(cards('3 3 3 4 4 4 5 5 5 6 6 6'), ON, target))).toEqual(
          sh('airplane', 6, 4, 12),
        );
        expect(analyzeAs(cards('3 4'), ON, target)).toBeNull();
        expect(analyzeAs(cards('5 5 5 5 6'), ON, target)).toBeNull();
      }
    });

    it('then only a stronger bomb or the rocket beats a bomb, and nothing beats the rocket', () => {
      const on = (spec: string, target: Combo): boolean =>
        beats(analyzeAs(cards(spec), ON, target) as Combo, target, ON);
      expect(on('9 9 9 9', bomb5)).toBe(true);
      expect(on('3 3 3 3', bomb5)).toBe(false);
      expect(on('5 5 5 5', bomb5)).toBe(false);
      expect(on('BJ RJ', bomb5)).toBe(true);
      expect(on('3 3 3 3 4 5', bomb5)).toBe(false);
      expect(on('2 2 2 2 3 3 4 4', bomb5)).toBe(false);
      expect(on('3 3 3 4 4 4 5 5 5 6 6 6', bomb5)).toBe(false);
      expect(on('2 2 2 2', rocket)).toBe(false);
      expect(on('BJ RJ', rocket)).toBe(false);
    });
  });

  describe('a four-card bomb against four + two of the same rank', () => {
    it('the bomb beats the four + two, the four + two never beats the bomb', () => {
      const bomb = combo('3 3 3 3');
      const singles = combo('3 3 3 3 4 5');
      const pairs = combo('3 3 3 3 4 4 5 5');
      expect(beats(bomb, singles, ON)).toBe(true);
      expect(beats(bomb, pairs, ON)).toBe(true);
      expect(beats(singles, bomb, ON)).toBe(false);
      expect(beats(pairs, bomb, ON)).toBe(false);
      expect(beats(combo('2 2 2 2 3 4'), bomb, ON)).toBe(false);
      expect(beats(combo('2 2 2 2 3 3 4 4'), bomb, ON)).toBe(false);
      expect(beats(bomb, combo('2 2 2 2 3 4'), ON)).toBe(true);
      expect(beats(bomb, combo('2 2 2 2 A A K K'), ON)).toBe(true);
      expect(beats(combo('BJ RJ'), combo('2 2 2 2 A A K K'), ON)).toBe(true);
      expect(beats(singles, pairs, ON)).toBe(false);
      expect(beats(pairs, singles, ON)).toBe(false);
      expect(beats(combo('4 4 4 4 3 3'), singles, ON)).toBe(true);
      expect(beats(combo('4 4 4 4 3 3 5 5'), pairs, ON)).toBe(true);
      expect(beats(singles, singles, ON)).toBe(false);
      expect(bombStrength(singles, ON)).toBe(0);
      expect(bombStrength(pairs, ON)).toBe(0);
    });

    it('the hand state agrees: findPlays answers four + two with bombs of any rank', () => {
      const hand = cards('3 3 3 3 4 4 4 4 5 6');
      expect(findPlays(hand, combo('5 5 5 5 6 7'), ON).map((p) => shape(p))).toEqual([
        sh('bomb', 3, 1, 4),
        sh('bomb', 4, 1, 4),
      ]);
      expect(findPlays(hand, combo('2 2 2 2 6 6 7 7'), ON).map((p) => shape(p))).toEqual([
        sh('bomb', 3, 1, 4),
        sh('bomb', 4, 1, 4),
      ]);
      expect(findPlays(hand, combo('3 3 3 3'), ON).map((p) => shape(p))).toEqual([
        sh('bomb', 4, 1, 4),
      ]);
    });
  });

  describe('every display name', () => {
    it('matches ENGINE_API.md for all fourteen types', () => {
      const names: Array<[string, string]> = [
        ['7', 'Single'],
        ['RJ', 'Single'],
        ['9 9', 'Pair'],
        ['Q Q Q', 'Triple'],
        ['Q Q Q 3', 'Triple + single'],
        ['Q Q Q 3 3', 'Triple + pair'],
        ['3 4 5 6 7', 'Straight of 5'],
        ['3 4 5 6 7 8 9 10 J Q K A', 'Straight of 12'],
        ['3 3 4 4 5 5', 'Pair chain of 3'],
        ['3 3 4 4 5 5 6 6', 'Pair chain of 4'],
        ['3 3 3 4 4 4', 'Airplane of 2'],
        ['3 3 3 4 4 4 5 5 5', 'Airplane of 3'],
        ['3 3 3 4 4 4 5 6', 'Airplane + singles'],
        ['3 3 3 4 4 4 5 5 5 6 7 8', 'Airplane + singles'],
        ['3 3 3 4 4 4 5 5 6 6', 'Airplane + pairs'],
        ['6 6 6 6 3 4', 'Four + two singles'],
        ['6 6 6 6 3 3 4 4', 'Four + two pairs'],
        ['6 6 6 6', 'Bomb'],
        ['2 2 2 2', 'Bomb'],
        ['BJ RJ', 'Rocket'],
      ];
      const seen = new Set<ComboType>();
      for (const [spec, name] of names) {
        const c = combo(spec);
        seen.add(c.type);
        expect(comboName(c), spec).toBe(name);
      }
      expect([...seen].sort()).toEqual(
        [
          'single',
          'pair',
          'triple',
          'triple_single',
          'triple_pair',
          'straight',
          'pair_chain',
          'airplane',
          'airplane_single',
          'airplane_pair',
          'four_two_single',
          'four_two_pair',
          'bomb',
          'rocket',
        ].sort(),
      );
    });
  });

  // ---- decompose, hint, findPlays with bombs and rockets ----------------------------------

  describe('decompose never splits a rocket', () => {
    const rocketWhole = (hand: Card[], rules: RuleSettings): string[] => {
      const problems: string[] = [];
      const parts = decompose(hand, rules);
      const label = `[${key(hand)}] twos ${rules.chainsThroughTwos ? 'on' : 'off'}`;
      const rockets = parts.filter((p) => p.type === 'rocket');
      if (rockets.length !== 1) problems.push(`${label}: ${rockets.length} rockets`);
      const rocket = rockets[0];
      if (rocket !== undefined && ranksAsc(rocket).join() !== '16,17') {
        problems.push(`${label}: rocket is [${key(rocket.cards)}]`);
      }
      for (const part of parts) {
        if (part.type !== 'rocket' && part.cards.some((card) => card.rank >= 16)) {
          problems.push(`${label}: ${comboName(part)} [${key(part.cards)}] holds a joker`);
        }
      }
      const all = parts.flatMap((p) => p.cards);
      if (ids(all).join() !== ids(hand).join()) problems.push(`${label}: does not cover the hand`);
      return problems;
    };

    it('on hands where the jokers could be kickers, a straight or a pair chain top', () => {
      const problems: string[] = [];
      for (const spec of [
        'BJ RJ',
        'BJ RJ 3',
        '3 3 3 BJ RJ',
        '3 3 3 4 4 4 BJ RJ',
        '3 3 3 4 4 4 5 BJ RJ',
        '3 3 3 4 4 4 5 5 5 BJ RJ 6',
        '10 J Q K A 2 BJ RJ',
        'K A 2 BJ RJ',
        '9 10 J Q K A 2 BJ RJ',
        '3 3 3 3 BJ RJ',
        'A A A 2 2 2 BJ RJ 3 4',
        '6 6 6 6 3 BJ RJ',
        'K K A A 2 2 BJ RJ',
        '3 4 5 6 7 8 9 10 J Q K A 2 BJ RJ',
      ]) {
        for (const rules of [ON, OFF]) problems.push(...rocketWhole(cards(spec), rules));
      }
      expect(problems).toEqual([]);
    });

    it('on 400 random three-player hands that hold both jokers', () => {
      const rng = seededRng('round-2-rocket-whole');
      const problems: string[] = [];
      let checked = 0;
      while (checked < 400) {
        const hand = randomHand(rng, rng() < 0.5 ? 17 : 20);
        if (!hand.some((c) => c.rank === 16) || !hand.some((c) => c.rank === 17)) continue;
        checked++;
        problems.push(...rocketWhole(hand, checked % 2 === 0 ? ON : OFF));
      }
      expect(problems).toEqual([]);
    });

    it('keeps every four of a kind whole and every part is a legal combination', () => {
      const rng = seededRng('round-2-decompose-legal');
      const problems: string[] = [];
      for (let i = 0; i < 400; i++) {
        const rules = i % 2 === 0 ? ON : OFF;
        const hand = i % 3 === 0 ? clumpy(rng, 20) : randomHand(rng, 1 + Math.floor(rng() * 20));
        const label = `[${key(hand)}] twos ${rules.chainsThroughTwos ? 'on' : 'off'}`;
        const parts = decompose(hand, rules);
        if (ids(parts.flatMap((p) => p.cards)).join() !== ids(hand).join()) {
          problems.push(`${label}: parts do not cover the hand exactly`);
        }
        for (const part of parts) {
          const reread = analyze(part.cards, rules);
          if (sig(reread) !== sig(part)) {
            problems.push(
              `${label}: part ${sig(part)} [${key(part.cards)}] reads as ${sig(reread)}`,
            );
          }
        }
        for (const rank of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
          if (hand.filter((c) => c.rank === rank).length < 4) continue;
          const bomb = parts.find((p) => p.type === 'bomb' && p.rank === rank);
          if (bomb === undefined || bomb.cards.length !== 4) {
            problems.push(`${label}: four ${rank}s not kept as a bomb`);
          }
        }
      }
      expect(problems).toEqual([]);
    });
  });

  describe('hint when only bombs remain, and never null otherwise', () => {
    it('leads the weakest bomb, then the rocket last', () => {
      expect(shape(hint(cards('3 3 3 3'), null, ON))).toEqual(sh('bomb', 3, 1, 4));
      expect(shape(hint(cards('5 5 5 5 3 3 3 3'), null, ON))).toEqual(sh('bomb', 3, 1, 4));
      expect(shape(hint(cards('2 2 2 2 BJ RJ'), null, ON))).toEqual(sh('bomb', 15, 1, 4));
      expect(shape(hint(cards('BJ RJ'), null, ON))).toEqual(sh('rocket', 17, 1, 2));
      expect(shape(hint(cards('BJ RJ 3 3 3 3 A A A A'), null, OFF))).toEqual(sh('bomb', 3, 1, 4));
    });

    it('answers with the weakest bomb when nothing else beats, the rocket when no bomb does', () => {
      expect(shape(hint(cards('3 3 3 3 BJ RJ'), combo('A A'), ON))).toEqual(sh('bomb', 3, 1, 4));
      expect(shape(hint(cards('4 4 4 4 3 3 3 3 BJ RJ'), combo('2 2 2'), ON))).toEqual(
        sh('bomb', 3, 1, 4),
      );
      expect(shape(hint(cards('3 3 3 3 BJ RJ'), combo('5 5 5 5'), ON))).toEqual(
        sh('rocket', 17, 1, 2),
      );
      expect(hint(cards('3 3 3 3'), combo('2 2 2 2'), ON)).toBeNull();
      expect(hint(cards('3 3 3 3 2 2 2 2'), combo('BJ RJ'), ON)).toBeNull();
      expect(hint([], null, ON)).toBeNull();
      expect(hint([], combo('3'), ON)).toBeNull();
    });

    it('prefers a non-bomb answer even when a bomb is also available', () => {
      expect(shape(hint(cards('3 3 3 3 A'), combo('K'), ON))).toEqual(sh('single', 14, 1, 1));
      expect(shape(hint(cards('BJ RJ'), combo('2'), ON))).toEqual(sh('single', 16, 1, 1));
      expect(shape(hint(cards('4 4 4 4'), combo('3'), ON))).toEqual(sh('single', 4, 1, 1));
      expect(shape(hint(cards('3 3 3 3 A A'), combo('K K'), ON))).toEqual(sh('pair', 14, 1, 2));
    });

    it('is never null for a non-empty hand, is a legal lead, and is a non-bomb whenever one exists', () => {
      const rng = seededRng('round-2-hint-lead');
      const problems: string[] = [];
      for (let i = 0; i < 400; i++) {
        const rules = i % 2 === 0 ? ON : OFF;
        const hand = i % 3 === 0 ? clumpy(rng, 20) : randomHand(rng, 1 + Math.floor(rng() * 20));
        const label = `[${key(hand)}] twos ${rules.chainsThroughTwos ? 'on' : 'off'}`;
        const suggestion = hint(hand, null, rules);
        if (suggestion === null) {
          problems.push(`${label}: null`);
          continue;
        }
        const handIds = new Set(ids(hand));
        if (!suggestion.cards.every((c) => handIds.has(c.id)))
          problems.push(`${label}: not in hand`);
        if (sig(analyze(suggestion.cards, rules)) !== sig(suggestion)) {
          problems.push(`${label}: ${sig(suggestion)} is not what its cards read as`);
        }
        const bothJokers = hand.some((c) => c.rank === 16) && hand.some((c) => c.rank === 17);
        const loose = hand.some((c) => {
          if (c.rank >= 16) return !bothJokers;
          return hand.filter((o) => o.rank === c.rank).length < 4;
        });
        if (loose && isBombLike(suggestion))
          problems.push(`${label}: bomb hinted ${sig(suggestion)}`);
      }
      expect(problems).toEqual([]);
    });

    it('answering: the weakest non-bomb legal answer by brute force, else the weakest bomb', () => {
      const rng = seededRng('round-2-hint-answer');
      const problems: string[] = [];
      let answered = 0;
      for (let i = 0; i < 300; i++) {
        const rules = i % 2 === 0 ? ON : OFF;
        const hand = i % 2 === 0 ? clumpy(rng, 17) : randomHand(rng, 17);
        const leads = findPlays(clumpy(rng, 12), null, rules);
        const current = leads[Math.floor(rng() * leads.length)];
        if (current === undefined) continue;
        const legal = [...bruteForce(hand, current, rules).values()];
        const suggestion = hint(hand, current, rules);
        const label = `[${key(hand)}] on ${comboName(current)} ${sig(current)}`;
        if (legal.length === 0) {
          if (suggestion !== null)
            problems.push(`${label}: hinted ${sig(suggestion)} with no legal play`);
          continue;
        }
        answered++;
        if (suggestion === null) {
          problems.push(`${label}: null with ${legal.length} legal plays`);
          continue;
        }
        if (sig(analyzeAs(suggestion.cards, rules, current)) !== sig(suggestion)) {
          problems.push(`${label}: hint ${sig(suggestion)} is not what its cards read as`);
        }
        if (!beats(suggestion, current, rules)) problems.push(`${label}: hint does not beat`);
        const nonBombs = legal.filter((c) => !isBombLike(c));
        if (nonBombs.length > 0) {
          const weakest = Math.min(...nonBombs.map((c) => c.rank));
          if (isBombLike(suggestion) || suggestion.rank !== weakest) {
            problems.push(
              `${label}: hinted ${sig(suggestion)}, weakest non-bomb has rank ${weakest}`,
            );
          }
        } else {
          const weakest = Math.min(...legal.map((c) => bombStrength(c, rules)));
          if (bombStrength(suggestion, rules) !== weakest) {
            problems.push(`${label}: hinted ${sig(suggestion)}, weakest bomb strength ${weakest}`);
          }
        }
      }
      expect(answered).toBeGreaterThan(80);
      expect(problems).toEqual([]);
    });
  });

  describe('findPlays on a rocket or a bomb', () => {
    it('offers nothing on a rocket, whatever the hand holds', () => {
      const rocket = combo('BJ RJ');
      for (const spec of [
        '2 2 2 2 3 3 3 3 A A A K K',
        '3 4 5 6 7 8 9 10 J Q K A 2',
        '3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 8 8 8 9 9',
        'BJ RJ',
        '2',
      ]) {
        expect(findPlays(cards(spec), rocket, ON), spec).toEqual([]);
        expect(findPlays(cards(spec), rocket, OFF), spec).toEqual([]);
        expect(hint(cards(spec), rocket, ON), spec).toBeNull();
      }
    });

    it('offers only higher bombs and the rocket on a bomb, weakest first', () => {
      const hand = cards('3 3 3 3 4 4 4 4 6 6 6 6 2 2 2 2 BJ RJ 5 7 7 7 8 8');
      expect(findPlays(hand, combo('5 5 5 5'), ON).map((p) => shape(p))).toEqual([
        sh('bomb', 6, 1, 4),
        sh('bomb', 15, 1, 4),
        sh('rocket', 17, 1, 2),
      ]);
      expect(findPlays(hand, combo('2 2 2 2'), ON).map((p) => shape(p))).toEqual([
        sh('rocket', 17, 1, 2),
      ]);
      expect(findPlays(hand, combo('3 3 3 3'), OFF).map((p) => shape(p))).toEqual([
        sh('bomb', 4, 1, 4),
        sh('bomb', 6, 1, 4),
        sh('bomb', 15, 1, 4),
        sh('rocket', 17, 1, 2),
      ]);
      expect(findPlays(cards('3 3 3 3 4 4 4 4 A A A A'), combo('2 2 2 2'), ON)).toEqual([]);
      expect(findPlays(cards('7 7 7 7 8 8 8 8'), combo('8 8 8 8'), ON)).toEqual([]);
    });

    it('never offers both jokers together except as the rocket or inside a straight', () => {
      const rng = seededRng('round-2-joker-plays');
      const problems: string[] = [];
      for (let i = 0; i < 60; i++) {
        const rules = i % 2 === 0 ? ON : OFF;
        const hand = [...cards('BJ RJ'), ...clumpy(rng, 15).filter((c) => c.rank < 16)];
        for (const play of findPlays(hand, null, rules)) {
          const both =
            play.cards.some((c) => c.rank === 16) && play.cards.some((c) => c.rank === 17);
          if (both && play.type !== 'rocket' && play.type !== 'straight') {
            problems.push(`[${key(hand)}]: ${comboName(play)} [${key(play.cards)}]`);
          }
        }
      }
      expect(problems).toEqual([]);
    });
  });

  // ---- brute force over full three-player hands --------------------------------------------

  describe('findPlays against brute force over whole three-player hands', () => {
    it('every lead of 17-card peasant and 20-card landlord hands, chains on and off', () => {
      const rng = seededRng('round-2-brute-leads');
      const problems: string[] = [];
      let plays = 0;
      for (let i = 0; i < 48; i++) {
        const rules = i % 2 === 0 ? ON : OFF;
        const size = i % 4 < 2 ? 17 : 20;
        const hand = i % 3 === 0 ? randomHand(rng, size) : clumpy(rng, size);
        plays += findPlays(hand, null, rules).length;
        problems.push(...comparePlays(hand, null, rules));
      }
      expect(plays).toBeGreaterThan(2000);
      expect(problems).toEqual([]);
    }, 120_000);

    it('every answer of 17-card hands to leads of every type, chains on and off', () => {
      const rng = seededRng('round-2-brute-answers');
      const problems: string[] = [];
      const typesSeen = new Set<ComboType>();
      let answers = 0;
      for (let i = 0; i < 40; i++) {
        const rules = i % 2 === 0 ? ON : OFF;
        const hand = i % 3 === 0 ? randomHand(rng, 17) : clumpy(rng, 17);
        const leads = findPlays(clumpy(rng, 14), null, rules);
        const byType = new Map<ComboType, Combo[]>();
        for (const lead of leads) byType.set(lead.type, [...(byType.get(lead.type) ?? []), lead]);
        for (const [type, options] of byType) {
          // the weakest lead of each type gives the hand the most answers
          const current = options[Math.floor(rng() * Math.min(3, options.length))] as Combo;
          typesSeen.add(type);
          answers += findPlays(hand, current, rules).length;
          problems.push(...comparePlays(hand, current, rules));
        }
      }
      expect(typesSeen.size).toBeGreaterThanOrEqual(12);
      expect(answers).toBeGreaterThan(300);
      expect(problems).toEqual([]);
    }, 120_000);

    it('analyze does not depend on the order of the cards and never touches the input', () => {
      const rng = seededRng('round-2-order');
      const problems: string[] = [];
      for (let i = 0; i < 300; i++) {
        const rules = i % 2 === 0 ? ON : OFF;
        const hand = clumpy(rng, 20);
        const leads = findPlays(hand, null, rules);
        const play = leads[Math.floor(rng() * leads.length)];
        if (play === undefined) continue;
        const forward = analyze(play.cards, rules);
        const reversed = analyze(play.cards.slice().reverse(), rules);
        const shuffled = analyze(shuffle(play.cards, rng), rules);
        const label = `[${key(play.cards)}] twos ${rules.chainsThroughTwos ? 'on' : 'off'}`;
        for (const other of [reversed, shuffled]) {
          if (sig(other) !== sig(forward))
            problems.push(`${label}: ${sig(other)} vs ${sig(forward)}`);
          else if (other !== null && forward !== null) {
            if (other.cards.map((c) => c.id).join() !== forward.cards.map((c) => c.id).join()) {
              problems.push(`${label}: card order differs`);
            }
          }
        }
        const frozen = Object.freeze(play.cards.map((c) => Object.freeze({ ...c })));
        expect(() => analyze(frozen as Card[], rules)).not.toThrow();
        expect(() => analyzeAs(frozen as Card[], rules, play)).not.toThrow();
      }
      expect(problems).toEqual([]);
    });

    it('findPlays, decompose and hint leave the hand untouched', () => {
      const rng = seededRng('round-2-immutable');
      for (let i = 0; i < 50; i++) {
        const hand = Object.freeze(clumpy(rng, 17).map((c) => Object.freeze({ ...c }))) as Card[];
        const before = hand.map((c) => c.id).join();
        expect(() => findPlays(hand, null, ON)).not.toThrow();
        expect(() => findPlays(hand, combo('3 3 3 4'), OFF)).not.toThrow();
        expect(() => decompose(hand, ON)).not.toThrow();
        expect(() => hint(hand, null, ON)).not.toThrow();
        expect(() => hint(hand, combo('5'), ON)).not.toThrow();
        expect(hand.map((c) => c.id).join()).toBe(before);
      }
    });

    it('lowestSingle is the lowest card, and timeouts could always lead it', () => {
      const rng = seededRng('round-2-lowest');
      for (let i = 0; i < 100; i++) {
        const hand = randomHand(rng, 1 + Math.floor(rng() * 20));
        const lowest = lowestSingle(hand);
        expect(shape(lowest)).toEqual(sh('single', Math.min(...ranksOf(hand)), 1, 1));
        expect(hand.some((c) => c.id === lowest.cards[0]?.id)).toBe(true);
        expect(findPlays(hand, null, ON).map((p) => key(p.cards))).toContain(key(lowest.cards));
      }
    });
  });
});
