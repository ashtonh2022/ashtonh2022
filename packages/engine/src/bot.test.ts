import { describe, expect, it } from 'vitest';

import type { Card, HandAction, HandState, RuleSettings } from './types';
import { applyAction, createHand, legalActions } from './hand';
import { botAction, botBid, botDouble, botPlay, handStrength } from './bot';
import { PASS, RULES_3P, RULES_4P, cards, play, playingState, run, step } from './test-helpers';

const STRONG = 'RJ BJ 2 2 2 A A A K K K Q Q J J 10 9';
const WEAK = '3 3 4 5 6 8 8 9 10 10 J Q Q K A 2 3';
const POINTS_3P: RuleSettings = { ...RULES_3P, biddingMode: 'points' };

function withHand(state: HandState, seat: number, spec: string): HandState {
  return {
    ...state,
    hands: state.hands.map((hand, other) => (other === seat ? cards(spec) : hand)),
  };
}

function fresh(rules: RuleSettings = RULES_3P, firstBidder = 0): HandState {
  return createHand({ rules, seed: 'bot', handNumber: 1, firstBidder });
}

function ranks(state: HandState, seat: number, action: HandAction): number[] {
  if (action.type !== 'play') return [];
  const hand = state.hands[seat] as Card[];
  return action.cardIds
    .map((id) => hand.find((card) => card.id === id)?.rank ?? 0)
    .sort((a, b) => a - b);
}

describe('handStrength', () => {
  it('rates bombs, rockets, 2s, jokers and compact hands higher', () => {
    expect(handStrength(cards(STRONG), RULES_3P)).toBeGreaterThan(
      handStrength(cards(WEAK), RULES_3P),
    );
    expect(handStrength(cards('3 4 5 6 7 8 9 10 J Q K A 3 4 5 6 7'), RULES_3P)).toBeLessThan(
      handStrength(cards('3 4 5 6 7 8 9 10 J Q K A 2 2 2 2 RJ'), RULES_3P),
    );
    expect(handStrength(cards('3 3 3 3 5 6 7 8 9'), RULES_3P)).toBeGreaterThan(
      handStrength(cards('3 3 3 4 5 6 7 8 9'), RULES_3P),
    );
    expect(handStrength([], RULES_3P)).toBe(0);
  });
});

describe('botBid: call mode', () => {
  it('calls with a strong hand and passes with a weak one', () => {
    expect(botBid(withHand(fresh(), 0, STRONG), 0)).toEqual({ type: 'call' });
    expect(botBid(withHand(fresh(), 0, WEAK), 0)).toEqual({ type: 'pass_bid' });
  });

  it('calls whatever the hand when it is the forced last bidder', () => {
    const forced = run(withHand(fresh(), 2, WEAK), [
      [0, { type: 'pass_bid' }],
      [1, { type: 'pass_bid' }],
    ]).state;
    expect(botBid(forced, 2)).toEqual({ type: 'call' });
  });

  it('robs only with a very strong hand, including on the rob-back', () => {
    const afterCall = step(withHand(withHand(fresh(), 1, STRONG), 2, WEAK), 0, {
      type: 'call',
    }).state;
    expect(botBid(afterCall, 1)).toEqual({ type: 'rob' });
    const robbed = step(afterCall, 1, { type: 'rob' }).state;
    expect(botBid(robbed, 2)).toEqual({ type: 'pass_bid' });
    const robBack = step(robbed, 2, { type: 'pass_bid' }).state;
    expect(robBack.turn).toBe(0);
    expect(botBid(withHand(robBack, 0, STRONG), 0)).toEqual({ type: 'rob' });
    expect(botBid(withHand(robBack, 0, WEAK), 0)).toEqual({ type: 'pass_bid' });
  });
});

describe('botBid: points mode', () => {
  it('bids according to strength and only above the current bid', () => {
    expect(botBid(withHand(fresh(POINTS_3P), 0, STRONG), 0)).toEqual({ type: 'bid', value: 3 });
    expect(botBid(withHand(fresh(POINTS_3P), 0, WEAK), 0)).toEqual({ type: 'pass_bid' });
    const medium = '2 2 A A A K K Q J 10 9 8 7 6 5 4 3';
    const wanted = botBid(withHand(fresh(POINTS_3P), 0, medium), 0);
    expect(wanted.type === 'bid' ? wanted.value : 0).toBeGreaterThanOrEqual(1);
    const raised = step(withHand(fresh(POINTS_3P), 1, medium), 0, { type: 'bid', value: 2 }).state;
    const answer = botBid(raised, 1);
    expect(answer.type === 'bid' ? answer.value === 3 : answer.type === 'pass_bid').toBe(true);
    const strongOverTwo = botBid(withHand(raised, 1, STRONG), 1);
    expect(strongOverTwo).toEqual({ type: 'bid', value: 3 });
  });
});

describe('botBid and botDouble always produce legal actions', () => {
  it('walks the bidding of many deals without a rejected action', () => {
    const variants: RuleSettings[] = [
      RULES_3P,
      RULES_4P,
      POINTS_3P,
      { ...RULES_4P, biddingMode: 'points', doublingRound: true },
      { ...RULES_3P, allPass: 'redeal', doublingRound: true },
    ];
    let decisions = 0;
    for (let i = 0; i < 60; i++) {
      const rules = variants[i % variants.length] as RuleSettings;
      let state = createHand({ rules, seed: `bid-${i}`, handNumber: 1, firstBidder: i % 3 });
      while (state.phase === 'bidding' || state.phase === 'doubling') {
        const seat =
          state.phase === 'doubling'
            ? state.doubles.findIndex((choice) => choice === null)
            : state.turn;
        const action = botAction(state, seat);
        const result = applyAction(state, seat, action);
        expect(result.ok, `${JSON.stringify(action)} for seat ${seat}`).toBe(true);
        if (!result.ok) break;
        state = result.state;
        decisions++;
      }
      expect(['playing', 'redeal']).toContain(state.phase);
    }
    expect(decisions).toBeGreaterThan(180);
  });
});

describe('botDouble', () => {
  it('doubles with a strong hand and keeps with a weak one', () => {
    const chosen = run(fresh({ ...RULES_3P, doublingRound: true }), [
      [0, { type: 'call' }],
      [1, { type: 'pass_bid' }],
      [2, { type: 'pass_bid' }],
    ]).state;
    expect(botDouble(withHand(chosen, 0, STRONG + ' 2 3 4'), 0)).toBe(true);
    expect(botDouble(withHand(chosen, 0, WEAK + ' 3 4 5'), 0)).toBe(false);
    expect(botDouble(withHand(chosen, 1, STRONG), 1)).toBe(true);
    expect(botDouble(withHand(chosen, 1, WEAK), 1)).toBe(false);
    expect(botAction(withHand(chosen, 1, WEAK), 1)).toEqual({ type: 'double', double: false });
  });
});

describe('botPlay: leading', () => {
  it('goes out in one play when the whole hand is a combination', () => {
    const state = playingState({ hands: ['3 3 3 4', '5 5 6 7 8', '9 9 10 J'], landlord: 0 });
    expect(ranks(state, 0, botPlay(state, 0))).toEqual([3, 3, 3, 4]);
    const straight = playingState({
      hands: ['3 4 5 6 7 8', '5 5 6 7 8', '9 9 10 J'],
      landlord: 0,
    });
    expect(ranks(straight, 0, botPlay(straight, 0))).toEqual([3, 4, 5, 6, 7, 8]);
    const fourTwo = playingState({ hands: ['3 3 3 3 4 5', '5 5 6 7 8', '9 9 10 J'], landlord: 0 });
    expect(ranks(fourTwo, 0, botPlay(fourTwo, 0))).toEqual([3, 3, 3, 3, 4, 5]);
    expect(step(fourTwo, 0, botPlay(fourTwo, 0)).state.phase).toBe('finished');
  });

  it('leads the part of its decomposition with the lowest card', () => {
    const state = playingState({
      hands: ['3 4 5 6 7 K K 2', '5 5 6 7 8 9 10 J', '9 9 10 J Q Q A A'],
      landlord: 0,
    });
    expect(ranks(state, 0, botPlay(state, 0))).toEqual([3, 4, 5, 6, 7]);
    const pairFirst = playingState({
      hands: ['4 4 9 A A A 2', '5 5 6 7 8 9 10 J', '9 9 10 J Q Q A K'],
      landlord: 0,
    });
    expect(ranks(pairFirst, 0, botPlay(pairFirst, 0))).toEqual([4, 4]);
  });

  it('keeps bombs back and leads them only when nothing else is left', () => {
    const state = playingState({
      hands: ['5 5 5 5 6 8 K', '8 9 10 J Q K A', '9 9 10 J Q Q A A'],
      landlord: 0,
    });
    expect(ranks(state, 0, botPlay(state, 0))).toEqual([6]);
    const onlyBombs = playingState({
      hands: ['5 5 5 5 BJ RJ', '8 9 10 J Q K A', '9 9 10 J Q Q A A'],
      landlord: 0,
    });
    expect(ranks(onlyBombs, 0, botPlay(onlyBombs, 0))).toEqual([5, 5, 5, 5]);
  });

  it('avoids leading singles when an opponent is down to one card', () => {
    const state = playingState({ hands: ['3 K K A', '2', '5 6 7 8 9 10'], landlord: 0 });
    expect(ranks(state, 0, botPlay(state, 0))).toEqual([13, 13]);
    const onlySingles = playingState({ hands: ['3 A', '2', '5 6 7 8 9 10'], landlord: 0 });
    expect(ranks(onlySingles, 0, botPlay(onlySingles, 0))).toEqual([14]);
    const peasant = playingState({
      hands: ['4', '3 K K A', '5 6 7 8 9 10'],
      landlord: 0,
      leader: 1,
    });
    expect(ranks(peasant, 1, botPlay(peasant, 1))).toEqual([13, 13]);
    const twoLeft = playingState({
      hands: ['4 5', '3 K K A', '5 6 7 8 9 10'],
      landlord: 0,
      leader: 1,
    });
    expect(ranks(twoLeft, 1, botPlay(twoLeft, 1))).toEqual([14]);
    const tripleSafe = playingState({
      hands: ['4 5', '3 K K K A', '5 6 7 8 9 10'],
      landlord: 0,
      leader: 1,
    });
    expect(ranks(tripleSafe, 1, botPlay(tripleSafe, 1))).toEqual([3, 13, 13, 13]);
  });
});

describe('botPlay: answering', () => {
  it('goes out when a single answer empties the hand', () => {
    const start = playingState({ hands: ['5 5 3 4 6 7 8', '6 6', '9 9 10 J'], landlord: 0 });
    const led = step(start, 0, play('5 5', start.hands[0] as Card[])).state;
    expect(ranks(led, 1, botPlay(led, 1))).toEqual([6, 6]);
  });

  it('answers with the weakest fitting combination, keeping its combos intact', () => {
    const start = playingState({
      hands: ['3 10 J Q K A 2', '4 5 6 7 8 K 2', '9 9 10 J Q Q A A'],
      landlord: 0,
    });
    const led = step(start, 0, play('3', start.hands[0] as Card[])).state;
    expect(ranks(led, 1, botPlay(led, 1))).toEqual([13]);
    const pairs = playingState({
      hands: ['3 3 10 J Q K A', '4 4 9 9 K K 2', '9 10 J Q Q A A'],
      landlord: 0,
    });
    const ledPair = step(pairs, 0, play('3 3', pairs.hands[0] as Card[])).state;
    expect(ranks(ledPair, 1, botPlay(ledPair, 1))).toEqual([4, 4]);
  });

  it('passes when it cannot beat the current combination', () => {
    const start = playingState({ hands: ['2 3 4 5 6', '7 8 9 10 J', 'K K A A 2'], landlord: 0 });
    const led = step(start, 0, play('2', start.hands[0] as Card[])).state;
    expect(botPlay(led, 1)).toEqual(PASS);
    expect(botPlay(step(led, 1, PASS).state, 2)).toEqual(PASS);
  });

  it('does not beat a partner who is winning the trick unless the landlord is nearly out', () => {
    const start = playingState({
      hands: ['3 4 5 6 7 8 9 10 J Q', '5 5 6 7 8', 'K K A A 2'],
      landlord: 0,
      leader: 1,
    });
    const led = step(start, 1, play('5 5', start.hands[1] as Card[])).state;
    expect(botPlay(led, 2)).toEqual(PASS);
    const landlordNearlyOut = playingState({
      hands: ['3 4', '5 5 6 7 8', 'K K A A 2'],
      landlord: 0,
      leader: 1,
    });
    const urgent = step(
      landlordNearlyOut,
      1,
      play('5 5', landlordNearlyOut.hands[1] as Card[]),
    ).state;
    expect(ranks(urgent, 2, botPlay(urgent, 2))).toEqual([14, 14]);
    const table = playingState({
      hands: ['3 4 5 6 7 8 9 10 J Q', '5 5 6 7 8', 'K K A A 2'],
      landlord: 0,
    });
    const partnerTookIt = run(table, [
      [0, play('3', table.hands[0] as Card[])],
      [1, play('6', table.hands[1] as Card[])],
    ]).state;
    expect(botPlay(partnerTookIt, 2)).toEqual(PASS);
    const landlordRetook = step(
      step(partnerTookIt, 2, PASS).state,
      0,
      play('10', table.hands[0] as Card[]),
    ).state;
    expect(ranks(landlordRetook, 1, botPlay(landlordRetook, 1))).toEqual([]);
    const seat2 = step(landlordRetook, 1, PASS).state;
    expect(ranks(seat2, 2, botPlay(seat2, 2))).toEqual([15]);
  });

  it('beats the landlord with its strongest answer when the landlord is nearly out', () => {
    const start = playingState({ hands: ['4 A', '5 9 2', '6 7 8 10 J'], landlord: 0 });
    const led = step(start, 0, play('4', start.hands[0] as Card[])).state;
    expect(ranks(led, 1, botPlay(led, 1))).toEqual([15]);
  });

  it('bombs when an opponent is nearly out or the play being answered is big', () => {
    const nearlyOut = playingState({ hands: ['A 2', '3 3 3 3 4 6 8', '5 6 7 9 10'], landlord: 0 });
    const ledAce = step(nearlyOut, 0, play('A', nearlyOut.hands[0] as Card[])).state;
    expect(ranks(ledAce, 1, botPlay(ledAce, 1))).toEqual([3, 3, 3, 3]);
    const bigPlay = playingState({
      hands: ['5 6 7 8 9 3 4 J Q K A', '3 3 3 3 4 6 8 10 Q Q K', '5 6 7 9 10'],
      landlord: 0,
    });
    const ledStraight = step(bigPlay, 0, play('5 6 7 8 9', bigPlay.hands[0] as Card[])).state;
    expect(ranks(ledStraight, 1, botPlay(ledStraight, 1))).toEqual([3, 3, 3, 3]);
    const landlordBombs = playingState({
      hands: ['3 3 3 3 4 6 8 10 Q Q K', '5 6 7 8 9 3 4 J Q K A', '5 6 7 9 10'],
      landlord: 0,
      leader: 1,
    });
    const peasantStraight = step(
      landlordBombs,
      1,
      play('5 6 7 8 9', landlordBombs.hands[1] as Card[]),
    ).state;
    const answer = step(peasantStraight, 2, PASS).state;
    expect(ranks(answer, 0, botPlay(answer, 0))).toEqual([3, 3, 3, 3]);
  });

  it('keeps its bomb when a small play is not worth it', () => {
    const start = playingState({
      hands: ['2 3 4 5 6 7 8 9 10 J Q', '3 3 3 3 4 6 8 10 Q Q K', '5 6 7 9 10'],
      landlord: 0,
    });
    const led = step(start, 0, play('2', start.hands[0] as Card[])).state;
    expect(botPlay(led, 1)).toEqual(PASS);
    const rocketOnly = playingState({
      hands: ['2 3 4 5 6 7 8 9 10 J Q', 'BJ RJ 4 6 8 10 Q Q K 3 5', '5 6 7 9 10'],
      landlord: 0,
    });
    const ledTwo = step(rocketOnly, 0, play('2', rocketOnly.hands[0] as Card[])).state;
    expect(botPlay(ledTwo, 1)).toEqual(PASS);
  });

  it('spends a bomb when the rest of the hand is nearly gone', () => {
    const start = playingState({
      hands: ['2 3 4 5 6 7 8 9', '3 3 3 3 K', '5 6 7 9 10'],
      landlord: 0,
    });
    const led = step(start, 0, play('2', start.hands[0] as Card[])).state;
    expect(ranks(led, 1, botPlay(led, 1))).toEqual([3, 3, 3, 3]);
  });

  it('plays a bigger bomb over a bomb when it matters', () => {
    const start = playingState({
      hands: ['4 4 4 4 5', '9 9 9 9 K 3', '5 6 7 9 10'],
      landlord: 0,
    });
    const bombed = step(start, 0, play('4 4 4 4', start.hands[0] as Card[])).state;
    expect(ranks(bombed, 1, botPlay(bombed, 1))).toEqual([9, 9, 9, 9]);
  });
});

describe('botAction', () => {
  it('dispatches on the phase and never returns an illegal action', () => {
    const bidding = fresh();
    expect(['call', 'pass_bid']).toContain(botAction(bidding, 0).type);
    const playing = playingState({ hands: ['3 4', '5 6', '7 8'], landlord: 0 });
    expect(botAction(playing, 0).type).toBe('play');
    const finished = step(
      playingState({ hands: ['3', '5 6', '7 8'], landlord: 0 }),
      0,
      play('3', cards('3')),
    ).state;
    expect(botAction(finished, 1)).toEqual(PASS);
    expect(legalActions(finished, 1).canPass).toBe(false);
  });
});
