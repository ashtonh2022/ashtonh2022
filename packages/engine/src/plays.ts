import type { Card, Combo, ComboType, Rank, RuleSettings } from './types';
import { RANK } from './types';
import { sortCards } from './cards';
import { bombStrength, chainRanks } from './combos';
import {
  ALL_RANKS,
  NON_JOKER_RANKS,
  countOf,
  groupByRank,
  isBombLike,
  makeCombo,
  preferReading,
  rankSequence,
  takeOf,
  takeRanks,
  type RankGroups,
} from './cardGroups';

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

const TYPE_ORDER: Record<ComboType, number> = {
  single: 0,
  pair: 1,
  triple: 2,
  triple_single: 3,
  triple_pair: 4,
  straight: 5,
  pair_chain: 6,
  airplane: 7,
  airplane_single: 8,
  airplane_pair: 9,
  four_two_single: 10,
  four_two_pair: 11,
  bomb: 12,
  rocket: 13,
};

function compareSequences(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** Everything `compareCombos` looks at before falling back to the cards themselves. */
function compareComboHeads(a: Combo, b: Combo, rules: RuleSettings): number {
  const aBomb = isBombLike(a);
  const bBomb = isBombLike(b);
  if (aBomb !== bBomb) return aBomb ? 1 : -1;
  if (aBomb) return bombStrength(a, rules) - bombStrength(b, rules);
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.cards.length !== b.cards.length) return a.cards.length - b.cards.length;
  return TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
}

/** Weakest first: non-bombs by rank, size, type and kickers; bombs and rockets last by strength. */
export function compareCombos(a: Combo, b: Combo, rules: RuleSettings): number {
  return (
    compareComboHeads(a, b, rules) || compareSequences(rankSequence(a.cards), rankSequence(b.cards))
  );
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

interface FoundPlay {
  combo: Combo;
  /** ascending ranks of the cards: the play's identity and its tie-breaker when sorting */
  sequence: number[];
}

interface Generator {
  groups: RankGroups;
  chain: Rank[];
  rules: RuleSettings;
  /** Distinct plays keyed by rank structure. */
  found: Map<string, FoundPlay>;
}

function createGenerator(hand: Card[], rules: RuleSettings): Generator {
  return { groups: groupByRank(hand), chain: chainRanks(rules), rules, found: new Map() };
}

function add(gen: Generator, combo: Combo): void {
  const sequence = rankSequence(combo.cards);
  const key = sequence.join(',');
  const existing = gen.found.get(key);
  if (existing === undefined || preferReading(combo, existing.combo)) {
    gen.found.set(key, { combo, sequence });
  }
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

interface KickerOption {
  rank: Rank;
  /** how many kickers (singles or pairs) this rank can supply */
  max: number;
}

interface KickerPick {
  rank: Rank;
  count: number;
}

/**
 * Every multiset of `size` kickers drawn from `pool` (ascending rank order), never containing both
 * joker colours. `picks` is reused between callbacks.
 */
function forEachKickerSet(
  pool: KickerOption[],
  size: number,
  visit: (picks: readonly KickerPick[]) => void,
): void {
  const capacity: number[] = new Array<number>(pool.length + 1).fill(0);
  for (let i = pool.length - 1; i >= 0; i--) {
    capacity[i] = (capacity[i + 1] ?? 0) + (pool[i] as KickerOption).max;
  }
  const picks: KickerPick[] = [];
  const recurse = (index: number, remaining: number): void => {
    if (remaining === 0) {
      visit(picks);
      return;
    }
    if (index >= pool.length || (capacity[index] ?? 0) < remaining) return;
    const option = pool[index] as KickerOption;
    const blocked =
      option.rank === RANK.RED_JOKER && picks.some((pick) => pick.rank === RANK.BLACK_JOKER);
    if (!blocked) {
      for (let take = Math.min(option.max, remaining); take >= 1; take--) {
        picks.push({ rank: option.rank, count: take });
        recurse(index + 1, remaining - take);
        picks.pop();
      }
    }
    recurse(index + 1, remaining);
  };
  recurse(0, size);
}

function kickerPool(gen: Generator, excluded: readonly Rank[], perKicker: number): KickerOption[] {
  const pool: KickerOption[] = [];
  for (const rank of ALL_RANKS) {
    if (excluded.includes(rank)) continue;
    const max = Math.floor(countOf(gen.groups, rank) / perKicker);
    if (max > 0) pool.push({ rank, max });
  }
  return pool;
}

function kickerCards(gen: Generator, picks: readonly KickerPick[], perKicker: number): Card[] {
  const out: Card[] = [];
  for (let i = picks.length - 1; i >= 0; i--) {
    const pick = picks[i] as KickerPick;
    out.push(...takeOf(gen.groups, pick.rank, pick.count * perKicker));
  }
  return out;
}

/** Singles, pairs or triples of every rank above `minRank`. */
function genOfAKind(gen: Generator, size: 1 | 2 | 3, minRank: number): void {
  const type: ComboType = size === 1 ? 'single' : size === 2 ? 'pair' : 'triple';
  for (const rank of ALL_RANKS) {
    if (rank <= minRank || countOf(gen.groups, rank) < size) continue;
    add(gen, makeCombo(type, takeOf(gen.groups, rank, size), [], rank, 1));
  }
}

function genTripleWithKicker(gen: Generator, kicker: 'single' | 'pair', minRank: number): void {
  const perKicker = kicker === 'single' ? 1 : 2;
  const type: ComboType = kicker === 'single' ? 'triple_single' : 'triple_pair';
  for (const rank of NON_JOKER_RANKS) {
    if (rank <= minRank || countOf(gen.groups, rank) < 3) continue;
    const main = takeOf(gen.groups, rank, 3);
    for (const kickerRank of ALL_RANKS) {
      if (kickerRank === rank || countOf(gen.groups, kickerRank) < perKicker) continue;
      add(gen, makeCombo(type, main, takeOf(gen.groups, kickerRank, perKicker), rank, 1));
    }
  }
}

/** Calls `visit` for every run of `length` consecutive chain ranks holding `unit`+ cards each. */
function forEachWindow(
  gen: Generator,
  unit: number,
  length: number,
  minRank: number,
  visit: (window: Rank[]) => void,
): void {
  const chain = gen.chain;
  for (let start = 0; start + length <= chain.length; start++) {
    const top = chain[start + length - 1] as Rank;
    if (top <= minRank) continue;
    let ok = true;
    for (let i = start; i < start + length; i++) {
      if (countOf(gen.groups, chain[i] as Rank) < unit) {
        ok = false;
        break;
      }
    }
    if (ok) visit(chain.slice(start, start + length));
  }
}

function genChains(gen: Generator, unit: 1 | 2 | 3, lengths: number[], minRank: number): void {
  const type: ComboType = unit === 1 ? 'straight' : unit === 2 ? 'pair_chain' : 'airplane';
  for (const length of lengths) {
    forEachWindow(gen, unit, length, minRank, (window) => {
      const top = window[window.length - 1] as Rank;
      add(gen, makeCombo(type, takeRanks(gen.groups, window, unit), [], top, length));
    });
  }
}

function genAirplaneWithKickers(
  gen: Generator,
  kicker: 'single' | 'pair',
  lengths: number[],
  minRank: number,
): void {
  const perKicker = kicker === 'single' ? 1 : 2;
  const type: ComboType = kicker === 'single' ? 'airplane_single' : 'airplane_pair';
  for (const length of lengths) {
    forEachWindow(gen, 3, length, minRank, (window) => {
      const top = window[window.length - 1] as Rank;
      const main = takeRanks(gen.groups, window, 3);
      const pool = kickerPool(gen, window, perKicker);
      forEachKickerSet(pool, length, (picks) => {
        add(gen, makeCombo(type, main, kickerCards(gen, picks, perKicker), top, length));
      });
    });
  }
}

function genFourWithTwo(gen: Generator, kicker: 'single' | 'pair', minRank: number): void {
  const perKicker = kicker === 'single' ? 1 : 2;
  const type: ComboType = kicker === 'single' ? 'four_two_single' : 'four_two_pair';
  for (const rank of NON_JOKER_RANKS) {
    if (rank <= minRank || countOf(gen.groups, rank) < 4) continue;
    const main = takeOf(gen.groups, rank, 4);
    const pool = kickerPool(gen, [rank], perKicker);
    forEachKickerSet(pool, 2, (picks) => {
      add(gen, makeCombo(type, main, kickerCards(gen, picks, perKicker), rank, 1));
    });
  }
}

/** Every bomb (any size from 4 up to what the hand holds) stronger than `minStrength`. */
function genBombs(gen: Generator, minStrength: number): void {
  for (const rank of NON_JOKER_RANKS) {
    const count = Math.min(countOf(gen.groups, rank), 8);
    for (let size = 4; size <= count; size++) {
      const combo = makeCombo('bomb', takeOf(gen.groups, rank, size), [], rank, 1);
      if (bombStrength(combo, gen.rules) > minStrength) add(gen, combo);
    }
  }
}

/** Every rocket (one red + one black, and in 4p any 3 or 4 jokers) stronger than `minStrength`. */
function genRockets(gen: Generator, minStrength: number): void {
  const blacks = Math.min(countOf(gen.groups, RANK.BLACK_JOKER), 2);
  const reds = Math.min(countOf(gen.groups, RANK.RED_JOKER), 2);
  for (let black = 1; black <= blacks; black++) {
    for (let red = 1; red <= reds; red++) {
      const cards = [
        ...takeOf(gen.groups, RANK.RED_JOKER, red),
        ...takeOf(gen.groups, RANK.BLACK_JOKER, black),
      ];
      const combo = makeCombo('rocket', cards, [], RANK.RED_JOKER, 1);
      if (bombStrength(combo, gen.rules) > minStrength) add(gen, combo);
    }
  }
}

function genEverything(gen: Generator, handSize: number): void {
  const chainLength = gen.chain.length;
  genOfAKind(gen, 1, 0);
  genOfAKind(gen, 2, 0);
  genOfAKind(gen, 3, 0);
  genTripleWithKicker(gen, 'single', 0);
  genTripleWithKicker(gen, 'pair', 0);
  genChains(gen, 1, range(5, Math.min(chainLength, handSize)), 0);
  genChains(gen, 2, range(3, Math.min(chainLength, Math.floor(handSize / 2))), 0);
  genChains(gen, 3, range(2, Math.min(chainLength, Math.floor(handSize / 3))), 0);
  genAirplaneWithKickers(gen, 'single', range(2, Math.floor(handSize / 4)), 0);
  genAirplaneWithKickers(gen, 'pair', range(2, Math.floor(handSize / 5)), 0);
  genFourWithTwo(gen, 'single', 0);
  genFourWithTwo(gen, 'pair', 0);
  genBombs(gen, 0);
  genRockets(gen, 0);
}

function genAnswers(gen: Generator, current: Combo): void {
  const minRank = current.rank;
  switch (current.type) {
    case 'single':
      genOfAKind(gen, 1, minRank);
      break;
    case 'pair':
      genOfAKind(gen, 2, minRank);
      break;
    case 'triple':
      genOfAKind(gen, 3, minRank);
      break;
    case 'triple_single':
      genTripleWithKicker(gen, 'single', minRank);
      break;
    case 'triple_pair':
      genTripleWithKicker(gen, 'pair', minRank);
      break;
    case 'straight':
      genChains(gen, 1, [current.length], minRank);
      break;
    case 'pair_chain':
      genChains(gen, 2, [current.length], minRank);
      break;
    case 'airplane':
      genChains(gen, 3, [current.length], minRank);
      break;
    case 'airplane_single':
      genAirplaneWithKickers(gen, 'single', [current.length], minRank);
      break;
    case 'airplane_pair':
      genAirplaneWithKickers(gen, 'pair', [current.length], minRank);
      break;
    case 'four_two_single':
      genFourWithTwo(gen, 'single', minRank);
      break;
    case 'four_two_pair':
      genFourWithTwo(gen, 'pair', minRank);
      break;
    case 'bomb':
    case 'rocket':
      break;
  }
  const floor = isBombLike(current) ? bombStrength(current, gen.rules) : 0;
  genBombs(gen, floor);
  genRockets(gen, floor);
}

/**
 * Every legal play from `hand` that beats `current`, or every distinct leadable combination when
 * `current` is null. Plays are distinct by rank structure (cards of one rank, and jokers of one
 * colour, are interchangeable) and sorted weakest first with bombs and rockets last.
 */
export function findPlays(hand: Card[], current: Combo | null, rules: RuleSettings): Combo[] {
  const gen = createGenerator(hand, rules);
  if (current === null) genEverything(gen, hand.length);
  else genAnswers(gen, current);
  return [...gen.found.values()]
    .sort(
      (a, b) =>
        compareComboHeads(a.combo, b.combo, rules) || compareSequences(a.sequence, b.sequence),
    )
    .map((found) => found.combo);
}

// ---------------------------------------------------------------------------
// Decomposition and hints
// ---------------------------------------------------------------------------

/** The lowest card of the hand as a single. The hand must not be empty. */
export function lowestSingle(hand: Card[]): Combo {
  if (hand.length === 0) throw new Error('lowestSingle: the hand is empty');
  const sorted = sortCards(hand);
  const card = sorted[sorted.length - 1] as Card;
  return makeCombo('single', [card], [], card.rank, 1);
}

interface MutableGroups {
  counts: number[];
  cards: Card[][];
}

function takeFrom(groups: MutableGroups, rank: Rank, n: number): Card[] {
  const bucket = groups.cards[rank] ?? [];
  groups.counts[rank] = (groups.counts[rank] ?? 0) - n;
  return bucket.splice(0, n);
}

function remaining(groups: MutableGroups, rank: Rank): number {
  return groups.counts[rank] ?? 0;
}

/** Repeatedly pulls the longest run of `unit` cards per consecutive chain rank (at least `minLength`). */
function extractRuns(
  groups: MutableGroups,
  chain: Rank[],
  unit: number,
  minLength: number,
  type: ComboType,
  out: Combo[],
): void {
  for (;;) {
    let bestStart = -1;
    let bestLength = 0;
    let i = 0;
    while (i < chain.length) {
      if (remaining(groups, chain[i] as Rank) < unit) {
        i++;
        continue;
      }
      let j = i;
      while (j < chain.length && remaining(groups, chain[j] as Rank) >= unit) j++;
      if (j - i > bestLength) {
        bestLength = j - i;
        bestStart = i;
      }
      i = j;
    }
    if (bestLength < minLength) return;
    const window = chain.slice(bestStart, bestStart + bestLength);
    const main: Card[] = [];
    for (let k = window.length - 1; k >= 0; k--)
      main.push(...takeFrom(groups, window[k] as Rank, unit));
    out.push(makeCombo(type, main, [], window[window.length - 1] as Rank, bestLength));
  }
}

/**
 * A greedy split of a hand into few strong combinations: rockets and bombs kept whole, then the
 * longest airplanes, pair chains and straights, then triples, pairs and singles. Leftover singles
 * (then pairs) are attached as kickers to airplanes and triples. Every card is used exactly once.
 */
export function decompose(hand: Card[], rules: RuleSettings): Combo[] {
  const grouped = groupByRank(hand);
  const groups: MutableGroups = {
    counts: grouped.counts.slice(),
    cards: grouped.cards.map((bucket) => bucket.slice()),
  };
  const chain = chainRanks(rules);
  const out: Combo[] = [];

  const blacks = remaining(groups, RANK.BLACK_JOKER);
  const reds = remaining(groups, RANK.RED_JOKER);
  if (blacks > 0 && reds > 0) {
    const jokers = [
      ...takeFrom(groups, RANK.RED_JOKER, reds),
      ...takeFrom(groups, RANK.BLACK_JOKER, blacks),
    ];
    out.push(makeCombo('rocket', jokers, [], RANK.RED_JOKER, 1));
  }
  for (const rank of NON_JOKER_RANKS) {
    const count = remaining(groups, rank);
    if (count >= 4) out.push(makeCombo('bomb', takeFrom(groups, rank, count), [], rank, 1));
  }

  const mains: Combo[] = [];
  extractRuns(groups, chain, 3, 2, 'airplane', mains);
  extractRuns(groups, chain, 2, 3, 'pair_chain', out);
  extractRuns(groups, chain, 1, 5, 'straight', out);

  const pairs: Combo[] = [];
  const singles: Combo[] = [];
  for (const rank of ALL_RANKS) {
    const count = remaining(groups, rank);
    if (count === 3) mains.push(makeCombo('triple', takeFrom(groups, rank, 3), [], rank, 1));
    else if (count === 2) pairs.push(makeCombo('pair', takeFrom(groups, rank, 2), [], rank, 1));
    else if (count === 1) singles.push(makeCombo('single', takeFrom(groups, rank, 1), [], rank, 1));
  }

  // Attach the lowest leftover singles (else pairs) as kickers, one per triple.
  for (const main of mains) {
    const needed = main.length;
    const isAirplane = main.type === 'airplane';
    if (singles.length >= needed) {
      const kickers = singles.splice(0, needed).flatMap((s) => s.cards);
      const type: ComboType = isAirplane ? 'airplane_single' : 'triple_single';
      out.push(makeCombo(type, main.cards, sortCards(kickers), main.rank, main.length));
    } else if (pairs.length >= needed) {
      const kickers = pairs.splice(0, needed).flatMap((p) => p.cards);
      const type: ComboType = isAirplane ? 'airplane_pair' : 'triple_pair';
      out.push(makeCombo(type, main.cards, sortCards(kickers), main.rank, main.length));
    } else {
      out.push(main);
    }
  }
  out.push(...pairs, ...singles);
  return out.sort((a, b) => compareCombos(a, b, rules));
}

/** Leading preference: lowest card first, then the combo that gets rid of more cards. */
function compareForLead(a: Combo, b: Combo): number {
  const lowA = Math.min(...a.cards.map((card) => card.rank));
  const lowB = Math.min(...b.cards.map((card) => card.rank));
  if (lowA !== lowB) return lowA - lowB;
  if (a.cards.length !== b.cards.length) return b.cards.length - a.cards.length;
  return a.rank - b.rank;
}

/**
 * A suggested play. Answering: the weakest legal non-bomb, else the weakest bomb or rocket, else
 * null. Leading: the weakest non-bomb part of `decompose(hand)` (preferring parts that spend more
 * low cards), or the weakest bomb when the hand is nothing but bombs. Null only for an empty hand.
 */
export function hint(hand: Card[], current: Combo | null, rules: RuleSettings): Combo | null {
  if (hand.length === 0) return null;
  if (current !== null) {
    const plays = findPlays(hand, current, rules);
    if (plays.length === 0) return null;
    return plays.find((play) => !isBombLike(play)) ?? (plays[0] as Combo);
  }
  const parts = decompose(hand, rules);
  const nonBombs = parts.filter((part) => !isBombLike(part));
  if (nonBombs.length > 0) {
    return nonBombs.reduce((best, part) => (compareForLead(part, best) < 0 ? part : best));
  }
  return parts.reduce((best, part) =>
    bombStrength(part, rules) < bombStrength(best, rules) ? part : best,
  );
}
