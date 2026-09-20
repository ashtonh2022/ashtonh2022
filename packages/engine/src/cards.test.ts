import { describe, expect, it } from 'vitest';

import {
  cardById,
  cardLabel,
  createDeck,
  isBlackJoker,
  isJoker,
  isRedJoker,
  makeCard,
  rankLabel,
  removeCards,
  seededRng,
  shuffle,
  sortCards,
} from './cards';
import { cards } from './test-helpers';

describe('createDeck', () => {
  it('builds 54 cards for 3 players with one deck index', () => {
    const deck = createDeck(3);
    expect(deck).toHaveLength(54);
    expect(new Set(deck.map((c) => c.id)).size).toBe(54);
    expect(deck.every((c) => c.deck === 0)).toBe(true);
    expect(deck.filter(isJoker)).toHaveLength(2);
    expect(deck.filter(isRedJoker)).toHaveLength(1);
    expect(deck.filter(isBlackJoker)).toHaveLength(1);
  });

  it('builds 108 cards for 4 players over two decks', () => {
    const deck = createDeck(4);
    expect(deck).toHaveLength(108);
    expect(new Set(deck.map((c) => c.id)).size).toBe(108);
    expect(deck.filter((c) => c.deck === 0)).toHaveLength(54);
    expect(deck.filter((c) => c.deck === 1)).toHaveLength(54);
    expect(deck.filter(isRedJoker)).toHaveLength(2);
    expect(deck.filter(isBlackJoker)).toHaveLength(2);
  });

  it('uses ranks 3..17, ids of the form rank-suit-deck and suit J for jokers', () => {
    const deck = createDeck(4);
    for (const card of deck) {
      expect(card.rank).toBeGreaterThanOrEqual(3);
      expect(card.rank).toBeLessThanOrEqual(17);
      expect(card.id).toBe(`${card.rank}-${card.suit}-${card.deck}`);
      expect(card.suit === 'J').toBe(card.rank >= 16);
    }
    for (let rank = 3; rank <= 15; rank++) {
      expect(deck.filter((c) => c.rank === rank)).toHaveLength(8);
    }
    expect(deck.map((c) => c.id)).toContain('14-S-0');
    expect(deck.map((c) => c.id)).toContain('16-J-1');
  });

  it('is deterministic', () => {
    expect(createDeck(3)).toEqual(createDeck(3));
    expect(createDeck(4)).toEqual(createDeck(4));
  });
});

describe('seededRng and shuffle', () => {
  it('produces the same sequence for the same seed, in [0, 1)', () => {
    const a = seededRng('hand-1');
    const b = seededRng('hand-1');
    const c = seededRng('hand-2');
    const seqA = Array.from({ length: 50 }, () => a());
    const seqB = Array.from({ length: 50 }, () => b());
    const seqC = Array.from({ length: 50 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const x of seqA) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(new Set(seqA).size).toBeGreaterThan(40);
  });

  it('shuffles into a permutation without mutating the input', () => {
    const deck = createDeck(3);
    const before = deck.map((c) => c.id);
    const shuffled = shuffle(deck, seededRng('seed'));
    expect(deck.map((c) => c.id)).toEqual(before);
    expect(shuffled).not.toBe(deck);
    expect(shuffled.map((c) => c.id).sort()).toEqual(before.slice().sort());
    expect(shuffled.map((c) => c.id)).not.toEqual(before);
    expect(shuffle(deck, seededRng('seed'))).toEqual(shuffled);
    expect(shuffle(deck, seededRng('other'))).not.toEqual(shuffled);
  });
});

describe('sortCards', () => {
  it('sorts by rank descending, then suit S H D C J, then deck', () => {
    const sorted = sortCards([
      makeCard(3, 'C', 0),
      makeCard(17, 'J', 0),
      makeCard(14, 'H', 1),
      makeCard(14, 'S', 1),
      makeCard(14, 'S', 0),
      makeCard(16, 'J', 1),
      makeCard(3, 'D', 1),
    ]);
    expect(sorted.map((c) => c.id)).toEqual([
      '17-J-0',
      '16-J-1',
      '14-S-0',
      '14-S-1',
      '14-H-1',
      '3-D-1',
      '3-C-0',
    ]);
  });

  it('returns a new array', () => {
    const input = cards('3 4');
    const output = sortCards(input);
    expect(output).not.toBe(input);
    expect(input.map((c) => c.rank)).toEqual([3, 4]);
  });
});

describe('labels', () => {
  it('labels ranks', () => {
    expect([3, 10, 11, 12, 13, 14, 15, 16, 17].map((r) => rankLabel(r as 3))).toEqual([
      '3',
      '10',
      'J',
      'Q',
      'K',
      'A',
      '2',
      'BJ',
      'RJ',
    ]);
  });

  it('labels cards with suit symbols and joker names', () => {
    expect(cardLabel(makeCard(10, 'S', 0))).toBe('10♠');
    expect(cardLabel(makeCard(14, 'H', 0))).toBe('A♥');
    expect(cardLabel(makeCard(15, 'D', 0))).toBe('2♦');
    expect(cardLabel(makeCard(3, 'C', 1))).toBe('3♣');
    expect(cardLabel(makeCard(16, 'J', 0))).toBe('Black Joker');
    expect(cardLabel(makeCard(17, 'J', 1))).toBe('Red Joker');
  });
});

describe('joker predicates', () => {
  it('distinguish red, black and non-jokers', () => {
    const [three, black, red] = cards('3 BJ RJ');
    expect(isJoker(three!)).toBe(false);
    expect(isJoker(black!)).toBe(true);
    expect(isJoker(red!)).toBe(true);
    expect(isBlackJoker(black!)).toBe(true);
    expect(isBlackJoker(red!)).toBe(false);
    expect(isRedJoker(red!)).toBe(true);
    expect(isRedJoker(black!)).toBe(false);
  });
});

describe('cardById and removeCards', () => {
  it('finds cards by id', () => {
    const hand = cards('3 4 5');
    expect(cardById(hand, '4-S-0')).toBe(hand[1]);
    expect(cardById(hand, '9-S-0')).toBeUndefined();
  });

  it('removes by id and leaves the hand untouched', () => {
    const hand = cards('3 3 4 5');
    const rest = removeCards(hand, [hand[0]!, hand[2]!]);
    expect(rest.map((c) => c.id)).toEqual([hand[1]!.id, hand[3]!.id]);
    expect(hand).toHaveLength(4);
    expect(removeCards(hand, [])).toEqual(hand);
    expect(removeCards(hand, cards('K'))).toEqual(hand);
  });
});
