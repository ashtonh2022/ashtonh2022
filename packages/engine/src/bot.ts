import type { BidAction, Card, Combo, HandAction, HandState, RuleSettings } from './types';
import { RANK } from './types';
import { analyze, bombStrength } from './combos';
import { decompose, findPlays, lowestSingle } from './plays';
import { applyAction, legalActions } from './hand';
import { isBombLike, rankKey } from './cardGroups';

// ---------------------------------------------------------------------------
// Hand strength
// ---------------------------------------------------------------------------

/**
 * A rough measure of how good a hand is: bombs, rockets, 2s and jokers count for a lot, and a hand
 * that splits into few combinations is better than one that splits into many. Roughly 0..12 for a
 * 17-card hand; an average hand scores about 2.5.
 */
export function handStrength(hand: Card[], rules: RuleSettings): number {
  if (hand.length === 0) return 0;
  const parts = decompose(hand, rules);
  let control = 0;
  for (const part of parts) {
    if (part.type === 'rocket') control += 3 + part.size;
    else if (part.type === 'bomb') control += part.size - 1;
  }
  for (const card of hand) {
    if (card.rank === RANK.TWO) control += 1;
    else if (card.rank >= RANK.BLACK_JOKER) control += 1.5;
  }
  const density = 17 / hand.length;
  const compactness = (hand.length / 2 - parts.length) * 0.5;
  return control * density + compactness;
}

const CALL_STRENGTH = 3.5;
const ROB_STRENGTH = 5.5;
const BID_STRENGTH: ReadonlyArray<[number, 1 | 2 | 3]> = [
  [6.5, 3],
  [5, 2],
  [3.5, 1],
];

// ---------------------------------------------------------------------------
// Bidding and doubling
// ---------------------------------------------------------------------------

/** A legal bid for `seat` from the hand's strength: call/rob (or bid) only with a strong hand. */
export function botBid(state: HandState, seat: number): BidAction {
  const legal = legalActions(state, seat);
  const strength = handStrength(state.hands[seat] ?? [], state.rules);
  if (legal.canCall && !legal.canPassBid) return { type: 'call' };
  if (legal.canCall) return strength >= CALL_STRENGTH ? { type: 'call' } : { type: 'pass_bid' };
  if (legal.canRob) return strength >= ROB_STRENGTH ? { type: 'rob' } : { type: 'pass_bid' };
  if (legal.bids.length > 0) {
    const wanted = BID_STRENGTH.find(([minimum]) => strength >= minimum)?.[1];
    if (wanted !== undefined && legal.bids.includes(wanted)) return { type: 'bid', value: wanted };
  }
  return { type: 'pass_bid' };
}

/** Whether `seat` doubles: the landlord with a strong hand, a peasant with a very strong one. */
export function botDouble(state: HandState, seat: number): boolean {
  const strength = handStrength(state.hands[seat] ?? [], state.rules);
  return seat === state.landlord ? strength >= 5.5 : strength >= 6;
}

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

function play(combo: Combo): HandAction {
  return { type: 'play', cardIds: combo.cards.map((card) => card.id) };
}

function lowestRank(combo: Combo): number {
  let low = RANK.RED_JOKER as number;
  for (const card of combo.cards) low = Math.min(low, card.rank);
  return low;
}

/** Leading preference: lowest card first, then the combo that spends more cards, then rank. */
function compareForLead(a: Combo, b: Combo): number {
  return lowestRank(a) - lowestRank(b) || b.cards.length - a.cards.length || a.rank - b.rank;
}

function weakestBomb(bombs: Combo[], rules: RuleSettings): Combo {
  return bombs.reduce((best, bomb) =>
    bombStrength(bomb, rules) < bombStrength(best, rules) ? bomb : best,
  );
}

/** Seats on the other side of `seat`, and the smallest hand among them. */
function fewestOpponentCards(state: HandState, seat: number): number {
  const landlord = state.landlord;
  let fewest = Number.POSITIVE_INFINITY;
  state.hands.forEach((hand, other) => {
    const opponent = seat === landlord ? other !== landlord : other === landlord;
    if (opponent) fewest = Math.min(fewest, hand.length);
  });
  return fewest;
}

function chooseLead(state: HandState, seat: number): Combo {
  const hand = state.hands[seat] ?? [];
  const rules = state.rules;
  // Going out in one play always wins.
  const whole = analyze(hand, rules);
  if (whole !== null) return whole;
  const parts = decompose(hand, rules);

  const nonBombs = parts.filter((part) => !isBombLike(part));
  const bombs = parts.filter(isBombLike);
  if (nonBombs.length === 0) return weakestBomb(bombs, rules);

  // An opponent about to go out: lead something they cannot answer with 1 or 2 cards, or else
  // the strongest thing available so the lead is hard to take.
  const threat = fewestOpponentCards(state, seat);
  if (threat <= 2) {
    const safe = nonBombs.filter((part) => part.cards.length > threat);
    if (safe.length > 0) return safe.reduce((a, b) => (compareForLead(b, a) < 0 ? b : a));
    return nonBombs.reduce((a, b) => (b.rank > a.rank ? b : a));
  }
  return nonBombs.reduce((a, b) => (compareForLead(b, a) < 0 ? b : a));
}

function chooseAnswer(state: HandState, seat: number, current: Combo): HandAction {
  const hand = state.hands[seat] ?? [];
  const rules = state.rules;
  const plays = findPlays(hand, current, rules);
  if (plays.length === 0) return { type: 'pass' };

  const finishing = plays.find((candidate) => candidate.cards.length === hand.length);
  if (finishing !== undefined) return play(finishing);

  const landlord = state.landlord;
  const isLandlord = seat === landlord;
  const partnerHolds = !isLandlord && state.trick.currentSeat !== landlord;
  const landlordCards = landlord === null ? 0 : (state.hands[landlord]?.length ?? 0);
  const threat = fewestOpponentCards(state, seat);
  const parts = decompose(hand, rules);
  const bombs = plays.filter(isBombLike);

  // Ordinary answers never break up a bomb or rocket the hand is holding.
  const reserved = new Set(
    parts.filter(isBombLike).flatMap((part) => part.cards.map((card) => card.id)),
  );
  const free = plays.filter(
    (candidate) =>
      !isBombLike(candidate) && candidate.cards.every((card) => !reserved.has(card.id)),
  );

  if (partnerHolds) {
    // Leave the trick to a partner unless the landlord is about to go out.
    if (landlordCards > 2 || free.length === 0) return { type: 'pass' };
    return play(free[free.length - 1] as Combo);
  }

  if (free.length > 0) {
    // An opponent nearly out: answer as high as possible so they cannot take the trick back.
    if (threat <= 2) return play(free[free.length - 1] as Combo);
    // Otherwise the weakest answer, preferring one that is a whole part of the decomposition.
    const intact = new Set(parts.map((part) => rankKey(part.cards)));
    const whole = free.find((candidate) => intact.has(rankKey(candidate.cards)));
    return play(whole ?? (free[0] as Combo));
  }

  // A bomb is the only answer: spend it when an opponent is nearly out, when the play being
  // answered is big, or when the rest of the hand is nearly gone anyway.
  if (bombs.length === 0) return play(plays[0] as Combo);
  const remainingParts = parts.filter((part) => !isBombLike(part)).length;
  const worthIt = threat <= 2 || current.cards.length >= 5 || remainingParts <= 2;
  return worthIt ? play(weakestBomb(bombs, rules)) : { type: 'pass' };
}

function isLegal(state: HandState, seat: number, action: HandAction): boolean {
  return applyAction(state, seat, action).ok;
}

/**
 * A legal play or pass for `seat`. Goes out when it can, otherwise leads from its decomposition
 * (lowest first) and answers with the weakest fitting combination, keeps bombs for when they
 * matter and never beats a partner who is winning the trick unless the landlord is nearly out.
 */
export function botPlay(state: HandState, seat: number): HandAction {
  const hand = state.hands[seat] ?? [];
  const current = state.trick.current;
  const choice =
    current === null ? play(chooseLead(state, seat)) : chooseAnswer(state, seat, current);
  if (isLegal(state, seat, choice)) return choice;

  // Defensive fallbacks: the heuristics above never reach this, but a legal action is a promise.
  const plays = findPlays(hand, current, state.rules);
  const first = plays[0];
  if (first !== undefined && isLegal(state, seat, play(first))) return play(first);
  if (current !== null) return { type: 'pass' };
  return hand.length > 0 ? play(lowestSingle(hand)) : { type: 'pass' };
}

/** The bot's action for the current phase (a pass when the hand is over). */
export function botAction(state: HandState, seat: number): HandAction {
  switch (state.phase) {
    case 'bidding':
      return botBid(state, seat);
    case 'doubling':
      return { type: 'double', double: botDouble(state, seat) };
    case 'playing':
      return botPlay(state, seat);
    default:
      return { type: 'pass' };
  }
}
