import type { Card, PlayerCount, Rank, Suit } from './types';
import { RANK } from './types';

const DEAL_SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'];

/** Display order of suits inside one rank. */
const SUIT_ORDER: Record<Suit, number> = { S: 0, H: 1, D: 2, C: 3, J: 4 };

const SUIT_SYMBOL: Record<Exclude<Suit, 'J'>, string> = {
  S: '♠',
  H: '♥',
  D: '♦',
  C: '♣',
};

const RANK_LABELS: Record<Rank, string> = {
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
  15: '2',
  16: 'BJ',
  17: 'RJ',
};

export function makeCard(rank: Rank, suit: Suit, deck: 0 | 1): Card {
  return { id: `${rank}-${suit}-${deck}`, rank, suit, deck };
}

/**
 * The full deck for a player count, in a fixed order: deck 0 then deck 1, ranks ascending,
 * suits S H D C, then the black and red joker of that deck.
 */
export function createDeck(playerCount: PlayerCount): Card[] {
  const deckCount = playerCount === 4 ? 2 : 1;
  const cards: Card[] = [];
  for (let d = 0; d < deckCount; d++) {
    const deck: 0 | 1 = d === 0 ? 0 : 1;
    for (let rank = RANK.THREE; rank <= RANK.TWO; rank++) {
      for (const suit of DEAL_SUITS) {
        cards.push(makeCard(rank as Rank, suit, deck));
      }
    }
    cards.push(makeCard(RANK.BLACK_JOKER, 'J', deck));
    cards.push(makeCard(RANK.RED_JOKER, 'J', deck));
  }
  return cards;
}

/** Deterministic PRNG (xmur3 seed hash feeding mulberry32). Returns numbers in [0, 1). */
export function seededRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const hashStep = (): number => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
  let state = hashStep();
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle driven by `rng`; returns a new array. */
export function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

export function compareCardsForDisplay(a: Card, b: Card): number {
  return b.rank - a.rank || SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit] || a.deck - b.deck;
}

/** Display order: rank descending, then suit S H D C J, then deck. Returns a new array. */
export function sortCards(cards: Card[]): Card[] {
  return cards.slice().sort(compareCardsForDisplay);
}

export function rankLabel(rank: Rank): string {
  return RANK_LABELS[rank];
}

export function cardLabel(card: Card): string {
  if (card.rank === RANK.RED_JOKER) return 'Red Joker';
  if (card.rank === RANK.BLACK_JOKER) return 'Black Joker';
  if (card.suit === 'J') return rankLabel(card.rank);
  return `${rankLabel(card.rank)}${SUIT_SYMBOL[card.suit]}`;
}

export function isJoker(card: Card): boolean {
  return card.rank === RANK.BLACK_JOKER || card.rank === RANK.RED_JOKER;
}

export function isRedJoker(card: Card): boolean {
  return card.rank === RANK.RED_JOKER;
}

export function isBlackJoker(card: Card): boolean {
  return card.rank === RANK.BLACK_JOKER;
}

export function cardById(cards: Card[], id: string): Card | undefined {
  return cards.find((card) => card.id === id);
}

/** The hand without the given cards (matched by id). Returns a new array. */
export function removeCards(hand: Card[], cards: Card[]): Card[] {
  const ids = new Set(cards.map((card) => card.id));
  return hand.filter((card) => !ids.has(card.id));
}
