/**
 * Adversarial verification, round 1: the bidding state machine.
 * Spec: docs/RULES.md ("Bidding", "Everyone passes", "Who bids first", "Turn timer") and
 * docs/ENGINE_API.md (hand.ts). Failing tests document engine bugs for the fixer; passing tests
 * are regression coverage.
 *
 * The core of this file is an independent reference model of the bidding rules and an exhaustive
 * walk over every legal bidding sequence in every configuration, comparing the engine's turn,
 * legal actions, timeout action, events and outcome with the model at every step.
 */
import { describe, expect, it } from 'vitest';

import type {
  BidAction,
  BidRecord,
  Card,
  HandAction,
  HandEvent,
  HandState,
  LegalActions,
  RuleSettings,
} from '../types';
import {
  applyAction,
  createHand,
  legalActions,
  nextFirstBidder,
  timeoutAction,
  viewHand,
} from '../hand';
import { compareCardsForDisplay } from '../cards';
import { cardsPerPlayer } from '../rules';
import {
  RULES_3P,
  RULES_4P,
  cards,
  deepFreeze,
  play,
  playingState,
  rejection,
  run,
  step,
} from '../test-helpers';

const CALL: BidAction = { type: 'call' };
const ROB: BidAction = { type: 'rob' };
const PASS_BID: BidAction = { type: 'pass_bid' };
const bid = (value: 1 | 2 | 3): BidAction => ({ type: 'bid', value });
const EVERY_BID: BidAction[] = [CALL, ROB, PASS_BID, bid(1), bid(2), bid(3)];

const NONE: LegalActions = {
  canCall: false,
  canRob: false,
  canPassBid: false,
  bids: [],
  canDouble: false,
  canPlay: false,
  canPass: false,
};

const POINTS_3P: RuleSettings = { ...RULES_3P, biddingMode: 'points' };
const POINTS_4P: RuleSettings = { ...RULES_4P, biddingMode: 'points' };
const REDEAL_4P: RuleSettings = { ...RULES_4P, allPass: 'redeal' };

function fresh(
  rules: RuleSettings = RULES_3P,
  firstBidder = 0,
  seed = 'verify-bidding',
): HandState {
  return createHand({ rules, seed, handNumber: 1, firstBidder });
}

function ids(set: readonly Card[]): string[] {
  return set.map((card) => card.id).sort();
}

function types(events: HandEvent[]): string[] {
  return events.map((event) => event.type);
}

function isDisplaySorted(hand: readonly Card[]): boolean {
  for (let i = 1; i < hand.length; i++) {
    if (compareCardsForDisplay(hand[i - 1] as Card, hand[i] as Card) > 0) return false;
  }
  return true;
}

function describeAction(action: BidAction): string {
  return action.type === 'bid' ? `bid${action.value}` : action.type;
}

function recordOf(seat: number, action: BidAction): BidRecord {
  if (action.type === 'bid') return { seat, action: 'bid', value: action.value };
  return { seat, action: action.type === 'pass_bid' ? 'pass' : action.type };
}

// ---------------------------------------------------------------------------
// Reference model of RULES.md "Bidding" / "Everyone passes", written independently of hand.ts.
// ---------------------------------------------------------------------------

type Outcome = { landlord: number; base: number; robs: number } | 'redeal' | null;

interface Ref {
  order: number[];
  /** Position in `order` of the next seat to be asked (call round, rob round or points round). */
  pos: number;
  caller: number | null;
  claimant: number | null;
  robs: number;
  highest: number;
  /** The caller is now deciding on the final rob-back. */
  robBack: boolean;
  outcome: Outcome;
}

function refStart(rules: RuleSettings, firstBidder: number): Ref {
  const n = rules.playerCount;
  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push((firstBidder + i) % n);
  return {
    order,
    pos: 0,
    caller: null,
    claimant: null,
    robs: 0,
    highest: 0,
    robBack: false,
    outcome: null,
  };
}

function refTurn(ref: Ref): number {
  if (ref.outcome !== null) return -1;
  if (ref.robBack) return ref.caller as number;
  return ref.order[ref.pos] as number;
}

/** The last seat in order, everyone before passed, the room forces a landlord: call only. */
function refForced(rules: RuleSettings, ref: Ref): boolean {
  return (
    rules.biddingMode === 'call' &&
    rules.allPass === 'force' &&
    ref.caller === null &&
    ref.pos === ref.order.length - 1
  );
}

function refLegal(rules: RuleSettings, ref: Ref): LegalActions {
  if (rules.biddingMode === 'points') {
    const bids = ([1, 2, 3] as const).filter((value) => value > ref.highest);
    return { ...NONE, bids, canPassBid: true };
  }
  if (ref.caller === null) return { ...NONE, canCall: true, canPassBid: !refForced(rules, ref) };
  return { ...NONE, canRob: true, canPassBid: true };
}

function refOptions(legal: LegalActions): BidAction[] {
  const options: BidAction[] = [];
  if (legal.canCall) options.push(CALL);
  if (legal.canRob) options.push(ROB);
  for (const value of legal.bids) options.push(bid(value));
  if (legal.canPassBid) options.push(PASS_BID);
  return options;
}

function refAllPassed(rules: RuleSettings, ref: Ref): Ref {
  if (rules.allPass === 'redeal') return { ...ref, outcome: 'redeal' };
  const last = ref.order[ref.order.length - 1] as number;
  return { ...ref, outcome: { landlord: last, base: 1, robs: 0 } };
}

/** Applies an action the model says is legal for the seat on turn. */
function refApply(rules: RuleSettings, ref: Ref, action: BidAction): Ref {
  const seat = refTurn(ref);
  const n = ref.order.length;
  if (rules.biddingMode === 'points') {
    if (action.type === 'bid') {
      const next = { ...ref, highest: action.value, claimant: seat, pos: ref.pos + 1 };
      if (action.value === 3 || next.pos === n) {
        return { ...next, outcome: { landlord: seat, base: action.value, robs: 0 } };
      }
      return next;
    }
    const next = { ...ref, pos: ref.pos + 1 };
    if (next.pos < n) return next;
    if (next.claimant !== null) {
      return { ...next, outcome: { landlord: next.claimant, base: next.highest, robs: 0 } };
    }
    return refAllPassed(rules, next);
  }
  if (ref.robBack) {
    const robs = action.type === 'rob' ? ref.robs + 1 : ref.robs;
    const claimant = action.type === 'rob' ? seat : (ref.claimant as number);
    return { ...ref, robs, claimant, outcome: { landlord: claimant, base: 1, robs } };
  }
  if (ref.caller === null) {
    if (action.type === 'call') {
      const next = { ...ref, caller: seat, claimant: seat, pos: ref.pos + 1 };
      return next.pos === n ? { ...next, outcome: { landlord: seat, base: 1, robs: 0 } } : next;
    }
    const next = { ...ref, pos: ref.pos + 1 };
    return next.pos === n ? refAllPassed(rules, next) : next;
  }
  const robs = action.type === 'rob' ? ref.robs + 1 : ref.robs;
  const claimant = action.type === 'rob' ? seat : (ref.claimant as number);
  const next = { ...ref, robs, claimant, pos: ref.pos + 1 };
  if (next.pos < n) return next;
  if (robs > 0) return { ...next, robBack: true };
  return { ...next, outcome: { landlord: claimant, base: 1, robs } };
}

// ---------------------------------------------------------------------------
// Exhaustive walk: every legal sequence in a configuration, checked at every step.
// ---------------------------------------------------------------------------

function checkOutcome(
  rules: RuleSettings,
  start: HandState,
  state: HandState,
  lastEvents: HandEvent[],
  outcome: Exclude<Outcome, null>,
  actionCount: number,
  label: string,
): void {
  if (outcome === 'redeal') {
    expect(state.phase, label).toBe('redeal');
    expect(state.turn, label).toBe(-1);
    expect(state.landlord, label).toBeNull();
    expect(state.kittyRevealed, label).toBe(false);
    expect(types(lastEvents), label).toEqual(['bid', 'redeal']);
    expect(viewHand(state, null).kitty, label).toBeNull();
    for (let seat = 0; seat < rules.playerCount; seat++) {
      expect(legalActions(state, seat), label).toEqual(NONE);
      expect(rejection(applyAction(state, seat, CALL)), label).toBe('wrong_phase');
    }
    return;
  }
  expect(state.landlord, label).toBe(outcome.landlord);
  expect(state.base, label).toBe(outcome.base);
  expect(state.bidding.robs, label).toBe(outcome.robs);
  expect(state.bidding.records.length, label).toBe(actionCount);
  expect(state.kittyRevealed, label).toBe(true);
  expect(state.phase, label).toBe(rules.doublingRound ? 'doubling' : 'playing');
  expect(state.turn, label).toBe(rules.doublingRound ? -1 : outcome.landlord);
  const chosen = lastEvents.find((event) => event.type === 'landlord_chosen');
  expect(chosen, label).toEqual({
    type: 'landlord_chosen',
    seat: outcome.landlord,
    base: outcome.base,
    kitty: start.kitty,
  });
  expect(types(lastEvents), label).toEqual(
    rules.doublingRound
      ? ['bid', 'landlord_chosen', 'doubling_started']
      : ['bid', 'landlord_chosen'],
  );
  const landlordHand = state.hands[outcome.landlord] as Card[];
  expect(landlordHand.length, label).toBe(cardsPerPlayer(rules) + rules.kittySize);
  expect(ids(landlordHand), label).toEqual(
    ids([...(start.hands[outcome.landlord] as Card[]), ...start.kitty]),
  );
  expect(isDisplaySorted(landlordHand), label).toBe(true);
  for (let seat = 0; seat < rules.playerCount; seat++) {
    if (seat !== outcome.landlord) expect(state.hands[seat], label).toBe(start.hands[seat]);
  }
  expect(viewHand(state, null).kitty, label).toEqual(start.kitty);
  expect(viewHand(state, outcome.landlord).currentStake, label).toBe(
    outcome.base * 2 ** outcome.robs,
  );
  if (rules.doublingRound) {
    for (let seat = 0; seat < rules.playerCount; seat++) {
      expect(legalActions(state, seat), label).toEqual({ ...NONE, canDouble: true });
    }
  } else {
    expect(state.trick, label).toEqual({
      leader: outcome.landlord,
      plays: [],
      current: null,
      currentSeat: null,
    });
    expect(legalActions(state, outcome.landlord), label).toEqual({ ...NONE, canPlay: true });
  }
}

/** Walks every legal bidding sequence; returns the number of complete sequences checked. */
function walk(rules: RuleSettings, firstBidder: number): number {
  const n = rules.playerCount;
  const start = deepFreeze(fresh(rules, firstBidder, `walk-${firstBidder}`));
  const prefix = `${n}p ${rules.biddingMode}/${rules.allPass}${rules.doublingRound ? '/doubling' : ''} fb${firstBidder}`;
  let leaves = 0;
  const dfs = (state: HandState, ref: Ref, path: string[], lastEvents: HandEvent[]): void => {
    const label = `${prefix}: ${path.join(' ')}`;
    if (ref.outcome !== null) {
      leaves++;
      checkOutcome(rules, start, state, lastEvents, ref.outcome, path.length, label);
      return;
    }
    const turn = refTurn(ref);
    expect(state.phase, label).toBe('bidding');
    expect(state.turn, label).toBe(turn);
    expect(state.landlord, label).toBeNull();
    expect(state.kittyRevealed, label).toBe(false);
    expect(viewHand(state, turn).kitty, label).toBeNull();
    const legal = refLegal(rules, ref);
    for (let seat = 0; seat < n; seat++) {
      expect(legalActions(state, seat), `${label} [seat ${seat}]`).toEqual(
        seat === turn ? legal : NONE,
      );
      expect(viewHand(state, seat).legal, `${label} [seat ${seat}]`).toEqual(
        seat === turn ? legal : NONE,
      );
    }
    expect(legalActions(state, null), label).toEqual(NONE);
    expect(timeoutAction(state, turn), label).toEqual(refForced(rules, ref) ? CALL : PASS_BID);
    expect(viewHand(state, turn).currentStake, label).toBe(state.base * 2 ** ref.robs);

    const options = refOptions(legal);
    for (const action of EVERY_BID) {
      const stepLabel = `${label} -> ${turn}:${describeAction(action)}`;
      const other = (turn + 1) % n;
      expect(rejection(applyAction(state, other, action)), `${stepLabel} by ${other}`).toBe(
        'not_your_turn',
      );
      if (!options.some((option) => describeAction(option) === describeAction(action))) {
        expect(rejection(applyAction(state, turn, action)), stepLabel).toBe('invalid_action');
        continue;
      }
      const result = applyAction(state, turn, action);
      expect(result.ok, stepLabel).toBe(true);
      if (!result.ok) return;
      expect(result.events[0], stepLabel).toEqual({
        type: 'bid',
        seat: turn,
        record: recordOf(turn, action),
      });
      expect(result.state.bidding.records[path.length], stepLabel).toEqual(recordOf(turn, action));
      dfs(
        deepFreeze(result.state),
        refApply(rules, ref, action),
        [...path, `${turn}:${describeAction(action)}`],
        result.events,
      );
    }
  };
  dfs(start, refStart(rules, firstBidder), [], []);
  return leaves;
}

describe('every legal bidding sequence matches the reference model', () => {
  const configs: RuleSettings[] = [];
  for (const base of [RULES_3P, RULES_4P]) {
    for (const biddingMode of ['call', 'points'] as const) {
      for (const allPass of ['force', 'redeal'] as const) {
        for (const doublingRound of [false, true]) {
          configs.push({ ...base, biddingMode, allPass, doublingRound });
        }
      }
    }
  }
  for (const rules of configs) {
    const name = `${rules.playerCount}p ${rules.biddingMode}/${rules.allPass}${rules.doublingRound ? ' with doubling' : ''}`;
    it(`agrees on turn, legality, timeout, events and outcome (${name}, every first bidder)`, () => {
      for (let firstBidder = 0; firstBidder < rules.playerCount; firstBidder++) {
        expect(walk(rules, firstBidder)).toBeGreaterThan(rules.playerCount);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Named scenarios from RULES.md (readable regression coverage of the paths above).
// ---------------------------------------------------------------------------

describe('call mode', () => {
  it('rob-back: A calls, B robs, C passes, A robs back -> landlord A with 2 robs', () => {
    const { state, events } = run(fresh(), [
      [0, CALL],
      [1, ROB],
      [2, PASS_BID],
      [0, ROB],
    ]);
    expect(state.landlord).toBe(0);
    expect(state.bidding.robs).toBe(2);
    expect(state.base).toBe(1);
    expect(viewHand(state, 1).currentStake).toBe(4);
    expect(types(events)).toEqual(['bid', 'bid', 'bid', 'bid', 'landlord_chosen']);
  });

  it('a seat that passed before the call is never asked to rob, the caller is offered a rob-back', () => {
    const { state } = run(fresh(), [
      [0, PASS_BID],
      [1, CALL],
      [2, ROB],
    ]);
    expect(state.turn).toBe(1);
    expect(state.bidding.robBackOffered).toBe(true);
    expect(legalActions(state, 0)).toEqual(NONE);
    expect(rejection(applyAction(state, 0, ROB))).toBe('not_your_turn');
    expect(legalActions(state, 1)).toEqual({ ...NONE, canRob: true, canPassBid: true });
    const declined = step(state, 1, PASS_BID).state;
    expect(declined.landlord).toBe(2);
    expect(declined.bidding.robs).toBe(1);
    expect(viewHand(declined, 0).currentStake).toBe(2);
  });

  it('bidding order starts at the first bidder and wraps (4p, first bidder 3)', () => {
    const start = fresh(RULES_4P, 3);
    expect(start.turn).toBe(3);
    const s1 = step(start, 3, PASS_BID).state;
    expect(s1.turn).toBe(0);
    const s2 = step(s1, 0, CALL).state;
    expect(s2.turn).toBe(1);
    const s3 = step(s2, 1, ROB).state;
    expect(s3.turn).toBe(2);
    const s4 = step(s3, 2, ROB).state;
    expect(s4.turn).toBe(0);
    expect(s4.bidding.robBackOffered).toBe(true);
    expect(rejection(applyAction(s4, 3, ROB))).toBe('not_your_turn');
    const done = step(s4, 0, ROB).state;
    expect(done.landlord).toBe(0);
    expect(done.bidding.robs).toBe(3);
    expect(viewHand(done, 3).currentStake).toBe(8);
  });

  it('force: when everyone before them passes the last seat in order can only call (4p, first bidder 1)', () => {
    const { state } = run(fresh(RULES_4P, 1), [
      [1, PASS_BID],
      [2, PASS_BID],
      [3, PASS_BID],
    ]);
    expect(state.turn).toBe(0);
    expect(legalActions(state, 0)).toEqual({ ...NONE, canCall: true, canPassBid: false });
    expect(timeoutAction(state, 0)).toEqual(CALL);
    expect(rejection(applyAction(state, 0, PASS_BID))).toBe('invalid_action');
    const forced = step(state, 0, timeoutAction(state, 0));
    expect(forced.state.landlord).toBe(0);
    expect(forced.state.base).toBe(1);
    expect(forced.state.bidding.robs).toBe(0);
    expect(forced.state.hands[0]).toHaveLength(33);
    expect(types(forced.events)).toEqual(['bid', 'landlord_chosen']);
  });

  it('redeal: when everyone passes the hand goes to phase redeal with a redeal event (4p)', () => {
    const { state, events } = run(fresh(REDEAL_4P, 2), [
      [2, PASS_BID],
      [3, PASS_BID],
      [0, PASS_BID],
      [1, PASS_BID],
    ]);
    expect(state.phase).toBe('redeal');
    expect(state.turn).toBe(-1);
    expect(state.landlord).toBeNull();
    expect(state.kittyRevealed).toBe(false);
    expect(events[events.length - 1]).toEqual({ type: 'redeal' });
    expect(timeoutAction(fresh(REDEAL_4P, 2), 2)).toEqual(PASS_BID);
  });
});

describe('points mode', () => {
  it('a bid must exceed the current bid and the highest bidder wins with that base', () => {
    const one = step(fresh(POINTS_3P), 0, bid(1)).state;
    expect(rejection(applyAction(one, 1, bid(1)))).toBe('invalid_action');
    expect(legalActions(one, 1)).toEqual({ ...NONE, bids: [2, 3], canPassBid: true });
    const two = step(one, 1, bid(2)).state;
    expect(rejection(applyAction(two, 2, bid(2)))).toBe('invalid_action');
    expect(legalActions(two, 2)).toEqual({ ...NONE, bids: [3], canPassBid: true });
    const { state, events } = step(two, 2, PASS_BID);
    expect(state.landlord).toBe(1);
    expect(state.base).toBe(2);
    expect(events.find((event) => event.type === 'landlord_chosen')).toMatchObject({
      seat: 1,
      base: 2,
    });
    expect(viewHand(state, 0).currentStake).toBe(2);
  });

  it('a bid of 3 ends the bidding immediately, later seats never act', () => {
    const { state, events } = run(fresh(POINTS_4P, 2), [
      [2, bid(1)],
      [3, bid(3)],
    ]);
    expect(state.landlord).toBe(3);
    expect(state.base).toBe(3);
    expect(state.bidding.records).toHaveLength(2);
    expect(types(events)).toEqual(['bid', 'bid', 'landlord_chosen']);
    expect(legalActions(state, 0)).toEqual(NONE);
    expect(rejection(applyAction(state, 0, bid(3)))).toBe('wrong_phase');
  });

  it('force: all pass makes the last seat in order landlord with base 1 (4p, first bidder 3)', () => {
    const { state, events } = run(fresh(POINTS_4P, 3), [
      [3, PASS_BID],
      [0, PASS_BID],
      [1, PASS_BID],
      [2, PASS_BID],
    ]);
    expect(state.landlord).toBe(2);
    expect(state.base).toBe(1);
    expect(state.bidding.robs).toBe(0);
    expect(events.find((event) => event.type === 'landlord_chosen')).toMatchObject({
      seat: 2,
      base: 1,
    });
    expect(rejection(applyAction(fresh(POINTS_3P), 0, { type: 'bid', value: 0 as 1 }))).toBe(
      'invalid_action',
    );
  });
});

describe('landlord chosen', () => {
  it('reveals the kitty, hands it to the landlord sorted, and starts play with the landlord leading', () => {
    const start = fresh(RULES_4P, 2);
    const { state, events } = run(start, [
      [2, PASS_BID],
      [3, CALL],
      [0, ROB],
      [1, PASS_BID],
      [3, PASS_BID],
    ]);
    expect(state.landlord).toBe(0);
    expect(state.kittyRevealed).toBe(true);
    expect(events.find((event) => event.type === 'landlord_chosen')).toEqual({
      type: 'landlord_chosen',
      seat: 0,
      base: 1,
      kitty: start.kitty,
    });
    const hand = state.hands[0] as Card[];
    expect(hand).toHaveLength(33);
    expect(ids(hand)).toEqual(ids([...(start.hands[0] as Card[]), ...start.kitty]));
    expect(isDisplaySorted(hand)).toBe(true);
    expect(viewHand(state, 1).kitty).toEqual(start.kitty);
    expect(viewHand(state, 1).hand).toBe(start.hands[1]);
    expect(state.phase).toBe('playing');
    expect(state.turn).toBe(0);
    expect(state.trick.leader).toBe(0);
    expect(legalActions(state, 0)).toEqual({ ...NONE, canPlay: true });
  });

  it('goes to the doubling round instead when the option is on', () => {
    const { state, events } = run(fresh({ ...POINTS_3P, doublingRound: true }, 1), [
      [1, PASS_BID],
      [2, bid(2)],
      [0, PASS_BID],
    ]);
    expect(types(events)).toEqual(['bid', 'bid', 'bid', 'landlord_chosen', 'doubling_started']);
    expect(state.phase).toBe('doubling');
    expect(state.turn).toBe(-1);
    expect(state.landlord).toBe(2);
    expect(state.base).toBe(2);
    expect(state.doubles).toEqual([null, null, null]);
    for (const seat of [0, 1, 2]) {
      expect(legalActions(state, seat)).toEqual({ ...NONE, canDouble: true });
      expect(rejection(applyAction(state, seat, PASS_BID))).toBe('wrong_phase');
    }
  });
});

describe('errors', () => {
  it('rejects bid actions outside the bidding phase and non-bid actions inside it', () => {
    const start = fresh();
    expect(rejection(applyAction(start, 0, { type: 'pass' }))).toBe('wrong_phase');
    expect(rejection(applyAction(start, 0, { type: 'double', double: true }))).toBe('wrong_phase');
    expect(rejection(applyAction(start, 0, { type: 'play', cardIds: [] }))).toBe('wrong_phase');
    const playing = step(step(step(start, 0, CALL).state, 1, PASS_BID).state, 2, PASS_BID).state;
    for (const action of EVERY_BID) {
      expect(rejection(applyAction(playing, 0, action))).toBe('wrong_phase');
    }
    const finished = step(
      playingState({ hands: ['5', '6 6', '7 7'], landlord: 2, leader: 2 }),
      2,
      play('7 7', cards('7 7')),
    ).state;
    expect(finished.phase).toBe('finished');
    expect(rejection(applyAction(finished, 0, CALL))).toBe('wrong_phase');
    expect(legalActions(finished, 0)).toEqual(NONE);
  });
});

describe('nextFirstBidder', () => {
  const constant = (value: number) => (): number => value;
  const finished = (): HandState =>
    step(
      playingState({ hands: ['5', '6 6', '7 7'], landlord: 2, leader: 2 }),
      2,
      play('7 7', cards('7 7')),
    ).state;
  const redealt = (rules: RuleSettings, firstBidder: number): HandState =>
    run(fresh({ ...rules, allPass: 'redeal' }, firstBidder), [
      [firstBidder, PASS_BID],
      [(firstBidder + 1) % 3, PASS_BID],
      [(firstBidder + 2) % 3, PASS_BID],
    ]).state;

  it('winner: the seat that went out first bids first; after a redeal the seat after the previous first bidder', () => {
    const done = finished();
    expect(done.result?.winnerSeat).toBe(2);
    expect(nextFirstBidder(RULES_3P, done, constant(0))).toBe(2);
    expect(nextFirstBidder(RULES_3P, redealt(RULES_3P, 2), constant(0))).toBe(0);
    expect(nextFirstBidder(RULES_3P, redealt(RULES_3P, 0), constant(0.9))).toBe(1);
  });

  it('rotate: one seat clockwise after a finished hand and after a redeal', () => {
    const rotate: RuleSettings = { ...RULES_3P, firstBidder: 'rotate' };
    const done = { ...finished(), firstBidder: 2 };
    expect(nextFirstBidder(rotate, done, constant(0))).toBe(0);
    expect(nextFirstBidder(rotate, redealt(rotate, 2), constant(0))).toBe(0);
    expect(nextFirstBidder(rotate, redealt(rotate, 1), constant(0.9))).toBe(2);
  });

  it('random: the rng picks after a finished hand, and the first hand is random in every mode', () => {
    const random: RuleSettings = { ...RULES_3P, firstBidder: 'random' };
    expect(nextFirstBidder(random, finished(), constant(0.5))).toBe(1);
    expect(nextFirstBidder(random, finished(), constant(0.99))).toBe(2);
    for (const mode of ['winner', 'rotate', 'random'] as const) {
      expect(nextFirstBidder({ ...RULES_3P, firstBidder: mode }, null, constant(0.4))).toBe(1);
      expect(nextFirstBidder({ ...RULES_4P, firstBidder: mode }, null, constant(0.99))).toBe(3);
    }
  });

  it('random: after a redeal the seat after the previous first bidder starts (RULES.md "Redeal")', () => {
    // RULES.md, Everyone passes / Redeal: "the player after the previous first bidder starts the
    // new bidding" - stated for the redeal itself, independent of the first-bidder option.
    const random: RuleSettings = { ...RULES_3P, firstBidder: 'random' };
    expect(nextFirstBidder(random, redealt(random, 2), constant(0.99))).toBe(0);
    expect(nextFirstBidder(random, redealt(random, 0), constant(0.99))).toBe(1);
  });
});
