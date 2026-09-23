import type {
  ApplyResult,
  BidAction,
  BidRecord,
  Card,
  EngineErrorCode,
  HandAction,
  HandEvent,
  HandState,
  HandView,
  LegalActions,
  RuleSettings,
  TrickState,
} from './types';
import { cardById, createDeck, removeCards, seededRng, shuffle, sortCards } from './cards';
import { cardsPerPlayer } from './rules';
import { analyze, analyzeAs, beats } from './combos';
import { lowestSingle } from './plays';
import { isBombLike } from './cardGroups';
import { currentStake, settle } from './scoring';

export interface CreateHandOptions {
  rules: RuleSettings;
  /** Shuffle seed; the same seed and rules always deal the same hand. */
  seed: string;
  /** Hand number within the room, starting at 1. */
  handNumber: number;
  firstBidder: number;
}

/** `turn` while nobody in particular must act (doubling round, redeal, finished). */
export const NO_SEAT = -1;

const NO_ACTIONS: LegalActions = {
  canCall: false,
  canRob: false,
  canPassBid: false,
  bids: [],
  canDouble: false,
  canPlay: false,
  canPass: false,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(code: EngineErrorCode, error: string): ApplyResult {
  return { ok: false, error, code };
}

function ok(state: HandState, events: HandEvent[]): ApplyResult {
  return { ok: true, state, events };
}

function isSeat(state: HandState, seat: unknown): seat is number {
  return (
    typeof seat === 'number' &&
    Number.isInteger(seat) &&
    seat >= 0 &&
    seat < state.rules.playerCount
  );
}

function setAt<T>(items: readonly T[], index: number, value: T): T[] {
  const out = items.slice();
  out[index] = value;
  return out;
}

function emptyTrick(leader: number): TrickState {
  return { leader, plays: [], current: null, currentSeat: null };
}

function nextSeat(state: HandState, seat: number): number {
  return (seat + 1) % state.rules.playerCount;
}

function isBidAction(action: HandAction): action is BidAction {
  return (
    action.type === 'call' ||
    action.type === 'rob' ||
    action.type === 'pass_bid' ||
    action.type === 'bid'
  );
}

/** Seats in bidding order: the first bidder, then clockwise. */
function biddingOrder(state: HandState): number[] {
  const order: number[] = [];
  for (let i = 0; i < state.rules.playerCount; i++) {
    order.push((state.firstBidder + i) % state.rules.playerCount);
  }
  return order;
}

function lastBidder(state: HandState): number {
  return (state.firstBidder + state.rules.playerCount - 1) % state.rules.playerCount;
}

/** The seat that bids after `seat`, or null when `seat` is the last in bidding order. */
function seatAfterInOrder(state: HandState, seat: number): number | null {
  return seat === lastBidder(state) ? null : nextSeat(state, seat);
}

/**
 * True when `seat` is the last bidder, everyone before them passed and the room forces a
 * landlord: that seat may only call (call mode).
 */
function isForcedCall(state: HandState, seat: number): boolean {
  if (state.phase !== 'bidding' || state.rules.biddingMode !== 'call') return false;
  if (state.rules.allPass !== 'force' || state.bidding.caller !== null) return false;
  if (seat !== state.turn || seat !== lastBidder(state)) return false;
  return state.bidding.passed.every((passed, other) => passed || other === seat);
}

/** The trick number the next play or pass belongs to. */
function currentTrickNumber(state: HandState): number {
  const last = state.history[state.history.length - 1];
  if (last === undefined) return 1;
  return state.trick.plays.length === 0 ? last.trickNumber + 1 : last.trickNumber;
}

// ---------------------------------------------------------------------------
// Dealing
// ---------------------------------------------------------------------------

/** Shuffles with the seed, deals every seat in order and leaves the rest as the face-down kitty. */
export function createHand(opts: CreateHandOptions): HandState {
  const { rules, seed, handNumber } = opts;
  const seatCount = rules.playerCount;
  const firstBidder = ((opts.firstBidder % seatCount) + seatCount) % seatCount;
  const deck = shuffle(createDeck(seatCount), seededRng(seed));
  const perSeat = cardsPerPlayer(rules);
  const hands: Card[][] = [];
  for (let seat = 0; seat < seatCount; seat++) {
    hands.push(sortCards(deck.slice(seat * perSeat, (seat + 1) * perSeat)));
  }
  const kitty = deck.slice(seatCount * perSeat);
  const flags = (): boolean[] => new Array<boolean>(seatCount).fill(false);
  return {
    rules,
    seed,
    handNumber,
    phase: 'bidding',
    hands,
    kitty,
    kittyRevealed: false,
    firstBidder,
    turn: firstBidder,
    bidding: {
      records: [],
      caller: null,
      claimant: null,
      highestBid: 0,
      robs: 0,
      passed: flags(),
      robDecided: flags(),
      robBackOffered: false,
    },
    landlord: null,
    base: 1,
    doubles: rules.doublingRound ? new Array<boolean | null>(seatCount).fill(null) : flags(),
    trick: emptyTrick(NO_SEAT),
    history: [],
    playCounts: new Array<number>(seatCount).fill(0),
    bombsPlayed: 0,
    result: null,
  };
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/**
 * Applies one action for one seat. Never mutates `state`; on success the new state and the events
 * that describe what happened are returned, otherwise an error code and a message.
 */
export function applyAction(state: HandState, seat: number, action: HandAction): ApplyResult {
  if (!isSeat(state, seat)) return fail('invalid_action', `seat ${String(seat)} does not exist`);
  if (typeof action !== 'object' || action === null || typeof action.type !== 'string') {
    return fail('invalid_action', 'malformed action');
  }
  switch (state.phase) {
    case 'bidding':
      if (!isBidAction(action)) return fail('wrong_phase', 'the hand is in the bidding phase');
      return applyBid(state, seat, action);
    case 'doubling':
      if (action.type !== 'double') return fail('wrong_phase', 'the hand is in the doubling round');
      return applyDouble(state, seat, action.double === true);
    case 'playing':
      if (action.type === 'play') return applyPlay(state, seat, action.cardIds);
      if (action.type === 'pass') return applyPass(state, seat);
      return fail('wrong_phase', 'the hand is being played');
    default:
      return fail('wrong_phase', `the hand is ${state.phase}`);
  }
}

// ---------------------------------------------------------------------------
// Bidding
// ---------------------------------------------------------------------------

function record(
  state: HandState,
  entry: BidRecord,
  events: HandEvent[],
  changes: Partial<HandState['bidding']>,
): HandState {
  events.push({ type: 'bid', seat: entry.seat, record: entry });
  return {
    ...state,
    bidding: { ...state.bidding, ...changes, records: [...state.bidding.records, entry] },
  };
}

function applyBid(state: HandState, seat: number, action: BidAction): ApplyResult {
  if (seat !== state.turn) return fail('not_your_turn', `seat ${state.turn} must bid`);
  return state.rules.biddingMode === 'call'
    ? applyCallBid(state, seat, action)
    : applyPointsBid(state, seat, action);
}

function applyCallBid(state: HandState, seat: number, action: BidAction): ApplyResult {
  const events: HandEvent[] = [];
  const bidding = state.bidding;

  if (bidding.caller === null) {
    if (action.type === 'call') {
      const next = record(state, { seat, action: 'call' }, events, {
        caller: seat,
        claimant: seat,
      });
      return continueRobRound(next, events);
    }
    if (action.type === 'pass_bid') {
      if (isForcedCall(state, seat)) {
        return fail('invalid_action', 'everyone else passed: the last bidder must call');
      }
      const next = record(state, { seat, action: 'pass' }, events, {
        passed: setAt(bidding.passed, seat, true),
      });
      const following = seatAfterInOrder(state, seat);
      if (following === null) return everyonePassed(next, events);
      return ok({ ...next, turn: following }, events);
    }
    return fail('invalid_action', `cannot ${action.type} before anyone has called`);
  }

  if (action.type === 'rob' || action.type === 'pass_bid') {
    const robbing = action.type === 'rob';
    const next = record(state, { seat, action: robbing ? 'rob' : 'pass' }, events, {
      robDecided: setAt(bidding.robDecided, seat, true),
      passed: robbing ? bidding.passed : setAt(bidding.passed, seat, true),
      robs: robbing ? bidding.robs + 1 : bidding.robs,
      claimant: robbing ? seat : bidding.claimant,
    });
    if (bidding.robBackOffered) {
      return chooseLandlord(next, next.bidding.claimant as number, 1, events);
    }
    return continueRobRound(next, events);
  }
  return fail('invalid_action', `cannot ${action.type} once someone has called`);
}

/** The next seat after the caller in bidding order that has neither passed nor decided on robbing. */
function nextRobCandidate(state: HandState): number | null {
  const order = biddingOrder(state);
  const start = order.indexOf(state.bidding.caller as number) + 1;
  for (let i = start; i < order.length; i++) {
    const seat = order[i] as number;
    if (!state.bidding.passed[seat] && !state.bidding.robDecided[seat]) return seat;
  }
  return null;
}

function continueRobRound(state: HandState, events: HandEvent[]): ApplyResult {
  const bidding = state.bidding;
  const candidate = nextRobCandidate(state);
  if (candidate !== null) return ok({ ...state, turn: candidate }, events);
  if (bidding.robs > 0 && !bidding.robBackOffered) {
    const offered = { ...state, bidding: { ...bidding, robBackOffered: true } };
    return ok({ ...offered, turn: bidding.caller as number }, events);
  }
  return chooseLandlord(state, bidding.claimant as number, 1, events);
}

function applyPointsBid(state: HandState, seat: number, action: BidAction): ApplyResult {
  const events: HandEvent[] = [];
  const bidding = state.bidding;
  if (action.type === 'bid') {
    const value = action.value;
    if (value !== 1 && value !== 2 && value !== 3) {
      return fail('invalid_action', 'a bid must be 1, 2 or 3');
    }
    if (value <= bidding.highestBid) {
      return fail('invalid_action', `a bid must be higher than ${bidding.highestBid}`);
    }
    const next = record(state, { seat, action: 'bid', value }, events, {
      highestBid: value,
      claimant: seat,
    });
    const raised = { ...next, base: value };
    if (value === 3) return chooseLandlord(raised, seat, 3, events);
    return continuePointsRound(raised, seat, events);
  }
  if (action.type === 'pass_bid') {
    const next = record(state, { seat, action: 'pass' }, events, {
      passed: setAt(bidding.passed, seat, true),
    });
    return continuePointsRound(next, seat, events);
  }
  return fail('invalid_action', 'call and rob are not used in points bidding');
}

function continuePointsRound(state: HandState, seat: number, events: HandEvent[]): ApplyResult {
  const following = seatAfterInOrder(state, seat);
  if (following !== null) return ok({ ...state, turn: following }, events);
  const { claimant, highestBid } = state.bidding;
  if (claimant !== null) return chooseLandlord(state, claimant, highestBid, events);
  return everyonePassed(state, events);
}

function everyonePassed(state: HandState, events: HandEvent[]): ApplyResult {
  if (state.rules.allPass === 'redeal') {
    events.push({ type: 'redeal' });
    return ok({ ...state, phase: 'redeal', turn: NO_SEAT }, events);
  }
  return chooseLandlord(state, lastBidder(state), 1, events);
}

function chooseLandlord(
  state: HandState,
  seat: number,
  base: number,
  events: HandEvent[],
): ApplyResult {
  const hands = state.hands.map((hand, other) =>
    other === seat ? sortCards([...hand, ...state.kitty]) : hand,
  );
  events.push({ type: 'landlord_chosen', seat, base, kitty: state.kitty });
  const chosen: HandState = { ...state, hands, kittyRevealed: true, landlord: seat, base };
  if (state.rules.doublingRound) {
    events.push({ type: 'doubling_started' });
    return ok({ ...chosen, phase: 'doubling', turn: NO_SEAT }, events);
  }
  return ok(startPlaying(chosen), events);
}

function startPlaying(state: HandState): HandState {
  const landlord = state.landlord as number;
  return { ...state, phase: 'playing', turn: landlord, trick: emptyTrick(landlord) };
}

// ---------------------------------------------------------------------------
// Doubling round
// ---------------------------------------------------------------------------

function applyDouble(state: HandState, seat: number, double: boolean): ApplyResult {
  if (state.doubles[seat] !== null) return fail('invalid_action', 'you have already decided');
  const doubles = setAt(state.doubles, seat, double);
  const events: HandEvent[] = [{ type: 'double', seat, double }];
  if (doubles.every((choice) => choice !== null)) {
    events.push({ type: 'doubling_finished', doubles: doubles.map((choice) => choice === true) });
    return ok(startPlaying({ ...state, doubles }), events);
  }
  return ok({ ...state, doubles }, events);
}

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

function applyPlay(state: HandState, seat: number, cardIds: string[]): ApplyResult {
  if (seat !== state.turn) return fail('not_your_turn', `seat ${state.turn} must play`);
  const hand = state.hands[seat] ?? [];
  if (!Array.isArray(cardIds) || cardIds.length === 0) {
    return fail('invalid_action', 'a play needs at least one card');
  }
  const cards: Card[] = [];
  const seen = new Set<string>();
  for (const id of cardIds) {
    const card = typeof id === 'string' ? cardById(hand, id) : undefined;
    if (card === undefined || seen.has(id)) {
      return fail('cards_not_in_hand', `card ${String(id)} is not in your hand`);
    }
    seen.add(id);
    cards.push(card);
  }

  const current = state.trick.current;
  const combo =
    current === null ? analyze(cards, state.rules) : analyzeAs(cards, state.rules, current);
  if (combo === null) return fail('invalid_combo', 'those cards are not a legal combination');
  if (current !== null && !beats(combo, current, state.rules)) {
    return fail('does_not_beat', 'that does not beat the current combination');
  }

  const remaining = removeCards(hand, cards);
  const trickNumber = currentTrickNumber(state);
  const next: HandState = {
    ...state,
    hands: state.hands.map((cards, other) => (other === seat ? remaining : cards)),
    trick: {
      ...state.trick,
      plays: [...state.trick.plays, { seat, combo }],
      current: combo,
      currentSeat: seat,
    },
    history: [...state.history, { seat, combo, trickNumber }],
    playCounts: setAt(state.playCounts, seat, (state.playCounts[seat] ?? 0) + 1),
    bombsPlayed: state.bombsPlayed + (isBombLike(combo) ? 1 : 0),
  };
  const events: HandEvent[] = [{ type: 'play', seat, combo }];
  if (remaining.length === 0) {
    const finished: HandState = { ...next, phase: 'finished', turn: NO_SEAT };
    const result = settle(finished);
    events.push({ type: 'hand_finished', result });
    return ok({ ...finished, result }, events);
  }
  return ok({ ...next, turn: nextSeat(state, seat) }, events);
}

function applyPass(state: HandState, seat: number): ApplyResult {
  if (seat !== state.turn) return fail('not_your_turn', `seat ${state.turn} must play`);
  if (state.trick.current === null) return fail('cannot_pass', 'the leader of a trick cannot pass');
  const trickNumber = currentTrickNumber(state);
  const plays = [...state.trick.plays, { seat, combo: null }];
  const history = [...state.history, { seat, combo: null, trickNumber }];
  const events: HandEvent[] = [{ type: 'pass', seat }];

  let passesInARow = 0;
  for (let i = plays.length - 1; i >= 0 && plays[i]?.combo === null; i--) passesInARow++;
  if (passesInARow >= state.rules.playerCount - 1) {
    const winner = state.trick.currentSeat as number;
    events.push({ type: 'trick_won', seat: winner });
    return ok({ ...state, history, trick: emptyTrick(winner), turn: winner }, events);
  }
  return ok(
    { ...state, history, trick: { ...state.trick, plays }, turn: nextSeat(state, seat) },
    events,
  );
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** What `seat` may do right now. Everything is false for spectators and seats that must wait. */
export function legalActions(state: HandState, seat: number | null): LegalActions {
  const none: LegalActions = { ...NO_ACTIONS, bids: [] };
  if (seat === null || !isSeat(state, seat)) return none;
  switch (state.phase) {
    case 'bidding': {
      if (seat !== state.turn) return none;
      if (state.rules.biddingMode === 'call') {
        if (state.bidding.caller === null) {
          return { ...none, canCall: true, canPassBid: !isForcedCall(state, seat) };
        }
        return { ...none, canRob: true, canPassBid: true };
      }
      const bids = ([1, 2, 3] as const).filter((value) => value > state.bidding.highestBid);
      return { ...none, bids, canPassBid: true };
    }
    case 'doubling':
      return { ...none, canDouble: state.doubles[seat] === null };
    case 'playing':
      if (seat !== state.turn) return none;
      return { ...none, canPlay: true, canPass: state.trick.current !== null };
    default:
      return none;
  }
}

/**
 * The state as one seat may see it (a spectator when `seat` is null): only their own cards, the
 * kitty once revealed, and other seats' doubling choices only once the round is over.
 */
export function viewHand(state: HandState, seat: number | null): HandView {
  const viewer = seat !== null && isSeat(state, seat) ? seat : null;
  const hideDoubles = state.phase === 'doubling';
  return {
    rules: state.rules,
    handNumber: state.handNumber,
    phase: state.phase,
    seat: viewer,
    hand: viewer === null ? [] : (state.hands[viewer] ?? []),
    cardCounts: state.hands.map((hand) => hand.length),
    kitty: state.kittyRevealed ? state.kitty : null,
    kittySize: state.rules.kittySize,
    firstBidder: state.firstBidder,
    turn: state.turn,
    bidding: state.bidding,
    landlord: state.landlord,
    base: state.base,
    doubles: hideDoubles
      ? state.doubles.map((choice, other) => (other === viewer ? choice : null))
      : state.doubles,
    trick: state.trick,
    history: state.history,
    playCounts: state.playCounts,
    bombsPlayed: state.bombsPlayed,
    currentStake: currentStake(state),
    result: state.result,
    legal: legalActions(state, viewer),
  };
}

/**
 * The action the server applies for a human whose timer ran out: pass when bidding (call when
 * they are the forced last bidder), keep in the doubling round, pass when answering and the
 * lowest single card when leading.
 */
export function timeoutAction(state: HandState, seat: number): HandAction {
  switch (state.phase) {
    case 'bidding':
      return isForcedCall(state, seat) ? { type: 'call' } : { type: 'pass_bid' };
    case 'doubling':
      return { type: 'double', double: false };
    case 'playing': {
      if (state.trick.current !== null) return { type: 'pass' };
      const hand = state.hands[seat] ?? [];
      if (hand.length === 0) return { type: 'pass' };
      return { type: 'play', cardIds: lowestSingle(hand).cards.map((card) => card.id) };
    }
    default:
      return { type: 'pass' };
  }
}

/**
 * Who bids first in the next hand: the previous winner (the seat after the previous first bidder
 * when that hand was redealt), the next seat clockwise, or a random seat. Random for the first
 * hand of a room in every mode.
 */
export function nextFirstBidder(
  rules: RuleSettings,
  previous: HandState | null,
  rng: () => number,
): number {
  const seatCount = rules.playerCount;
  const random = (): number => Math.min(seatCount - 1, Math.max(0, Math.floor(rng() * seatCount)));
  if (previous === null) return random();
  const rotated = (previous.firstBidder + 1) % seatCount;
  // RULES.md, "Everyone passes": after a redeal the player after the previous first bidder
  // starts the new bidding, whatever the first-bidder option is.
  if (previous.phase === 'redeal') return rotated;
  switch (rules.firstBidder) {
    case 'random':
      return random();
    case 'rotate':
      return rotated;
    default:
      if (previous.result === null) return rotated;
      return previous.result.winnerSeat % seatCount;
  }
}
