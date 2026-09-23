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
import { cardsPerPlayer, kittySizeOptions } from '../rules';
import { botAction, botBid } from '../bot';
import { currentStake, kittyBonusMultiplier } from '../scoring';
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

// ---------------------------------------------------------------------------
// Round 2: second pass over the bidding state machine. Named scenarios from RULES.md that the
// walk above only covers implicitly, the kitty-size variants, the doubling round in four-player
// order, information leaks in the view while bidding, and a legality sweep of timeoutAction and
// the bot over every bidding state with strong and weak hands injected.
// ---------------------------------------------------------------------------

describe('round 2', () => {
  const STRONG = 'RJ BJ 2 2 2 2 A A A K K K Q Q J J 10';
  const WEAK = '3 3 4 5 6 8 8 9 10 10 J Q Q K A 4 5';
  const DOUBLING_4P: RuleSettings = { ...RULES_4P, doublingRound: true };
  const REDEAL_3P: RuleSettings = { ...RULES_3P, allPass: 'redeal' };
  const constant = (value: number) => (): number => value;
  const seats = (rules: RuleSettings): number[] => {
    const out: number[] = [];
    for (let seat = 0; seat < rules.playerCount; seat++) out.push(seat);
    return out;
  };

  function withHand(state: HandState, seat: number, spec: string): HandState {
    return {
      ...state,
      hands: state.hands.map((hand, other) => (other === seat ? cards(spec) : hand)),
    };
  }

  /** Every bid action the engine says is legal for the seat on turn. */
  function engineOptions(state: HandState): BidAction[] {
    return refOptions(legalActions(state, state.turn));
  }

  /** Visits every reachable bidding state of a configuration (as the engine enumerates it). */
  function visitBiddingStates(
    rules: RuleSettings,
    firstBidder: number,
    visit: (state: HandState, path: string) => void,
  ): number {
    let visited = 0;
    const dfs = (state: HandState, path: string): void => {
      if (state.phase !== 'bidding') return;
      visited++;
      visit(state, path);
      for (const action of engineOptions(state)) {
        const result = applyAction(state, state.turn, action);
        expect(result.ok, `${path} -> ${state.turn}:${describeAction(action)}`).toBe(true);
        if (result.ok) {
          dfs(deepFreeze(result.state), `${path} ${state.turn}:${describeAction(action)}`);
        }
      }
    };
    dfs(deepFreeze(fresh(rules, firstBidder, `sweep-${firstBidder}`)), '');
    return visited;
  }

  const ALL_CONFIGS: RuleSettings[] = [];
  for (const base of [RULES_3P, RULES_4P]) {
    for (const biddingMode of ['call', 'points'] as const) {
      for (const allPass of ['force', 'redeal'] as const) {
        for (const doublingRound of [false, true]) {
          ALL_CONFIGS.push({ ...base, biddingMode, allPass, doublingRound });
        }
      }
    }
  }

  describe('call mode: caller position, rob round order, rob-back', () => {
    it('4p: seats 0, 1 and 2 pass, seat 3 is the forced last bidder and is landlord at once with no rob round', () => {
      const before = run(fresh(RULES_4P, 0), [
        [0, PASS_BID],
        [1, PASS_BID],
        [2, PASS_BID],
      ]).state;
      expect(before.turn).toBe(3);
      expect(legalActions(before, 3)).toEqual({ ...NONE, canCall: true, canPassBid: false });
      expect(rejection(applyAction(before, 3, PASS_BID))).toBe('invalid_action');
      expect(rejection(applyAction(before, 3, ROB))).toBe('invalid_action');
      const { state, events } = step(before, 3, CALL);
      expect(types(events)).toEqual(['bid', 'landlord_chosen']);
      expect(events[1]).toMatchObject({ type: 'landlord_chosen', seat: 3, base: 1 });
      expect(state.landlord).toBe(3);
      expect(state.bidding.caller).toBe(3);
      expect(state.bidding.claimant).toBe(3);
      expect(state.bidding.robs).toBe(0);
      expect(state.bidding.robBackOffered).toBe(false);
      expect(state.bidding.records).toHaveLength(4);
      expect(state.base).toBe(1);
      expect(state.phase).toBe('playing');
      expect(state.turn).toBe(3);
      expect(state.trick.leader).toBe(3);
      expect(state.kittyRevealed).toBe(true);
      expect(state.hands[3]).toHaveLength(33);
      expect(viewHand(state, 0).currentStake).toBe(1);
      for (const seat of [0, 1, 2]) {
        expect(rejection(applyAction(state, seat, ROB))).toBe('wrong_phase');
        expect(legalActions(state, seat)).toEqual(NONE);
      }
    });

    it('4p: seats 0 and 1 pass, seat 2 calls: only seat 3 is asked to rob, and its rob sends the rob-back to seat 2', () => {
      const { state } = run(fresh(RULES_4P, 0), [
        [0, PASS_BID],
        [1, PASS_BID],
        [2, CALL],
      ]);
      expect(state.phase).toBe('bidding');
      expect(state.turn).toBe(3);
      expect(state.bidding.caller).toBe(2);
      expect(legalActions(state, 3)).toEqual({ ...NONE, canRob: true, canPassBid: true });
      for (const seat of [0, 1]) {
        expect(legalActions(state, seat)).toEqual(NONE);
        expect(viewHand(state, seat).legal).toEqual(NONE);
        expect(rejection(applyAction(state, seat, ROB))).toBe('not_your_turn');
        expect(rejection(applyAction(state, seat, PASS_BID))).toBe('not_your_turn');
      }
      expect(rejection(applyAction(state, 2, ROB))).toBe('not_your_turn');
      expect(rejection(applyAction(state, 3, CALL))).toBe('invalid_action');

      const robbed = step(state, 3, ROB).state;
      expect(robbed.phase).toBe('bidding');
      expect(robbed.turn).toBe(2);
      expect(robbed.bidding.robBackOffered).toBe(true);
      expect(robbed.bidding.claimant).toBe(3);
      expect(robbed.bidding.robs).toBe(1);
      expect(viewHand(robbed, 0).currentStake).toBe(2);
      expect(legalActions(robbed, 2)).toEqual({ ...NONE, canRob: true, canPassBid: true });
      for (const seat of [0, 1, 3]) {
        expect(legalActions(robbed, seat)).toEqual(NONE);
        expect(rejection(applyAction(robbed, seat, ROB))).toBe('not_your_turn');
      }

      const back = step(robbed, 2, ROB);
      expect(types(back.events)).toEqual(['bid', 'landlord_chosen']);
      expect(back.state.landlord).toBe(2);
      expect(back.state.bidding.claimant).toBe(2);
      expect(back.state.bidding.robs).toBe(2);
      expect(back.state.base).toBe(1);
      expect(viewHand(back.state, 0).currentStake).toBe(4);
      expect(back.state.hands[2]).toHaveLength(33);
      expect(back.state.hands[3]).toHaveLength(25);
    });

    it('the rob round wraps past seat 0: 3p first bidder 2 runs 2 (call) -> 0 -> 1 -> rob-back to 2', () => {
      const s0 = fresh(RULES_3P, 2);
      expect(s0.turn).toBe(2);
      const s1 = step(s0, 2, CALL).state;
      expect(s1.turn).toBe(0);
      const s2 = step(s1, 0, ROB).state;
      expect(s2.turn).toBe(1);
      expect(s2.bidding.robs).toBe(1);
      expect(s2.bidding.claimant).toBe(0);
      const s3 = step(s2, 1, ROB).state;
      expect(s3.phase).toBe('bidding');
      expect(s3.turn).toBe(2);
      expect(s3.bidding.robBackOffered).toBe(true);
      expect(s3.bidding.robs).toBe(2);
      expect(s3.bidding.claimant).toBe(1);
      expect(viewHand(s3, 0).currentStake).toBe(4);
      const done = step(s3, 2, ROB);
      expect(types(done.events)).toEqual(['bid', 'landlord_chosen']);
      expect(done.state.landlord).toBe(2);
      expect(done.state.bidding.robs).toBe(3);
      expect(done.state.base).toBe(1);
      expect(viewHand(done.state, 0).currentStake).toBe(8);
    });

    it('4p first bidder 1: the rob round runs 2, 3, 0 (wrapping) and then offers the rob-back to caller 1', () => {
      const { state } = run(fresh(RULES_4P, 1), [
        [1, CALL],
        [2, PASS_BID],
        [3, ROB],
      ]);
      expect(state.turn).toBe(0);
      expect(state.bidding.robBackOffered).toBe(false);
      const robbed = step(state, 0, ROB).state;
      expect(robbed.turn).toBe(1);
      expect(robbed.bidding.robBackOffered).toBe(true);
      expect(robbed.bidding.robs).toBe(2);
      expect(robbed.bidding.claimant).toBe(0);
      expect(legalActions(robbed, 2)).toEqual(NONE);
      expect(legalActions(robbed, 3)).toEqual(NONE);
      const declined = step(robbed, 1, PASS_BID);
      expect(types(declined.events)).toEqual(['bid', 'landlord_chosen']);
      expect(declined.state.landlord).toBe(0);
      expect(declined.state.bidding.robs).toBe(2);
      expect(declined.state.base).toBe(1);
      expect(viewHand(declined.state, 2).currentStake).toBe(4);
    });

    it('the rob-back is offered only to the original caller and only once; after it nobody bids again', () => {
      const { state } = run(fresh(RULES_3P, 0), [
        [0, CALL],
        [1, ROB],
        [2, ROB],
      ]);
      expect(state.turn).toBe(0);
      expect(state.bidding.robBackOffered).toBe(true);
      expect(legalActions(state, 1)).toEqual(NONE);
      expect(legalActions(state, 2)).toEqual(NONE);
      expect(rejection(applyAction(state, 1, ROB))).toBe('not_your_turn');
      expect(rejection(applyAction(state, 2, ROB))).toBe('not_your_turn');

      const back = step(state, 0, ROB).state;
      expect(back.phase).toBe('playing');
      expect(back.landlord).toBe(0);
      expect(back.bidding.robs).toBe(3);
      expect(back.base).toBe(1);
      expect(viewHand(back, 1).currentStake).toBe(8);
      for (const seat of [0, 1, 2]) {
        for (const action of EVERY_BID) {
          expect(rejection(applyAction(back, seat, action))).toBe('wrong_phase');
        }
      }

      const declined = step(state, 0, PASS_BID).state;
      expect(declined.phase).toBe('playing');
      expect(declined.landlord).toBe(2);
      expect(declined.bidding.robs).toBe(2);
      expect(declined.base).toBe(1);
      expect(viewHand(declined, 1).currentStake).toBe(4);
    });

    it('a seat that robbed is not asked again while the rest of the rob round runs', () => {
      const { state } = run(fresh(RULES_4P, 0), [
        [0, CALL],
        [1, ROB],
      ]);
      expect(state.turn).toBe(2);
      expect(legalActions(state, 1)).toEqual(NONE);
      expect(rejection(applyAction(state, 1, ROB))).toBe('not_your_turn');
      const rest = run(state, [
        [2, PASS_BID],
        [3, PASS_BID],
      ]).state;
      expect(rest.turn).toBe(0);
      expect(rest.bidding.robBackOffered).toBe(true);
      expect(legalActions(rest, 1)).toEqual(NONE);
      expect(rejection(applyAction(rest, 1, ROB))).toBe('not_your_turn');
    });

    it('no rob-back when nobody robbed: the caller is landlord as soon as the last seat passes', () => {
      const { state, events } = run(fresh(RULES_4P, 3), [
        [3, CALL],
        [0, PASS_BID],
        [1, PASS_BID],
        [2, PASS_BID],
      ]);
      expect(state.landlord).toBe(3);
      expect(state.bidding.robBackOffered).toBe(false);
      expect(state.bidding.robs).toBe(0);
      expect(types(events)).toEqual(['bid', 'bid', 'bid', 'bid', 'landlord_chosen']);
    });

    it('rejects rob and bid before a call, call and bid after a call (invalid_action, state unchanged)', () => {
      const start = fresh(RULES_3P, 0);
      expect(rejection(applyAction(start, 0, ROB))).toBe('invalid_action');
      expect(rejection(applyAction(start, 0, bid(1)))).toBe('invalid_action');
      const called = step(start, 0, CALL).state;
      expect(rejection(applyAction(called, 1, CALL))).toBe('invalid_action');
      expect(rejection(applyAction(called, 1, bid(3)))).toBe('invalid_action');
      expect(called.bidding.records).toHaveLength(1);
      expect(called.turn).toBe(1);
    });
  });

  describe('points mode with four players', () => {
    it('bids 1, 2, pass, 3: the 3 ends the bidding at once and seat 3 is landlord with base 3', () => {
      const { state, events } = run(fresh(POINTS_4P, 0), [
        [0, bid(1)],
        [1, bid(2)],
        [2, PASS_BID],
        [3, bid(3)],
      ]);
      expect(state.landlord).toBe(3);
      expect(state.base).toBe(3);
      expect(state.bidding.highestBid).toBe(3);
      expect(state.bidding.claimant).toBe(3);
      expect(state.bidding.robs).toBe(0);
      expect(state.bidding.records.map((record) => record.action)).toEqual([
        'bid',
        'bid',
        'pass',
        'bid',
      ]);
      expect(types(events)).toEqual(['bid', 'bid', 'bid', 'bid', 'landlord_chosen']);
      expect(events[events.length - 1]).toMatchObject({
        type: 'landlord_chosen',
        seat: 3,
        base: 3,
      });
      expect(viewHand(state, 0).currentStake).toBe(3);
      expect(state.hands[3]).toHaveLength(33);
      expect(state.phase).toBe('playing');
      expect(state.turn).toBe(3);
    });

    it('bids 1, pass, pass, 2: seat 3 is landlord with base 2 and seat 0 is never asked again', () => {
      const { state, events } = run(fresh(POINTS_4P, 0), [
        [0, bid(1)],
        [1, PASS_BID],
        [2, PASS_BID],
        [3, bid(2)],
      ]);
      expect(state.landlord).toBe(3);
      expect(state.base).toBe(2);
      expect(state.bidding.records).toHaveLength(4);
      expect(types(events)).toEqual(['bid', 'bid', 'bid', 'bid', 'landlord_chosen']);
      expect(events[events.length - 1]).toMatchObject({ seat: 3, base: 2 });
      expect(state.phase).toBe('playing');
      expect(rejection(applyAction(state, 0, bid(3)))).toBe('wrong_phase');
    });

    it('1, 2, pass, pass: the highest bidder (seat 1) is landlord with base 2, not the last seat', () => {
      const { state } = run(fresh(POINTS_4P, 0), [
        [0, bid(1)],
        [1, bid(2)],
        [2, PASS_BID],
        [3, PASS_BID],
      ]);
      expect(state.landlord).toBe(1);
      expect(state.base).toBe(2);
      expect(state.hands[1]).toHaveLength(33);
      expect(state.hands[3]).toHaveLength(25);
    });

    it('a bid equal to or below the current bid is rejected and leaves the state unchanged', () => {
      const two = run(fresh(POINTS_4P, 0), [
        [0, bid(1)],
        [1, bid(2)],
      ]).state;
      expect(two.turn).toBe(2);
      expect(legalActions(two, 2)).toEqual({ ...NONE, bids: [3], canPassBid: true });
      expect(rejection(applyAction(two, 2, bid(2)))).toBe('invalid_action');
      expect(rejection(applyAction(two, 2, bid(1)))).toBe('invalid_action');
      expect(two.bidding.records).toHaveLength(2);
      expect(two.bidding.highestBid).toBe(2);
      expect(two.base).toBe(2);
      const three = step(two, 2, bid(3)).state;
      expect(three.landlord).toBe(2);
      expect(three.base).toBe(3);
      expect(three.bidding.records).toHaveLength(3);
    });

    it('after a bid of 3 every further bidding action from every seat is rejected with wrong_phase', () => {
      const { state, events } = run(fresh(POINTS_4P, 1), [[1, bid(3)]]);
      expect(types(events)).toEqual(['bid', 'landlord_chosen']);
      expect(state.phase).toBe('playing');
      expect(state.landlord).toBe(1);
      expect(state.turn).toBe(1);
      expect(state.bidding.records).toHaveLength(1);
      for (const seat of seats(POINTS_4P)) {
        for (const action of EVERY_BID) {
          expect(rejection(applyAction(state, seat, action))).toBe('wrong_phase');
        }
      }
      const middle = run(fresh(POINTS_4P, 0), [
        [0, PASS_BID],
        [1, bid(3)],
      ]).state;
      expect(middle.landlord).toBe(1);
      expect(middle.bidding.records).toHaveLength(2);
      expect(rejection(applyAction(middle, 2, bid(3)))).toBe('wrong_phase');
    });

    it('rejects bid values other than 1, 2, 3 and call/rob in points mode without changing the state', () => {
      const start = fresh(POINTS_4P, 0);
      const bad: unknown[] = [0, 4, -1, 2.5, Number.NaN, '2', undefined, null];
      for (const value of bad) {
        const action: BidAction = { type: 'bid', value: value as 1 };
        expect(rejection(applyAction(start, 0, action)), String(value)).toBe('invalid_action');
      }
      expect(rejection(applyAction(start, 0, CALL))).toBe('invalid_action');
      expect(rejection(applyAction(start, 0, ROB))).toBe('invalid_action');
      expect(start.bidding.records).toHaveLength(0);
      expect(start.turn).toBe(0);
    });

    it('all pass with force: the last seat in bidding order (wrapping) is landlord with base 1 and no robs', () => {
      const { state, events } = run(fresh(POINTS_4P, 2), [
        [2, PASS_BID],
        [3, PASS_BID],
        [0, PASS_BID],
        [1, PASS_BID],
      ]);
      expect(state.landlord).toBe(1);
      expect(state.base).toBe(1);
      expect(state.bidding.robs).toBe(0);
      expect(state.bidding.highestBid).toBe(0);
      expect(events[events.length - 1]).toMatchObject({
        type: 'landlord_chosen',
        seat: 1,
        base: 1,
      });
      expect(viewHand(state, 0).currentStake).toBe(1);
      expect(state.hands[1]).toHaveLength(33);
    });
  });

  describe('everyone passes', () => {
    it('force, call mode: the last seat in order may not pass (pass_bid is invalid_action) and becomes landlord by calling', () => {
      const three = run(fresh(RULES_3P, 1), [
        [1, PASS_BID],
        [2, PASS_BID],
      ]).state;
      expect(three.turn).toBe(0);
      expect(rejection(applyAction(three, 0, PASS_BID))).toBe('invalid_action');
      expect(three.bidding.records).toHaveLength(2);
      expect(three.turn).toBe(0);
      expect(three.phase).toBe('bidding');
      expect(legalActions(three, 0)).toEqual({ ...NONE, canCall: true, canPassBid: false });
      expect(viewHand(three, 0).legal).toEqual({ ...NONE, canCall: true, canPassBid: false });
      expect(timeoutAction(three, 0)).toEqual(CALL);
      const forced = step(three, 0, timeoutAction(three, 0));
      expect(types(forced.events)).toEqual(['bid', 'landlord_chosen']);
      expect(forced.state).toMatchObject({ landlord: 0, base: 1, phase: 'playing', turn: 0 });
      expect(forced.state.bidding.robs).toBe(0);

      const four = run(fresh(RULES_4P, 2), [
        [2, PASS_BID],
        [3, PASS_BID],
        [0, PASS_BID],
      ]).state;
      expect(four.turn).toBe(1);
      expect(rejection(applyAction(four, 1, PASS_BID))).toBe('invalid_action');
      expect(legalActions(four, 1)).toEqual({ ...NONE, canCall: true, canPassBid: false });
      expect(step(four, 1, CALL).state).toMatchObject({ landlord: 1, base: 1 });
    });

    it('force, points mode: when the last seat in order passes too, that seat is landlord with base 1', () => {
      const { state, events } = run(fresh(POINTS_3P, 1), [
        [1, PASS_BID],
        [2, PASS_BID],
        [0, PASS_BID],
      ]);
      expect(types(events)).toEqual(['bid', 'bid', 'bid', 'landlord_chosen']);
      expect(state).toMatchObject({ landlord: 0, base: 1, phase: 'playing', turn: 0 });
      expect(state.bidding.robs).toBe(0);
      expect(viewHand(state, 1).currentStake).toBe(1);
      expect(state.hands[0]).toHaveLength(20);
    });

    it('redeal: everyone passing gives phase redeal with no landlord, hidden kitty and nothing legal (call and points, 3p and 4p)', () => {
      for (const base of [RULES_3P, RULES_4P]) {
        for (const biddingMode of ['call', 'points'] as const) {
          const rules: RuleSettings = { ...base, biddingMode, allPass: 'redeal' };
          const n = rules.playerCount;
          const firstBidder = n - 1;
          const start = fresh(rules, firstBidder);
          const moves: Array<[number, HandAction]> = seats(rules).map((i) => [
            (firstBidder + i) % n,
            PASS_BID,
          ]);
          const { state, events } = run(start, moves);
          const label = `${n}p ${biddingMode}`;
          expect(state.phase, label).toBe('redeal');
          expect(state.turn, label).toBe(-1);
          expect(state.landlord, label).toBeNull();
          expect(state.kittyRevealed, label).toBe(false);
          expect(state.bidding.records, label).toHaveLength(n);
          expect(events[events.length - 1], label).toEqual({ type: 'redeal' });
          expect(
            events.filter((event) => event.type === 'landlord_chosen'),
            label,
          ).toHaveLength(0);
          expect(viewHand(state, null).kitty, label).toBeNull();
          expect(viewHand(state, 0).currentStake, label).toBe(1);
          for (const seat of seats(rules)) {
            expect(state.hands[seat], label).toBe(start.hands[seat]);
            expect(legalActions(state, seat), label).toEqual(NONE);
            for (const action of EVERY_BID) {
              expect(rejection(applyAction(state, seat, action)), label).toBe('wrong_phase');
            }
            expect(
              rejection(applyAction(state, seat, { type: 'double', double: true })),
              label,
            ).toBe('wrong_phase');
            expect(timeoutAction(state, seat), label).toEqual({ type: 'pass' });
          }
        }
      }
    });

    it('after a redeal the seat after the previous first bidder starts the new deal in every mode, wrapping past the last seat', () => {
      for (const base of [RULES_3P, RULES_4P]) {
        const n = base.playerCount;
        for (const mode of ['winner', 'rotate', 'random'] as const) {
          const rules: RuleSettings = { ...base, allPass: 'redeal', firstBidder: mode };
          for (const firstBidder of seats(rules)) {
            const moves: Array<[number, HandAction]> = seats(rules).map((i) => [
              (firstBidder + i) % n,
              PASS_BID,
            ]);
            const redealt = run(fresh(rules, firstBidder), moves).state;
            expect(redealt.phase).toBe('redeal');
            const label = `${n}p ${mode} fb${firstBidder}`;
            for (const draw of [0, 0.5, 0.999]) {
              expect(nextFirstBidder(rules, redealt, constant(draw)), label).toBe(
                (firstBidder + 1) % n,
              );
            }
            const next = createHand({
              rules,
              seed: 'again',
              handNumber: redealt.handNumber,
              firstBidder: nextFirstBidder(rules, redealt, constant(0.3)),
            });
            expect(next.phase, label).toBe('bidding');
            expect(next.turn, label).toBe((firstBidder + 1) % n);
            expect(next.firstBidder, label).toBe((firstBidder + 1) % n);
          }
        }
      }
    });
  });

  describe('kitty sizes and the landlord hand', () => {
    for (const base of [RULES_3P, RULES_4P]) {
      const n = base.playerCount;
      const deckSize = n === 4 ? 108 : 54;
      for (const kittySize of kittySizeOptions(n)) {
        const per = (deckSize - kittySize) / n;
        it(`${n}p kitty ${kittySize}: deals ${per} each, hides the kitty, then hands the landlord ${per + kittySize} cards`, () => {
          const rules: RuleSettings = { ...base, kittySize };
          expect(Number.isInteger(per)).toBe(true);
          expect(cardsPerPlayer(rules)).toBe(per);
          const start = deepFreeze(fresh(rules, 1, `kitty-${n}-${kittySize}`));
          expect(start.hands).toHaveLength(n);
          for (const seat of seats(rules)) {
            expect(start.hands[seat]).toHaveLength(per);
            expect(isDisplaySorted(start.hands[seat] as Card[])).toBe(true);
          }
          expect(start.kitty).toHaveLength(kittySize);
          expect(start.kittyRevealed).toBe(false);
          const all = [...start.hands.flat(), ...start.kitty];
          expect(new Set(all.map((card) => card.id)).size).toBe(deckSize);

          const before = viewHand(start, 0);
          expect(before.kitty).toBeNull();
          expect(before.kittySize).toBe(kittySize);
          expect(before.cardCounts).toEqual(new Array<number>(n).fill(per));
          expect(before.hand).toBe(start.hands[0]);
          expect(viewHand(start, null).hand).toEqual([]);
          expect(viewHand(start, null).kitty).toBeNull();

          // a lone call by the first bidder; the rest pass
          const moves: Array<[number, HandAction]> = [[1, CALL]];
          for (let i = 1; i < n; i++) moves.push([(1 + i) % n, PASS_BID]);
          const { state, events } = run(start, moves);
          expect(state.landlord).toBe(1);
          expect(state.kittyRevealed).toBe(true);
          const chosen = events.find((event) => event.type === 'landlord_chosen');
          expect(chosen).toEqual({ type: 'landlord_chosen', seat: 1, base: 1, kitty: start.kitty });
          const landlordHand = state.hands[1] as Card[];
          expect(landlordHand).toHaveLength(per + kittySize);
          expect(ids(landlordHand)).toEqual(ids([...(start.hands[1] as Card[]), ...start.kitty]));
          expect(isDisplaySorted(landlordHand)).toBe(true);
          for (const seat of seats(rules)) {
            if (seat !== 1) {
              expect(state.hands[seat]).toBe(start.hands[seat]);
              expect(state.hands[seat]).toHaveLength(per);
            }
          }
          const after = viewHand(state, null);
          expect(after.kitty).toEqual(start.kitty);
          expect(after.kittySize).toBe(kittySize);
          expect(after.cardCounts).toEqual(
            seats(rules).map((seat) => (seat === 1 ? per + kittySize : per)),
          );
          expect(viewHand(state, 1).hand).toBe(landlordHand);
          expect(viewHand(state, 0).hand).toBe(start.hands[0]);
        });
      }
    }

    it('same seed and rules deal the same cards; the first bidder is wrapped into the seat range (4p)', () => {
      const a = fresh(RULES_4P, 0, 'same');
      const b = fresh(RULES_4P, 0, 'same');
      expect(b.hands.map(ids)).toEqual(a.hands.map(ids));
      expect(ids(b.kitty)).toEqual(ids(a.kitty));
      expect(createHand({ rules: RULES_4P, seed: 's', handNumber: 1, firstBidder: 5 }).turn).toBe(
        1,
      );
      expect(createHand({ rules: RULES_4P, seed: 's', handNumber: 1, firstBidder: -1 }).turn).toBe(
        3,
      );
      expect(
        createHand({ rules: RULES_4P, seed: 's', handNumber: 1, firstBidder: -1 }).firstBidder,
      ).toBe(3);
    });
  });

  describe('doubling round', () => {
    it('is entered only when the option is on, in both bidding modes and both player counts', () => {
      for (const base of [RULES_3P, RULES_4P]) {
        for (const biddingMode of ['call', 'points'] as const) {
          for (const doublingRound of [false, true]) {
            const rules: RuleSettings = { ...base, biddingMode, doublingRound };
            const n = rules.playerCount;
            const first: HandAction = biddingMode === 'call' ? CALL : bid(2);
            const moves: Array<[number, HandAction]> = [[0, first]];
            for (let seat = 1; seat < n; seat++) moves.push([seat, PASS_BID]);
            const { state, events } = run(fresh(rules, 0), moves);
            const label = `${n}p ${biddingMode} doubling=${String(doublingRound)}`;
            expect(state.landlord, label).toBe(0);
            expect(state.kittyRevealed, label).toBe(true);
            if (doublingRound) {
              expect(state.phase, label).toBe('doubling');
              expect(state.turn, label).toBe(-1);
              expect(state.doubles, label).toEqual(new Array<null>(n).fill(null));
              expect(types(events).slice(-2), label).toEqual([
                'landlord_chosen',
                'doubling_started',
              ]);
              for (const seat of seats(rules)) {
                expect(legalActions(state, seat), label).toEqual({ ...NONE, canDouble: true });
                expect(rejection(applyAction(state, seat, CALL)), label).toBe('wrong_phase');
                expect(rejection(applyAction(state, seat, { type: 'pass' })), label).toBe(
                  'wrong_phase',
                );
              }
            } else {
              expect(state.phase, label).toBe('playing');
              expect(state.turn, label).toBe(0);
              expect(state.doubles, label).toEqual(new Array<boolean>(n).fill(false));
              expect(types(events), label).not.toContain('doubling_started');
              for (const seat of seats(rules)) {
                expect(legalActions(state, seat).canDouble, label).toBe(false);
                expect(
                  rejection(applyAction(state, seat, { type: 'double', double: true })),
                  label,
                ).toBe('wrong_phase');
              }
            }
          }
        }
      }
    });

    it('4p: every seat decides exactly once in any order, other choices stay hidden, then the landlord leads', () => {
      const chosen = run(fresh(DOUBLING_4P, 2), [
        [2, PASS_BID],
        [3, CALL],
        [0, ROB],
        [1, PASS_BID],
        [3, PASS_BID],
      ]).state;
      expect(chosen.phase).toBe('doubling');
      expect(chosen.landlord).toBe(0);
      expect(chosen.bidding.robs).toBe(1);
      expect(viewHand(chosen, 1).currentStake).toBe(2);

      const one = step(chosen, 3, { type: 'double', double: true });
      expect(one.events).toEqual([{ type: 'double', seat: 3, double: true }]);
      expect(one.state.phase).toBe('doubling');
      expect(one.state.turn).toBe(-1);
      expect(one.state.doubles).toEqual([null, null, null, true]);
      expect(rejection(applyAction(one.state, 3, { type: 'double', double: false }))).toBe(
        'invalid_action',
      );
      expect(rejection(applyAction(one.state, 3, { type: 'double', double: true }))).toBe(
        'invalid_action',
      );
      expect(legalActions(one.state, 3)).toEqual(NONE);
      for (const seat of [0, 1, 2]) {
        expect(legalActions(one.state, seat)).toEqual({ ...NONE, canDouble: true });
        expect(viewHand(one.state, seat).doubles).toEqual([null, null, null, null]);
        for (const action of EVERY_BID) {
          expect(rejection(applyAction(one.state, seat, action))).toBe('wrong_phase');
        }
        expect(rejection(applyAction(one.state, seat, { type: 'pass' }))).toBe('wrong_phase');
        expect(rejection(applyAction(one.state, seat, { type: 'play', cardIds: [] }))).toBe(
          'wrong_phase',
        );
      }
      expect(viewHand(one.state, 3).doubles).toEqual([null, null, null, true]);
      expect(viewHand(one.state, null).doubles).toEqual([null, null, null, null]);

      // the landlord keeps via timeout, seat 1 via the bot
      expect(timeoutAction(one.state, 0)).toEqual({ type: 'double', double: false });
      const two = step(one.state, 0, timeoutAction(one.state, 0)).state;
      expect(two.doubles).toEqual([false, null, null, true]);
      const botChoice = botAction(two, 1);
      expect(botChoice.type).toBe('double');
      const three = step(two, 1, botChoice).state;
      expect(three.phase).toBe('doubling');
      expect(viewHand(three, 2).doubles).toEqual([null, null, null, null]);

      const done = step(three, 2, { type: 'double', double: true });
      const decided = [false, botChoice.type === 'double' && botChoice.double, true, true];
      expect(done.events).toEqual([
        { type: 'double', seat: 2, double: true },
        { type: 'doubling_finished', doubles: decided },
      ]);
      expect(done.state.phase).toBe('playing');
      expect(done.state.turn).toBe(0);
      expect(done.state.trick).toEqual({ leader: 0, plays: [], current: null, currentSeat: null });
      expect(done.state.doubles).toEqual(decided);
      for (const seat of [0, 1, 2, 3, null]) {
        expect(viewHand(done.state, seat).doubles).toEqual(decided);
      }
      expect(legalActions(done.state, 0)).toEqual({ ...NONE, canPlay: true });
      expect(rejection(applyAction(done.state, 1, { type: 'double', double: true }))).toBe(
        'wrong_phase',
      );
    });
  });

  describe('the view while bidding', () => {
    it('shows no kitty and no kitty bonus in the stake before the landlord is chosen, even with the bonus option on', () => {
      const rules: RuleSettings = { ...RULES_3P, kittyBonus: true };
      let start: HandState | null = null;
      for (let i = 0; i < 500 && start === null; i++) {
        const candidate = fresh(rules, 0, `leak-${i}`);
        if (kittyBonusMultiplier(candidate.kitty, rules) > 1) start = candidate;
      }
      expect(start).not.toBeNull();
      if (start === null) return;
      const bonus = kittyBonusMultiplier(start.kitty, rules);
      const during: HandState[] = [start];
      during.push(step(start, 0, CALL).state);
      during.push(step(during[1] as HandState, 1, ROB).state);
      during.push(step(during[2] as HandState, 2, PASS_BID).state);
      const robsAt = [0, 0, 1, 1];
      during.forEach((state, i) => {
        expect(state.phase, `step ${i}`).toBe('bidding');
        expect(state.kittyRevealed, `step ${i}`).toBe(false);
        for (const seat of [0, 1, 2, null]) {
          const view = viewHand(state, seat);
          expect(view.kitty, `step ${i} seat ${String(seat)}`).toBeNull();
          expect(view.currentStake, `step ${i} seat ${String(seat)}`).toBe(
            2 ** (robsAt[i] as number),
          );
          expect(view.hand, `step ${i} seat ${String(seat)}`).toBe(
            seat === null ? view.hand : state.hands[seat],
          );
          if (seat === null) expect(view.hand).toEqual([]);
          expect(view.cardCounts, `step ${i}`).toEqual([17, 17, 17]);
        }
        expect(currentStake(state), `step ${i}`).toBe(2 ** (robsAt[i] as number));
      });
      const chosen = step(during[3] as HandState, 0, ROB).state;
      expect(chosen.landlord).toBe(0);
      expect(chosen.bidding.robs).toBe(2);
      expect(viewHand(chosen, 1).kitty).toEqual(start.kitty);
      expect(viewHand(chosen, 1).currentStake).toBe(4 * bonus);
      expect(currentStake(chosen)).toBe(4 * bonus);
    });

    it('a rejected action changes nothing: the same legal action afterwards produces the identical state', () => {
      const start = deepFreeze(fresh(RULES_4P, 3));
      const reference = step(start, 3, CALL).state;
      expect(rejection(applyAction(start, 0, CALL))).toBe('not_your_turn');
      expect(rejection(applyAction(start, 3, ROB))).toBe('invalid_action');
      expect(rejection(applyAction(start, 3, bid(2)))).toBe('invalid_action');
      expect(rejection(applyAction(start, 3, { type: 'pass' }))).toBe('wrong_phase');
      const again = step(start, 3, CALL).state;
      expect(again).toEqual(reference);
      expect(start.bidding.records).toHaveLength(0);
      expect(start.turn).toBe(3);
    });
  });

  describe('timeout and bot actions at every bidding state', () => {
    it('timeoutAction is accepted, and botBid is legal with the dealt, a very strong and a very weak hand', () => {
      let states = 0;
      for (const rules of ALL_CONFIGS) {
        for (const firstBidder of seats(rules)) {
          const prefix = `${rules.playerCount}p ${rules.biddingMode}/${rules.allPass}${rules.doublingRound ? '/doubling' : ''} fb${firstBidder}`;
          states += visitBiddingStates(rules, firstBidder, (state, path) => {
            const turn = state.turn;
            const label = `${prefix}:${path}`;
            const legal = legalActions(state, turn);

            const timeout = timeoutAction(state, turn);
            const timed = applyAction(state, turn, timeout);
            expect(timed.ok, `${label} timeout ${JSON.stringify(timeout)}`).toBe(true);
            if (timed.ok) {
              expect(timed.events[0]?.type, label).toBe('bid');
              if (timed.state.phase !== 'bidding') {
                expect(['landlord_chosen', 'redeal'], label).toContain(timed.events[1]?.type);
              }
            }

            const variants: Array<[string, HandState]> = [
              ['dealt', state],
              ['strong', withHand(state, turn, STRONG)],
              ['weak', withHand(state, turn, WEAK)],
            ];
            for (const [name, variant] of variants) {
              const choice = botBid(variant, turn);
              const permitted =
                choice.type === 'bid'
                  ? legal.bids.includes(choice.value)
                  : (choice.type === 'call' && legal.canCall) ||
                    (choice.type === 'rob' && legal.canRob) ||
                    (choice.type === 'pass_bid' && legal.canPassBid);
              expect(permitted, `${label} bot(${name}) ${JSON.stringify(choice)}`).toBe(true);
              expect(applyAction(variant, turn, choice).ok, `${label} bot(${name})`).toBe(true);
              expect(botAction(variant, turn), `${label} botAction(${name})`).toEqual(choice);
            }

            // seats that do not exist are refused without throwing
            for (const seat of [-1, rules.playerCount, 1.5, Number.NaN]) {
              expect(rejection(applyAction(state, seat, CALL)), `${label} seat ${seat}`).toBe(
                'invalid_action',
              );
              expect(legalActions(state, seat), `${label} seat ${seat}`).toEqual(NONE);
            }
          });
        }
      }
      expect(states).toBeGreaterThan(300);
    });

    it('a strong bot calls, robs (including the rob-back) and bids 3; a weak bot passes unless forced', () => {
      const strongCall = withHand(fresh(RULES_3P, 0), 0, STRONG);
      expect(botBid(strongCall, 0)).toEqual(CALL);
      const weakCall = withHand(fresh(RULES_3P, 0), 0, WEAK);
      expect(botBid(weakCall, 0)).toEqual(PASS_BID);
      const robRound = step(fresh(RULES_3P, 0), 0, CALL).state;
      expect(botBid(withHand(robRound, 1, STRONG), 1)).toEqual(ROB);
      expect(botBid(withHand(robRound, 1, WEAK), 1)).toEqual(PASS_BID);
      const robBack = run(fresh(RULES_3P, 0), [
        [0, CALL],
        [1, ROB],
        [2, PASS_BID],
      ]).state;
      expect(robBack.turn).toBe(0);
      expect(botBid(withHand(robBack, 0, STRONG), 0)).toEqual(ROB);
      expect(botBid(withHand(robBack, 0, WEAK), 0)).toEqual(PASS_BID);
      const forced = run(fresh(RULES_3P, 0), [
        [0, PASS_BID],
        [1, PASS_BID],
      ]).state;
      expect(botBid(withHand(forced, 2, WEAK), 2)).toEqual(CALL);
      const points = fresh(POINTS_3P, 0);
      expect(botBid(withHand(points, 0, STRONG), 0)).toEqual(bid(3));
      expect(botBid(withHand(points, 0, WEAK), 0)).toEqual(PASS_BID);
      const raised = step(points, 0, bid(2)).state;
      expect(botBid(withHand(raised, 1, STRONG), 1)).toEqual(bid(3));
      expect(botBid(withHand(raised, 1, WEAK), 1)).toEqual(PASS_BID);
    });
  });

  describe('nextFirstBidder edge cases', () => {
    it('winner mode with a previous hand that has no result yet (still bidding or playing) returns a valid seat, deterministically', () => {
      const bidding = fresh(RULES_3P, 2);
      const playing = run(fresh(RULES_4P, 1), [
        [1, CALL],
        [2, PASS_BID],
        [3, PASS_BID],
        [0, PASS_BID],
      ]).state;
      expect(playing.phase).toBe('playing');
      expect(playing.result).toBeNull();
      for (const [rules, previous] of [
        [RULES_3P, bidding],
        [RULES_4P, playing],
      ] as const) {
        const n = rules.playerCount;
        const first = nextFirstBidder(rules, previous, constant(0.5));
        expect(Number.isInteger(first)).toBe(true);
        expect(first).toBeGreaterThanOrEqual(0);
        expect(first).toBeLessThan(n);
        expect(nextFirstBidder(rules, previous, constant(0.5))).toBe(first);
      }
    });

    it('winner mode, 4p: the peasant who went out first bids first; the landlord when the landlord wins', () => {
      const peasantWins = step(
        step(
          playingState({ hands: ['5 6', '8', '9 9', '10 10'], landlord: 0 }),
          0,
          play('5', cards('5')),
        ).state,
        1,
        play('8', cards('8')),
      ).state;
      expect(peasantWins.phase).toBe('finished');
      expect(peasantWins.result?.winnerSide).toBe('peasants');
      expect(peasantWins.result?.winnerSeat).toBe(1);
      expect(nextFirstBidder(RULES_4P, peasantWins, constant(0.99))).toBe(1);

      const landlordWins = step(
        playingState({ hands: ['5 6', '8', '9 9', '10 10'], landlord: 3, leader: 3 }),
        3,
        play('10 10', cards('10 10')),
      ).state;
      expect(landlordWins.result?.winnerSeat).toBe(3);
      expect(nextFirstBidder(RULES_4P, landlordWins, constant(0))).toBe(3);
      expect(
        nextFirstBidder({ ...RULES_4P, firstBidder: 'rotate' }, landlordWins, constant(0)),
      ).toBe((landlordWins.firstBidder + 1) % 4);
    });
  });
});
