import type { Card, Combo, ComboType, Rank, RuleSettings } from './types';
import { RANK } from './types';
import { sortCards } from './cards';
import {
  ALL_RANKS,
  cardsOf,
  countOf,
  groupByRank,
  isBombLike,
  makeCombo,
  mixesJokerColours,
  preferReading,
  takeRanks,
  type RankGroups,
} from './cardGroups';

/** Ranks that may appear in a chain, in chain order (3..A, or 3..Red Joker). Chains never wrap. */
export function chainRanks(rules: RuleSettings): Rank[] {
  const top = rules.chainsThroughTwos ? RANK.RED_JOKER : RANK.ACE;
  return ALL_RANKS.filter((rank) => rank <= top);
}

/** Position of every rank inside the chain order, -1 when the rank cannot be in a chain. */
function chainPositions(rules: RuleSettings): number[] {
  const positions: number[] = [];
  for (let i = 0; i <= RANK.RED_JOKER; i++) positions.push(-1);
  chainRanks(rules).forEach((rank, index) => {
    positions[rank] = index;
  });
  return positions;
}

function presentRanks(groups: RankGroups): Rank[] {
  return ALL_RANKS.filter((rank) => countOf(groups, rank) > 0);
}

function allCardsOf(groups: RankGroups, ranks: readonly Rank[]): Card[] {
  const out: Card[] = [];
  for (let i = ranks.length - 1; i >= 0; i--) out.push(...cardsOf(groups, ranks[i] as Rank));
  return out;
}

/**
 * Every legal interpretation of a set of cards under the rules (any order). Most sets have at
 * most one; airplanes with kickers and four + two pairs can have several.
 */
export function readings(cards: Card[], rules: RuleSettings): Combo[] {
  const n = cards.length;
  const out: Combo[] = [];
  if (n === 0) return out;

  const groups = groupByRank(cards);
  const present = presentRanks(groups);
  const blacks = countOf(groups, RANK.BLACK_JOKER);
  const reds = countOf(groups, RANK.RED_JOKER);

  // Rocket: nothing but jokers, at least one of each colour, 2..4 cards.
  if (blacks > 0 && reds > 0 && blacks + reds === n) {
    if (n <= 4) out.push(makeCombo('rocket', sortCards(cards), [], RANK.RED_JOKER, 1));
    return out;
  }

  // One rank only: single, pair, triple or bomb. (A red + black joker never reaches here.)
  if (present.length === 1) {
    const rank = present[0] as Rank;
    const all = cardsOf(groups, rank);
    if (n === 1) out.push(makeCombo('single', all, [], rank, 1));
    else if (n === 2) out.push(makeCombo('pair', all, [], rank, 1));
    else if (n === 3) out.push(makeCombo('triple', all, [], rank, 1));
    else if (n <= 8 && rank <= RANK.TWO) out.push(makeCombo('bomb', all, [], rank, 1));
    return out;
  }

  // Triple + single / triple + pair.
  if ((n === 4 || n === 5) && present.length === 2) {
    const tripleRank = present.find((rank) => countOf(groups, rank) === 3);
    const kickerRank = present.find((rank) => countOf(groups, rank) !== 3);
    if (tripleRank !== undefined && kickerRank !== undefined) {
      const kickers = cardsOf(groups, kickerRank);
      if (n === 4) {
        out.push(makeCombo('triple_single', cardsOf(groups, tripleRank), kickers, tripleRank, 1));
      } else if (kickers.length === 2) {
        out.push(makeCombo('triple_pair', cardsOf(groups, tripleRank), kickers, tripleRank, 1));
      }
    }
  }

  // Four + two singles (6 cards) / four + two pairs (8 cards). Kickers are always of other ranks.
  if (n === 6 || n === 8) {
    for (const rank of present) {
      if (rank > RANK.TWO || countOf(groups, rank) !== 4) continue;
      const kickerRanks = present.filter((other) => other !== rank);
      const kickers = allCardsOf(groups, kickerRanks);
      if (mixesJokerColours(kickers)) continue;
      const main = cardsOf(groups, rank);
      if (n === 6) {
        out.push(makeCombo('four_two_single', main, kickers, rank, 1));
      } else if (kickerRanks.every((other) => countOf(groups, other) % 2 === 0)) {
        out.push(makeCombo('four_two_pair', main, kickers, rank, 1));
      }
    }
  }

  // Plain chains: straight, pair chain, airplane. All ranks consecutive in chain order.
  const positions = chainPositions(rules);
  const consecutive = present.every((rank, index) => {
    const position = positions[rank] ?? -1;
    if (position < 0) return false;
    if (index === 0) return true;
    return position === (positions[present[index - 1] as Rank] ?? -1) + 1;
  });
  if (consecutive) {
    const top = present[present.length - 1] as Rank;
    const uniform = (count: number): boolean =>
      present.every((rank) => countOf(groups, rank) === count);
    if (n >= 5 && uniform(1))
      out.push(makeCombo('straight', takeRanks(groups, present, 1), [], top, n));
    if (n >= 6 && uniform(2)) {
      out.push(makeCombo('pair_chain', takeRanks(groups, present, 2), [], top, n / 2));
    }
    if (n >= 6 && uniform(3)) {
      out.push(makeCombo('airplane', takeRanks(groups, present, 3), [], top, n / 3));
    }
  }

  // Airplane with single kickers (4 cards per triple) or pair kickers (5 cards per triple).
  const chain = chainRanks(rules);
  const kickerTypes: Array<[number, ComboType]> = [
    [4, 'airplane_single'],
    [5, 'airplane_pair'],
  ];
  for (const [cardsPerTriple, type] of kickerTypes) {
    if (n % cardsPerTriple !== 0) continue;
    const length = n / cardsPerTriple;
    if (length < 2) continue;
    for (let start = 0; start + length <= chain.length; start++) {
      const window = chain.slice(start, start + length);
      if (!window.every((rank) => countOf(groups, rank) === 3)) continue;
      const kickerRanks = present.filter((rank) => !window.includes(rank));
      if (
        type === 'airplane_pair' &&
        !kickerRanks.every((rank) => countOf(groups, rank) % 2 === 0)
      ) {
        continue;
      }
      const kickers = allCardsOf(groups, kickerRanks);
      if (mixesJokerColours(kickers)) continue;
      const top = window[window.length - 1] as Rank;
      out.push(makeCombo(type, takeRanks(groups, window, 3), kickers, top, length));
    }
  }

  return out;
}

function bestReading(candidates: Combo[]): Combo | null {
  let best: Combo | null = null;
  for (const candidate of candidates) {
    if (best === null || preferReading(candidate, best)) best = candidate;
  }
  return best;
}

/**
 * Classify a set of cards, or null when it is not a legal combination. When the cards can be
 * read in more than one way the RULES.md order applies: longest plain airplane, then airplane
 * with pairs, then airplane with singles (and the higher rank among equals).
 */
export function analyze(cards: Card[], rules: RuleSettings): Combo | null {
  return bestReading(readings(cards, rules));
}

/**
 * Classify a set of cards preferring the reading with the same type and length as `target`
 * (the combination being answered), taking the highest-ranked such reading. Falls back to
 * `analyze` when no reading matches.
 */
export function analyzeAs(cards: Card[], rules: RuleSettings, target: Combo): Combo | null {
  const all = readings(cards, rules);
  let best: Combo | null = null;
  for (const candidate of all) {
    if (candidate.type !== target.type || candidate.length !== target.length) continue;
    if (best === null || candidate.rank > best.rank) best = candidate;
  }
  return best ?? bestReading(all);
}

/**
 * Monotone strength of a bomb or rocket, comparable across both. Non-bombs score 0.
 *
 * Tiers per RULES.md (4-player; the 3-player game only ever has the first two):
 * 4-bomb (by rank) < 2-rocket < 5-bomb < 3-rocket < 6-bomb < 7-bomb < 8-bomb < 4-rocket.
 */
export function bombStrength(combo: Combo, rules: RuleSettings): number {
  void rules;
  if (combo.type === 'rocket') {
    if (combo.size >= 4) return 800;
    if (combo.size === 3) return 400;
    return 200;
  }
  if (combo.type === 'bomb') {
    const tier =
      combo.size >= 8
        ? 700
        : combo.size === 7
          ? 600
          : combo.size === 6
            ? 500
            : combo.size === 5
              ? 300
              : 100;
    return tier + combo.rank;
  }
  return 0;
}

/** Whether `candidate` may be played on top of `current`. */
export function beats(candidate: Combo, current: Combo, rules: RuleSettings): boolean {
  const candidateBomb = isBombLike(candidate);
  const currentBomb = isBombLike(current);
  if (candidateBomb && currentBomb) {
    return bombStrength(candidate, rules) > bombStrength(current, rules);
  }
  if (candidateBomb) return true;
  if (currentBomb) return false;
  return (
    candidate.type === current.type &&
    candidate.length === current.length &&
    candidate.cards.length === current.cards.length &&
    candidate.rank > current.rank
  );
}

/** Display name of a combination. */
export function comboName(combo: Combo): string {
  switch (combo.type) {
    case 'single':
      return 'Single';
    case 'pair':
      return 'Pair';
    case 'triple':
      return 'Triple';
    case 'triple_single':
      return 'Triple + single';
    case 'triple_pair':
      return 'Triple + pair';
    case 'straight':
      return `Straight of ${combo.length}`;
    case 'pair_chain':
      return `Pair chain of ${combo.length}`;
    case 'airplane':
      return `Airplane of ${combo.length}`;
    case 'airplane_single':
      return 'Airplane + singles';
    case 'airplane_pair':
      return 'Airplane + pairs';
    case 'four_two_single':
      return 'Four + two singles';
    case 'four_two_pair':
      return 'Four + two pairs';
    case 'bomb':
      return 'Bomb';
    case 'rocket':
      return 'Rocket';
  }
}
