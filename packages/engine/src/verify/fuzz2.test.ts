/**
 * Adversarial verification, round 2 (fuzz, second pass) of packages/engine against docs/RULES.md
 * and docs/ENGINE_API.md. Different angles from round 1 (fuzz.test.ts):
 *
 *  1. adversarial applyAction fuzzing: at every step of 300 seeded hands, 30 illegal actions
 *     (random card subsets, foreign/duplicated/fabricated cards, wrong seats, wrong phases,
 *     malformed actions) must be rejected with ok:false, never throw and leave the state untouched;
 *     legal ones (judged by findPlays / legalActions) must be accepted, and the state must still
 *     be untouched (applyAction is immutable);
 *  2. determinism of simulateHand;
 *  3. viewHand never mutates the state and is idempotent;
 *  4. every combo returned by findPlays (leading and answering) is accepted by applyAction and
 *     recorded with the same reading;
 *  5. 500 bot-vs-bot 4-player hands with chainsThroughTwos off and a 16-card kitty finish;
 *  6. createDeck ids are unique, sortCards is a stable total order and pure;
 *  7. normalizeRules is idempotent.
 *
 * Failing tests document engine bugs for the fixer; passing tests are regression coverage. Hot
 * loops collect problems in an array (with the seed and step) instead of calling `expect` per fact.
 */
import { describe, expect, it } from 'vitest';

import type { Card, Combo, HandAction, HandState, LegalActions, RuleSettings } from '../types';
import { createDeck, seededRng, shuffle, sortCards } from '../cards';
import { analyze, analyzeAs, beats, bombStrength } from '../combos';
import { applyAction, createHand, legalActions, nextFirstBidder, viewHand } from '../hand';
import { decompose, findPlays, hint, lowestSingle } from '../plays';
import { settle } from '../scoring';
import { botAction } from '../bot';
import { simulateHand } from '../sim';
import { DEFAULT_RULES, cardsPerPlayer, kittySizeOptions, normalizeRules } from '../rules';
import { RULES_3P, RULES_4P, cards, deepFreeze, key, shape } from '../test-helpers';

declare const performance: { now(): number };
declare function structuredClone<T>(value: T): T;

type Actor = (state: HandState, seat: number) => HandAction;

// ---- helpers --------------------------------------------------------------------------------

const ids = (set: readonly Card[]): string[] => set.map((card) => card.id);
const sig = (combo: Combo | null): string => JSON.stringify(shape(combo));
const show = (combo: Combo): string => `${sig(combo)} [${key(combo.cards)}]`;
const isBomb = (combo: Combo): boolean => combo.type === 'bomb' || combo.type === 'rocket';
const toPlay = (set: readonly Card[]): HandAction => ({ type: 'play', cardIds: ids(set) });
const sum = (values: readonly number[]): number => values.reduce((t, v) => t + v, 0);

/** Structural equality of plain JSON-like data (what every engine value is). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, k)) return false;
    if (!deepEqual(left[k], right[k])) return false;
  }
  return true;
}

/** Rule variants: 3p/4p x call/points x force/redeal x doubling x kittyBonus x chains x kitty sizes. */
function variantFor(i: number): RuleSettings {
  const playerCount: 3 | 4 = i % 2 === 0 ? 3 : 4;
  const biddingMode = (i >> 1) % 2 === 0 ? 'call' : 'points';
  const allPass = (i >> 2) % 2 === 0 ? 'force' : 'redeal';
  const doublingRound = (i >> 3) % 2 === 1;
  const kittyBonus = (i >> 4) % 2 === 1;
  const chainsThroughTwos = (i >> 5) % 2 === 0;
  const options = kittySizeOptions(playerCount);
  const kittySize = options[(i >> 6) % options.length] as number;
  return {
    ...DEFAULT_RULES,
    playerCount,
    kittySize,
    biddingMode,
    allPass,
    doublingRound,
    kittyBonus,
    firstBidder: (['winner', 'rotate', 'random'] as const)[i % 3] as RuleSettings['firstBidder'],
    chainsThroughTwos,
  };
}

function actingSeats(state: HandState): number[] {
  if (state.phase !== 'doubling') return state.turn < 0 ? [] : [state.turn];
  return state.doubles.flatMap((choice, seat) => (choice === null ? [seat] : []));
}

const pick = <T>(rng: () => number, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)] as T;

/** A seeded actor picking uniformly among legal actions (so robs, wild bids, doubles occur). */
function randomActor(rng: () => number): Actor {
  return (state, seat) => {
    const may = legalActions(state, seat);
    if (may.canPlay) {
      const plays = findPlays(state.hands[seat] ?? [], state.trick.current, state.rules);
      if (may.canPass && (plays.length === 0 || rng() < 0.3)) return { type: 'pass' };
      return toPlay(pick(rng, plays).cards);
    }
    const options: HandAction[] = may.bids.map((value) => ({ type: 'bid', value }));
    if (may.canCall) options.push({ type: 'call' });
    if (may.canRob) options.push({ type: 'rob' });
    if (may.canPassBid) options.push({ type: 'pass_bid' });
    if (may.canDouble) options.push({ type: 'double', double: rng() < 0.5 });
    return pick(rng, options);
  };
}

/** Whether `legal` permits a well-formed action (a play only when `canPlay`). */
function permitted(action: HandAction, legal: LegalActions): boolean {
  switch (action.type) {
    case 'call':
      return legal.canCall;
    case 'rob':
      return legal.canRob;
    case 'pass_bid':
      return legal.canPassBid;
    case 'bid':
      return legal.bids.includes(action.value);
    case 'double':
      return legal.canDouble;
    case 'pass':
      return legal.canPass;
    case 'play':
      return legal.canPlay;
  }
}

// ---- adversarial action generation ---------------------------------------------------------

interface Attempt {
  seat: number;
  action: HandAction;
  /** whether the engine must accept it */
  expected: boolean;
  what: string;
}

/** Everything a step needs to judge plays: the legal rank structures for the seat on turn. */
interface StepOracle {
  seat: number;
  hand: Card[];
  plays: Combo[];
  keys: Set<string>;
}

function stepOracle(state: HandState): StepOracle | null {
  if (state.phase !== 'playing') return null;
  const seat = state.turn;
  const hand = state.hands[seat] ?? [];
  const plays = findPlays(hand, state.trick.current, state.rules);
  return { seat, hand, plays, keys: new Set(plays.map((play) => key(play.cards))) };
}

/** Random distinct cards from a hand (1..max), biased towards small sets. */
function randomSubset(rng: () => number, hand: Card[], max: number): Card[] {
  const roll = rng();
  const size = Math.min(
    hand.length,
    roll < 0.5 ? 1 + Math.floor(rng() * 3) : 1 + Math.floor(rng() * max),
  );
  return shuffle(hand, rng).slice(0, Math.max(1, size));
}

/** A legal play with one card removed, added or swapped: usually illegal, sometimes still legal. */
function nearLegal(rng: () => number, oracle: StepOracle): Card[] {
  if (oracle.plays.length === 0) return randomSubset(rng, oracle.hand, 6);
  const base = pick(rng, oracle.plays).cards;
  const used = new Set(ids(base));
  const rest = oracle.hand.filter((card) => !used.has(card.id));
  const roll = rng();
  if (roll < 0.35 && base.length > 1) {
    const drop = Math.floor(rng() * base.length);
    return base.filter((_, index) => index !== drop);
  }
  if (roll < 0.7 && rest.length > 0) return [...base, pick(rng, rest)];
  if (rest.length > 0 && base.length > 0) {
    const drop = Math.floor(rng() * base.length);
    return [...base.filter((_, index) => index !== drop), pick(rng, rest)];
  }
  return base;
}

const MALFORMED: unknown[] = [
  null,
  undefined,
  42,
  'play',
  {},
  [],
  { type: 'play' },
  { type: 'play', cardIds: 'x' },
  { type: 'play', cardIds: [null] },
  { type: 'play', cardIds: [42] },
  { type: 'play', cardIds: {} },
  { type: 'PLAY', cardIds: [] },
  { type: 'bid', value: 4 },
  { type: 'bid', value: 0 },
  { type: 'bid', value: 2.5 },
  { type: 'bid', value: '3' },
  { type: 'bid' },
  { type: 'pass_bid_' },
  { type: 42 },
  { type: null },
];

const BAD_SEATS: unknown[] = [
  -1,
  1.5,
  NaN,
  Infinity,
  -Infinity,
  '0',
  null,
  undefined,
  {},
  [],
  true,
];

/** One adversarial attempt for the current state, with the legality the spec demands. */
function adversarial(state: HandState, rng: () => number, oracle: StepOracle | null): Attempt {
  const n = state.rules.playerCount;
  const acting = actingSeats(state);
  const actingSet = new Set(acting);
  const others = state.hands.map((_, seat) => seat).filter((seat) => !actingSet.has(seat));
  const roll = rng();
  const seat = acting[0] ?? 0;
  const hand = state.hands[seat] ?? [];

  // Random subsets and near-legal mutations of the hand on turn: legal iff findPlays lists them.
  if (roll < 0.3 && oracle !== null) {
    const set = rng() < 0.5 ? randomSubset(rng, oracle.hand, 8) : nearLegal(rng, oracle);
    const expected = oracle.keys.has(key(set));
    return { seat: oracle.seat, action: toPlay(set), expected, what: `subset [${key(set)}]` };
  }
  // Cards that are not (all) in the hand: another seat's, the kitty's, fabricated, duplicated, none.
  if (roll < 0.45) {
    const pool: Card[] = [];
    const source = rng();
    if (source < 0.4) pool.push(...(state.hands[pick(rng, others.length ? others : [seat])] ?? []));
    else if (source < 0.6) pool.push(...state.kitty);
    // Once the landlord has taken the kitty, its cards are in the landlord's own hand and are
    // legal to play, so only cards outside the acting seat's hand count as foreign.
    const inHand = new Set(hand.map((card) => card.id));
    const foreign = pool.filter((card) => !inHand.has(card.id));
    const own = hand.length > 0 ? [pick(rng, hand)] : [];
    const options: Array<[string, string[]]> = [
      ['empty play', []],
      ['duplicated card', [...ids(own), ...ids(own)]],
      ['fabricated id', ['99-S-0', ...ids(own)]],
      ['empty id', ['']],
      [
        "another seat's or kitty card",
        foreign.length > 0
          ? ids(shuffle(foreign, rng).slice(0, 1 + Math.floor(rng() * 3)))
          : ['3-X-9'],
      ],
      [
        'own plus foreign card',
        [...ids(own), ...(foreign.length ? [ids(foreign)[0] as string] : ['0-S-0'])],
      ],
    ];
    const [what, cardIds] = pick(rng, options);
    // A set with cards outside the hand (or empty, or duplicated) can never be a legal play,
    // whatever the phase.
    return { seat, action: { type: 'play', cardIds }, expected: false, what };
  }
  // Wrong seat: a seat that must wait, or a value that is not a seat at all.
  if (roll < 0.6) {
    const action: HandAction =
      oracle !== null && oracle.plays.length > 0 && rng() < 0.5
        ? toPlay(pick(rng, oracle.plays).cards)
        : pick(rng, [
            { type: 'pass' },
            { type: 'call' },
            { type: 'pass_bid' },
            { type: 'bid', value: 3 },
            { type: 'double', double: true },
            { type: 'rob' },
          ] as HandAction[]);
    if (rng() < 0.5 || others.length === 0) {
      const bad = pick(rng, [...BAD_SEATS, n, n + 1, 100]);
      return { seat: bad as number, action, expected: false, what: `seat ${String(bad)}` };
    }
    const other = pick(rng, others);
    // In the doubling round every undecided seat may act; those seats are never in `others`.
    return { seat: other, action, expected: false, what: `waiting seat ${other} ${action.type}` };
  }
  // Wrong phase: an action of another phase from the seat that may act.
  if (roll < 0.75) {
    const byPhase: Record<string, HandAction[]> = {
      bidding: [
        { type: 'pass' },
        { type: 'play', cardIds: ids(hand.slice(0, 1)) },
        { type: 'double', double: true },
      ],
      doubling: [
        { type: 'call' },
        { type: 'rob' },
        { type: 'pass_bid' },
        { type: 'bid', value: 3 },
        { type: 'pass' },
        { type: 'play', cardIds: ids(hand.slice(0, 1)) },
      ],
      playing: [
        { type: 'call' },
        { type: 'rob' },
        { type: 'pass_bid' },
        { type: 'bid', value: 1 },
        { type: 'double', double: false },
      ],
      finished: [{ type: 'pass' }, { type: 'call' }],
      redeal: [{ type: 'pass' }, { type: 'call' }],
    };
    const action = pick(rng, byPhase[state.phase] ?? [{ type: 'pass' }]);
    return { seat, action, expected: false, what: `${action.type} during ${state.phase}` };
  }
  // Wrong for the moment: bids that legalActions forbids, a pass when leading, a second double.
  if (roll < 0.9) {
    if (state.phase === 'playing') {
      if (state.trick.current === null) {
        return { seat, action: { type: 'pass' }, expected: false, what: 'pass when leading' };
      }
      const set = hand.length > 0 ? [pick(rng, hand)] : [];
      return {
        seat,
        action: toPlay(set),
        expected: oracle?.keys.has(key(set)) ?? false,
        what: 'single answer',
      };
    }
    if (state.phase === 'doubling') {
      const decided = state.doubles.flatMap((choice, s) => (choice === null ? [] : [s]));
      if (decided.length > 0) {
        const s = pick(rng, decided);
        return {
          seat: s,
          action: { type: 'double', double: rng() < 0.5 },
          expected: false,
          what: `seat ${s} doubles twice`,
        };
      }
      return { seat, action: { type: 'call' }, expected: false, what: 'call during doubling' };
    }
    if (state.phase === 'bidding') {
      const legal = legalActions(state, seat);
      const action = pick(rng, [
        { type: 'call' },
        { type: 'rob' },
        { type: 'pass_bid' },
        { type: 'bid', value: 1 },
        { type: 'bid', value: 2 },
        { type: 'bid', value: 3 },
      ] as HandAction[]);
      return {
        seat,
        action,
        expected: permitted(action, legal),
        what: `bid ${JSON.stringify(action)}`,
      };
    }
    return { seat, action: { type: 'pass' }, expected: false, what: `pass while ${state.phase}` };
  }
  // Malformed actions.
  const action = pick(rng, MALFORMED);
  return {
    seat,
    action: action as HandAction,
    expected: false,
    what: `malformed ${JSON.stringify(action)}`,
  };
}

// ---- the adversarial replay --------------------------------------------------------------------

interface Budget {
  attempts: number;
  accepted: number;
  rejectedCodes: Set<string>;
  playsChecked: number;
  steps: number;
  views: number;
}

const ALL_KINDS: HandAction[] = [
  { type: 'call' },
  { type: 'rob' },
  { type: 'pass_bid' },
  { type: 'bid', value: 1 },
  { type: 'bid', value: 2 },
  { type: 'bid', value: 3 },
  { type: 'double', double: true },
  { type: 'pass' },
];

/** legalActions must agree with applyAction for every seat and every kind of action. */
function checkLegalConsistency(state: HandState, ctx: string, problems: string[]): void {
  for (let seat = 0; seat < state.rules.playerCount; seat++) {
    const legal = legalActions(state, seat);
    for (const action of ALL_KINDS) {
      const result = applyAction(state, seat, action);
      if (result.ok !== permitted(action, legal)) {
        problems.push(
          `${ctx}: seat ${seat} ${JSON.stringify(action)}: legalActions says ${String(permitted(action, legal))} but applyAction ${result.ok ? 'accepts' : `rejects (${result.code})`}`,
        );
      }
    }
    const hand = state.hands[seat] ?? [];
    if (hand.length === 0) continue;
    const suggestion = legal.canPlay ? hint(hand, state.trick.current, state.rules) : null;
    const set = suggestion === null ? lowestSingle(hand).cards : suggestion.cards;
    const result = applyAction(state, seat, toPlay(set));
    if (legal.canPlay && suggestion !== null && !result.ok) {
      problems.push(
        `${ctx}: seat ${seat} may play but the hint ${show(suggestion)} is rejected: ${result.code}`,
      );
    }
    if (!legal.canPlay && result.ok) {
      problems.push(`${ctx}: seat ${seat} may not play but a play was accepted`);
    }
  }
}

/** Every findPlays combo is accepted and recorded with the same reading. */
function checkPlaysAccepted(
  state: HandState,
  oracle: StepOracle,
  ctx: string,
  problems: string[],
  budget: Budget,
): void {
  for (const play of oracle.plays) {
    budget.playsChecked++;
    const result = applyAction(state, oracle.seat, toPlay(play.cards));
    if (!result.ok) {
      problems.push(`${ctx}: findPlays ${show(play)} rejected: ${result.code} ${result.error}`);
      continue;
    }
    const recorded = result.state.history[result.state.history.length - 1]?.combo ?? null;
    if (sig(recorded) !== sig(play)) {
      problems.push(`${ctx}: findPlays ${show(play)} was recorded as ${sig(recorded)}`);
    }
    const event = result.events[0];
    if (event?.type !== 'play' || sig(event.combo) !== sig(play)) {
      problems.push(`${ctx}: findPlays ${show(play)} raised event ${JSON.stringify(event?.type)}`);
    }
  }
}

function checkViews(state: HandState, ctx: string, problems: string[], budget: Budget): void {
  const viewers: Array<number | null> = [...state.hands.keys(), null, -1, state.rules.playerCount];
  for (const viewer of viewers) {
    budget.views++;
    const first = viewHand(state, viewer);
    const second = viewHand(state, viewer);
    if (!deepEqual(first, second))
      problems.push(`${ctx}: viewHand(${String(viewer)}) is not idempotent`);
    const expectedSeat =
      viewer !== null && viewer >= 0 && viewer < state.rules.playerCount ? viewer : null;
    if (first.seat !== expectedSeat)
      problems.push(`${ctx}: viewHand(${String(viewer)}).seat is ${String(first.seat)}`);
  }
}

function adversarialHand(i: number, problems: string[], budget: Budget, thorough: boolean): void {
  const rules = variantFor(i);
  const n = rules.playerCount;
  const seed = `adv-${i}`;
  const rng = seededRng(`${seed}-illegal`);
  const actor = i % 2 === 0 ? botAction : randomActor(seededRng(`${seed}-actor`));
  let bidder = i % n;
  let state = createHand({ rules, seed, handNumber: i + 1, firstBidder: bidder });
  let redeals = 0;
  let steps = 0;
  for (;;) {
    while (state.phase !== 'finished' && state.phase !== 'redeal') {
      deepFreeze(state);
      const ctx = `${state.seed} step ${steps}`;
      const snapshot = structuredClone(state);
      const oracle = stepOracle(state);
      budget.steps++;

      for (let k = 0; k < 30; k++) {
        const attempt = adversarial(state, rng, oracle);
        budget.attempts++;
        let result;
        try {
          result = applyAction(state, attempt.seat, attempt.action);
        } catch (error) {
          problems.push(`${ctx}: ${attempt.what} threw ${String(error)}`);
          continue;
        }
        if (result.ok !== attempt.expected) {
          problems.push(
            `${ctx}: ${attempt.what} from seat ${String(attempt.seat)} must be ${attempt.expected ? 'accepted' : 'rejected'} but was ${result.ok ? 'accepted' : `rejected: ${result.code} ${result.error}`}`,
          );
        }
        if (result.ok) budget.accepted++;
        else {
          budget.rejectedCodes.add(result.code);
          if (typeof result.error !== 'string' || result.error.length === 0) {
            problems.push(`${ctx}: ${attempt.what}: rejection without a message`);
          }
        }
      }
      checkLegalConsistency(state, ctx, problems);
      checkViews(state, ctx, problems, budget);
      if (oracle !== null && (thorough || state.trick.current === null || steps % 5 === 0)) {
        checkPlaysAccepted(state, oracle, ctx, problems, budget);
      }
      if (!deepEqual(state, snapshot)) {
        problems.push(`${ctx}: the state was mutated by rejected or discarded actions`);
      }

      for (const seat of actingSeats(state)) {
        // Several seats act in turn during the doubling round, so compare each call's input
        // against a snapshot of that same input, not the snapshot taken before the first seat.
        deepFreeze(state);
        const before = structuredClone(state);
        const action = actor(state, seat);
        const result = applyAction(state, seat, action);
        if (!result.ok) {
          problems.push(`${ctx}: actor's ${JSON.stringify(action)} rejected: ${result.code}`);
          return;
        }
        if (!deepEqual(state, before)) {
          problems.push(`${ctx}: applyAction mutated its input state`);
          return;
        }
        state = result.state;
        steps++;
        if (steps > 3000) {
          problems.push(`${ctx}: the hand does not finish`);
          return;
        }
        if (state.phase === 'finished' || state.phase === 'redeal') break;
      }
    }
    if (state.phase === 'finished') {
      const result = state.result;
      if (result === null || sum(result.amounts) !== 0 || !deepEqual(result, settle(state))) {
        problems.push(`${state.seed}: finished without a consistent result`);
      }
      return;
    }
    redeals++;
    if (redeals > 50) {
      problems.push(`${seed}: redealt more than 50 times`);
      return;
    }
    const nextSeed = `${seed}-${redeals}`;
    bidder = nextFirstBidder(rules, state, seededRng(nextSeed));
    state = createHand({ rules, seed: nextSeed, handNumber: i + 1, firstBidder: bidder });
  }
}

describe('round 2', () => {
  it('128 seeded hands (every rule variant twice): 30 illegal actions per step are rejected without throwing or mutating; legal ones accepted; legalActions agrees with applyAction; every findPlays combo is accepted as itself; viewHand is pure', () => {
    const problems: string[] = [];
    const budget: Budget = {
      attempts: 0,
      accepted: 0,
      rejectedCodes: new Set(),
      playsChecked: 0,
      steps: 0,
      views: 0,
    };
    const started = performance.now();
    for (let i = 0; i < 128; i++) {
      adversarialHand(i, problems, budget, i < 32);
      if (problems.length > 40) break;
    }
    const elapsed = performance.now() - started;
    expect(problems.slice(0, 40)).toEqual([]);
    expect(budget.attempts).toBeGreaterThan(128 * 30 * 30);
    expect(budget.accepted).toBeGreaterThan(1000);
    expect(budget.playsChecked).toBeGreaterThan(8_000);
    expect([...budget.rejectedCodes].sort()).toEqual([
      'cannot_pass',
      'cards_not_in_hand',
      'does_not_beat',
      'invalid_action',
      'invalid_combo',
      'not_your_turn',
      'wrong_phase',
    ]);
    expect(elapsed, `${budget.steps} steps took ${elapsed.toFixed(0)} ms`).toBeLessThan(60_000);
  }, 120_000);

  it('simulateHand is deterministic: the same seed, rules, first bidder and actor twice give deep-equal results', () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 48; i++) {
      const rules = variantFor(i * 7);
      const seed = `det-${i}`;
      const opts = { rules, seed, firstBidder: i % rules.playerCount, handNumber: i + 1 };
      const actor = i % 3 === 2 ? randomActor(seededRng(seed)) : undefined;
      const again = i % 3 === 2 ? randomActor(seededRng(seed)) : undefined;
      const first = simulateHand({ ...opts, actor });
      outcomes.push(JSON.stringify(first));
      const second = simulateHand({ ...opts, actor: again });
      expect(deepEqual(first, second), `${seed} differs between runs`).toBe(true);
      expect(JSON.stringify(second)).toBe(outcomes[i]);
      const dealt = createHand({ rules, seed, handNumber: i + 1, firstBidder: opts.firstBidder });
      expect(createHand({ rules, seed, handNumber: i + 1, firstBidder: opts.firstBidder })).toEqual(
        dealt,
      );
      expect(first.seeds[0]).toBe(seed);
    }
    // Interleaving other seeds must not change a result (no hidden global state).
    for (let i = 0; i < 48; i += 5) {
      const rules = variantFor(i * 7);
      const seed = `det-${i}`;
      const opts = { rules, seed, firstBidder: i % rules.playerCount, handNumber: i + 1 };
      const actor = i % 3 === 2 ? randomActor(seededRng(seed)) : undefined;
      expect(JSON.stringify(simulateHand({ ...opts, actor }))).toBe(outcomes[i]);
    }
  });

  it('500 bot-vs-bot 4-player hands with chainsThroughTwos off and a 16-card kitty finish and settle', () => {
    const rules: RuleSettings = { ...RULES_4P, kittySize: 16, chainsThroughTwos: false };
    expect(cardsPerPlayer(rules)).toBe(23);
    const started = performance.now();
    const problems: string[] = [];
    let landlordWins = 0;
    let maxSteps = 0;
    let slowest = 0;
    for (let i = 0; i < 500; i++) {
      const rulesVariant: RuleSettings = {
        ...rules,
        biddingMode: i % 2 === 0 ? 'call' : 'points',
        allPass: i % 4 < 2 ? 'force' : 'redeal',
        doublingRound: i % 8 >= 4,
        kittyBonus: i % 16 >= 8,
      };
      const handStart = performance.now();
      let outcome;
      try {
        outcome = simulateHand({
          rules: rulesVariant,
          seed: `k16-${i}`,
          firstBidder: i % 4,
          handNumber: i + 1,
        });
      } catch (error) {
        problems.push(`k16-${i}: ${String(error)}`);
        continue;
      }
      slowest = Math.max(slowest, performance.now() - handStart);
      const state = outcome.state;
      const result = state.result;
      maxSteps = Math.max(maxSteps, outcome.steps);
      const landlord = state.landlord ?? -1;
      const dealt = createHand({
        rules: rulesVariant,
        seed: state.seed,
        handNumber: i + 1,
        firstBidder: state.firstBidder,
      });
      const landlordCards = (dealt.hands[landlord] ?? []).length + 16;
      const kittyIn =
        state.history
          .filter((entry) => entry.seat === landlord && entry.combo !== null)
          .reduce((total, entry) => total + (entry.combo?.cards.length ?? 0), 0) +
        (state.hands[landlord]?.length ?? 0);
      const facts: Record<string, boolean> = {
        'must finish with a result': state.phase === 'finished' && result !== null,
        'result must equal settle()': result !== null && deepEqual(result, settle(state)),
        'amounts must be zero-sum': result !== null && sum(result.amounts) === 0,
        'exactly one seat is empty': state.hands.filter((hand) => hand.length === 0).length === 1,
        'the landlord held 23 + 16 cards': landlordCards === 39 && kittyIn === 39,
        'every deal gave 23 cards': dealt.hands.every((hand) => hand.length === 23),
        'no chain passes the ace': state.history.every(
          (entry) =>
            entry.combo === null ||
            !['straight', 'pair_chain', 'airplane', 'airplane_single', 'airplane_pair'].includes(
              entry.combo.type,
            ) ||
            entry.combo.rank <= 14,
        ),
      };
      const failed = Object.keys(facts).filter((name) => !facts[name]);
      if (failed.length > 0) problems.push(`k16-${i}: ${failed.join('; ')}`);
      if (result?.winnerSide === 'landlord') landlordWins++;
    }
    const elapsed = performance.now() - started;
    expect(problems).toEqual([]);
    expect(landlordWins).toBeGreaterThan(50);
    expect(landlordWins).toBeLessThan(450);
    expect(maxSteps).toBeLessThan(2000);
    expect(
      elapsed,
      `500 hands took ${elapsed.toFixed(0)} ms (slowest ${slowest.toFixed(0)} ms)`,
    ).toBeLessThan(50_000);
  }, 120_000);

  it('createDeck ids are unique and deterministic; sortCards is a pure, stable total order; shuffle is pure', () => {
    for (const playerCount of [3, 4] as const) {
      const deck = createDeck(playerCount);
      expect(deck).toHaveLength(playerCount === 4 ? 108 : 54);
      expect(new Set(ids(deck)).size).toBe(deck.length);
      expect(createDeck(playerCount)).toEqual(deck);
      for (const card of deck) {
        expect(card.id).toBe(`${card.rank}-${card.suit}-${card.deck}`);
        expect(card.rank >= 3 && card.rank <= 17).toBe(true);
        expect(card.suit === 'J').toBe(card.rank >= 16);
        expect(card.deck === 1 ? playerCount === 4 : true).toBe(true);
      }
      const counts = new Map<string, number>();
      for (const card of deck)
        counts.set(`${card.rank}-${card.suit}`, (counts.get(`${card.rank}-${card.suit}`) ?? 0) + 1);
      const decks = playerCount === 4 ? 2 : 1;
      for (let rank = 3; rank <= 15; rank++)
        for (const suit of ['S', 'H', 'D', 'C']) expect(counts.get(`${rank}-${suit}`)).toBe(decks);
      expect(counts.get('16-J')).toBe(decks);
      expect(counts.get('17-J')).toBe(decks);

      const sorted = sortCards(deck);
      const suitOrder: Record<string, number> = { S: 0, H: 1, D: 2, C: 3, J: 4 };
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1] as Card;
        const b = sorted[i] as Card;
        const order = b.rank - a.rank || suitOrder[a.suit]! - suitOrder[b.suit]! || a.deck - b.deck;
        expect(order, `${a.id} before ${b.id}`).toBeLessThan(0);
      }
      const rng = seededRng(`sort-${playerCount}`);
      for (let i = 0; i < 40; i++) {
        const shuffled = shuffle(deck, rng);
        const before = JSON.stringify(shuffled);
        const frozen = deepFreeze(shuffled.slice());
        expect(sortCards(frozen)).toEqual(sorted);
        expect(sortCards(sortCards(frozen))).toEqual(sorted);
        expect(JSON.stringify(shuffled)).toBe(before);
        expect(new Set(ids(shuffled)).size).toBe(deck.length);
        const subset = shuffled.slice(0, 1 + Math.floor(rng() * 30));
        const twice = sortCards(sortCards(subset));
        expect(twice).toEqual(sortCards(subset));
        expect(sortCards(shuffle(subset, rng))).toEqual(sortCards(subset));
      }
      const frozenDeck = deepFreeze(deck.slice());
      expect(() => shuffle(frozenDeck, rng)).not.toThrow();
      expect(frozenDeck).toEqual(deck);
    }
    const rngA = seededRng('same');
    const rngB = seededRng('same');
    for (let i = 0; i < 1000; i++) {
      const value = rngA();
      expect(value).toBe(rngB());
      expect(value >= 0 && value < 1).toBe(true);
    }
  });

  it('normalizeRules(normalizeRules(x)) equals normalizeRules(x) for garbage, partial and valid inputs', () => {
    const rng = seededRng('normalize-twice');
    const values: unknown[] = [
      4,
      3,
      5,
      '4',
      0,
      -1,
      2.5,
      7.5,
      1e9,
      -0,
      NaN,
      Infinity,
      null,
      undefined,
      true,
      false,
      'points',
      'call',
      'redeal',
      'force',
      'random',
      'rotate',
      'winner',
      [],
      {},
      16,
      12,
      9,
      8,
      6,
      120,
      121,
      4.999,
      5,
      119.5,
    ];
    const inputs: unknown[] = [
      undefined,
      null,
      0,
      '',
      'rules',
      [],
      {},
      DEFAULT_RULES,
      RULES_3P,
      RULES_4P,
      { playerCount: 4 },
      { playerCount: '4' },
      { turnSeconds: 7.5 },
      { turnSeconds: -5 },
      { turnSeconds: 1e9 },
      { kittySize: 12, playerCount: 3 },
      { kittySize: 12, playerCount: 4 },
      { kittySize: 3, playerCount: 4 },
    ];
    for (let i = 0; i < 400; i++) {
      const input: Record<string, unknown> = {};
      for (const k of Object.keys(DEFAULT_RULES)) if (rng() < 0.75) input[k] = pick(rng, values);
      if (rng() < 0.3) input[`extra${i}`] = pick(rng, values);
      inputs.push(input);
    }
    for (const input of inputs) {
      const once = normalizeRules(input);
      const twice = normalizeRules(once);
      expect(twice, JSON.stringify(input)).toEqual(once);
      expect(normalizeRules(JSON.parse(JSON.stringify(once)))).toEqual(once);
      expect(Object.keys(once).sort()).toEqual(Object.keys(DEFAULT_RULES).sort());
      expect(kittySizeOptions(once.playerCount)).toContain(once.kittySize);
      expect(once.turnSeconds >= 5 && once.turnSeconds <= 120).toBe(true);
      expect(Number.isInteger(cardsPerPlayer(once))).toBe(true);
    }
    for (const playerCount of [3, 4] as const)
      for (const kittySize of kittySizeOptions(playerCount))
        for (const biddingMode of ['call', 'points'] as const)
          for (const turnSeconds of [5, 30, 120]) {
            const rules: RuleSettings = {
              ...DEFAULT_RULES,
              playerCount,
              kittySize,
              biddingMode,
              turnSeconds,
            };
            expect(normalizeRules(rules)).toEqual(rules);
          }
  });

  it('beats is irreflexive and antisymmetric; bombs are ordered by bombStrength; analyze ignores card order and never mutates', () => {
    const rng = seededRng('beats');
    for (let i = 0; i < 120; i++) {
      const rules = i % 2 === 0 ? RULES_3P : RULES_4P;
      const rulesVariant = { ...rules, chainsThroughTwos: i % 4 < 2 };
      const hand = shuffle(createDeck(rules.playerCount), rng).slice(
        0,
        rules.playerCount === 3 ? 20 : 33,
      );
      const plays = findPlays(hand, null, rulesVariant);
      const sample = shuffle(plays, rng).slice(0, 60);
      for (const a of sample) {
        expect(beats(a, a, rulesVariant), `${show(a)} beats itself`).toBe(false);
        for (const b of sample) {
          if (beats(a, b, rulesVariant) && beats(b, a, rulesVariant)) {
            throw new Error(`${show(a)} and ${show(b)} beat each other`);
          }
          if (isBomb(a) && isBomb(b)) {
            const expected = bombStrength(a, rulesVariant) > bombStrength(b, rulesVariant);
            expect(beats(a, b, rulesVariant), `${show(a)} vs ${show(b)}`).toBe(expected);
          } else if (isBomb(a) !== isBomb(b)) {
            expect(beats(a, b, rulesVariant)).toBe(isBomb(a));
          }
        }
        const frozen = deepFreeze(shuffle(a.cards, rng));
        const before = JSON.stringify(frozen);
        const read = analyze(frozen, rulesVariant);
        expect(JSON.stringify(frozen)).toBe(before);
        expect(read, `analyze(${key(a.cards)}) in another order`).not.toBeNull();
        expect(sig(read)).toBe(sig(analyze(a.cards, rulesVariant)));
        expect(sig(analyzeAs(frozen, rulesVariant, a))).toBe(sig(a));
        expect(ids(read?.cards ?? []).sort()).toEqual(ids(a.cards).sort());
      }
      const frozenHand = deepFreeze(hand.slice());
      const snapshot = JSON.stringify(frozenHand);
      expect(() => findPlays(frozenHand, null, rulesVariant)).not.toThrow();
      expect(() => decompose(frozenHand, rulesVariant)).not.toThrow();
      expect(() => hint(frozenHand, null, rulesVariant)).not.toThrow();
      expect(() => hint(frozenHand, plays[0] ?? null, rulesVariant)).not.toThrow();
      expect(JSON.stringify(frozenHand)).toBe(snapshot);
    }
  });

  it('a 39-card landlord hand (4p, kitty 16) still lists every lead in reasonable time', () => {
    const rules: RuleSettings = { ...RULES_4P, kittySize: 16, chainsThroughTwos: false };
    const hands = [
      '3 3 3 3 4 4 4 4 5 5 5 5 6 6 6 6 7 7 7 7 8 8 8 8 9 9 9 9 10 10 10 10 J J J J Q Q Q',
      '3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 8 8 8 9 9 9 10 10 10 J J J Q Q Q K K K A A A 2 2 2',
      '3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 8 8 8 9 9 9 10 10 10 J J J Q Q Q K K K A A 2 2 BJ RJ BJ',
    ].map(cards);
    const rng = seededRng('perf-39');
    for (let i = 0; i < 6; i++) hands.push(shuffle(createDeck(4), rng).slice(0, 39));
    findPlays(hands[0] as Card[], null, rules);
    for (const hand of hands) {
      const started = performance.now();
      const plays = findPlays(hand, null, rules);
      const elapsed = performance.now() - started;
      expect(plays.length).toBeGreaterThan(0);
      expect(elapsed, `hand [${key(hand)}] took ${elapsed.toFixed(1)} ms`).toBeLessThan(500);
      const bot = performance.now();
      const state = {
        ...createHand({ rules, seed: 'x', handNumber: 1, firstBidder: 0 }),
        phase: 'playing' as const,
        turn: 0,
        landlord: 0,
        kittyRevealed: true,
        hands: [hand, [], [], []],
        trick: { leader: 0, plays: [], current: null, currentSeat: null },
      };
      const action = botAction(state, 0);
      expect(applyAction(state, 0, action).ok).toBe(true);
      expect(performance.now() - bot, 'botAction on 39 cards').toBeLessThan(1000);
    }
  });
});
