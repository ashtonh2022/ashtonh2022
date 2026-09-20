/**
 * Internal helpers shared by combos.ts and plays.ts: cards bucketed by rank, and the
 * rank-structure key used to treat cards of equal rank as interchangeable.
 * Not part of the public engine API.
 */
import type { Card, Combo, ComboType, Rank } from './types';
import { RANK } from './types';
import { sortCards } from './cards';

export const ALL_RANKS: readonly Rank[] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];

/** Ranks that can appear four or more times (jokers never can). */
export const NON_JOKER_RANKS: readonly Rank[] = ALL_RANKS.filter((r) => r <= RANK.TWO);

export interface RankGroups {
  /** counts[rank] = number of cards of that rank */
  counts: number[];
  /** cards[rank] = those cards in display order */
  cards: Card[][];
}

export function groupByRank(cards: Card[]): RankGroups {
  const counts: number[] = [];
  const byRank: Card[][] = [];
  for (let i = 0; i <= RANK.RED_JOKER; i++) {
    counts.push(0);
    byRank.push([]);
  }
  for (const card of sortCards(cards)) {
    counts[card.rank] = (counts[card.rank] ?? 0) + 1;
    byRank[card.rank]?.push(card);
  }
  return { counts, cards: byRank };
}

export function countOf(groups: RankGroups, rank: Rank): number {
  return groups.counts[rank] ?? 0;
}

export function cardsOf(groups: RankGroups, rank: Rank): Card[] {
  return groups.cards[rank] ?? [];
}

/** The first `n` cards of a rank (cards of one rank are interchangeable). */
export function takeOf(groups: RankGroups, rank: Rank, n: number): Card[] {
  return cardsOf(groups, rank).slice(0, n);
}

/** Cards of the given ranks, highest rank first, `perRank` cards from each. */
export function takeRanks(groups: RankGroups, ranks: readonly Rank[], perRank: number): Card[] {
  const out: Card[] = [];
  for (let i = ranks.length - 1; i >= 0; i--) {
    out.push(...takeOf(groups, ranks[i] as Rank, perRank));
  }
  return out;
}

/** Build a combo. Main cards come first, kickers last, exactly as they should be displayed. */
export function makeCombo(
  type: ComboType,
  main: Card[],
  kickers: Card[],
  rank: Rank,
  length: number,
): Combo {
  const cards = kickers.length === 0 ? main : [...main, ...kickers];
  return { type, cards, rank, length, size: cards.length };
}

export function isBombLike(combo: Combo): boolean {
  return combo.type === 'bomb' || combo.type === 'rocket';
}

/** True when the set contains a red joker together with a black joker. */
export function mixesJokerColours(cards: readonly Card[]): boolean {
  let black = false;
  let red = false;
  for (const card of cards) {
    if (card.rank === RANK.BLACK_JOKER) black = true;
    else if (card.rank === RANK.RED_JOKER) red = true;
  }
  return black && red;
}

/** Ranks of the cards in ascending order (the rank-structure identity of a play). */
export function rankSequence(cards: readonly Card[]): number[] {
  return cards.map((card) => card.rank).sort((a, b) => a - b);
}

export function rankKey(cards: readonly Card[]): string {
  return rankSequence(cards).join(',');
}

/**
 * Reading preference when one set of cards has several legal interpretations
 * (docs/RULES.md): rocket, bomb, then the longest plain airplane, then airplane with pairs,
 * then airplane with singles. Among equals the higher rank wins.
 */
const READING_PRIORITY: Record<ComboType, number> = {
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

/** True when reading `a` should be preferred over reading `b` of the same cards. */
export function preferReading(a: Combo, b: Combo): boolean {
  const pa = READING_PRIORITY[a.type];
  const pb = READING_PRIORITY[b.type];
  if (pa !== pb) return pa < pb;
  if (a.length !== b.length) return a.length > b.length;
  return a.rank > b.rank;
}
