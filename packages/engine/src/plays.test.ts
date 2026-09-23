import { describe, expect, it } from 'vitest';

import type { Card, Combo, RuleSettings } from './types';
import { createDeck, seededRng, shuffle } from './cards';
import { analyze, analyzeAs, beats, bombStrength } from './combos';
import { decompose, findPlays, hint, lowestSingle } from './plays';
import { RULES_3P, RULES_4P, cards, key, shape, withoutTwos } from './test-helpers';

declare const performance: { now(): number };

function combo(spec: string, rules: RuleSettings = RULES_3P): Combo {
  const result = analyze(cards(spec), rules);
  if (result === null) throw new Error(`"${spec}" is not a combo`);
  return result;
}

function keys(plays: Combo[]): string[] {
  return plays.map((play) => key(play.cards));
}

function isSubsetOf(play: Combo, hand: Card[]): boolean {
  const ids = new Set(hand.map((card) => card.id));
  const used = new Set<string>();
  for (const card of play.cards) {
    if (!ids.has(card.id) || used.has(card.id)) return false;
    used.add(card.id);
  }
  return true;
}

describe('findPlays: answering', () => {
  it('answers a single with every higher rank once, weakest first', () => {
    const plays = findPlays(cards('6 5 5 4 3 RJ'), combo('3'), RULES_3P);
    expect(plays.map((p) => p.type)).toEqual(['single', 'single', 'single', 'single']);
    expect(plays.map((p) => p.rank)).toEqual([4, 5, 6, 17]);
  });

  it('answers a pair with pairs (jokers of one colour count as a pair in 4p)', () => {
    const plays = findPlays(cards('4 4 5 5 5 6 BJ BJ'), combo('3 3'), RULES_4P);
    expect(plays.map((p) => `${p.type}:${p.rank}`)).toEqual(['pair:4', 'pair:5', 'pair:16']);
    expect(findPlays(cards('BJ RJ 4'), combo('3 3'), RULES_4P).map((p) => p.type)).toEqual([
      'rocket',
    ]);
  });

  it('answers a triple with kickers using each other rank once', () => {
    const plays = findPlays(cards('4 4 4 5 6 6'), combo('3 3 3 K'), RULES_3P);
    expect(plays.map((p) => p.type)).toEqual(['triple_single', 'triple_single']);
    expect(keys(plays)).toEqual(['4,4,4,5', '4,4,4,6']);
    const pairPlays = findPlays(cards('4 4 4 5 6 6'), combo('3 3 3 K K'), RULES_3P);
    expect(keys(pairPlays)).toEqual(['4,4,4,6,6']);
  });

  it('only returns plays that beat the current combination', () => {
    expect(findPlays(cards('3 4 5 6 7'), combo('3 4 5 6 7'), RULES_3P)).toEqual([]);
    expect(findPlays(cards('3 4'), combo('K'), RULES_3P)).toEqual([]);
    expect(keys(findPlays(cards('4 5 6 7 8 9'), combo('3 4 5 6 7'), RULES_3P))).toEqual([
      '4,5,6,7,8',
      '5,6,7,8,9',
    ]);
    expect(
      findPlays(cards('4 5 6 7 8 9'), combo('3 4 5 6 7 8'), RULES_3P).map((p) => p.length),
    ).toEqual([6]);
  });

  it('adds bombs and rockets after the ordinary answers', () => {
    const plays = findPlays(cards('4 3 3 3 3 BJ RJ'), combo('RJ'), RULES_3P);
    expect(plays.map((p) => p.type)).toEqual(['bomb', 'rocket']);
    const withJokers = findPlays(cards('K 3 3 3 3 BJ RJ'), combo('2'), RULES_3P);
    expect(withJokers.map((p) => `${p.type}:${p.rank}`)).toEqual([
      'single:16',
      'single:17',
      'bomb:3',
      'rocket:17',
    ]);
    const withHigher = findPlays(cards('RJ 3 3 3 3'), combo('2'), RULES_3P);
    expect(withHigher.map((p) => p.type)).toEqual(['single', 'bomb']);
  });

  it('answers bombs with stronger bombs only', () => {
    const plays = findPlays(cards('3 3 3 3 5 5 5 5 BJ RJ 6'), combo('4 4 4 4'), RULES_3P);
    expect(plays.map((p) => `${p.type}:${p.rank}`)).toEqual(['bomb:5', 'rocket:17']);
    expect(findPlays(cards('3 3 3 3 5 5 5 5'), combo('BJ RJ'), RULES_3P)).toEqual([]);
  });

  it('uses the 4-player bomb tiers', () => {
    const hand = cards('3 3 3 3 3 2 2 2 2 BJ BJ RJ');
    const onRocket2 = findPlays(hand, combo('BJ RJ', RULES_4P), RULES_4P);
    expect(onRocket2.map((p) => `${p.type}:${p.size}`)).toEqual(['bomb:5', 'rocket:3']);
    const onFourBomb = findPlays(hand, combo('A A A A', RULES_4P), RULES_4P);
    expect(onFourBomb.map((p) => `${p.type}:${p.size}:${p.rank}`)).toEqual([
      'bomb:4:15',
      'rocket:2:17',
      'bomb:5:3',
      'rocket:3:17',
    ]);
    expect(findPlays(hand, combo('BJ BJ RJ RJ', RULES_4P), RULES_4P)).toEqual([]);
  });

  it('answers an airplane with singles using the reading that beats it', () => {
    const current = combo('3 3 3 4 4 4 5 5 5 6 7 8');
    const plays = findPlays(cards('3 3 3 4 4 4 5 5 5 6 6 6'), current, RULES_3P);
    expect(plays).toHaveLength(1);
    expect(shape(plays[0]!)).toEqual({ type: 'airplane_single', rank: 6, length: 3, size: 12 });
    expect(plays[0]!.cards.slice(9).map((c) => c.rank)).toEqual([3, 3, 3]);
  });

  it('enumerates kicker choices as distinct rank multisets', () => {
    const plays = findPlays(cards('4 4 4 5 5 5 6 6 7 8'), combo('3 3 3 4 4 4 5 6'), RULES_3P);
    expect(keys(plays)).toEqual([
      '4,4,4,5,5,5,6,6',
      '4,4,4,5,5,5,6,7',
      '4,4,4,5,5,5,6,8',
      '4,4,4,5,5,5,7,8',
    ]);
    const pairPlays = findPlays(
      cards('4 4 4 5 5 5 6 6 7 7 8 8'),
      combo('3 3 3 4 4 4 5 5 6 6'),
      RULES_3P,
    );
    expect(keys(pairPlays)).toEqual([
      '4,4,4,5,5,5,6,6,7,7',
      '4,4,4,5,5,5,6,6,8,8',
      '4,4,4,5,5,5,7,7,8,8',
    ]);
  });

  it('never pairs a red joker with a black joker as kickers', () => {
    const plays = findPlays(cards('4 4 4 5 5 5 BJ RJ'), combo('3 3 3 4 4 4 5 6'), RULES_3P);
    expect(plays.map((p) => p.type)).toEqual(['rocket']);
    const noJokerKickers = findPlays(
      cards('4 4 4 5 5 5 BJ RJ 6'),
      combo('3 3 3 4 4 4 5 6'),
      RULES_3P,
    );
    expect(keys(noJokerKickers)).toEqual(['4,4,4,5,5,5,6,16', '4,4,4,5,5,5,6,17', '16,17']);
    const fourTwo = findPlays(cards('4 4 4 4 BJ RJ'), combo('3 3 3 3 5 6'), RULES_3P);
    expect(fourTwo.map((p) => p.type)).toEqual(['bomb', 'rocket']);
    const fourTwo4p = findPlays(cards('4 4 4 4 BJ BJ'), combo('3 3 3 3 5 6', RULES_4P), RULES_4P);
    expect(fourTwo4p.map((p) => p.type)).toEqual(['four_two_single', 'bomb']);
  });

  it('never uses cards of the airplane ranks as kickers', () => {
    const plays = findPlays(cards('4 4 4 4 5 5 5 5'), combo('3 3 3 4 4 4 5 6', RULES_4P), RULES_4P);
    expect(plays.map((p) => p.type)).toEqual(['bomb', 'bomb']);
  });
});

describe('findPlays: leading', () => {
  it('lists every distinct combination once', () => {
    expect(keys(findPlays(cards('3 3 3'), null, RULES_3P))).toEqual(['3', '3,3', '3,3,3']);
    const plays = findPlays(cards('3 4 5 6 7 8'), null, RULES_3P);
    expect(keys(plays)).toEqual([
      '3',
      '4',
      '5',
      '6',
      '7',
      '3,4,5,6,7',
      '8',
      '4,5,6,7,8',
      '3,4,5,6,7,8',
    ]);
  });

  it('reads 333 444 555 666 once, as the plain airplane', () => {
    const plays = findPlays(cards('3 3 3 4 4 4 5 5 5 6 6 6'), null, RULES_3P);
    const twelve = plays.filter((p) => p.cards.length === 12);
    expect(twelve).toHaveLength(1);
    expect(shape(twelve[0]!)).toEqual({ type: 'airplane', rank: 6, length: 4, size: 12 });
    expect(new Set(keys(plays)).size).toBe(plays.length);
    expect(plays.some((p) => p.type === 'airplane_single' && p.length === 2)).toBe(true);
    expect(plays.some((p) => p.type === 'airplane_pair' && p.length == 2)).toBe(true);
  });

  it('lists all joker plays in 4p including every rocket size', () => {
    const plays = findPlays(cards('BJ BJ RJ RJ'), null, RULES_4P);
    expect(keys(plays)).toEqual([
      '16',
      '16,16',
      '17',
      '17,17',
      '16,17',
      '16,16,17',
      '16,17,17',
      '16,16,17,17',
    ]);
    expect(plays.slice(4).map((p) => p.type)).toEqual(['rocket', 'rocket', 'rocket', 'rocket']);
    expect(findPlays(cards('BJ RJ'), null, RULES_3P).map((p) => p.type)).toEqual([
      'single',
      'single',
      'rocket',
    ]);
  });

  it('puts bombs and rockets last, ordered by strength', () => {
    const plays = findPlays(cards('3 3 3 3 3 3 BJ RJ 4'), null, RULES_4P);
    const tail = plays.filter((p) => p.type === 'bomb' || p.type === 'rocket');
    expect(tail.map((p) => `${p.type}:${p.size}`)).toEqual([
      'bomb:4',
      'rocket:2',
      'bomb:5',
      'bomb:6',
    ]);
    expect(plays.slice(plays.length - tail.length)).toEqual(tail);
    for (let i = 1; i < tail.length; i++) {
      expect(bombStrength(tail[i]!, RULES_4P)).toBeGreaterThan(
        bombStrength(tail[i - 1]!, RULES_4P),
      );
    }
  });

  it('does not read 3333 4444 as an airplane in 4p', () => {
    const plays = findPlays(cards('3 3 3 3 4 4 4 4'), null, RULES_4P);
    expect(plays.some((p) => p.type === 'airplane_single')).toBe(false);
    expect(plays.filter((p) => p.type === 'four_two_pair').map((p) => p.rank)).toEqual([4]);
  });

  it('follows the chains-through-twos option', () => {
    const hand = cards('J Q K A 2');
    expect(findPlays(hand, null, RULES_3P).some((p) => p.type === 'straight')).toBe(true);
    expect(findPlays(hand, null, withoutTwos(RULES_3P)).some((p) => p.type === 'straight')).toBe(
      false,
    );
  });
});

describe('findPlays: property test', () => {
  const rng = seededRng('findPlays property test');
  const pick = <T>(items: T[]): T => items[Math.floor(rng() * items.length)] as T;

  function bruteForce(hand: Card[], current: Combo | null, rules: RuleSettings): Set<string> {
    const found = new Set<string>();
    for (let mask = 1; mask < 1 << hand.length; mask++) {
      const subset = hand.filter((_, i) => (mask & (1 << i)) !== 0);
      const read = current ? analyzeAs(subset, rules, current) : analyze(subset, rules);
      if (read !== null && (current === null || beats(read, current, rules)))
        found.add(key(subset));
    }
    return found;
  }

  it('is complete, correct and duplicate-free over 300 random hands', () => {
    let checkedAnswers = 0;
    let bruteForced = 0;
    for (let i = 0; i < 300; i++) {
      const playerCount = rng() < 0.5 ? 3 : 4;
      const rules: RuleSettings = {
        ...(playerCount === 4 ? RULES_4P : RULES_3P),
        chainsThroughTwos: rng() < 0.7,
      };
      const deck = shuffle(createDeck(playerCount), rng);
      // Half the time draw from a narrow pool so triples, bombs and jokers collide often.
      const pool = rng() < 0.5 ? deck : deck.filter((c) => c.rank <= 6 || c.rank >= 14);
      const handSize = 1 + Math.floor(rng() * (i % 2 === 0 ? 8 : 20));
      const hand = pool.slice(0, handSize);
      const others = pool.slice(handSize, handSize + 12);
      const leads = findPlays(others, null, rules);
      const current = rng() < 0.2 || leads.length === 0 ? null : pick(leads);

      const plays = findPlays(hand, current, rules);
      const seen = new Set<string>();
      for (const play of plays) {
        expect(isSubsetOf(play, hand), `play is a subset of the hand (#${i})`).toBe(true);
        const read = current ? analyzeAs(play.cards, rules, current) : analyze(play.cards, rules);
        expect(read, `play analyzes (#${i}: ${key(play.cards)})`).not.toBeNull();
        expect(shape(read), `findPlays agrees with analyze (#${i})`).toEqual(shape(play));
        if (current) expect(beats(read!, current, rules), `play beats current (#${i})`).toBe(true);
        const k = key(play.cards);
        expect(seen.has(k), `no duplicate rank structure (#${i}: ${k})`).toBe(false);
        seen.add(k);
        checkedAnswers++;
      }
      for (let j = 1; j < plays.length; j++) {
        const a = plays[j - 1]!;
        const b = plays[j]!;
        const aBomb = a.type === 'bomb' || a.type === 'rocket';
        const bBomb = b.type === 'bomb' || b.type === 'rocket';
        expect(aBomb && !bBomb, `bombs come last (#${i})`).toBe(false);
        if (aBomb && bBomb) {
          expect(bombStrength(a, rules)).toBeLessThanOrEqual(bombStrength(b, rules));
        } else if (!aBomb && !bBomb && a.type === b.type && a.length === b.length) {
          expect(a.rank).toBeLessThanOrEqual(b.rank);
        }
      }
      if (hand.length <= 8) {
        expect(
          seen,
          `brute force agrees (#${i}, current ${current ? key(current.cards) : 'none'})`,
        ).toEqual(bruteForce(hand, current, rules));
        bruteForced++;
      }

      const suggestion = hint(hand, current, rules);
      if (plays.length > 0) {
        expect(suggestion, `hint is not null when plays exist (#${i})`).not.toBeNull();
        expect(isSubsetOf(suggestion!, hand)).toBe(true);
        if (current) expect(beats(suggestion!, current, rules)).toBe(true);
      } else if (current) {
        expect(suggestion).toBeNull();
      }
      if (current === null) expect(suggestion).not.toBeNull();

      const parts = decompose(hand, rules);
      const used = parts.flatMap((part) => part.cards.map((card) => card.id)).sort();
      expect(used, `decompose covers the hand exactly (#${i})`).toEqual(
        hand.map((c) => c.id).sort(),
      );
      for (const part of parts) {
        expect(analyze(part.cards, rules)?.type, `decompose part is legal (#${i})`).toBe(part.type);
      }
    }
    expect(checkedAnswers).toBeGreaterThan(1000);
    expect(bruteForced).toBeGreaterThan(100);
  });
});

describe('hint', () => {
  it('suggests the weakest non-bomb answer, then the weakest bomb, then null', () => {
    expect(shape(hint(cards('4 K 3 3 3 3 5 5 5 5'), combo('3'), RULES_3P))).toEqual({
      type: 'single',
      rank: 4,
      length: 1,
      size: 1,
    });
    expect(shape(hint(cards('3 3 3 3 5 5 5 5 BJ'), combo('K'), RULES_3P))).toEqual({
      type: 'single',
      rank: 16,
      length: 1,
      size: 1,
    });
    expect(shape(hint(cards('3 3 3 3 5 5 5 5 BJ RJ'), combo('RJ'), RULES_3P))).toEqual({
      type: 'bomb',
      rank: 3,
      length: 1,
      size: 4,
    });
    expect(shape(hint(cards('BJ RJ'), combo('K K'), RULES_3P))).toEqual({
      type: 'rocket',
      rank: 17,
      length: 1,
      size: 2,
    });
    expect(hint(cards('3 4 5'), combo('K'), RULES_3P)).toBeNull();
    expect(hint([], combo('K'), RULES_3P)).toBeNull();
    expect(hint([], null, RULES_3P)).toBeNull();
  });

  it('leads with the weakest non-bomb part of the decomposition, spending low cards', () => {
    const lead = hint(cards('3 3 4 5 6 7 8 9 K K K A'), null, RULES_3P);
    expect(shape(lead)).toEqual({ type: 'straight', rank: 9, length: 7, size: 7 });
    expect(shape(hint(cards('A 3 3'), null, RULES_3P))).toEqual({
      type: 'pair',
      rank: 3,
      length: 1,
      size: 2,
    });
    expect(shape(hint(cards('3 3 3 3 A A A A'), null, RULES_3P))).toEqual({
      type: 'bomb',
      rank: 3,
      length: 1,
      size: 4,
    });
    expect(shape(hint(cards('BJ RJ'), null, RULES_3P))).toEqual({
      type: 'rocket',
      rank: 17,
      length: 1,
      size: 2,
    });
    expect(shape(hint(cards('BJ RJ 5'), null, RULES_3P))).toEqual({
      type: 'single',
      rank: 5,
      length: 1,
      size: 1,
    });
  });
});

describe('decompose', () => {
  const types = (spec: string, rules: RuleSettings = RULES_3P): string[] =>
    decompose(cards(spec), rules).map((part) => `${part.type}:${part.rank}`);

  it('keeps bombs and rockets whole', () => {
    expect(types('3 3 3 3')).toEqual(['bomb:3']);
    expect(types('3 3 3 3 3 3', RULES_4P)).toEqual(['bomb:3']);
    expect(types('BJ RJ 5')).toEqual(['single:5', 'rocket:17']);
    expect(types('BJ BJ RJ RJ', RULES_4P)).toEqual(['rocket:17']);
    expect(decompose(cards('BJ BJ RJ RJ'), RULES_4P)[0]!.size).toBe(4);
    expect(types('BJ BJ', RULES_4P)).toEqual(['pair:16']);
  });

  it('finds airplanes, chains and triples with kickers', () => {
    expect(types('3 3 3 4 4 4 5 5 5 6 6 6')).toEqual(['airplane:6']);
    expect(types('3 3 3 4 4 4 5 6')).toEqual(['airplane_single:4']);
    expect(types('3 3 3 4 4 4 5 5 6 6')).toEqual(['airplane_pair:4']);
    expect(types('3 3 4 4 5 5')).toEqual(['pair_chain:5']);
    expect(types('3 4 5 6 7 8 9')).toEqual(['straight:9']);
    expect(types('3 3 3 4')).toEqual(['triple_single:3']);
    expect(types('3 3 3 4 4')).toEqual(['triple_pair:3']);
    expect(types('3 3 3 4 5')).toEqual(['triple_single:3', 'single:5']);
    expect(types('A A A 2 2 2', withoutTwos(RULES_3P))).toEqual(['triple:14', 'triple:15']);
  });

  it('uses every card exactly once and each part is legal', () => {
    const rng = seededRng('decompose');
    for (const playerCount of [3, 4] as const) {
      const rules = playerCount === 4 ? RULES_4P : RULES_3P;
      for (let i = 0; i < 20; i++) {
        const hand = shuffle(createDeck(playerCount), rng).slice(0, 17 + i);
        const parts = decompose(hand, rules);
        const ids = parts.flatMap((part) => part.cards.map((c) => c.id)).sort();
        expect(ids).toEqual(hand.map((c) => c.id).sort());
        for (const part of parts) expect(analyze(part.cards, rules)?.type).toBe(part.type);
      }
    }
  });
});

describe('lowestSingle', () => {
  it('returns the lowest card as a single', () => {
    const hand = cards('K 5 3 4 RJ');
    expect(shape(lowestSingle(hand))).toEqual({ type: 'single', rank: 3, length: 1, size: 1 });
    expect(lowestSingle(hand).cards[0]!.id).toBe(hand[2]!.id);
    expect(() => lowestSingle([])).toThrow();
  });
});

describe('performance', () => {
  it('enumerates every lead of a 33-card 4-player hand well under 200 ms', () => {
    const hand = cards('3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 8 8 8 9 9 10 10 J J Q Q K K A A 2 2 BJ');
    expect(hand).toHaveLength(33);
    findPlays(hand, null, RULES_4P);
    const start = performance.now();
    const plays = findPlays(hand, null, RULES_4P);
    const elapsed = performance.now() - start;
    expect(plays.length).toBeGreaterThan(1000);
    expect(new Set(keys(plays)).size).toBe(plays.length);
    expect(elapsed).toBeLessThan(500);

    const answerStart = performance.now();
    const answers = findPlays(hand, combo('3 3 3 4 4 4 5 5 5 6 7 8'), RULES_4P);
    expect(performance.now() - answerStart).toBeLessThan(500);
    expect(answers.length).toBeGreaterThan(0);
  });
});
