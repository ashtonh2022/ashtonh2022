import { describe, expect, it } from 'vitest';

import type { Card, HandAction, HandEvent, HandState, RuleSettings } from './types';
import { createDeck } from './cards';
import { applyAction, createHand } from './hand';
import { botAction } from './bot';
import { simulateHand, simulateMany, type SimulationResult } from './sim';
import { RULES_3P, RULES_4P } from './test-helpers';

declare const performance: { now(): number };

const VARIANTS: RuleSettings[] = [
  RULES_3P,
  RULES_4P,
  { ...RULES_3P, biddingMode: 'points' },
  { ...RULES_4P, biddingMode: 'points', allPass: 'redeal' },
  { ...RULES_3P, allPass: 'redeal', doublingRound: true },
  { ...RULES_4P, kittyBonus: true, chainsThroughTwos: false },
  { ...RULES_3P, kittySize: 6, kittyBonus: true, doublingRound: true, biddingMode: 'points' },
  { ...RULES_4P, kittySize: 16, doublingRound: true, chainsThroughTwos: false },
];

function ids(cards: readonly Card[]): string[] {
  return cards.map((card) => card.id).sort();
}

/** The events of the final deal only (after the last redeal, if any). */
function finalDealEvents(events: HandEvent[]): HandEvent[] {
  let start = 0;
  events.forEach((event, index) => {
    if (event.type === 'redeal') start = index + 1;
  });
  return events.slice(start);
}

function actionOf(event: HandEvent): [seat: number, action: HandAction] | null {
  switch (event.type) {
    case 'bid':
      switch (event.record.action) {
        case 'call':
          return [event.seat, { type: 'call' }];
        case 'rob':
          return [event.seat, { type: 'rob' }];
        case 'pass':
          return [event.seat, { type: 'pass_bid' }];
        case 'bid':
          return [event.seat, { type: 'bid', value: event.record.value as 1 | 2 | 3 }];
      }
      return null;
    case 'double':
      return [event.seat, { type: 'double', double: event.double }];
    case 'play':
      return [event.seat, { type: 'play', cardIds: event.combo.cards.map((card) => card.id) }];
    case 'pass':
      return [event.seat, { type: 'pass' }];
    default:
      return null;
  }
}

function replay(result: SimulationResult): HandState {
  const final = result.state;
  let state = createHand({
    rules: final.rules,
    seed: final.seed,
    handNumber: final.handNumber,
    firstBidder: final.firstBidder,
  });
  for (const event of finalDealEvents(result.events)) {
    const move = actionOf(event);
    if (move === null) continue;
    const applied = applyAction(state, move[0], move[1]);
    if (!applied.ok) {
      throw new Error(`replay rejected ${JSON.stringify(move)}: ${applied.code}`);
    }
    state = applied.state;
  }
  return state;
}

describe('simulateHand', () => {
  it('plays a full hand with bots deterministically', () => {
    const first = simulateHand({ rules: RULES_3P, seed: 'sim-1', firstBidder: 1 });
    const second = simulateHand({ rules: RULES_3P, seed: 'sim-1', firstBidder: 1 });
    expect(first.state.phase).toBe('finished');
    expect(first.state.result).not.toBeNull();
    expect(first.steps).toBeGreaterThan(3);
    expect(first.events.length).toBeGreaterThanOrEqual(first.steps);
    expect(first.state.firstBidder).toBe(1);
    expect(first.seeds).toEqual(['sim-1']);
    expect(first.redeals).toBe(0);
    expect(second).toEqual(first);
    expect(first.events[first.events.length - 1]?.type).toBe('hand_finished');
    const other = simulateHand({ rules: RULES_3P, seed: 'sim-2', firstBidder: 1 });
    expect(other.events).not.toEqual(first.events);
  });

  it('throws when an actor produces an action the engine rejects', () => {
    const alwaysPass = (): HandAction => ({ type: 'pass_bid' });
    expect(() => simulateHand({ rules: RULES_3P, seed: 'reject', actor: alwaysPass })).toThrow(
      /rejected/,
    );
    const wrongPhase = (): HandAction => ({ type: 'pass' });
    expect(() => simulateHand({ rules: RULES_3P, seed: 'reject', actor: wrongPhase })).toThrow(
      /wrong_phase/,
    );
  });

  it('redeals with a suffixed seed and the next first bidder when everyone passes', () => {
    const rules: RuleSettings = { ...RULES_3P, allPass: 'redeal' };
    const passOnce = (state: HandState, seat: number): HandAction =>
      state.seed === 'again' ? { type: 'pass_bid' } : botAction(state, seat);
    const result = simulateHand({ rules, seed: 'again', firstBidder: 2, actor: passOnce });
    expect(result.redeals).toBe(1);
    expect(result.seeds).toEqual(['again', 'again-1']);
    expect(result.state.seed).toBe('again-1');
    expect(result.state.firstBidder).toBe(0);
    expect(result.state.phase).toBe('finished');
    expect(result.events.slice(0, 4).map((event) => event.type)).toEqual([
      'bid',
      'bid',
      'bid',
      'redeal',
    ]);
    expect(result.steps).toBeGreaterThan(3);
    const passForever = (): HandAction => ({ type: 'pass_bid' });
    expect(() => simulateHand({ rules, seed: 'forever', actor: passForever })).toThrow(/redealt/);
  });
});

describe('simulateMany: bot self-play invariants', () => {
  const started = performance.now();
  const summary = simulateMany(320, 'self-play', VARIANTS);
  const elapsed = performance.now() - started;

  it('finishes every hand in reasonable time and reports consistent statistics', () => {
    expect(elapsed).toBeLessThan(10_000);
    expect(summary.hands).toBe(320);
    expect(summary.results).toHaveLength(320);
    expect(summary.landlordWins).toBe(
      summary.results.filter((result) => result.state.result?.winnerSide === 'landlord').length,
    );
    expect(summary.landlordWinRate).toBeCloseTo(summary.landlordWins / 320, 10);
    expect(summary.landlordWinRate).toBeGreaterThan(0.2);
    expect(summary.landlordWinRate).toBeLessThan(0.9);
    expect(summary.averageSteps).toBeCloseTo(
      summary.results.reduce((total, result) => total + result.steps, 0) / 320,
      10,
    );
    expect(summary.averageSteps).toBeGreaterThan(10);
    expect(summary.springs + summary.antiSprings).toBe(
      summary.results.filter((result) => result.state.result?.spring !== null).length,
    );
    expect(summary.redeals).toBe(summary.results.reduce((total, r) => total + r.redeals, 0));
    expect(summary.bombs).toBe(
      summary.results.reduce((total, result) => total + (result.state.result?.bombs ?? 0), 0),
    );
    expect(summary.bombs).toBeGreaterThan(0);
  });

  it('ends every hand in the finished phase with exactly one empty hand', () => {
    for (const { state } of summary.results) {
      expect(state.phase).toBe('finished');
      expect(state.turn).toBe(-1);
      expect(state.landlord).not.toBeNull();
      expect(state.kittyRevealed).toBe(true);
      const result = state.result;
      expect(result).not.toBeNull();
      if (result === null) continue;
      expect(state.hands[result.winnerSeat]).toEqual([]);
      expect(state.hands.filter((hand) => hand.length === 0)).toHaveLength(1);
      expect(result.landlord).toBe(state.landlord);
      expect(result.winnerSide).toBe(
        result.winnerSeat === state.landlord ? 'landlord' : 'peasants',
      );
    }
  });

  it('conserves every card: hands plus played cards are exactly the deck', () => {
    for (const { state } of summary.results) {
      const played = state.history.flatMap((entry) => entry.combo?.cards ?? []);
      const everything = [...state.hands.flat(), ...played];
      expect(ids(everything)).toEqual(ids(createDeck(state.rules.playerCount)));
      expect(new Set(everything.map((card) => card.id)).size).toBe(everything.length);
      expect(state.kitty).toHaveLength(state.rules.kittySize);
      for (const card of state.kitty) expect(everything.some((c) => c.id === card.id)).toBe(true);
    }
  });

  it('settles amounts that sum to zero and follow the stake formula', () => {
    for (const { state } of summary.results) {
      const result = state.result;
      if (result === null) throw new Error('unfinished');
      expect(result.amounts.reduce((total, amount) => total + amount, 0)).toBe(0);
      expect(result.amounts).toHaveLength(state.rules.playerCount);
      const peasants = result.amounts.filter((_, seat) => seat !== result.landlord);
      expect(result.amounts[result.landlord]).toBe(-peasants.reduce((a, b) => a + b, 0));
      const expectedStake =
        result.base *
        2 ** result.robs *
        2 ** result.bombs *
        (result.spring === null ? 1 : 2) *
        result.kittyBonus;
      expect(result.stake).toBe(expectedStake);
      expect(result.base).toBe(state.base);
      expect(result.robs).toBe(state.bidding.robs);
      expect(result.bombs).toBe(state.bombsPlayed);
      if (!state.rules.kittyBonus) expect(result.kittyBonus).toBe(1);
      if (!state.rules.doublingRound) expect(result.doubled.every((d) => !d)).toBe(true);
      if (state.rules.biddingMode === 'points') expect(result.robs).toBe(0);
      if (state.rules.biddingMode === 'call') expect(result.base).toBe(1);
      result.amounts.forEach((amount, seat) => {
        if (seat === result.landlord) return;
        let expected = result.stake;
        if (result.doubled[result.landlord]) expected *= 2;
        if (result.doubled[seat]) expected *= 2;
        expect(Math.abs(amount)).toBe(expected);
        expect(amount > 0).toBe(result.winnerSide === 'peasants');
      });
    }
  });

  it('detects springs and anti-springs from the play counts', () => {
    for (const { state } of summary.results) {
      const result = state.result;
      if (result === null) throw new Error('unfinished');
      const landlord = result.landlord;
      const peasantsSilent = state.playCounts.every(
        (count, seat) => seat === landlord || count === 0,
      );
      const spring = result.winnerSide === 'landlord' && peasantsSilent;
      const antiSpring = result.winnerSide === 'peasants' && state.playCounts[landlord] === 1;
      expect(result.spring).toBe(spring ? 'spring' : antiSpring ? 'anti_spring' : null);
    }
  });

  it('keeps play counts, bomb counts and trick numbers consistent with the history', () => {
    for (const { state } of summary.results) {
      const counts = new Array<number>(state.rules.playerCount).fill(0);
      let bombs = 0;
      let trick = 1;
      for (const entry of state.history) {
        expect(entry.trickNumber).toBeGreaterThanOrEqual(trick);
        trick = entry.trickNumber;
        if (entry.combo === null) continue;
        counts[entry.seat] = (counts[entry.seat] ?? 0) + 1;
        if (entry.combo.type === 'bomb' || entry.combo.type === 'rocket') bombs++;
      }
      expect(state.playCounts).toEqual(counts);
      expect(state.bombsPlayed).toBe(bombs);
      expect(state.history[0]?.seat).toBe(state.landlord);
      expect(state.history[0]?.trickNumber).toBe(1);
    }
  });

  it('replays every hand from its seed and events to the identical final state', () => {
    let replayed = 0;
    for (const result of summary.results) {
      expect(replay(result)).toEqual(result.state);
      replayed++;
    }
    expect(replayed).toBe(320);
  });

  it('covers every rules variant, both player counts and some redeals', () => {
    const seen = new Set(summary.results.map((result) => JSON.stringify(result.state.rules)));
    expect(seen.size).toBe(VARIANTS.length);
    expect(summary.results.some((result) => result.state.rules.playerCount === 4)).toBe(true);
    expect(summary.redeals).toBeGreaterThan(0);
    expect(
      summary.results.some(
        (result) => result.state.rules.doublingRound && result.state.doubles.includes(true),
      ),
    ).toBe(true);
    expect(summary.results.some((result) => result.state.bidding.robs > 0)).toBe(true);
    expect(summary.results.some((result) => (result.state.result?.base ?? 0) > 1)).toBe(true);
    for (const result of summary.results) {
      expect(result.state.seed.startsWith('self-play-')).toBe(true);
      if (result.redeals > 0) {
        expect(result.seeds).toHaveLength(result.redeals + 1);
        expect(result.state.seed).toBe(`${result.seeds[0]}-${result.redeals}`);
      }
    }
  });
});
