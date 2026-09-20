import { describe, expect, it } from 'vitest';

import type { Combo, RuleSettings } from './types';
import { analyze, analyzeAs, beats, bombStrength, chainRanks, comboName, readings } from './combos';
import { RULES_3P, RULES_4P, cards, key, shape, withoutTwos } from './test-helpers';

const NO_TWOS_3P = withoutTwos(RULES_3P);
const NO_TWOS_4P = withoutTwos(RULES_4P);

function type(spec: string, rules: RuleSettings = RULES_3P): string | null {
  return analyze(cards(spec), rules)?.type ?? null;
}

function combo(spec: string, rules: RuleSettings = RULES_3P): Combo {
  const result = analyze(cards(spec), rules);
  if (result === null) throw new Error(`"${spec}" is not a combo`);
  return result;
}

describe('chainRanks', () => {
  it('runs 3..A when chains stop at the ace and 3..RJ when they run through twos', () => {
    expect(chainRanks(NO_TWOS_3P)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(chainRanks(RULES_3P)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });
});

describe('analyze: singles, pairs, triples, bombs', () => {
  it('reads singles including jokers', () => {
    expect(shape(analyze(cards('3'), RULES_3P))).toEqual({
      type: 'single',
      rank: 3,
      length: 1,
      size: 1,
    });
    expect(shape(analyze(cards('RJ'), RULES_3P))).toEqual({
      type: 'single',
      rank: 17,
      length: 1,
      size: 1,
    });
    expect(shape(analyze(cards('BJ'), RULES_4P))).toEqual({
      type: 'single',
      rank: 16,
      length: 1,
      size: 1,
    });
    expect(analyze([], RULES_3P)).toBeNull();
  });

  it('reads pairs and rejects two different ranks', () => {
    expect(shape(combo('3 3'))).toEqual({ type: 'pair', rank: 3, length: 1, size: 2 });
    expect(shape(combo('2 2'))).toEqual({ type: 'pair', rank: 15, length: 1, size: 2 });
    expect(type('3 4')).toBeNull();
    expect(type('A 2')).toBeNull();
  });

  it('reads triples', () => {
    expect(shape(combo('7 7 7'))).toEqual({ type: 'triple', rank: 7, length: 1, size: 3 });
    expect(type('7 7 8')).toBeNull();
    expect(type('3 3 4 4')).toBeNull();
  });

  it('reads four of a kind as a bomb in both player counts', () => {
    expect(shape(combo('3 3 3 3'))).toEqual({ type: 'bomb', rank: 3, length: 1, size: 4 });
    expect(shape(combo('2 2 2 2', RULES_4P))).toEqual({
      type: 'bomb',
      rank: 15,
      length: 1,
      size: 4,
    });
  });

  it('reads 5..8 of a kind as bombs in 4-player games', () => {
    expect(shape(combo('3 3 3 3 3', RULES_4P))).toEqual({
      type: 'bomb',
      rank: 3,
      length: 1,
      size: 5,
    });
    expect(shape(combo('3 3 3 3 3 3', RULES_4P))).toEqual({
      type: 'bomb',
      rank: 3,
      length: 1,
      size: 6,
    });
    expect(shape(combo('9 9 9 9 9 9 9', RULES_4P))).toEqual({
      type: 'bomb',
      rank: 9,
      length: 1,
      size: 7,
    });
    expect(shape(combo('A A A A A A A A', RULES_4P))).toEqual({
      type: 'bomb',
      rank: 14,
      length: 1,
      size: 8,
    });
  });

  it('never reads 6 of a kind as four + two singles', () => {
    expect(type('3 3 3 3 3 3', RULES_4P)).toBe('bomb');
    expect(readings(cards('3 3 3 3 3 3'), RULES_4P).map((r) => r.type)).toEqual(['bomb']);
    expect(readings(cards('3 3 3 3 3 3 3 3'), RULES_4P).map((r) => r.type)).toEqual(['bomb']);
  });
});

describe('analyze: jokers and rockets', () => {
  it('reads a red and a black joker only as a rocket', () => {
    for (const rules of [RULES_3P, RULES_4P]) {
      const rocket = analyze(cards('BJ RJ'), rules);
      expect(shape(rocket)).toEqual({ type: 'rocket', rank: 17, length: 1, size: 2 });
      expect(readings(cards('BJ RJ'), rules).map((r) => r.type)).toEqual(['rocket']);
    }
  });

  it('reads same-colour joker pairs as ordinary pairs (4 players)', () => {
    expect(shape(combo('BJ BJ', RULES_4P))).toEqual({ type: 'pair', rank: 16, length: 1, size: 2 });
    expect(shape(combo('RJ RJ', RULES_4P))).toEqual({ type: 'pair', rank: 17, length: 1, size: 2 });
  });

  it('reads 3 and 4 jokers as rockets of that size (4 players)', () => {
    expect(shape(combo('BJ BJ RJ', RULES_4P))).toEqual({
      type: 'rocket',
      rank: 17,
      length: 1,
      size: 3,
    });
    expect(shape(combo('BJ RJ RJ', RULES_4P))).toEqual({
      type: 'rocket',
      rank: 17,
      length: 1,
      size: 3,
    });
    expect(shape(combo('BJ BJ RJ RJ', RULES_4P))).toEqual({
      type: 'rocket',
      rank: 17,
      length: 1,
      size: 4,
    });
    expect(readings(cards('BJ BJ RJ RJ'), RULES_4P).map((r) => r.type)).toEqual(['rocket']);
  });

  it('never lets a red and a black joker be kickers together', () => {
    expect(type('3 3 3 BJ RJ')).toBeNull();
    expect(type('3 3 3 3 BJ RJ')).toBeNull();
    expect(type('3 3 3 4 4 4 BJ RJ')).toBeNull();
    expect(type('3 3 3 4 4 4 BJ BJ RJ RJ', RULES_4P)).toBeNull();
    expect(type('3 3 3 3 BJ BJ RJ RJ', RULES_4P)).toBeNull();
  });

  it('lets single jokers and same-colour joker pairs be kickers', () => {
    expect(shape(combo('3 3 3 RJ'))).toEqual({
      type: 'triple_single',
      rank: 3,
      length: 1,
      size: 4,
    });
    expect(shape(combo('3 3 3 BJ BJ', RULES_4P))).toEqual({
      type: 'triple_pair',
      rank: 3,
      length: 1,
      size: 5,
    });
    expect(shape(combo('3 3 3 3 BJ BJ', RULES_4P))).toEqual({
      type: 'four_two_single',
      rank: 3,
      length: 1,
      size: 6,
    });
    expect(shape(combo('3 3 3 3 4 4 RJ RJ', RULES_4P))).toEqual({
      type: 'four_two_pair',
      rank: 3,
      length: 1,
      size: 8,
    });
    expect(shape(combo('3 3 3 4 4 4 5 RJ'))).toEqual({
      type: 'airplane_single',
      rank: 4,
      length: 2,
      size: 8,
    });
    expect(shape(combo('3 3 3 4 4 4 BJ BJ 5 5', RULES_4P))).toEqual({
      type: 'airplane_pair',
      rank: 4,
      length: 2,
      size: 10,
    });
  });
});

describe('analyze: triples with kickers', () => {
  it('reads triple + single and triple + pair', () => {
    expect(shape(combo('5 5 5 3'))).toEqual({ type: 'triple_single', rank: 5, length: 1, size: 4 });
    expect(shape(combo('5 5 5 A A'))).toEqual({ type: 'triple_pair', rank: 5, length: 1, size: 5 });
  });

  it('puts the triple first and the kicker last', () => {
    expect(combo('3 5 5 5').cards.map((c) => c.rank)).toEqual([5, 5, 5, 3]);
    expect(combo('A A 5 5 5').cards.map((c) => c.rank)).toEqual([5, 5, 5, 14, 14]);
  });

  it('rejects malformed kickers', () => {
    expect(type('5 5 5 3 4')).toBeNull();
    expect(type('5 5 5 3 3 3')).toBeNull();
    expect(type('5 5 5 3 4 6')).toBeNull();
    expect(type('5 5 5 5 3', RULES_4P)).toBeNull();
    expect(type('5 5 5 5 5 3', RULES_4P)).toBeNull();
  });
});

describe('analyze: straights', () => {
  it('needs at least 5 consecutive different ranks', () => {
    expect(shape(combo('3 4 5 6 7'))).toEqual({ type: 'straight', rank: 7, length: 5, size: 5 });
    expect(shape(combo('7 3 5 4 6'))).toEqual({ type: 'straight', rank: 7, length: 5, size: 5 });
    expect(type('3 4 5 6')).toBeNull();
    expect(type('3 4 5 6 8')).toBeNull();
    expect(type('3 3 4 5 6 7')).toBeNull();
    expect(shape(combo('3 4 5 6 7 8 9 10 J Q K A'))).toEqual({
      type: 'straight',
      rank: 14,
      length: 12,
      size: 12,
    });
  });

  it('may run through 2 and the jokers only when the option is on', () => {
    expect(shape(combo('J Q K A 2'))).toEqual({ type: 'straight', rank: 15, length: 5, size: 5 });
    expect(type('J Q K A 2', NO_TWOS_3P)).toBeNull();
    expect(shape(combo('K A 2 BJ RJ'))).toEqual({ type: 'straight', rank: 17, length: 5, size: 5 });
    expect(type('K A 2 BJ RJ', NO_TWOS_3P)).toBeNull();
    expect(shape(combo('10 J Q K A', NO_TWOS_3P))).toEqual({
      type: 'straight',
      rank: 14,
      length: 5,
      size: 5,
    });
    expect(shape(combo('3 4 5 6 7 8 9 10 J Q K A 2 BJ RJ', RULES_4P))).toEqual({
      type: 'straight',
      rank: 17,
      length: 15,
      size: 15,
    });
  });

  it('never wraps around from the red joker to 3', () => {
    expect(type('A 2 3 4 5')).toBeNull();
    expect(type('2 BJ RJ 3 4')).toBeNull();
    expect(type('K A 3 4 5', NO_TWOS_3P)).toBeNull();
    expect(type('RJ 3 4 5 6')).toBeNull();
  });

  it('lists the straight from the highest card down', () => {
    expect(combo('5 3 4 7 6').cards.map((c) => c.rank)).toEqual([7, 6, 5, 4, 3]);
  });
});

describe('analyze: pair chains', () => {
  it('needs at least 3 consecutive pairs', () => {
    expect(shape(combo('3 3 4 4 5 5'))).toEqual({
      type: 'pair_chain',
      rank: 5,
      length: 3,
      size: 6,
    });
    expect(shape(combo('3 3 4 4 5 5 6 6'))).toEqual({
      type: 'pair_chain',
      rank: 6,
      length: 4,
      size: 8,
    });
    expect(type('3 3 4 4')).toBeNull();
    expect(type('A A 2 2')).toBeNull();
    expect(type('3 3 4 4 6 6')).toBeNull();
    expect(type('3 3 4 4 5 5 5')).toBeNull();
  });

  it('respects the chains-through-twos option', () => {
    expect(shape(combo('K K A A 2 2'))).toEqual({
      type: 'pair_chain',
      rank: 15,
      length: 3,
      size: 6,
    });
    expect(type('K K A A 2 2', NO_TWOS_3P)).toBeNull();
    expect(shape(combo('Q Q K K A A', NO_TWOS_3P))).toEqual({
      type: 'pair_chain',
      rank: 14,
      length: 3,
      size: 6,
    });
    expect(shape(combo('A A 2 2 BJ BJ', RULES_4P))).toEqual({
      type: 'pair_chain',
      rank: 16,
      length: 3,
      size: 6,
    });
    expect(type('A A 2 2 BJ BJ', NO_TWOS_4P)).toBeNull();
    expect(shape(combo('2 2 BJ BJ RJ RJ', RULES_4P))).toEqual({
      type: 'pair_chain',
      rank: 17,
      length: 3,
      size: 6,
    });
  });

  it('never wraps', () => {
    expect(type('2 2 3 3 4 4')).toBeNull();
    expect(type('BJ BJ RJ RJ 3 3', RULES_4P)).toBeNull();
  });
});

describe('analyze: airplanes', () => {
  it('needs at least 2 consecutive triples', () => {
    expect(shape(combo('3 3 3 4 4 4'))).toEqual({ type: 'airplane', rank: 4, length: 2, size: 6 });
    expect(shape(combo('3 3 3 4 4 4 5 5 5'))).toEqual({
      type: 'airplane',
      rank: 5,
      length: 3,
      size: 9,
    });
    expect(type('3 3 3 5 5 5')).toBeNull();
    expect(shape(combo('A A A 2 2 2'))).toEqual({ type: 'airplane', rank: 15, length: 2, size: 6 });
    expect(type('A A A 2 2 2', NO_TWOS_3P)).toBeNull();
    expect(shape(combo('K K K A A A', NO_TWOS_3P))).toEqual({
      type: 'airplane',
      rank: 14,
      length: 2,
      size: 6,
    });
    expect(type('2 2 2 3 3 3')).toBeNull();
  });

  it('reads airplane + singles with exactly one single per triple', () => {
    expect(shape(combo('3 3 3 4 4 4 5 6'))).toEqual({
      type: 'airplane_single',
      rank: 4,
      length: 2,
      size: 8,
    });
    expect(shape(combo('3 3 3 4 4 4 5 5'))).toEqual({
      type: 'airplane_single',
      rank: 4,
      length: 2,
      size: 8,
    });
    expect(shape(combo('3 3 3 4 4 4 5 5 5 6 7 8'))).toEqual({
      type: 'airplane_single',
      rank: 5,
      length: 3,
      size: 12,
    });
    expect(shape(combo('3 3 3 4 4 4 2 2'))).toEqual({
      type: 'airplane_single',
      rank: 4,
      length: 2,
      size: 8,
    });
    expect(type('3 3 3 4 4 4 5')).toBeNull();
    expect(type('3 3 3 4 4 4 5 6 7')).toBeNull();
    expect(type('3 3 3 4 4 4 5 5 5 6')).toBeNull();
  });

  it('reads airplane + pairs with exactly one pair per triple', () => {
    expect(shape(combo('3 3 3 4 4 4 5 5 6 6'))).toEqual({
      type: 'airplane_pair',
      rank: 4,
      length: 2,
      size: 10,
    });
    expect(shape(combo('3 3 3 4 4 4 5 5 5 5'))).toEqual({
      type: 'airplane_pair',
      rank: 4,
      length: 2,
      size: 10,
    });
    expect(shape(combo('3 3 3 4 4 4 5 5 5 6 6 7 7 8 8'))).toEqual({
      type: 'airplane_pair',
      rank: 5,
      length: 3,
      size: 15,
    });
    expect(type('3 3 3 4 4 4 5 5 6 7')).toBeNull();
    expect(type('3 3 3 4 4 4 5 5')).not.toBe('airplane_pair');
    expect(type('3 3 3 4 4 4 5 5 6 6 7 7')).toBeNull();
  });

  it('keeps kickers of a rank other than the airplane triples', () => {
    expect(type('3 3 3 3 4 4 4 4', RULES_4P)).not.toBe('airplane');
    expect(type('3 3 3 3 4 4 4 4', RULES_4P)).not.toBe('airplane_single');
    expect(type('3 3 3 3 4 4 4 5', RULES_4P)).toBeNull();
    expect(type('3 3 3 4 4 4 3 3 4 4', RULES_4P)).toBeNull();
  });

  it('respects the chains-through-twos option for the triples but not for kickers', () => {
    expect(shape(combo('A A A 2 2 2 3 4'))).toEqual({
      type: 'airplane_single',
      rank: 15,
      length: 2,
      size: 8,
    });
    expect(type('A A A 2 2 2 3 4', NO_TWOS_3P)).toBeNull();
    expect(shape(combo('K K K A A A 2 2', NO_TWOS_3P))).toEqual({
      type: 'airplane_single',
      rank: 14,
      length: 2,
      size: 8,
    });
  });

  it('lists the triples first (highest first) and the kickers last', () => {
    expect(combo('5 3 3 3 4 4 4 6').cards.map((c) => c.rank)).toEqual([4, 4, 4, 3, 3, 3, 6, 5]);
  });
});

describe('analyze: four + two', () => {
  it('reads four + two singles, including two singles that form a pair', () => {
    expect(shape(combo('3 3 3 3 4 5'))).toEqual({
      type: 'four_two_single',
      rank: 3,
      length: 1,
      size: 6,
    });
    expect(shape(combo('3 3 3 3 4 4'))).toEqual({
      type: 'four_two_single',
      rank: 3,
      length: 1,
      size: 6,
    });
    expect(shape(combo('2 2 2 2 3 RJ'))).toEqual({
      type: 'four_two_single',
      rank: 15,
      length: 1,
      size: 6,
    });
    expect(combo('4 5 3 3 3 3').cards.map((c) => c.rank)).toEqual([3, 3, 3, 3, 5, 4]);
  });

  it('reads four + two pairs', () => {
    expect(shape(combo('3 3 3 3 4 4 5 5'))).toEqual({
      type: 'four_two_pair',
      rank: 3,
      length: 1,
      size: 8,
    });
    expect(shape(combo('3 3 3 3 4 4 4 4'))).toEqual({
      type: 'four_two_pair',
      rank: 4,
      length: 1,
      size: 8,
    });
    expect(type('3 3 3 3 4 4 5 6')).toBeNull();
    expect(type('3 3 3 3 4 5 6 7')).toBeNull();
    expect(type('3 3 3 3 4 4 4 5')).toBeNull();
  });

  it('never uses the four itself as a kicker', () => {
    expect(type('3 3 3 3 3 4', RULES_4P)).toBeNull();
    expect(type('3 3 3 3 3 3 4 4', RULES_4P)).toBeNull();
  });
});

describe('analyze: ambiguity resolution', () => {
  it('reads 333 444 555 666 as the longest plain airplane', () => {
    expect(shape(combo('3 3 3 4 4 4 5 5 5 6 6 6'))).toEqual({
      type: 'airplane',
      rank: 6,
      length: 4,
      size: 12,
    });
  });

  it('answers an airplane + singles of length 3 with 333 444 555 666, using its best rank', () => {
    const target = combo('3 3 3 4 4 4 5 5 5 6 7 8');
    expect(shape(target)).toEqual({ type: 'airplane_single', rank: 5, length: 3, size: 12 });
    const answer = analyzeAs(cards('3 3 3 4 4 4 5 5 5 6 6 6'), RULES_3P, target);
    expect(shape(answer)).toEqual({ type: 'airplane_single', rank: 6, length: 3, size: 12 });
    expect(answer!.cards.slice(9).map((c) => c.rank)).toEqual([3, 3, 3]);
    expect(beats(answer!, target, RULES_3P)).toBe(true);
  });

  it('prefers airplane + pairs over airplane + singles when both fit', () => {
    const set = cards('3 3 3 4 4 4 5 5 5 6 6 6 7 7 8 8 9 9 10 10');
    expect(shape(analyze(set, RULES_3P))).toEqual({
      type: 'airplane_pair',
      rank: 6,
      length: 4,
      size: 20,
    });
  });

  it('falls back to analyze when no reading matches the target', () => {
    const target = combo('3 3 3 4 4 4 5 6');
    expect(shape(analyzeAs(cards('3 3 3 4 4 4 5 5 5 6 6 6'), RULES_3P, target))).toEqual({
      type: 'airplane',
      rank: 6,
      length: 4,
      size: 12,
    });
    expect(shape(analyzeAs(cards('3 3 3 3'), RULES_3P, target))).toEqual({
      type: 'bomb',
      rank: 3,
      length: 1,
      size: 4,
    });
    expect(analyzeAs(cards('3 4'), RULES_3P, target)).toBeNull();
  });

  it('analyzeAs picks the reading whose type and length match the target', () => {
    const plain = combo('3 3 3 4 4 4 5 5 5 6 6 6');
    expect(shape(analyzeAs(cards('7 7 7 8 8 8 9 9 9 10 10 10'), RULES_3P, plain))).toEqual({
      type: 'airplane',
      rank: 10,
      length: 4,
      size: 12,
    });
    const fourTwoPair = combo('5 5 5 5 6 6 7 7');
    expect(shape(analyzeAs(cards('3 3 3 3 4 4 4 4'), RULES_3P, fourTwoPair))).toEqual({
      type: 'four_two_pair',
      rank: 4,
      length: 1,
      size: 8,
    });
  });

  it('reads 3333 + 44 in 3p as four + two singles and 333333 in 4p as a 6-bomb', () => {
    expect(shape(combo('3 3 3 3 4 4'))).toEqual({
      type: 'four_two_single',
      rank: 3,
      length: 1,
      size: 6,
    });
    expect(shape(combo('3 3 3 3 3 3', RULES_4P))).toEqual({
      type: 'bomb',
      rank: 3,
      length: 1,
      size: 6,
    });
  });

  it('reads 333 444 + 55 as an airplane with singles', () => {
    expect(shape(combo('3 3 3 4 4 4 5 5'))).toEqual({
      type: 'airplane_single',
      rank: 4,
      length: 2,
      size: 8,
    });
  });

  it('always returns exactly the cards it was given', () => {
    for (const spec of [
      '3 3 3 4 4 4 5 5 5 6 6 6',
      'K A 2 BJ RJ',
      '3 3 3 3 4 4 5 5',
      '3 3 3 4 4 4 5 6',
    ]) {
      const set = cards(spec);
      const result = combo(spec);
      expect(result.cards.map((c) => c.id).sort()).toEqual(set.map((c) => c.id).sort());
      expect(key(result.cards)).toBe(key(set));
    }
  });
});

describe('beats', () => {
  const single3 = combo('3');
  const single4 = combo('4');
  const pair3 = combo('3 3');
  const pair4 = combo('4 4');
  const bomb3 = combo('3 3 3 3');
  const bomb4 = combo('4 4 4 4');
  const rocket = combo('BJ RJ');

  it('needs the same type, the same length and a higher rank', () => {
    expect(beats(single4, single3, RULES_3P)).toBe(true);
    expect(beats(single3, single4, RULES_3P)).toBe(false);
    expect(beats(single3, single3, RULES_3P)).toBe(false);
    expect(beats(pair4, pair3, RULES_3P)).toBe(true);
    expect(beats(pair4, single3, RULES_3P)).toBe(false);
    expect(beats(single4, pair3, RULES_3P)).toBe(false);
    expect(beats(combo('RJ'), combo('BJ'), RULES_3P)).toBe(true);
    expect(beats(combo('BJ'), combo('2'), RULES_3P)).toBe(true);
    expect(beats(combo('4 4 4'), combo('3 3 3'), RULES_3P)).toBe(true);
  });

  it('ignores kickers when comparing', () => {
    expect(beats(combo('4 4 4 3'), combo('3 3 3 A'), RULES_3P)).toBe(true);
    expect(beats(combo('3 3 3 A'), combo('4 4 4 3'), RULES_3P)).toBe(false);
    expect(beats(combo('4 4 4 3 3'), combo('3 3 3 A A'), RULES_3P)).toBe(true);
    expect(beats(combo('4 4 4 3'), combo('3 3 3 A A'), RULES_3P)).toBe(false);
    expect(beats(combo('4 4 4 4 3 5'), combo('3 3 3 3 K A'), RULES_3P)).toBe(true);
    expect(beats(combo('4 4 4 4 3 3 5 5'), combo('3 3 3 3 K K A A'), RULES_3P)).toBe(true);
    expect(beats(combo('4 4 4 5 5 5 3 6'), combo('3 3 3 4 4 4 A 2'), RULES_3P)).toBe(true);
  });

  it('compares chains of the same length only', () => {
    expect(beats(combo('4 5 6 7 8'), combo('3 4 5 6 7'), RULES_3P)).toBe(true);
    expect(beats(combo('3 4 5 6 7 8'), combo('3 4 5 6 7'), RULES_3P)).toBe(false);
    expect(beats(combo('4 5 6 7 8'), combo('3 4 5 6 7 8'), RULES_3P)).toBe(false);
    expect(beats(combo('4 4 5 5 6 6'), combo('3 3 4 4 5 5'), RULES_3P)).toBe(true);
    expect(beats(combo('4 4 5 5 6 6 7 7'), combo('3 3 4 4 5 5'), RULES_3P)).toBe(false);
    expect(beats(combo('4 4 4 5 5 5'), combo('3 3 3 4 4 4'), RULES_3P)).toBe(true);
    expect(beats(combo('4 4 4 5 5 5 6 6 6'), combo('3 3 3 4 4 4'), RULES_3P)).toBe(false);
    expect(beats(combo('4 4 4 5 5 5 6 7'), combo('3 3 3 4 4 4 5 6'), RULES_3P)).toBe(true);
    expect(beats(combo('4 4 4 5 5 5'), combo('3 3 3 4 4 4 5 6'), RULES_3P)).toBe(false);
    expect(beats(combo('4 4 4 5 5 5 6 6 7 7'), combo('3 3 3 4 4 4 5 5 6 6'), RULES_3P)).toBe(true);
    expect(beats(combo('4 4 4 5 5 5 6 6 7 7'), combo('3 3 3 4 4 4 5 6'), RULES_3P)).toBe(false);
  });

  it('lets bombs and rockets beat every non-bomb, and nothing else beat them', () => {
    for (const current of [single3, pair3, combo('3 4 5 6 7'), combo('3 3 3 4 4 4 5 5 6 6')]) {
      expect(beats(bomb3, current, RULES_3P)).toBe(true);
      expect(beats(rocket, current, RULES_3P)).toBe(true);
      expect(beats(current, bomb3, RULES_3P)).toBe(false);
      expect(beats(current, rocket, RULES_3P)).toBe(false);
    }
  });

  it('compares 3-player bombs by rank and puts the rocket on top', () => {
    expect(beats(bomb4, bomb3, RULES_3P)).toBe(true);
    expect(beats(bomb3, bomb4, RULES_3P)).toBe(false);
    expect(beats(bomb3, bomb3, RULES_3P)).toBe(false);
    expect(beats(rocket, bomb4, RULES_3P)).toBe(true);
    expect(beats(rocket, combo('2 2 2 2'), RULES_3P)).toBe(true);
    expect(beats(combo('2 2 2 2'), rocket, RULES_3P)).toBe(false);
    expect(beats(rocket, rocket, RULES_3P)).toBe(false);
  });

  it('orders 4-player bombs and rockets exactly as the RULES.md tiers', () => {
    const tiers = [
      combo('3 3 3 3', RULES_4P),
      combo('2 2 2 2', RULES_4P),
      combo('BJ RJ', RULES_4P),
      combo('3 3 3 3 3', RULES_4P),
      combo('2 2 2 2 2', RULES_4P),
      combo('BJ BJ RJ', RULES_4P),
      combo('3 3 3 3 3 3', RULES_4P),
      combo('A A A A A A', RULES_4P),
      combo('3 3 3 3 3 3 3', RULES_4P),
      combo('4 4 4 4 4 4 4', RULES_4P),
      combo('3 3 3 3 3 3 3 3', RULES_4P),
      combo('2 2 2 2 2 2 2 2', RULES_4P),
      combo('BJ BJ RJ RJ', RULES_4P),
    ];
    for (let i = 0; i < tiers.length; i++) {
      for (let j = 0; j < tiers.length; j++) {
        expect(beats(tiers[i]!, tiers[j]!, RULES_4P), `tier ${i} vs ${j}`).toBe(i > j);
      }
      if (i > 0) {
        expect(bombStrength(tiers[i]!, RULES_4P)).toBeGreaterThan(
          bombStrength(tiers[i - 1]!, RULES_4P),
        );
      }
    }
    expect(beats(combo('BJ RJ RJ', RULES_4P), combo('BJ BJ RJ', RULES_4P), RULES_4P)).toBe(false);
    expect(beats(combo('BJ RJ RJ', RULES_4P), combo('BJ RJ', RULES_4P), RULES_4P)).toBe(true);
    expect(bombStrength(single3, RULES_4P)).toBe(0);
  });

  it('never lets a bomb beat a stronger bomb of more cards', () => {
    expect(beats(combo('2 2 2 2', RULES_4P), combo('3 3 3 3 3', RULES_4P), RULES_4P)).toBe(false);
    expect(beats(combo('2 2 2 2 2', RULES_4P), combo('BJ BJ RJ', RULES_4P), RULES_4P)).toBe(false);
    expect(beats(combo('BJ BJ RJ', RULES_4P), combo('3 3 3 3 3 3', RULES_4P), RULES_4P)).toBe(
      false,
    );
  });
});

describe('comboName', () => {
  it('names every combination type in plain English', () => {
    const names: Array<[string, string, RuleSettings]> = [
      ['3', 'Single', RULES_3P],
      ['3 3', 'Pair', RULES_3P],
      ['3 3 3', 'Triple', RULES_3P],
      ['3 3 3 4', 'Triple + single', RULES_3P],
      ['3 3 3 4 4', 'Triple + pair', RULES_3P],
      ['3 4 5 6 7', 'Straight of 5', RULES_3P],
      ['3 4 5 6 7 8 9', 'Straight of 7', RULES_3P],
      ['3 3 4 4 5 5', 'Pair chain of 3', RULES_3P],
      ['3 3 3 4 4 4', 'Airplane of 2', RULES_3P],
      ['3 3 3 4 4 4 5 6', 'Airplane + singles', RULES_3P],
      ['3 3 3 4 4 4 5 5 6 6', 'Airplane + pairs', RULES_3P],
      ['3 3 3 3 4 5', 'Four + two singles', RULES_3P],
      ['3 3 3 3 4 4 5 5', 'Four + two pairs', RULES_3P],
      ['3 3 3 3', 'Bomb', RULES_3P],
      ['3 3 3 3 3 3', 'Bomb', RULES_4P],
      ['BJ RJ', 'Rocket', RULES_3P],
      ['BJ BJ RJ RJ', 'Rocket', RULES_4P],
    ];
    for (const [spec, name, rules] of names) {
      expect(comboName(combo(spec, rules)), spec).toBe(name);
    }
  });
});
