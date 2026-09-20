/**
 * Adversarial verification, round 1: trick play, trick resolution, end of hand, settlement,
 * views and timeouts. Spec: docs/RULES.md ("Play", "Scoring", "Kitty bonus", "Doubling round",
 * "Turn timer") and docs/ENGINE_API.md (hand.ts, scoring.ts). Failing tests document engine
 * bugs for the fixer; passing tests are regression coverage.
 */
import { describe, expect, it } from 'vitest';

import type { Card, HandAction, HandEvent, HandResult, HandState, RuleSettings } from '../types';
import { createDeck, makeCard, seededRng } from '../cards';
import { applyAction, createHand, legalActions, timeoutAction, viewHand } from '../hand';
import { findPlays } from '../plays';
import { currentStake, kittyBonusMultiplier, settle } from '../scoring';
import {
  PASS,
  RULES_3P,
  RULES_4P,
  cards,
  play,
  playingState,
  rejection,
  run,
  step,
} from '../test-helpers';

const BONUS_3P: RuleSettings = { ...RULES_3P, kittyBonus: true };
const BONUS_4P: RuleSettings = { ...RULES_4P, kittyBonus: true };
const POINTS_3P: RuleSettings = { ...RULES_3P, biddingMode: 'points' };
const DOUBLING_3P: RuleSettings = { ...RULES_3P, doublingRound: true };

const CALL: HandAction = { type: 'call' };
const PASS_BID: HandAction = { type: 'pass_bid' };

function ids(set: readonly Card[]): string[] {
  return set.map((card) => card.id);
}

function types(events: HandEvent[]): string[] {
  return events.map((event) => event.type);
}

function hand(state: HandState, seat: number): Card[] {
  return state.hands[seat] as Card[];
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

interface SettleOptions {
  rules?: RuleSettings;
  /** One spec per seat, '' for the seat that went out. */
  hands: string[];
  landlord: number;
  kitty?: string | Card[];
  base?: number;
  robs?: number;
  bombs?: number;
  /** Defaults to 2 for everyone (never a spring or anti-spring). */
  playCounts?: number[];
  doubles?: boolean[];
}

/** A hand-built finished position, settled. */
function settled(opts: SettleOptions): HandResult {
  const kitty = typeof opts.kitty === 'string' ? opts.kitty : undefined;
  const base = playingState({
    rules: opts.rules,
    hands: opts.hands,
    landlord: opts.landlord,
    kitty,
  });
  return settle({
    ...base,
    kitty: Array.isArray(opts.kitty) ? opts.kitty : base.kitty,
    base: opts.base ?? 1,
    bidding: { ...base.bidding, robs: opts.robs ?? 0 },
    bombsPlayed: opts.bombs ?? 0,
    playCounts: opts.playCounts ?? opts.hands.map(() => 2),
    doubles: opts.doubles ?? base.doubles,
  });
}

// ---------------------------------------------------------------------------
// Trick play legality (RULES.md "Play")
// ---------------------------------------------------------------------------

describe('trick play legality', () => {
  it('the landlord leads the first trick and cannot pass', () => {
    const dealt = createHand({ rules: RULES_3P, seed: 'lead', handNumber: 1, firstBidder: 1 });
    const { state } = run(dealt, [
      [1, CALL],
      [2, PASS_BID],
      [0, PASS_BID],
    ]);
    expect(state).toMatchObject({ phase: 'playing', landlord: 1, turn: 1 });
    expect(state.trick.leader).toBe(1);
    expect(rejection(applyAction(state, 1, PASS))).toBe('cannot_pass');
    expect(legalActions(state, 1)).toMatchObject({ canPlay: true, canPass: false });
    expect(legalActions(state, 2)).toMatchObject({ canPlay: false, canPass: false });
    expect(timeoutAction(state, 1).type).toBe('play');
  });

  it('an answer needs the same type and length with a higher rank, or a bomb or rocket', () => {
    const start = playingState({
      hands: ['7 7 8 9 10 J Q', '3 5 7 7 9 9 K', '4 4 4 4 BJ RJ 6'],
      landlord: 0,
    });
    const led = step(start, 0, play('7', hand(start, 0))).state;
    for (const spec of ['3', '7', '9 9', '7 7']) {
      expect(rejection(applyAction(led, 1, play(spec, hand(led, 1))))).toBe('does_not_beat');
    }
    const answered = step(led, 1, play('K', hand(led, 1))).state;
    const bombed = step(answered, 2, play('4 4 4 4', hand(answered, 2))).state;
    expect(bombed.bombsPlayed).toBe(1);
    expect(rejection(applyAction(bombed, 0, play('8 9 10 J Q', hand(bombed, 0))))).toBe(
      'does_not_beat',
    );
  });

  it('rejects cards the seat does not hold, duplicates, empty plays and illegal final plays', () => {
    const start = playingState({ hands: ['8 8', '3', '9 10 J'], landlord: 0 });
    const foreign = hand(start, 1)[0] as Card;
    const own = hand(start, 0)[0] as Card;
    const playIds = (cardIds: string[]): HandAction => ({ type: 'play', cardIds });
    expect(rejection(applyAction(start, 0, playIds([foreign.id])))).toBe('cards_not_in_hand');
    expect(rejection(applyAction(start, 0, playIds([own.id, own.id])))).toBe('cards_not_in_hand');
    expect(rejection(applyAction(start, 0, playIds(['nope'])))).toBe('cards_not_in_hand');
    expect(applyAction(start, 0, playIds([])).ok).toBe(false);
    expect(rejection(applyAction(start, 1, playIds([foreign.id])))).toBe('not_your_turn');
    expect(rejection(applyAction(start, 1, PASS))).toBe('not_your_turn');
    // Playing your last card is still subject to "must beat".
    const led = step(start, 0, play('8', hand(start, 0))).state;
    expect(rejection(applyAction(led, 1, play('3', hand(led, 1))))).toBe('does_not_beat');
    expect(led.phase).toBe('playing');
  });
});

// ---------------------------------------------------------------------------
// Trick resolution
// ---------------------------------------------------------------------------

describe('trick resolution', () => {
  it('3 players: only passes after the current play count; the last player to play leads', () => {
    const start = playingState({ hands: ['3 K 2', '4 5 6', '7 8 9'], landlord: 0 });
    const first = run(start, [
      [0, play('3', hand(start, 0))],
      [1, PASS],
      [2, play('7', hand(start, 2))],
      [0, PASS],
    ]);
    expect(types(first.events)).toEqual(['play', 'pass', 'play', 'pass']);
    expect(first.state.turn).toBe(1);
    const won = step(first.state, 1, PASS);
    expect(types(won.events)).toEqual(['pass', 'trick_won']);
    expect(won.events[1]).toEqual({ type: 'trick_won', seat: 2 });
    expect(won.state.turn).toBe(2);
    expect(won.state.trick).toEqual({ leader: 2, plays: [], current: null, currentSeat: null });
    expect(won.state.history.map((entry) => entry.trickNumber)).toEqual([1, 1, 1, 1, 1]);
    expect(rejection(applyAction(won.state, 2, PASS))).toBe('cannot_pass');
  });

  it('4 players: needs three passes after the current play; a passed seat may play again', () => {
    const four = playingState({ hands: ['3 K 2', '4 9 J', '7 8 Q', '5 6 10'], landlord: 0 });
    const partial = run(four, [
      [0, play('3', hand(four, 0))],
      [1, PASS],
      [2, play('7', hand(four, 2))],
      [3, PASS],
      [0, PASS],
    ]);
    expect(types(partial.events)).not.toContain('trick_won');
    expect(partial.state.turn).toBe(1);
    const again = run(partial.state, [
      [1, play('9', hand(four, 1))], // seat 1 passed earlier in this trick
      [2, PASS],
      [3, play('10', hand(four, 3))],
      [0, PASS],
      [1, PASS],
      [2, PASS],
    ]);
    expect(again.events[again.events.length - 1]).toEqual({ type: 'trick_won', seat: 3 });
    expect(again.state.turn).toBe(3);
    expect(again.state.trick.leader).toBe(3);
    expect(again.state.playCounts).toEqual([1, 1, 1, 1]);
    expect(again.state.history.every((entry) => entry.trickNumber === 1)).toBe(true);
  });

  it('trick numbers advance by one per trick and the ending pass belongs to the trick it ended', () => {
    const start = playingState({ hands: ['3 4 K 2', '5 9 J A', '7 8 Q 10'], landlord: 0 });
    const { state } = run(start, [
      [0, play('3', hand(start, 0))],
      [1, play('5', hand(start, 1))],
      [2, PASS],
      [0, PASS],
      [1, play('9', hand(start, 1))],
      [2, play('10', hand(start, 2))],
      [0, play('K', hand(start, 0))],
      [1, PASS],
      [2, PASS],
      [0, play('4', hand(start, 0))],
    ]);
    expect(state.history.map((entry) => entry.trickNumber)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 2, 3]);
    expect(state.history.map((entry) => entry.seat)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2, 0]);
    expect(state.trick).toMatchObject({ leader: 0, currentSeat: 0 });
    expect(state.trick.plays).toHaveLength(1);
    expect(state.playCounts).toEqual([3, 2, 1]);
  });
});

// ---------------------------------------------------------------------------
// End of hand, bombsPlayed, playCounts, spring and anti-spring
// ---------------------------------------------------------------------------

describe('end of hand', () => {
  it('ends the moment a peasant plays their last cards mid-trick (anti-spring, 3 players)', () => {
    const start = playingState({ hands: ['3 K', '9', '7 8'], landlord: 0, kitty: '5 6 J' });
    const { state, events } = run(start, [
      [0, play('3', hand(start, 0))],
      [1, play('9', hand(start, 1))],
    ]);
    expect(types(events)).toEqual(['play', 'play', 'hand_finished']);
    expect(state).toMatchObject({ phase: 'finished', turn: -1, playCounts: [1, 1, 0] });
    expect(state.hands[1]).toEqual([]);
    expect(state.result).toMatchObject({
      winnerSide: 'peasants',
      winnerSeat: 1,
      landlord: 0,
      spring: 'anti_spring',
      stake: 2,
      amounts: [-4, 2, 2],
    });
    expect(state.result).toEqual(settle(state));
    expect(rejection(applyAction(state, 2, PASS))).toBe('wrong_phase');
    expect(rejection(applyAction(state, 0, play('K', hand(state, 0))))).toBe('wrong_phase');
    expect(legalActions(state, 2).canPlay).toBe(false);
  });

  it('is not an anti-spring once the landlord has played more than the opening lead', () => {
    const start = playingState({ hands: ['3 4 K 2', '5 9', '7 8'], landlord: 0 });
    const { state } = run(start, [
      [0, play('3', hand(start, 0))],
      [1, play('5', hand(start, 1))],
      [2, PASS],
      [0, play('K', hand(start, 0))],
      [1, PASS],
      [2, PASS],
      [0, play('4', hand(start, 0))],
      [1, play('9', hand(start, 1))],
    ]);
    expect(state).toMatchObject({ phase: 'finished', playCounts: [3, 2, 0] });
    expect(state.result).toMatchObject({ spring: null, stake: 1, amounts: [-2, 1, 1] });
  });

  it('4 players: spring when the landlord wins and no peasant ever played', () => {
    const start = playingState({ hands: ['3 3 K', '4 5 6', '7 8 9', '10 J Q'], landlord: 0 });
    const { state, events } = run(start, [
      [0, play('3 3', hand(start, 0))],
      [1, PASS],
      [2, PASS],
      [3, PASS],
      [0, play('K', hand(start, 0))],
    ]);
    expect(types(events)).toEqual([
      'play',
      'pass',
      'pass',
      'pass',
      'trick_won',
      'play',
      'hand_finished',
    ]);
    expect(state.playCounts).toEqual([2, 0, 0, 0]);
    expect(state.result).toMatchObject({
      winnerSide: 'landlord',
      spring: 'spring',
      stake: 2,
      amounts: [6, -2, -2, -2],
    });
    expect(state.history.map((entry) => entry.trickNumber)).toEqual([1, 1, 1, 1, 2]);
  });

  it('4 players: anti-spring when the landlord only led once; no spring while a peasant played', () => {
    const start = playingState({ hands: ['3 3 K', '4 4 6', '7 8 9', '10 J Q'], landlord: 0 });
    const { state } = run(start, [
      [0, play('3', hand(start, 0))],
      [1, play('6', hand(start, 1))],
      [2, PASS],
      [3, PASS],
      [0, PASS],
      [1, play('4 4', hand(start, 1))],
    ]);
    expect(state).toMatchObject({ phase: 'finished', playCounts: [1, 2, 0, 0] });
    expect(state.result).toMatchObject({ spring: 'anti_spring', amounts: [-6, 2, 2, 2] });
    const silent = settled({ hands: ['', '3', '4', '5'], landlord: 0, playCounts: [3, 1, 0, 0] });
    expect(silent.spring).toBeNull();
    expect(silent.amounts).toEqual([3, -1, -1, -1]);
  });

  it('bombsPlayed counts bombs and rockets from anyone, when leading too, but not four + two', () => {
    const start = playingState({
      hands: ['5 5 5 5 6 7 3', '9 9 9 9 K', 'BJ RJ 4 4 4 4 8'],
      landlord: 0,
    });
    const led = step(start, 0, play('5 5 5 5 6 7', hand(start, 0))).state;
    expect(led.trick.current?.type).toBe('four_two_single');
    expect(led.bombsPlayed).toBe(0);
    const { state } = run(led, [
      [1, play('9 9 9 9', hand(led, 1))],
      [2, play('BJ RJ', hand(led, 2))],
      [0, PASS],
      [1, PASS],
      [2, play('4 4 4 4', hand(led, 2))],
    ]);
    expect(state.bombsPlayed).toBe(3);
    expect(state.playCounts).toEqual([1, 1, 2]);
    expect(currentStake(state)).toBe(8);
    expect(viewHand(state, null).currentStake).toBe(8);
  });

  it('4 players: a 5-card bomb and a 3-joker rocket each count once', () => {
    const start = playingState({
      hands: ['3 3 3 3 3 K', 'BJ BJ RJ 5', 'RJ 6 9', '7 7 7 7 8'],
      landlord: 0,
    });
    const { state } = run(start, [
      [0, play('3 3 3 3 3', hand(start, 0))],
      [1, play('BJ BJ RJ', hand(start, 1))],
      [2, PASS],
      [3, PASS],
      [0, PASS],
      [1, play('5', hand(start, 1))],
    ]);
    expect(state).toMatchObject({ phase: 'finished', bombsPlayed: 2 });
    expect(state.result).toMatchObject({ bombs: 2, spring: 'anti_spring', stake: 8 });
    expect(state.result?.amounts).toEqual([-24, 8, 8, 8]);
  });
});

// ---------------------------------------------------------------------------
// settle() on hand-built positions (RULES.md "Scoring", "Kitty bonus", "Doubling round")
// ---------------------------------------------------------------------------

describe('settle', () => {
  it('call mode: base 1 doubled per rob and per bomb', () => {
    for (const robs of [0, 1, 2, 3]) {
      for (const bombs of [0, 1, 2]) {
        const result = settled({ hands: ['', '3', '4'], landlord: 0, robs, bombs });
        const stake = 2 ** robs * 2 ** bombs;
        expect(result).toMatchObject({ base: 1, robs, bombs, kittyBonus: 1, spring: null, stake });
        expect(result.amounts).toEqual([2 * stake, -stake, -stake]);
      }
    }
  });

  it('points mode: the winning bid is the base', () => {
    const rules = POINTS_3P;
    expect(settled({ rules, hands: ['3', '', '4'], landlord: 0, base: 3 })).toMatchObject({
      base: 3,
      stake: 3,
      amounts: [-6, 3, 3],
    });
    expect(settled({ rules, hands: ['', '3', '4'], landlord: 0, base: 2, bombs: 2 })).toMatchObject(
      { stake: 8, amounts: [16, -8, -8] },
    );
    const spring = settled({
      rules,
      hands: ['', '3', '4'],
      landlord: 0,
      base: 3,
      playCounts: [4, 0, 0],
    });
    expect(spring).toMatchObject({ spring: 'spring', stake: 6, amounts: [12, -6, -6] });
  });

  it('spring and anti-spring double the stake, with the exact playCounts boundaries', () => {
    const win = (counts: number[]): HandResult =>
      settled({ hands: ['', '3', '4'], landlord: 0, playCounts: counts });
    expect(win([3, 0, 0])).toMatchObject({ spring: 'spring', stake: 2 });
    expect(win([3, 0, 1]).spring).toBeNull();
    const lose = (counts: number[]): HandResult =>
      settled({ hands: ['3', '', '4'], landlord: 0, playCounts: counts });
    expect(lose([1, 2, 0])).toMatchObject({ spring: 'anti_spring', stake: 2, amounts: [-4, 2, 2] });
    expect(lose([2, 2, 0]).spring).toBeNull();
    const four = (hands: string[], counts: number[]): HandResult =>
      settled({ hands, landlord: 2, playCounts: counts });
    expect(four(['3', '4', '', '5'], [0, 0, 5, 0])).toMatchObject({
      spring: 'spring',
      amounts: [-2, -2, 6, -2],
    });
    expect(four(['3', '4', '5', ''], [0, 0, 1, 3])).toMatchObject({
      spring: 'anti_spring',
      amounts: [2, 2, -6, 2],
    });
    expect(four(['3', '4', '5', ''], [0, 0, 2, 3]).spring).toBeNull();
  });

  it('applies every kitty bonus row when the option is on, and 1 when it is off', () => {
    const suits = ['S', 'H', 'D'] as const;
    const mixedRun = cards('3 4 5').map((card, i) => makeCard(card.rank, suits[i] as 'S', 0));
    const rows: Array<[string | Card[], number]> = [
      ['BJ RJ 5', 3],
      ['5 5 5', 3],
      ['3 4 5', 3], // cards() deals the first copy of every rank as a spade: a same-suit run
      [mixedRun, 2],
      ['3 8 BJ', 2],
      ['3 8 K', 1],
    ];
    for (const [kitty, multiplier] of rows) {
      const on = settled({ rules: BONUS_3P, hands: ['', '6', '7'], landlord: 0, kitty });
      expect(on).toMatchObject({ kittyBonus: multiplier, stake: multiplier });
      expect(on.amounts).toEqual([2 * multiplier, -multiplier, -multiplier]);
      const off = settled({ rules: RULES_3P, hands: ['', '6', '7'], landlord: 0, kitty });
      expect(off).toMatchObject({ kittyBonus: 1, stake: 1 });
    }
    const fourP = settled({
      rules: BONUS_4P,
      hands: ['', '6', '7', '8'],
      landlord: 0,
      kitty: 'RJ RJ 3 4 5 9 J K',
      robs: 1,
      bombs: 1,
    });
    expect(fourP).toMatchObject({ kittyBonus: 1, stake: 4, amounts: [12, -4, -4, -4] });
    expect(kittyBonusMultiplier(cards('RJ RJ 3 4 5 9 J K'), BONUS_4P)).toBe(1);
  });

  it('doubling: the landlord doubles every settlement, a peasant only their own', () => {
    const base = { rules: DOUBLING_3P, hands: ['', '3', '4'], landlord: 0, robs: 1 };
    expect(settled({ ...base, doubles: [true, false, false] })).toMatchObject({
      stake: 2,
      doubled: [true, false, false],
      amounts: [8, -4, -4],
    });
    expect(settled({ ...base, doubles: [false, true, false] }).amounts).toEqual([6, -4, -2]);
    expect(settled({ ...base, doubles: [true, true, false] }).amounts).toEqual([12, -8, -4]);
    expect(settled({ ...base, doubles: [true, true, true] }).amounts).toEqual([16, -8, -8]);
    const lost = settled({ ...base, hands: ['3', '', '4'], doubles: [true, false, true] });
    expect(lost.amounts).toEqual([-12, 4, 8]);
    const four = settled({
      rules: { ...RULES_4P, doublingRound: true },
      hands: ['3', '4', '', '5'],
      landlord: 2,
      bombs: 1,
      doubles: [true, false, true, true],
    });
    expect(four).toMatchObject({ stake: 2, doubled: [true, false, true, true] });
    expect(four.amounts).toEqual([-8, -4, 20, -8]);
  });
});

describe('currentStake', () => {
  it('multiplies base, robs, bombs and the revealed kitty bonus, never spring or doubles', () => {
    const start = playingState({
      rules: { ...BONUS_3P, doublingRound: true },
      hands: ['3', '4', '5'],
      landlord: 0,
      kitty: 'BJ RJ 9',
    });
    const state: HandState = {
      ...start,
      bidding: { ...start.bidding, robs: 2 },
      bombsPlayed: 1,
      doubles: [true, true, true],
      playCounts: [3, 0, 0],
    };
    expect(currentStake(state)).toBe(24);
    const done = step(state, 0, play('3', hand(state, 0))).state;
    expect(done.result).toMatchObject({ spring: 'spring', stake: 48 });
    expect(currentStake(done)).toBe(24);
    expect(viewHand(done, 1).currentStake).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// viewHand and timeoutAction
// ---------------------------------------------------------------------------

/** Ids of cards the viewer must not be able to see, as they appear inside a JSON view. */
function hiddenIds(state: HandState, viewer: number | null): string[] {
  const visibleKitty = new Set(state.kittyRevealed ? ids(state.kitty) : []);
  const hidden: string[] = [];
  state.hands.forEach((cards, seat) => {
    if (seat === viewer) return;
    for (const card of cards) if (!visibleKitty.has(card.id)) hidden.push(card.id);
  });
  if (!state.kittyRevealed) hidden.push(...ids(state.kitty));
  return hidden;
}

function expectNoLeak(state: HandState, viewer: number | null): void {
  const view = viewHand(state, viewer);
  const json = JSON.stringify(view);
  for (const id of hiddenIds(state, viewer)) expect(json).not.toContain(`"${id}"`);
  expect(view.hand).toEqual(viewer === null ? [] : state.hands[viewer]);
  expect(view.cardCounts).toEqual(state.hands.map((cards) => cards.length));
  expect(view.seat).toBe(viewer);
  expect(view.currentStake).toBe(currentStake(state));
  expect(view.legal).toEqual(legalActions(state, viewer));
}

describe('viewHand', () => {
  it('shows only the viewer own cards, hides the kitty until revealed, spectators get none', () => {
    const dealt = createHand({ rules: DOUBLING_3P, seed: 'view', handNumber: 1, firstBidder: 0 });
    for (const viewer of [0, 1, 2, null]) {
      expectNoLeak(dealt, viewer);
      expect(viewHand(dealt, viewer).kitty).toBeNull();
    }
    expect('hands' in viewHand(dealt, 0)).toBe(false);
    const chosen = run(dealt, [
      [0, CALL],
      [1, PASS_BID],
      [2, PASS_BID],
    ]).state;
    expect(chosen.phase).toBe('doubling');
    for (const viewer of [0, 1, 2, null]) {
      expectNoLeak(chosen, viewer);
      expect(viewHand(chosen, viewer).kitty).toEqual(chosen.kitty);
    }
    expect(viewHand(chosen, 0).hand).toHaveLength(20);
    expect(viewHand(chosen, 1).cardCounts).toEqual([20, 17, 17]);
    const start = playingState({ hands: ['3 4', '5 6', '7 8'], landlord: 0, kitty: '9 10 J' });
    const led = step(start, 0, play('3', hand(start, 0))).state;
    const spectator = viewHand(led, null);
    expect(spectator.seat).toBeNull();
    expect(spectator.hand).toEqual([]);
    expect(spectator.kitty).toEqual(led.kitty);
    expect(spectator.trick.current?.cards.map((card) => card.rank)).toEqual([3]);
    expect(spectator.history).toHaveLength(1);
    expect(Object.values(spectator.legal).every((flag) => flag === false || flag.length === 0));
    expectNoLeak(led, null);
    expectNoLeak(led, 1);
    expect(viewHand(led, 7).seat).toBeNull();
  });

  it('hides other seats doubling choices until the round ends, then shows them to all', () => {
    const dealt = createHand({ rules: DOUBLING_3P, seed: 'view', handNumber: 1, firstBidder: 0 });
    const doubling = run(dealt, [
      [0, CALL],
      [1, PASS_BID],
      [2, PASS_BID],
      [1, { type: 'double', double: true }],
    ]).state;
    expect(doubling.doubles).toEqual([null, true, null]);
    expect(viewHand(doubling, 1).doubles).toEqual([null, true, null]);
    expect(viewHand(doubling, 0).doubles).toEqual([null, null, null]);
    expect(viewHand(doubling, 2).doubles).toEqual([null, null, null]);
    expect(viewHand(doubling, null).doubles).toEqual([null, null, null]);
    expect(viewHand(doubling, 2).legal.canDouble).toBe(true);
    expect(viewHand(doubling, 1).legal.canDouble).toBe(false);
    const playing = run(doubling, [
      [0, { type: 'double', double: false }],
      [2, { type: 'double', double: true }],
    ]).state;
    expect(playing.phase).toBe('playing');
    for (const viewer of [0, 1, 2, null]) {
      expect(viewHand(playing, viewer).doubles).toEqual([false, true, true]);
    }
  });
});

describe('timeoutAction while playing', () => {
  it('leads the lowest single of the remaining hand and passes when answering', () => {
    const start = playingState({ hands: ['K 5 9 3 BJ', '4 6 8 10 2', '7 J Q A RJ'], landlord: 0 });
    const rankId = (state: HandState, seat: number, rank: number): string =>
      (hand(state, seat).find((card) => card.rank === rank) as Card).id;
    expect(timeoutAction(start, 0)).toEqual({ type: 'play', cardIds: [rankId(start, 0, 3)] });
    const led = step(start, 0, timeoutAction(start, 0)).state;
    expect(timeoutAction(led, 1)).toEqual({ type: 'pass' });
    const later = run(led, [
      [1, PASS],
      [2, PASS],
    ]).state;
    expect(later.turn).toBe(0);
    expect(timeoutAction(later, 0)).toEqual({ type: 'play', cardIds: [rankId(later, 0, 5)] });
    expect(applyAction(later, 0, timeoutAction(later, 0)).ok).toBe(true);
    const jokers = playingState({ hands: ['RJ BJ', '3 4', '5 6'], landlord: 0 });
    expect(timeoutAction(jokers, 0)).toEqual({ type: 'play', cardIds: [rankId(jokers, 0, 16)] });
    const four = playingState({ hands: ['A 2 10', '3 4 5', '6 7 8', '9 J Q'], landlord: 0 });
    expect(timeoutAction(four, 0)).toEqual({ type: 'play', cardIds: [rankId(four, 0, 10)] });
  });
});

// ---------------------------------------------------------------------------
// Random legal playouts: every RULES.md invariant of play and settlement on every state
// ---------------------------------------------------------------------------

function randomAction(state: HandState, seat: number, rng: () => number): HandAction {
  const legal = legalActions(state, seat);
  const options: HandAction[] = [];
  if (legal.canCall) options.push({ type: 'call' });
  if (legal.canRob) options.push({ type: 'rob' });
  if (legal.canPassBid) options.push({ type: 'pass_bid' });
  for (const value of legal.bids) options.push({ type: 'bid', value });
  if (legal.canDouble) options.push({ type: 'double', double: rng() < 0.5 });
  if (legal.canPlay) {
    const plays = findPlays(hand(state, seat), state.trick.current, state.rules);
    if (legal.canPass && (plays.length === 0 || rng() < 0.4)) return { type: 'pass' };
    const combo = plays[Math.floor(rng() * plays.length)];
    if (combo === undefined) throw new Error('a leader always has a play');
    return { type: 'play', cardIds: ids(combo.cards) };
  }
  return options[Math.floor(rng() * options.length)] as HandAction;
}

function actingSeats(state: HandState): number[] {
  if (state.phase !== 'doubling') return [state.turn];
  return state.doubles.flatMap((choice, seat) => (choice === null ? [seat] : []));
}

function checkFinished(state: HandState): void {
  const n = state.rules.playerCount;
  const result = state.result as HandResult;
  const landlord = state.landlord as number;
  expect(state).toMatchObject({ phase: 'finished', turn: -1 });
  expect(result).toEqual(settle(state));
  expect(state.hands.filter((cards) => cards.length === 0)).toHaveLength(1);
  expect(state.hands[result.winnerSeat]).toEqual([]);
  expect(result.winnerSide).toBe(result.winnerSeat === landlord ? 'landlord' : 'peasants');
  expect(sum(result.amounts)).toBe(0);
  const sign = result.winnerSide === 'landlord' ? -1 : 1;
  for (let seat = 0; seat < n; seat++) {
    if (seat === landlord) continue;
    const doubled = (result.doubled[landlord] ? 2 : 1) * (result.doubled[seat] ? 2 : 1);
    expect(result.amounts[seat]).toBe(sign * result.stake * doubled);
  }
  expect(result.amounts[landlord]).toBe(-sum(result.amounts.filter((_, s) => s !== landlord)));

  const played = state.history.filter((entry) => entry.combo !== null);
  const bombs = played.filter((e) => e.combo?.type === 'bomb' || e.combo?.type === 'rocket');
  expect(state.bombsPlayed).toBe(bombs.length);
  expect(result.bombs).toBe(bombs.length);
  const counts = new Array<number>(n).fill(0);
  for (const entry of played) counts[entry.seat] = (counts[entry.seat] ?? 0) + 1;
  expect(state.playCounts).toEqual(counts);
  const peasantsSilent = counts.every((count, seat) => seat === landlord || count === 0);
  const expectedSpring =
    result.winnerSide === 'landlord' && peasantsSilent
      ? 'spring'
      : result.winnerSide === 'peasants' && counts[landlord] === 1
        ? 'anti_spring'
        : null;
  expect(result.spring).toBe(expectedSpring);
  const bonus = kittyBonusMultiplier(state.kitty, state.rules);
  expect(result.kittyBonus).toBe(bonus);
  expect(result.base).toBe(state.rules.biddingMode === 'call' ? 1 : state.bidding.highestBid);
  expect(result.robs).toBe(state.rules.biddingMode === 'call' ? state.bidding.robs : 0);
  expect(result.stake).toBe(
    result.base * 2 ** result.robs * 2 ** bombs.length * (expectedSpring === null ? 1 : 2) * bonus,
  );
  expect(result.doubled).toEqual(state.doubles.map((choice) => choice === true));

  // Trick bookkeeping: the landlord leads trick 1, the winner of a trick leads the next.
  const first = state.history[0];
  expect(first).toMatchObject({ seat: landlord, trickNumber: 1 });
  expect(first?.combo).not.toBeNull();
  let passes = 0;
  let lastPlayer = landlord;
  for (let i = 1; i < state.history.length; i++) {
    const prev = state.history[i - 1] as HandState['history'][number];
    const entry = state.history[i] as HandState['history'][number];
    passes = prev.combo === null ? passes + 1 : 0;
    if (prev.combo !== null) lastPlayer = prev.seat;
    if (passes === n - 1) {
      expect(entry.trickNumber).toBe(prev.trickNumber + 1);
      expect(entry.seat).toBe(lastPlayer);
      expect(entry.combo).not.toBeNull();
      passes = 0;
    } else {
      expect(entry.trickNumber).toBe(prev.trickNumber);
      expect(entry.seat).toBe((prev.seat + 1) % n);
    }
  }

  // Card conservation: hands plus every played card is exactly the deck.
  const all = [...state.hands.flat(), ...played.flatMap((entry) => entry.combo?.cards ?? [])];
  expect(ids(all).sort()).toEqual(ids(createDeck(state.rules.playerCount)).sort());
}

function playout(seed: string, rules: RuleSettings): HandState {
  const rng = seededRng(seed);
  const firstBidder = Math.floor(rng() * rules.playerCount);
  let state = createHand({ rules, seed, handNumber: 1, firstBidder });
  for (let steps = 0; state.phase !== 'finished'; steps++) {
    if (steps > 1500) throw new Error(`${seed} did not finish`);
    expect(state.phase).not.toBe('redeal');
    if (state.phase === 'playing') {
      for (const viewer of [...state.hands.keys(), null]) expectNoLeak(state, viewer);
      expect(applyAction(state, state.turn, timeoutAction(state, state.turn)).ok).toBe(true);
    }
    for (const seat of actingSeats(state)) {
      const result = applyAction(state, seat, randomAction(state, seat, rng));
      if (!result.ok) throw new Error(`${seed}: ${result.code} ${result.error}`);
      state = result.state;
      if (state.phase === 'finished') break;
    }
  }
  return state;
}

describe('random legal playouts', () => {
  it('3 players: keep every play and settlement invariant (call, points, doubling, bonus)', () => {
    const variants: RuleSettings[] = [
      RULES_3P,
      { ...POINTS_3P, kittyBonus: true },
      { ...DOUBLING_3P, kittyBonus: true, kittySize: 6 },
    ];
    for (let i = 0; i < 24; i++) {
      checkFinished(playout(`verify-3p-${i}`, variants[i % variants.length] as RuleSettings));
    }
  });

  it('4 players: keep every play and settlement invariant', () => {
    const variants: RuleSettings[] = [
      RULES_4P,
      { ...RULES_4P, biddingMode: 'points', doublingRound: true, kittyBonus: true },
    ];
    for (let i = 0; i < 8; i++) {
      checkFinished(playout(`verify-4p-${i}`, variants[i % variants.length] as RuleSettings));
    }
  });
});
