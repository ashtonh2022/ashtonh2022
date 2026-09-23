import { describe, expect, it } from 'vitest';

import type { Card, HandAction, HandEvent, HandState, RuleSettings } from './types';
import { createDeck, seededRng } from './cards';
import { cardsPerPlayer } from './rules';
import { kittyBonusMultiplier } from './scoring';
import {
  applyAction,
  createHand,
  legalActions,
  nextFirstBidder,
  timeoutAction,
  viewHand,
} from './hand';
import {
  PASS,
  RULES_3P,
  RULES_4P,
  cards,
  deepFreeze,
  play,
  playingState,
  rejection,
  run,
  step,
} from './test-helpers';

const CALL: HandAction = { type: 'call' };
const ROB: HandAction = { type: 'rob' };
const PASS_BID: HandAction = { type: 'pass_bid' };
const bid = (value: 1 | 2 | 3): HandAction => ({ type: 'bid', value });
const double = (choice: boolean): HandAction => ({ type: 'double', double: choice });

const POINTS_3P: RuleSettings = { ...RULES_3P, biddingMode: 'points' };
const POINTS_4P: RuleSettings = { ...RULES_4P, biddingMode: 'points' };
const REDEAL_3P: RuleSettings = { ...RULES_3P, allPass: 'redeal' };
const DOUBLING_3P: RuleSettings = { ...RULES_3P, doublingRound: true };

function fresh(rules: RuleSettings = RULES_3P, firstBidder = 0, seed = 'hand-test'): HandState {
  return createHand({ rules, seed, handNumber: 1, firstBidder });
}

function ids(cards: readonly Card[]): string[] {
  return cards.map((card) => card.id);
}

function types(events: HandEvent[]): string[] {
  return events.map((event) => event.type);
}

function landlordChosen(events: HandEvent[]): { seat: number; base: number; kitty: Card[] } | null {
  const event = events.find((candidate) => candidate.type === 'landlord_chosen');
  return event !== undefined && event.type === 'landlord_chosen' ? event : null;
}

const NONE = {
  canCall: false,
  canRob: false,
  canPassBid: false,
  bids: [],
  canDouble: false,
  canPlay: false,
  canPass: false,
};

describe('createHand', () => {
  it('deals every seat in order, sorted, and leaves the kitty face down', () => {
    const state = fresh();
    expect(state.phase).toBe('bidding');
    expect(state.turn).toBe(0);
    expect(state.firstBidder).toBe(0);
    expect(state.kittyRevealed).toBe(false);
    expect(state.landlord).toBeNull();
    expect(state.result).toBeNull();
    expect(state.hands.map((hand) => hand.length)).toEqual([17, 17, 17]);
    expect(state.kitty).toHaveLength(3);
    for (const hand of state.hands) {
      for (let i = 1; i < hand.length; i++) {
        expect((hand[i - 1] as Card).rank).toBeGreaterThanOrEqual((hand[i] as Card).rank);
      }
    }
    const dealt = [...state.hands.flat(), ...state.kitty].map((card) => card.id).sort();
    expect(dealt).toEqual(ids(createDeck(3)).sort());
    expect(state.bidding).toEqual({
      records: [],
      caller: null,
      claimant: null,
      highestBid: 0,
      robs: 0,
      passed: [false, false, false],
      robDecided: [false, false, false],
      robBackOffered: false,
    });
    expect(state.playCounts).toEqual([0, 0, 0]);
    expect(state.bombsPlayed).toBe(0);
    expect(state.history).toEqual([]);
    expect(state.trick.current).toBeNull();
  });

  it('is deterministic for a seed and different for another', () => {
    expect(fresh(RULES_3P, 0, 'a')).toEqual(fresh(RULES_3P, 0, 'a'));
    expect(ids(fresh(RULES_3P, 0, 'a').hands[0] as Card[])).not.toEqual(
      ids(fresh(RULES_3P, 0, 'b').hands[0] as Card[]),
    );
  });

  it('deals 4-player hands from two decks and honours the kitty size', () => {
    const state = fresh(RULES_4P, 2);
    expect(state.hands.map((hand) => hand.length)).toEqual([25, 25, 25, 25]);
    expect(state.kitty).toHaveLength(8);
    expect(state.turn).toBe(2);
    expect(state.doubles).toEqual([false, false, false, false]);
    const big = fresh({ ...RULES_3P, kittySize: 12 });
    expect(big.hands.map((hand) => hand.length)).toEqual([14, 14, 14]);
    expect(big.kitty).toHaveLength(12);
    expect(cardsPerPlayer(big.rules)).toBe(14);
  });

  it('starts the doubling choices as undecided only when the round is on', () => {
    expect(fresh(RULES_3P).doubles).toEqual([false, false, false]);
    expect(fresh(DOUBLING_3P).doubles).toEqual([null, null, null]);
  });

  it('wraps the first bidder into the seat range', () => {
    expect(fresh(RULES_3P, 3).firstBidder).toBe(0);
    expect(fresh(RULES_3P, -1).firstBidder).toBe(2);
  });
});

describe('bidding: call mode', () => {
  it('makes a lone caller the landlord with base 1 and hands them the kitty', () => {
    const start = fresh();
    const kitty = start.kitty;
    const { state, events } = run(start, [
      [0, CALL],
      [1, PASS_BID],
      [2, PASS_BID],
    ]);
    expect(types(events)).toEqual(['bid', 'bid', 'bid', 'landlord_chosen']);
    expect(landlordChosen(events)).toEqual({ type: 'landlord_chosen', seat: 0, base: 1, kitty });
    expect(state.landlord).toBe(0);
    expect(state.base).toBe(1);
    expect(state.bidding.robs).toBe(0);
    expect(state.bidding.records).toEqual([
      { seat: 0, action: 'call' },
      { seat: 1, action: 'pass' },
      { seat: 2, action: 'pass' },
    ]);
    expect(state.kittyRevealed).toBe(true);
    expect(state.hands[0]).toHaveLength(20);
    expect(ids(state.hands[0] as Card[])).toEqual(
      expect.arrayContaining(kitty.map((card) => card.id)),
    );
    for (let i = 1; i < 20; i++) {
      const hand = state.hands[0] as Card[];
      expect((hand[i - 1] as Card).rank).toBeGreaterThanOrEqual((hand[i] as Card).rank);
    }
    expect(state.phase).toBe('playing');
    expect(state.turn).toBe(0);
    expect(state.trick).toEqual({ leader: 0, plays: [], current: null, currentSeat: null });
  });

  it('asks the remaining seats to rob after a call and offers the caller a rob-back', () => {
    const afterCall = step(fresh(), 0, CALL).state;
    expect(afterCall.turn).toBe(1);
    expect(afterCall.bidding.caller).toBe(0);
    expect(legalActions(afterCall, 1)).toEqual({ ...NONE, canRob: true, canPassBid: true });
    expect(legalActions(afterCall, 0)).toEqual(NONE);

    const afterRob = step(afterCall, 1, ROB).state;
    expect(afterRob.bidding.robs).toBe(1);
    expect(afterRob.bidding.claimant).toBe(1);
    expect(afterRob.turn).toBe(2);

    const robBack = step(afterRob, 2, PASS_BID).state;
    expect(robBack.phase).toBe('bidding');
    expect(robBack.turn).toBe(0);
    expect(robBack.bidding.robBackOffered).toBe(true);
    expect(legalActions(robBack, 0)).toEqual({ ...NONE, canRob: true, canPassBid: true });

    const robbedBack = step(robBack, 0, ROB);
    expect(robbedBack.state.landlord).toBe(0);
    expect(robbedBack.state.bidding.robs).toBe(2);
    expect(landlordChosen(robbedBack.events)?.seat).toBe(0);

    const declined = step(robBack, 0, PASS_BID).state;
    expect(declined.landlord).toBe(1);
    expect(declined.bidding.robs).toBe(1);
    expect(declined.base).toBe(1);
  });

  it('skips seats that passed before the call and lets the last robber win', () => {
    const { state } = run(fresh(), [
      [0, PASS_BID],
      [1, CALL],
      [2, ROB],
    ]);
    expect(state.turn).toBe(1);
    expect(state.bidding.robBackOffered).toBe(true);
    expect(applyAction(state, 0, ROB).ok).toBe(false);
    expect(rejection(applyAction(state, 0, ROB))).toBe('not_your_turn');
    const done = step(state, 1, PASS_BID).state;
    expect(done.landlord).toBe(2);
    expect(done.bidding.robs).toBe(1);
    expect(done.bidding.passed).toEqual([true, true, false]);
  });

  it('does not offer a rob-back when nobody robbed', () => {
    const { state, events } = run(fresh(), [
      [0, PASS_BID],
      [1, CALL],
      [2, PASS_BID],
    ]);
    expect(state.bidding.robBackOffered).toBe(false);
    expect(state.landlord).toBe(1);
    expect(landlordChosen(events)?.base).toBe(1);
  });

  it('makes the caller landlord at once when they are the last bidder', () => {
    const { state } = run(fresh(RULES_3P, 1), [
      [1, PASS_BID],
      [2, PASS_BID],
      [0, CALL],
    ]);
    expect(state.landlord).toBe(0);
    expect(state.phase).toBe('playing');
  });

  it('forces the last bidder to call when everyone else passed', () => {
    const { state } = run(fresh(), [
      [0, PASS_BID],
      [1, PASS_BID],
    ]);
    expect(state.turn).toBe(2);
    expect(legalActions(state, 2)).toEqual({ ...NONE, canCall: true, canPassBid: false });
    expect(rejection(applyAction(state, 2, PASS_BID))).toBe('invalid_action');
    expect(timeoutAction(state, 2)).toEqual(CALL);
    const forced = step(state, 2, CALL);
    expect(forced.state.landlord).toBe(2);
    expect(forced.state.base).toBe(1);
    expect(forced.state.bidding.robs).toBe(0);
    expect(types(forced.events)).toEqual(['bid', 'landlord_chosen']);
  });

  it('forces the last seat in bidding order, not seat n-1', () => {
    const { state } = run(fresh(RULES_3P, 2), [
      [2, PASS_BID],
      [0, PASS_BID],
    ]);
    expect(state.turn).toBe(1);
    expect(legalActions(state, 1).canPassBid).toBe(false);
    expect(step(state, 1, CALL).state.landlord).toBe(1);
  });

  it('redeals when everyone passes and the room says so', () => {
    const { state, events } = run(fresh(REDEAL_3P), [
      [0, PASS_BID],
      [1, PASS_BID],
      [2, PASS_BID],
    ]);
    expect(events[events.length - 1]).toEqual({ type: 'redeal' });
    expect(state.phase).toBe('redeal');
    expect(state.turn).toBe(-1);
    expect(state.landlord).toBeNull();
    expect(state.kittyRevealed).toBe(false);
    expect(legalActions(state, 0)).toEqual(NONE);
    expect(rejection(applyAction(state, 0, CALL))).toBe('wrong_phase');
  });

  it('rejects out-of-order and out-of-place bidding actions', () => {
    const start = fresh();
    expect(rejection(applyAction(start, 1, CALL))).toBe('not_your_turn');
    expect(rejection(applyAction(start, 0, ROB))).toBe('invalid_action');
    expect(rejection(applyAction(start, 0, bid(1)))).toBe('invalid_action');
    expect(rejection(applyAction(start, 0, PASS))).toBe('wrong_phase');
    expect(rejection(applyAction(start, 0, { type: 'play', cardIds: [] }))).toBe('wrong_phase');
    expect(rejection(applyAction(start, 0, double(true)))).toBe('wrong_phase');
    expect(rejection(applyAction(start, 3, CALL))).toBe('invalid_action');
    expect(rejection(applyAction(start, -1, CALL))).toBe('invalid_action');
    const afterCall = step(start, 0, CALL).state;
    expect(rejection(applyAction(afterCall, 1, CALL))).toBe('invalid_action');
    expect(rejection(applyAction(afterCall, 2, ROB))).toBe('not_your_turn');
    expect(rejection(applyAction(afterCall, 1, bid(2)))).toBe('invalid_action');
  });

  it('runs a four-seat rob round in which every rob doubles the stake', () => {
    const { state, events } = run(fresh(RULES_4P), [
      [0, CALL],
      [1, ROB],
      [2, ROB],
      [3, ROB],
      [0, ROB],
    ]);
    expect(state.landlord).toBe(0);
    expect(state.bidding.robs).toBe(4);
    expect(state.bidding.robDecided).toEqual([true, true, true, true]);
    expect(viewHand(state, 0).currentStake).toBe(16);
    expect(types(events).filter((type) => type === 'bid')).toHaveLength(5);
    expect(state.hands[0]).toHaveLength(33);
  });

  it('never asks a seat that passed before the call to rob (4 players)', () => {
    const { state } = run(fresh(RULES_4P, 3), [
      [3, PASS_BID],
      [0, PASS_BID],
      [1, CALL],
    ]);
    expect(state.turn).toBe(2);
    const robbed = step(state, 2, ROB).state;
    expect(robbed.turn).toBe(1);
    expect(robbed.bidding.robBackOffered).toBe(true);
    for (const seat of [3, 0]) {
      expect(legalActions(robbed, seat)).toEqual(NONE);
      expect(rejection(applyAction(robbed, seat, ROB))).toBe('not_your_turn');
    }
    const done = step(robbed, 1, ROB).state;
    expect(done.landlord).toBe(1);
    expect(done.bidding.robs).toBe(2);
  });
});

describe('bidding: points mode', () => {
  it('gives the landlord seat to the highest bidder with that bid as the base', () => {
    const start = fresh(POINTS_3P);
    expect(legalActions(start, 0)).toEqual({ ...NONE, bids: [1, 2, 3], canPassBid: true });
    const one = step(start, 0, bid(1)).state;
    expect(one.base).toBe(1);
    expect(one.bidding.highestBid).toBe(1);
    expect(one.bidding.claimant).toBe(0);
    expect(legalActions(one, 1)).toEqual({ ...NONE, bids: [2, 3], canPassBid: true });
    expect(rejection(applyAction(one, 1, bid(1)))).toBe('invalid_action');
    const { state, events } = run(one, [
      [1, bid(2)],
      [2, PASS_BID],
    ]);
    expect(state.landlord).toBe(1);
    expect(state.base).toBe(2);
    expect(landlordChosen(events)).toMatchObject({ seat: 1, base: 2 });
    expect(state.bidding.records).toEqual([
      { seat: 0, action: 'bid', value: 1 },
      { seat: 1, action: 'bid', value: 2 },
      { seat: 2, action: 'pass' },
    ]);
    expect(state.bidding.robs).toBe(0);
  });

  it('ends bidding at once on a bid of 3', () => {
    const { state, events } = run(fresh(POINTS_3P), [
      [0, PASS_BID],
      [1, bid(3)],
    ]);
    expect(state.landlord).toBe(1);
    expect(state.base).toBe(3);
    expect(state.bidding.records).toHaveLength(2);
    expect(types(events)).toEqual(['bid', 'bid', 'landlord_chosen']);
    expect(legalActions(state, 2)).toEqual({ ...NONE, canPlay: false });
  });

  it('lets every seat act exactly once: a lone bidder wins without a second turn', () => {
    const { state } = run(fresh(POINTS_3P), [
      [0, bid(1)],
      [1, PASS_BID],
      [2, PASS_BID],
    ]);
    expect(state.landlord).toBe(0);
    expect(state.base).toBe(1);
  });

  it('forces the last seat in order when everyone passes', () => {
    const { state } = run(fresh(POINTS_3P, 1), [
      [1, PASS_BID],
      [2, PASS_BID],
      [0, PASS_BID],
    ]);
    expect(state.landlord).toBe(0);
    expect(state.base).toBe(1);
    expect(state.phase).toBe('playing');
  });

  it('redeals when everyone passes and the room says so', () => {
    const { state, events } = run(fresh({ ...POINTS_3P, allPass: 'redeal' }), [
      [0, PASS_BID],
      [1, PASS_BID],
      [2, PASS_BID],
    ]);
    expect(state.phase).toBe('redeal');
    expect(types(events)).toEqual(['bid', 'bid', 'bid', 'redeal']);
  });

  it('rejects call, rob, bids that do not raise and bad values', () => {
    const start = fresh(POINTS_3P);
    expect(rejection(applyAction(start, 0, CALL))).toBe('invalid_action');
    expect(rejection(applyAction(start, 0, ROB))).toBe('invalid_action');
    expect(rejection(applyAction(start, 1, bid(1)))).toBe('not_your_turn');
    expect(rejection(applyAction(start, 0, { type: 'bid', value: 4 as 3 }))).toBe('invalid_action');
    const two = step(start, 0, bid(2)).state;
    expect(rejection(applyAction(two, 1, bid(2)))).toBe('invalid_action');
    expect(legalActions(two, 1).bids).toEqual([3]);
  });

  it('runs a four-seat points round', () => {
    const { state } = run(fresh(POINTS_4P), [
      [0, PASS_BID],
      [1, bid(1)],
      [2, bid(2)],
      [3, PASS_BID],
    ]);
    expect(state.landlord).toBe(2);
    expect(state.base).toBe(2);
    expect(state.bidding.records).toHaveLength(4);
    expect(state.bidding.passed).toEqual([true, false, false, true]);
    expect(state.hands[2]).toHaveLength(33);
  });
});

describe('doubling round', () => {
  const chosen = (): HandState =>
    run(fresh(DOUBLING_3P), [
      [0, CALL],
      [1, PASS_BID],
      [2, PASS_BID],
    ]).state;

  it('starts after the landlord is chosen and takes one simultaneous choice per seat', () => {
    const { events, state } = run(fresh(DOUBLING_3P), [
      [0, CALL],
      [1, PASS_BID],
      [2, PASS_BID],
    ]);
    expect(types(events)).toEqual(['bid', 'bid', 'bid', 'landlord_chosen', 'doubling_started']);
    expect(state.phase).toBe('doubling');
    expect(state.turn).toBe(-1);
    expect(state.kittyRevealed).toBe(true);
    for (const seat of [0, 1, 2]) {
      expect(legalActions(state, seat)).toEqual({ ...NONE, canDouble: true });
    }
  });

  it('hides other seats choices until everyone has decided', () => {
    const one = step(chosen(), 1, double(true));
    expect(one.events).toEqual([{ type: 'double', seat: 1, double: true }]);
    expect(one.state.doubles).toEqual([null, true, null]);
    expect(viewHand(one.state, 1).doubles).toEqual([null, true, null]);
    expect(viewHand(one.state, 0).doubles).toEqual([null, null, null]);
    expect(viewHand(one.state, 2).doubles).toEqual([null, null, null]);
    expect(viewHand(one.state, null).doubles).toEqual([null, null, null]);
    expect(legalActions(one.state, 1).canDouble).toBe(false);
    expect(rejection(applyAction(one.state, 1, double(false)))).toBe('invalid_action');

    const two = step(one.state, 2, double(false)).state;
    expect(two.phase).toBe('doubling');
    const done = step(two, 0, double(true));
    expect(done.events).toEqual([
      { type: 'double', seat: 0, double: true },
      { type: 'doubling_finished', doubles: [true, true, false] },
    ]);
    expect(done.state.phase).toBe('playing');
    expect(done.state.turn).toBe(0);
    expect(done.state.trick.leader).toBe(0);
    expect(done.state.doubles).toEqual([true, true, false]);
    for (const seat of [0, 1, 2, null]) {
      expect(viewHand(done.state, seat).doubles).toEqual([true, true, false]);
    }
  });

  it('rejects anything but a double during the round and doubles outside it', () => {
    const state = chosen();
    expect(rejection(applyAction(state, 0, PASS))).toBe('wrong_phase');
    expect(rejection(applyAction(state, 0, CALL))).toBe('wrong_phase');
    expect(rejection(applyAction(state, 0, { type: 'play', cardIds: [] }))).toBe('wrong_phase');
    expect(rejection(applyAction(fresh(), 0, double(true)))).toBe('wrong_phase');
    expect(timeoutAction(state, 2)).toEqual(double(false));
  });

  it('is skipped entirely when the option is off', () => {
    const { state, events } = run(fresh(), [
      [0, CALL],
      [1, PASS_BID],
      [2, PASS_BID],
    ]);
    expect(state.phase).toBe('playing');
    expect(types(events)).not.toContain('doubling_started');
  });
});

describe('playing', () => {
  const scenario = (): HandState =>
    playingState({
      hands: ['3 3 3 4 5 6 7 8 9 K K', '4 4 4 5 6 7 8 9 10 A A', '2 2 5 5 5 6 6 6 7 BJ RJ'],
      landlord: 0,
      kitty: 'Q Q Q',
    });

  it('lets the leader play any combination and records it', () => {
    const start = scenario();
    const { state, events } = step(start, 0, play('3 3 3 4', start.hands[0] as Card[]));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('play');
    expect(state.trick.current?.type).toBe('triple_single');
    expect(state.trick.currentSeat).toBe(0);
    expect(state.trick.plays).toHaveLength(1);
    expect(state.history).toEqual([{ seat: 0, combo: state.trick.current, trickNumber: 1 }]);
    expect(state.playCounts).toEqual([1, 0, 0]);
    expect(state.hands[0]).toHaveLength(7);
    expect(state.turn).toBe(1);
    expect(state.phase).toBe('playing');
  });

  it('does not let the leader pass', () => {
    const start = scenario();
    expect(rejection(applyAction(start, 0, PASS))).toBe('cannot_pass');
    expect(legalActions(start, 0)).toEqual({ ...NONE, canPlay: true, canPass: false });
    expect(legalActions(start, 1)).toEqual(NONE);
  });

  it('rejects plays out of turn, with foreign or duplicate cards, or malformed', () => {
    const start = scenario();
    expect(rejection(applyAction(start, 1, play('4 4', start.hands[1] as Card[])))).toBe(
      'not_your_turn',
    );
    expect(rejection(applyAction(start, 0, play('4 4', start.hands[1] as Card[])))).toBe(
      'cards_not_in_hand',
    );
    const own = (start.hands[0] as Card[])[0] as Card;
    expect(rejection(applyAction(start, 0, { type: 'play', cardIds: [own.id, own.id] }))).toBe(
      'cards_not_in_hand',
    );
    expect(rejection(applyAction(start, 0, { type: 'play', cardIds: ['nope'] }))).toBe(
      'cards_not_in_hand',
    );
    expect(rejection(applyAction(start, 0, { type: 'play', cardIds: [] }))).toBe('invalid_action');
    expect(rejection(applyAction(start, 0, CALL))).toBe('wrong_phase');
    expect(rejection(applyAction(start, 0, double(true)))).toBe('wrong_phase');
  });

  it('rejects card sets that are not a combination', () => {
    const start = scenario();
    expect(rejection(applyAction(start, 0, play('3 4', start.hands[0] as Card[])))).toBe(
      'invalid_combo',
    );
    expect(rejection(applyAction(start, 0, play('3 3 3 K K 4', start.hands[0] as Card[])))).toBe(
      'invalid_combo',
    );
  });

  it('requires an answer to beat the current combination', () => {
    const start = scenario();
    const led = step(start, 0, play('K K', start.hands[0] as Card[])).state;
    expect(rejection(applyAction(led, 1, play('4 4', led.hands[1] as Card[])))).toBe(
      'does_not_beat',
    );
    expect(rejection(applyAction(led, 1, play('A', led.hands[1] as Card[])))).toBe('does_not_beat');
    expect(rejection(applyAction(led, 1, play('4 4 4', led.hands[1] as Card[])))).toBe(
      'does_not_beat',
    );
    expect(legalActions(led, 1)).toEqual({ ...NONE, canPlay: true, canPass: true });
    const answered = step(led, 1, play('A A', led.hands[1] as Card[])).state;
    expect(answered.trick.current?.rank).toBe(14);
    expect(answered.trick.currentSeat).toBe(1);
    expect(answered.turn).toBe(2);
    const bombed = step(answered, 2, play('BJ RJ', answered.hands[2] as Card[]));
    expect(bombed.state.bombsPlayed).toBe(1);
    expect(bombed.state.trick.current?.type).toBe('rocket');
  });

  it('ends the trick after n-1 passes and lets the winner lead the next one', () => {
    const start = scenario();
    const { state, events } = run(start, [
      [0, play('9', start.hands[0] as Card[])],
      [1, play('10', start.hands[1] as Card[])],
      [2, PASS],
      [0, PASS],
    ]);
    expect(types(events)).toEqual(['play', 'play', 'pass', 'pass', 'trick_won']);
    expect(events[events.length - 1]).toEqual({ type: 'trick_won', seat: 1 });
    expect(state.trick).toEqual({ leader: 1, plays: [], current: null, currentSeat: null });
    expect(state.turn).toBe(1);
    expect(state.history.map((entry) => entry.trickNumber)).toEqual([1, 1, 1, 1]);
    expect(state.history[2]).toEqual({ seat: 2, combo: null, trickNumber: 1 });
    expect(rejection(applyAction(state, 1, PASS))).toBe('cannot_pass');
    const next = step(state, 1, play('4 4 4 5', state.hands[1] as Card[])).state;
    expect(next.history[4]?.trickNumber).toBe(2);
    expect(next.playCounts).toEqual([1, 2, 0]);
  });

  it('lets a seat that passed play again when the trick comes back around', () => {
    const start = scenario();
    const { state, events } = run(start, [
      [0, play('9', start.hands[0] as Card[])],
      [1, PASS],
      [2, play('BJ', start.hands[2] as Card[])],
      [0, PASS],
      [1, PASS],
    ]);
    expect(types(events)).toEqual(['play', 'pass', 'play', 'pass', 'pass', 'trick_won']);
    expect(state.trick.leader).toBe(2);
    const again = run(start, [
      [0, play('K', start.hands[0] as Card[])],
      [1, PASS],
      [2, play('2', start.hands[2] as Card[])],
      [0, PASS],
      [1, PASS],
    ]).state;
    expect(again.turn).toBe(2);
    const single = run(start, [
      [0, play('4', start.hands[0] as Card[])],
      [1, play('5', start.hands[1] as Card[])],
      [2, PASS],
      [0, play('K', start.hands[0] as Card[])],
      [1, play('A', start.hands[1] as Card[])],
      [2, PASS],
      [0, PASS],
    ]).state;
    expect(single.trick.leader).toBe(1);
    expect(single.history.filter((entry) => entry.combo === null)).toHaveLength(3);
  });

  it('needs three passes in a row to end a four-player trick', () => {
    const start = playingState({
      hands: ['3 3 3 4 K', '4 4 5 6 7', '5 5 8 9 10', '6 6 J Q 2'],
      landlord: 1,
    });
    const { state } = run(start, [
      [1, play('4 4', start.hands[1] as Card[])],
      [2, play('5 5', start.hands[2] as Card[])],
      [3, PASS],
      [0, PASS],
    ]);
    expect(state.trick.current?.rank).toBe(5);
    expect(state.turn).toBe(1);
    const won = step(state, 1, PASS);
    expect(won.events[1]).toEqual({ type: 'trick_won', seat: 2 });
    expect(won.state.turn).toBe(2);
  });

  it('answers with the reading that beats the current combination', () => {
    const start = playingState({
      hands: ['3 3 3 4 4 4 5 5 5 7 8 9', '3 3 3 4 4 4 5 5 5 6 6 6', '10 J Q'],
      rules: RULES_4P,
      landlord: 0,
    });
    const led = step(start, 0, play('3 3 3 4 4 4 5 5 5 7 8 9', start.hands[0] as Card[])).state;
    expect(led.phase).toBe('finished');
    const other = playingState({
      hands: ['3 3 3 4 4 4 5 5 5 7 8 9 2', '3 3 3 4 4 4 5 5 5 6 6 6', '10 J Q'],
      rules: RULES_4P,
      landlord: 0,
    });
    const airplane = step(other, 0, play('3 3 3 4 4 4 5 5 5 7 8 9', other.hands[0] as Card[]));
    expect(airplane.state.trick.current?.type).toBe('airplane_single');
    const answer = step(
      airplane.state,
      1,
      play('3 3 3 4 4 4 5 5 5 6 6 6', airplane.state.hands[1] as Card[]),
    );
    expect(answer.state.trick.current).toMatchObject({ type: 'airplane_single', rank: 6 });
    expect(answer.state.phase).toBe('finished');
    expect(answer.state.result?.winnerSeat).toBe(1);
  });

  it('finishes the hand the moment a seat plays its last card', () => {
    const start = playingState({
      hands: ['5 5', '6 6 7', '8 8 9 9'],
      landlord: 0,
      kitty: 'Q Q Q',
    });
    const { state, events } = step(start, 0, play('5 5', start.hands[0] as Card[]));
    expect(types(events)).toEqual(['play', 'hand_finished']);
    expect(state.phase).toBe('finished');
    expect(state.turn).toBe(-1);
    expect(state.hands[0]).toEqual([]);
    expect(state.result).not.toBeNull();
    expect(state.result?.winnerSeat).toBe(0);
    expect(state.result?.winnerSide).toBe('landlord');
    expect(state.result?.spring).toBe('spring');
    expect(state.result?.amounts).toEqual([4, -2, -2]);
    expect(events[1]).toEqual({ type: 'hand_finished', result: state.result });
    expect(legalActions(state, 0)).toEqual(NONE);
    expect(rejection(applyAction(state, 1, PASS))).toBe('wrong_phase');
    expect(viewHand(state, 1).result).toEqual(state.result);
  });

  it('lets a peasant win for the team', () => {
    const start = playingState({
      hands: ['5 5 3', '6 6', '8 8 9 9'],
      landlord: 0,
    });
    const { state } = run(start, [
      [0, play('5 5', start.hands[0] as Card[])],
      [1, play('6 6', start.hands[1] as Card[])],
    ]);
    expect(state.phase).toBe('finished');
    expect(state.result?.winnerSide).toBe('peasants');
    expect(state.result?.winnerSeat).toBe(1);
    expect(state.result?.spring).toBe('anti_spring');
    expect(state.result?.amounts).toEqual([-4, 2, 2]);
  });

  it('never mutates the state it is given', () => {
    const start = deepFreeze(scenario());
    const snapshot = JSON.stringify(start);
    const { state } = run(start, [
      [0, play('3 3 3 4', start.hands[0] as Card[])],
      [1, play('4 4 4 5', start.hands[1] as Card[])],
      [2, PASS],
      [0, PASS],
    ]);
    expect(JSON.stringify(start)).toBe(snapshot);
    expect(state.hands[0]).toHaveLength(7);
    const frozenBid = deepFreeze(fresh(DOUBLING_3P));
    const bidSnapshot = JSON.stringify(frozenBid);
    const { state: bidState } = run(frozenBid, [
      [0, CALL],
      [1, ROB],
      [2, PASS_BID],
      [0, PASS_BID],
      [0, double(true)],
    ]);
    expect(JSON.stringify(frozenBid)).toBe(bidSnapshot);
    expect(bidState.landlord).toBe(1);
  });
});

describe('viewHand', () => {
  it('shows a seat only its own cards and hides the kitty until it is revealed', () => {
    const state = fresh(RULES_3P, 1, 'view');
    const view = viewHand(state, 0);
    const serialized = JSON.stringify(view);
    expect(view.seat).toBe(0);
    expect(view.hand).toEqual(state.hands[0]);
    expect(view.cardCounts).toEqual([17, 17, 17]);
    expect(view.kitty).toBeNull();
    expect(view.kittySize).toBe(3);
    expect(view.turn).toBe(1);
    expect(view.firstBidder).toBe(1);
    expect(view.currentStake).toBe(1);
    expect(view.legal).toEqual(NONE);
    expect(viewHand(state, 1).legal).toEqual({ ...NONE, canCall: true, canPassBid: true });
    for (const seat of [1, 2]) {
      for (const card of state.hands[seat] as Card[]) {
        expect(serialized).not.toContain(`"${card.id}"`);
      }
    }
    for (const card of state.kitty) expect(serialized).not.toContain(`"${card.id}"`);
    expect('hands' in view).toBe(false);
    expect('seed' in view).toBe(false);
  });

  it('gives spectators no cards and no actions', () => {
    const state = fresh();
    const view = viewHand(state, null);
    expect(view.seat).toBeNull();
    expect(view.hand).toEqual([]);
    expect(view.legal).toEqual(NONE);
    const serialized = JSON.stringify(view);
    for (const card of [...state.hands.flat(), ...state.kitty]) {
      expect(serialized).not.toContain(`"${card.id}"`);
    }
    expect(viewHand(state, 7).seat).toBeNull();
  });

  it('reveals the kitty once the landlord is chosen and shows the stake', () => {
    const start = fresh({ ...RULES_3P, kittyBonus: true }, 0, 'view');
    const { state } = run(start, [
      [0, CALL],
      [1, ROB],
      [2, PASS_BID],
      [0, PASS_BID],
    ]);
    const view = viewHand(state, 2);
    expect(view.kitty).toEqual(start.kitty);
    expect(view.landlord).toBe(1);
    expect(view.cardCounts).toEqual([17, 20, 17]);
    expect(view.currentStake).toBe(2 * kittyBonusMultiplier(start.kitty, start.rules));
    expect(view.bidding.robs).toBe(1);
    const serialized = JSON.stringify(view);
    for (const card of state.hands[0] as Card[]) {
      expect(serialized).not.toContain(`"${card.id}"`);
    }
    for (const card of state.hands[1] as Card[]) {
      if (!start.kitty.some((kittyCard) => kittyCard.id === card.id)) {
        expect(serialized).not.toContain(`"${card.id}"`);
      }
    }
  });

  it('only ever exposes played cards inside the trick and the history', () => {
    const start = scenarioForView();
    const { state } = run(start, [
      [0, play('3 3 3 4', start.hands[0] as Card[])],
      [1, play('4 4 4 5', start.hands[1] as Card[])],
    ]);
    const serialized = JSON.stringify(viewHand(state, 2));
    for (const card of [...(state.hands[0] as Card[]), ...(state.hands[1] as Card[])]) {
      expect(serialized).not.toContain(`"${card.id}"`);
    }
    expect(viewHand(state, 2).history).toHaveLength(2);
    expect(viewHand(state, 2).trick.current?.rank).toBe(4);
  });
});

function scenarioForView(): HandState {
  return playingState({
    hands: ['3 3 3 4 5 6 7 8 9 K K', '4 4 4 5 6 7 8 9 10 A A', '2 2 5 5 5 6 6 6 7 BJ RJ'],
    landlord: 0,
  });
}

describe('timeoutAction', () => {
  it('passes when bidding unless the seat is the forced last bidder', () => {
    const start = fresh();
    expect(timeoutAction(start, 0)).toEqual(PASS_BID);
    const afterCall = step(start, 0, CALL).state;
    expect(timeoutAction(afterCall, 1)).toEqual(PASS_BID);
    const forced = run(fresh(), [
      [0, PASS_BID],
      [1, PASS_BID],
    ]).state;
    expect(timeoutAction(forced, 2)).toEqual(CALL);
    expect(applyAction(forced, 2, timeoutAction(forced, 2)).ok).toBe(true);
    const redeal = run(fresh(REDEAL_3P), [
      [0, PASS_BID],
      [1, PASS_BID],
    ]).state;
    expect(timeoutAction(redeal, 2)).toEqual(PASS_BID);
    expect(timeoutAction(fresh(POINTS_3P), 0)).toEqual(PASS_BID);
  });

  it('keeps in the doubling round, passes when answering and leads the lowest single', () => {
    const doubling = run(fresh(DOUBLING_3P), [
      [0, CALL],
      [1, PASS_BID],
      [2, PASS_BID],
    ]).state;
    expect(timeoutAction(doubling, 1)).toEqual(double(false));
    const start = scenarioForView();
    const lead = timeoutAction(start, 0);
    expect(lead.type).toBe('play');
    const played = lead.type === 'play' ? lead.cardIds : [];
    expect(played).toHaveLength(1);
    expect((start.hands[0] as Card[]).find((card) => card.id === played[0])?.rank).toBe(3);
    expect(applyAction(start, 0, lead).ok).toBe(true);
    const led = step(start, 0, play('K', start.hands[0] as Card[])).state;
    expect(timeoutAction(led, 1)).toEqual(PASS);
    expect(applyAction(led, 1, PASS).ok).toBe(true);
    const finished = step(
      playingState({ hands: ['5', '6 6', '7 7'], landlord: 0 }),
      0,
      play('5', cards('5')),
    ).state;
    expect(timeoutAction(finished, 1)).toEqual(PASS);
  });
});

describe('nextFirstBidder', () => {
  const constant = (value: number) => (): number => value;

  it('picks a random seat for the first hand in every mode', () => {
    for (const mode of ['winner', 'rotate', 'random'] as const) {
      const rules = { ...RULES_3P, firstBidder: mode };
      expect(nextFirstBidder(rules, null, constant(0.5))).toBe(1);
      expect(nextFirstBidder(rules, null, constant(0.99))).toBe(2);
      expect(nextFirstBidder({ ...RULES_4P, firstBidder: mode }, null, constant(0.99))).toBe(3);
    }
    expect(nextFirstBidder(RULES_3P, null, seededRng('bidder'))).toBeGreaterThanOrEqual(0);
  });

  it('follows the previous winner, or the next seat after a redeal', () => {
    const finished = step(
      playingState({ hands: ['5', '6 6', '7 7'], landlord: 2, leader: 2 }),
      2,
      play('7 7', cards('7 7')),
    ).state;
    const won = { ...finished, hands: [[], finished.hands[1] as Card[], []] };
    expect(nextFirstBidder(RULES_3P, finished, constant(0))).toBe(2);
    expect(nextFirstBidder(RULES_3P, won, constant(0))).toBe(2);
    const redeal = run(fresh(REDEAL_3P, 2), [
      [2, PASS_BID],
      [0, PASS_BID],
      [1, PASS_BID],
    ]).state;
    expect(nextFirstBidder(RULES_3P, redeal, constant(0))).toBe(0);
    expect(nextFirstBidder(RULES_3P, fresh(RULES_3P, 1), constant(0))).toBe(2);
  });

  it('rotates or draws at random when the room says so', () => {
    const rotate = { ...RULES_3P, firstBidder: 'rotate' as const };
    expect(nextFirstBidder(rotate, fresh(RULES_3P, 2), constant(0))).toBe(0);
    expect(nextFirstBidder(rotate, fresh(RULES_3P, 0), constant(0))).toBe(1);
    const random = { ...RULES_4P, firstBidder: 'random' as const };
    expect(nextFirstBidder(random, fresh(RULES_4P, 0), constant(0.3))).toBe(1);
    expect(nextFirstBidder(random, fresh(RULES_4P, 0), constant(0.8))).toBe(3);
  });
});
