/**
 * Adversarial verification, round 1: property-based and simulation testing of packages/engine
 * against docs/RULES.md and docs/ENGINE_API.md. Bot and random-actor self-play over every rule
 * variant is replayed step by step; findPlays is checked against brute-force subset enumeration;
 * decompose, hint, analyze and normalizeRules are fuzzed. Failing tests document engine bugs for
 * the fixer; passing tests are regression coverage. Hot loops use `checks` (a throw naming the
 * violated facts with the seed and step) instead of `expect` for speed.
 */
import { describe, expect, it } from 'vitest';

import type {
  Card,
  Combo,
  ComboType,
  HandAction,
  HandEvent,
  HandState,
  LegalActions,
  RuleSettings,
} from '../types';
import { createDeck, seededRng, shuffle } from '../cards';
import { analyze, analyzeAs, beats, bombStrength, chainRanks } from '../combos';
import {
  applyAction,
  createHand,
  legalActions,
  nextFirstBidder,
  timeoutAction,
  viewHand,
} from '../hand';
import { decompose, findPlays, hint, lowestSingle } from '../plays';
import { currentStake, kittyBonusMultiplier, settle } from '../scoring';
import { botAction } from '../bot';
import { simulateHand, simulateMany, type SimulationResult } from '../sim';
import { DEFAULT_RULES, cardsPerPlayer, kittySizeOptions, normalizeRules } from '../rules';
import { RULES_3P, RULES_4P, cards, deepFreeze, key, shape } from '../test-helpers';

declare const performance: { now(): number };

type Actor = (state: HandState, seat: number) => HandAction;
type Facts = Record<string, boolean>;

// ---- helpers --------------------------------------------------------------------------------

/** Throws naming every fact that is false (facts are evaluated eagerly: guard with `?.`). */
function checks(ctx: string, facts: Facts): void {
  const failed = Object.keys(facts).filter((name) => !facts[name]);
  if (failed.length > 0) throw new Error(`${ctx}: ${failed.join('; ')}`);
}

const ids = (set: readonly Card[]): string[] => set.map((card) => card.id);
const sortedIds = (set: readonly Card[]): string => ids(set).sort().join(',');
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sig = (combo: Combo | null): string => JSON.stringify(shape(combo));
const isBomb = (combo: Combo): boolean => combo.type === 'bomb' || combo.type === 'rocket';
const toPlay = (combo: Combo): HandAction => ({ type: 'play', cardIds: ids(combo.cards) });
const sum = (values: readonly number[]): number => values.reduce((t, v) => t + v, 0);
const show = (combo: Combo): string => `${sig(combo)} [${key(combo.cards)}]`;
const seatsOf = (state: HandState): Array<number | null> => [...state.hands.keys(), null];
const legal = (state: HandState, seat: number, action: HandAction): boolean =>
  applyAction(state, seat, action).ok;
const flagOf = (type: string): keyof LegalActions =>
  `can${type.replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase())}` as keyof LegalActions;
const permitted = (action: HandAction, may: LegalActions): boolean =>
  action.type === 'bid' ? may.bids.includes(action.value) : may[flagOf(action.type)] === true;
const noActions = (may: LegalActions): boolean =>
  Object.values(may).every((flag) => flag === false || (Array.isArray(flag) && !flag.length));
const CHAINS: string[] = ['straight', 'pair_chain', 'airplane', 'airplane_single', 'airplane_pair'];

/** Every rule variant: 3p/4p x call/points x force/redeal x doubling x kittyBonus x chains. */
function allVariants(): RuleSettings[] {
  const out: RuleSettings[] = [];
  for (const playerCount of [3, 4] as const)
    for (const biddingMode of ['call', 'points'] as const)
      for (const allPass of ['force', 'redeal'] as const)
        for (const doublingRound of [false, true])
          for (const kittyBonus of [false, true])
            for (const chainsThroughTwos of [true, false]) {
              const kittySize = playerCount === 4 ? 8 : 3;
              const shared = { playerCount, kittySize, biddingMode, allPass, doublingRound };
              out.push({ ...DEFAULT_RULES, ...shared, kittyBonus, chainsThroughTwos });
            }
  return out;
}
const VARIANTS = allVariants();

/** Variant for hand `i`: cycles the 64 variants, then the kitty size (default first). */
function variantFor(i: number): RuleSettings {
  const base = VARIANTS[i % VARIANTS.length] as RuleSettings;
  const options = kittySizeOptions(base.playerCount);
  const rotated = [base.kittySize, ...options.filter((size) => size !== base.kittySize)];
  const kittySize = rotated[Math.floor(i / VARIANTS.length) % rotated.length] as number;
  return { ...base, kittySize };
}

/** Why a combo breaks the types.ts Combo contract or is not a legal reading of its own cards. */
function comboDefect(combo: Combo, rules: RuleSettings): string | null {
  if (new Set(ids(combo.cards)).size !== combo.cards.length) return 'duplicate cards';
  if (combo.size !== combo.cards.length) return `size ${combo.size} != ${combo.cards.length}`;
  const unit = CHAINS.indexOf(combo.type) + 1;
  const length = unit === 0 ? 1 : combo.cards.length / unit;
  if (combo.length !== length) return `length ${combo.length}, expected ${length}`;
  const read = analyzeAs(combo.cards, rules, combo);
  if (read === null) return 'its cards are not a legal combination';
  return sig(read) === sig(combo) ? null : `reads as ${sig(read)}`;
}

/** RULES.md "Kitty bonus" table, written independently of scoring.ts. */
function expectedKittyBonus(kitty: Card[], rules: RuleSettings): number {
  if (!rules.kittyBonus) return 1;
  const counts = new Map<number, number>();
  for (const card of kitty) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  const chain = chainRanks(rules);
  const positions = kitty.map((card) => chain.indexOf(card.rank)).sort((a, b) => a - b);
  const run =
    kitty.length >= 3 &&
    positions.every((p, i) => p >= 0 && (i === 0 || p === (positions[i - 1] as number) + 1));
  const sameSuit = new Set(kitty.map((card) => card.suit)).size === 1;
  const candidates = [1];
  if (counts.has(16) && counts.has(17)) candidates.push(3);
  if ([...counts.values()].some((count) => count >= 3)) candidates.push(3);
  if (run) candidates.push(sameSuit ? 3 : 2);
  if ((counts.get(16) ?? 0) + (counts.get(17) ?? 0) === 1) candidates.push(2);
  return Math.max(...candidates);
}

function actingSeats(state: HandState): number[] {
  if (state.phase !== 'doubling') return [state.turn];
  return state.doubles.flatMap((choice, seat) => (choice === null ? [seat] : []));
}

/** Card ids `viewer` must not see: other seats' unplayed cards (a revealed kitty is public). */
function hiddenIds(state: HandState, viewer: number | null): string[] {
  const kitty = new Set(ids(state.kitty));
  const hidden = state.hands.flatMap((hand, seat) =>
    seat === viewer ? [] : ids(hand.filter((c) => !(state.kittyRevealed && kitty.has(c.id)))),
  );
  return state.kittyRevealed ? hidden : [...hidden, ...kitty];
}

/** A seeded actor that picks uniformly among legal actions (bombs and passes a little more). */
function randomActor(rng: () => number): Actor {
  return (state, seat) => {
    const may = legalActions(state, seat);
    if (may.canPlay) {
      const plays = findPlays(state.hands[seat] ?? [], state.trick.current, state.rules);
      if (may.canPass && (plays.length === 0 || rng() < 0.3)) return { type: 'pass' };
      const index = rng() < 0.2 ? plays.length - 1 : Math.floor(rng() * plays.length);
      return toPlay(plays[index] as Combo);
    }
    const options: HandAction[] = may.bids.map((value) => ({ type: 'bid', value }));
    if (may.canCall) options.push({ type: 'call' });
    if (may.canRob) options.push({ type: 'rob' });
    if (may.canPassBid) options.push({ type: 'pass_bid' });
    if (may.canDouble) options.push({ type: 'double', double: rng() < 0.5 });
    return options[Math.floor(rng() * options.length)] as HandAction;
  };
}

// ---- step-by-step replay of self-play with every invariant checked ---------------------------

function checkViews(state: HandState, leaks: boolean, ctx: string): void {
  for (const viewer of [...seatsOf(state), -1, 9]) {
    const view = viewHand(state, viewer);
    const seat = viewer !== null && viewer >= 0 && viewer < state.hands.length ? viewer : null;
    const hide = state.phase === 'doubling';
    const doubles = hide ? state.doubles.map((c, s) => (s === seat ? c : null)) : state.doubles;
    const json = leaks ? JSON.stringify(view) : '';
    const visible = new Set([...json.matchAll(/"(\d+-[SHDCJ]-[01])"/g)].map((m) => m[1]));
    const leaked = hiddenIds(state, seat).filter((id) => visible.has(id));
    const own = seat === null ? view.hand.length === 0 : view.hand === state.hands[seat];
    const meta = view.currentStake === currentStake(state) && view.phase === state.phase;
    checks(`${ctx}: viewer ${String(viewer)}`, {
      'must see own seat and hand only': view.seat === seat && own,
      'card counts': same(
        view.cardCounts,
        state.hands.map((hand) => hand.length),
      ),
      'kitty once revealed': view.kitty === (state.kittyRevealed ? state.kitty : null),
      'others doubles hidden until the round ends': same(view.doubles, doubles),
      'legal actions': same(view.legal, legalActions(state, seat)),
      'stake, phase, turn': meta && view.turn === state.turn,
      [`hidden cards leak: ${leaked.join(' ')}`]: leaked.length === 0,
    });
  }
}

function checkTrick(state: HandState, ctx: string): void {
  const n = state.rules.playerCount;
  const { plays, leader, current, currentSeat } = state.trick;
  const playing = state.phase === 'playing';
  const trickNumber = state.history[state.history.length - 1]?.trickNumber;
  const entries = state.history.filter((e) => e.trickNumber === trickNumber);
  const mirror = entries.map(({ seat, combo }) => ({ seat, combo }));
  const lastPlay = [...plays].reverse().find((play) => play.combo !== null);
  const lastSeat = plays[plays.length - 1]?.seat ?? -1;
  const counts = new Array<number>(n).fill(0);
  let bombs = 0;
  for (const entry of state.history) {
    if (entry.combo === null) continue;
    counts[entry.seat] = (counts[entry.seat] ?? 0) + 1;
    if (isBomb(entry.combo)) bombs++;
  }
  const empty = plays.length === 0;
  checks(ctx, {
    'empty trick has no current play': !empty || (current === null && currentSeat === null),
    'empty trick: the leader acts': !empty || !playing || leader === state.turn,
    'trick.plays must mirror the history': empty || same(mirror, plays),
    'leader is the first player': empty || leader === plays[0]?.seat,
    'current is the last play': empty || current === lastPlay?.combo,
    'currentSeat is its seat': empty || currentSeat === lastPlay?.seat,
    'turn goes clockwise': empty || !playing || state.turn === (lastSeat + 1) % n,
    'playCounts match the history': same(counts, state.playCounts),
    'bombsPlayed matches the history': bombs === state.bombsPlayed,
  });
}

function checkStep(state: HandState, deckSize: number, ctx: string, thorough: boolean): void {
  const all = [...state.hands.flat(), ...state.history.flatMap((e) => e.combo?.cards ?? [])];
  if (!state.kittyRevealed) all.push(...state.kitty);
  const conserved = new Set(ids(all)).size === deckSize && all.length === deckSize;
  const acting = new Set(actingSeats(state));
  const waiting = seatsOf(state).filter((seat) => seat === null || !acting.has(seat));
  const sorted = (h: Card[]): boolean =>
    h.every((c, i) => i === 0 || (h[i - 1] as Card).rank >= c.rank);
  checks(ctx, {
    'hands + played (+ face-down kitty) must be the deck': conserved,
    'kitty has kittySize cards': state.kitty.length === state.rules.kittySize,
    'kitty revealed iff a landlord exists': (state.landlord === null) === !state.kittyRevealed,
    'no landlord only while bidding': state.landlord !== null || state.phase === 'bidding',
    'hands sorted by rank descending': state.hands.every(sorted),
    'waiting seats may not act': waiting.every((s) => noActions(legalActions(state, s))),
  });
  checkTrick(state, ctx);
  if (thorough && state.phase !== 'doubling') {
    const turn = state.turn;
    const other = (turn + 1) % state.rules.playerCount;
    const stolen = ids((state.hands[other] ?? []).slice(0, 1));
    const own = ids((state.hands[turn] ?? []).slice(0, 1));
    const wrong: HandAction = state.phase === 'playing' ? { type: 'call' } : { type: 'pass' };
    const leading = state.phase === 'playing' && state.trick.current === null;
    checks(`${ctx}: must refuse`, {
      "another seat's card": !legal(state, turn, { type: 'play', cardIds: stolen }),
      'acting out of turn': !legal(state, other, timeoutAction(state, other)),
      'an empty play': !legal(state, turn, { type: 'play', cardIds: [] }),
      'a duplicated card': !legal(state, turn, { type: 'play', cardIds: [...own, ...own] }),
      'the wrong phase': !legal(state, turn, wrong),
      'a pass when leading': !leading || !legal(state, turn, { type: 'pass' }),
    });
  }
  checkViews(state, thorough, ctx);
}

/** The actor's action for `seat`, after checking it, the timeout action and the hint. */
function checkAction(state: HandState, seat: number, actor: Actor, bot: boolean, ctx: string) {
  const rules = state.rules;
  const may = legalActions(state, seat);
  const action = actor(state, seat);
  const timeout = timeoutAction(state, seat);
  checks(ctx, {
    [`${JSON.stringify(action)} must be legal`]: permitted(action, may),
    [`timeout ${JSON.stringify(timeout)} must be legal`]: legal(state, seat, timeout),
  });
  if (state.phase !== 'playing') return action;
  const hand = state.hands[seat] ?? [];
  const current = state.trick.current;
  const suggestion = hint(hand, current, rules);
  const hintKey = suggestion && key(suggestion.cards);
  const goesOut = action.type === 'play' && action.cardIds.length === hand.length;
  if (current === null) {
    const lowest = (lowestSingle(hand).cards[0] as Card).id;
    const leadsLowest = timeout.type === 'play' && timeout.cardIds.join() === lowest;
    const allBombs = decompose(hand, rules).every(isBomb);
    checks(ctx, {
      'canPlay without canPass when leading': may.canPlay && !may.canPass,
      'timeout must lead the lowest single': leadsLowest,
      'hint(hand, null) must not be null': suggestion !== null,
      'hint must be a legal lead': suggestion !== null && legal(state, seat, toPlay(suggestion)),
      'hint must not be a bomb': suggestion !== null && (!isBomb(suggestion) || allBombs),
      'bot must not pass when leading': !bot || action.type === 'play',
      'bot must go out with a one-combo hand': !bot || analyze(hand, rules) === null || goesOut,
    });
    return action;
  }
  const plays = findPlays(hand, current, rules);
  const rejected = plays.filter((play) => !legal(state, seat, toPlay(play))).map(show);
  const strength = (combo: Combo): number => bombStrength(combo, rules);
  const bombs = plays.filter(isBomb).sort((a, b) => strength(a) - strength(b));
  const expected = plays.find((play) => !isBomb(play)) ?? bombs[0] ?? null;
  const finishing = plays.some((play) => play.cards.length === hand.length);
  const landlord = state.landlord as number;
  const landlordCards = (state.hands[landlord] ?? []).length;
  const partnerHolds = seat !== landlord && state.trick.currentSeat !== landlord;
  const partnerOk = !partnerHolds || landlordCards <= 2 || action.type === 'pass' || goesOut;
  checks(ctx, {
    'canPlay and canPass when answering': may.canPlay && may.canPass,
    'timeout must pass when answering': timeout.type === 'pass',
    [`findPlays answers must be accepted: ${rejected.join(' ')}`]: rejected.length === 0,
    'hint must be the weakest non-bomb answer, else the weakest bomb': same(
      hintKey,
      expected && key(expected.cards),
    ),
    'bot must go out when it can in one play': !bot || !finishing || goesOut,
    [`peasant bot must not beat its partner (landlord holds ${landlordCards})`]: !bot || partnerOk,
  });
  return action;
}

function checkTransition(
  state: HandState,
  next: HandState,
  events: HandEvent[],
  seat: number,
  action: HandAction,
  ctx: string,
): void {
  const n = state.rules.playerCount;
  const chosen = state.landlord === null && next.landlord !== null;
  const started = next.phase === 'playing' && state.phase !== 'playing';
  const ended = state.phase === 'playing' && next.phase === 'playing' && !next.trick.plays.length;
  const simple = action.type === 'play' || action.type === 'pass' || action.type === 'double';
  const expected: string[] = [simple ? action.type : 'bid'];
  if (chosen) expected.push('landlord_chosen');
  if (chosen && next.rules.doublingRound) expected.push('doubling_started');
  if (state.phase === 'doubling' && next.phase === 'playing') expected.push('doubling_finished');
  if (ended) expected.push('trick_won');
  if (next.phase === 'finished') expected.push('hand_finished');
  if (next.phase === 'redeal') expected.push('redeal');
  const types = events.map((event) => event.type);
  const hand = state.hands[seat] ?? [];
  const nextHand = next.hands[seat] ?? [];
  const lastEntry = next.history[next.history.length - 1];
  const played = action.type === 'play' ? [...action.cardIds].sort().join(',') : null;
  const historyGrew = next.history.length === state.history.length + 1;
  const countMoved = next.playCounts[seat] === (state.playCounts[seat] ?? 0) + 1;
  const landlord = next.landlord ?? -1;
  const before = (state.hands[landlord] ?? []).length + state.rules.kittySize;
  const kittyIn = (next.hands[landlord] ?? []).length === before && next.kittyRevealed;
  const over = next.phase === 'finished' || next.phase === 'redeal';
  const facts: Facts = {
    [`events ${types.join()} must be ${expected.join()}`]: same(types, expected),
  };
  for (const event of events) {
    const at = `${event.type} event`;
    switch (event.type) {
      case 'play':
        facts[`${at} must carry the seat and the cards`] =
          event.seat === seat && sortedIds(event.combo.cards) === played;
        facts[`${at} must move history, hand and playCounts`] =
          historyGrew &&
          countMoved &&
          lastEntry?.combo === event.combo &&
          nextHand.length === hand.length - event.combo.cards.length;
        break;
      case 'pass':
        facts[`${at} must add a pass to the history only`] =
          event.seat === seat && historyGrew && lastEntry?.combo === null && nextHand === hand;
        break;
      case 'landlord_chosen':
        facts[`${at} must reveal the kitty into the landlord's hand`] =
          event.seat === landlord &&
          event.base === next.base &&
          sortedIds(event.kitty) === sortedIds(next.kitty) &&
          kittyIn;
        facts['doubling round or play must follow'] =
          next.phase === (next.rules.doublingRound ? 'doubling' : 'playing');
        break;
      case 'doubling_finished':
        facts[`${at} must carry every choice`] = same(event.doubles, next.doubles);
        break;
      case 'trick_won':
        facts['the last player to play must lead the next trick'] =
          event.seat === next.turn && event.seat === state.trick.currentSeat;
        break;
      case 'hand_finished':
        facts[`${at} must carry the result`] = same(event.result, next.result);
        break;
      default:
        facts[`${at} must carry the seat`] = !('seat' in event) || event.seat === seat;
    }
  }
  const leads = next.turn === next.landlord && next.trick.leader === next.landlord;
  facts['the landlord must lead the first trick'] = !started || (leads && !next.trick.plays.length);
  const clockwise = next.phase !== 'playing' || started || ended;
  facts['the turn must go clockwise'] = clockwise || next.turn === (seat + 1) % n;
  facts['nobody acts once the deal is over'] = !over || next.turn === -1;
  checks(ctx, facts);
}

/** Re-validates every play of the history against the trick it was played into. */
function checkHistory(state: HandState, ctx: string): void {
  const n = state.rules.playerCount;
  const rules = state.rules;
  let current: Combo | null = null;
  let currentSeat = -1;
  let passes = 0;
  let trickNumber = 1;
  let expectedSeat = state.landlord as number;
  state.history.forEach((entry, index) => {
    const combo = entry.combo;
    const beaten = current;
    const read =
      combo === null
        ? null
        : beaten === null
          ? analyze(combo.cards, rules)
          : analyzeAs(combo.cards, rules, beaten);
    const defect = combo === null ? null : comboDefect(combo, rules);
    checks(`${ctx}: history[${index}]`, {
      [`trick ${entry.trickNumber} seat ${entry.seat} must be ${trickNumber} ${expectedSeat}`]:
        entry.trickNumber === trickNumber && entry.seat === expectedSeat,
      'a pass must answer a play': combo !== null || beaten !== null,
      [`${combo === null ? '' : show(combo)} ${String(defect)}`]: defect === null,
      [`re-reads as ${sig(read)} not ${sig(combo)}`]: combo === null || sig(read) === sig(combo),
      [`${sig(combo)} must beat ${sig(beaten)}`]: !combo || !beaten || beats(combo, beaten, rules),
    });
    if (combo !== null) {
      [current, currentSeat, passes, expectedSeat] = [combo, entry.seat, 0, (entry.seat + 1) % n];
    } else if (++passes === n - 1) {
      [trickNumber, expectedSeat, current, passes] = [trickNumber + 1, currentSeat, null, 0];
    } else {
      expectedSeat = (entry.seat + 1) % n;
    }
  });
  const last = state.history[state.history.length - 1];
  const winner = last?.combo !== null && last?.seat === state.result?.winnerSeat;
  checks(ctx, { 'the hand must end with the winner play': winner });
}

function checkFinished(state: HandState, ctx: string): void {
  const rules = state.rules;
  const result = state.result;
  const over = state.phase === 'finished' && state.turn === -1 && result !== null;
  checks(ctx, { 'must be finished with a result and nobody on turn': over });
  if (result === null) return;
  const landlord = state.landlord as number;
  checkHistory(state, ctx);
  const played = state.history.filter((entry) => entry.combo !== null);
  const bombs = played.filter((entry) => entry.combo !== null && isBomb(entry.combo)).length;
  const robs = state.bidding.records.filter((record) => record.action === 'rob').length;
  const bids = state.bidding.records.flatMap((r) => (r.value === undefined ? [] : [r.value]));
  const base = rules.biddingMode === 'call' || bids.length === 0 ? 1 : Math.max(...bids);
  const peasantPlays = played.filter((entry) => entry.seat !== landlord).length;
  const landlordPlays = played.length - peasantPlays;
  const peasantsWon = result.winnerSide === 'peasants';
  const spring = !peasantsWon && peasantPlays === 0 ? 'spring' : null;
  const antiSpring = peasantsWon && landlordPlays === 1 ? 'anti_spring' : null;
  const kittyBonus = expectedKittyBonus(state.kitty, rules);
  const stake = base * 2 ** robs * 2 ** bombs * ((spring ?? antiSpring) ? 2 : 1) * kittyBonus;
  const doubled = state.doubles.map((choice) => choice === true);
  const sign = peasantsWon ? 1 : -1;
  const amounts = state.hands.map((_, seat) =>
    seat === landlord ? 0 : sign * stake * (doubled[landlord] ? 2 : 1) * (doubled[seat] ? 2 : 1),
  );
  amounts[landlord] = -sum(amounts);
  const expected = {
    base,
    robs,
    bombs,
    spring: spring ?? antiSpring,
    kittyBonus,
    stake,
    doubled,
    amounts,
  };
  const actual = Object.fromEntries(
    Object.keys(expected).map((k) => [k, result[k as keyof typeof expected]]),
  );
  const empty = state.hands.flatMap((hand, seat) => (hand.length === 0 ? [seat] : []));
  const side = result.winnerSeat === landlord ? 'landlord' : 'peasants';
  checks(ctx, {
    'result must equal settle()': same(result, settle(state)),
    'exactly the winner must have gone out': same(empty, [result.winnerSeat]),
    'landlord and winner side': result.landlord === landlord && result.winnerSide === side,
    [`${JSON.stringify(actual)} must be ${JSON.stringify(expected)}`]: same(actual, expected),
    'amounts must sum to zero': sum(result.amounts) === 0,
    'kittyBonusMultiplier must agree': kittyBonusMultiplier(state.kitty, rules) === kittyBonus,
    'currentStake must be the stake without spring':
      currentStake(state) * (expected.spring ? 2 : 1) === stake,
    'doubles must be decided': state.doubles.every((c) => typeof c === 'boolean'),
    'doubles must be false when the round is off': rules.doublingRound || !doubled.includes(true),
    'nobody may act once finished': seatsOf(state).every((s) => noActions(legalActions(state, s))),
  });
}

/** simulateHand for hand `i`, re-implemented with every state deep-frozen and every step checked. */
function replay(
  rules: RuleSettings,
  seed: string,
  i: number,
  actor: Actor,
  bot: boolean,
  thorough: boolean,
): SimulationResult {
  const n = rules.playerCount;
  const deckSize = createDeck(n).length;
  const perSeat = cardsPerPlayer(rules);
  const events: HandEvent[] = [];
  const seeds = [seed];
  let steps = 0;
  let redeals = 0;
  let bidder = i % n;
  let state = createHand({ rules, seed, handNumber: i + 1, firstBidder: bidder });
  for (;;) {
    const deal = state.seed;
    const fresh =
      state.phase === 'bidding' && state.turn === bidder && state.firstBidder === bidder;
    checks(deal, {
      'a new deal must start bidding with the first bidder': fresh && state.handNumber === i + 1,
      'everyone must be dealt cardsPerPlayer cards': state.hands.every((h) => h.length === perSeat),
    });
    let dealSteps = 0;
    while (state.phase !== 'finished' && state.phase !== 'redeal') {
      deepFreeze(state);
      const ctx = `${deal} step ${steps}`;
      checkStep(state, deckSize, ctx, thorough || steps % 8 === 0);
      for (const seat of actingSeats(state)) {
        const action = checkAction(state, seat, actor, bot, `${ctx} seat ${seat}`);
        const result = applyAction(state, seat, action);
        if (!result.ok) throw new Error(`${ctx}: action rejected: ${result.code} ${result.error}`);
        checkTransition(state, result.state, result.events, seat, action, `${ctx} seat ${seat}`);
        state = result.state;
        events.push(...result.events);
        steps++;
        checks(ctx, { 'the deal must end within 2000 steps': ++dealSteps <= 2000 });
        if (state.phase === 'finished' || state.phase === 'redeal') break;
      }
    }
    if (state.phase === 'finished') {
      checkFinished(state, `${deal} finished`);
      return { state, events, steps, redeals, seeds };
    }
    const records = state.bidding.records;
    const nextSeed = `${seed}-${++redeals}`;
    const next = nextFirstBidder(rules, state, seededRng(nextSeed));
    const idle = state.turn === -1 && state.landlord === null && !state.kittyRevealed;
    checks(deal, {
      'a redeal needs a redeal room': rules.allPass === 'redeal',
      'a redeal needs everyone to have passed':
        records.length === n && records.every((r) => r.action === 'pass'),
      'nobody acts after a redeal':
        idle && seatsOf(state).every((s) => noActions(legalActions(state, s))),
      'after a redeal the next seat must bid first': next === (bidder + 1) % n,
    });
    bidder = next;
    state = createHand({ rules, seed: nextSeed, handNumber: i + 1, firstBidder: bidder });
    seeds.push(nextSeed);
  }
}

function checkSimAgrees(
  rules: RuleSettings,
  seed: string,
  i: number,
  outcome: SimulationResult,
  actor?: Actor,
) {
  const sim = simulateHand({
    rules,
    seed,
    firstBidder: i % rules.playerCount,
    handNumber: i + 1,
    actor,
  });
  checks(seed, { 'simulateHand must equal the step-by-step replay': same(sim, outcome) });
}

describe('self-play over every rule variant, replayed step by step', () => {
  const HANDS = 1500;

  it(`${HANDS} bot hands: every step keeps the RULES.md invariants and simulateHand agrees`, () => {
    const seen = new Set<string>();
    let redeals = 0;
    let landlordWins = 0;
    for (let i = 0; i < HANDS; i++) {
      const rules = variantFor(i);
      seen.add(JSON.stringify(rules));
      const outcome = replay(rules, `fuzz-${i}`, i, botAction, true, i < 100);
      redeals += outcome.redeals;
      if (outcome.state.result?.winnerSide === 'landlord') landlordWins++;
      if (i % 3 === 0) checkSimAgrees(rules, `fuzz-${i}`, i, outcome);
    }
    expect(seen.size).toBe(VARIANTS.length * 4);
    expect(redeals).toBeGreaterThan(0);
    expect(landlordWins).toBeGreaterThan(HANDS * 0.2);
    expect(landlordWins).toBeLessThan(HANDS * 0.9);
  }, 120_000);

  it('320 random-actor hands (robs, wild bids, bombs on bombs, passes) keep every invariant', () => {
    let bombs = 0;
    let robs = 0;
    for (let i = 0; i < 320; i++) {
      const rules = variantFor(i);
      const seed = `random-${i}`;
      const outcome = replay(rules, seed, i, randomActor(seededRng(seed)), false, i < 64);
      bombs += outcome.state.result?.bombs ?? 0;
      robs += outcome.state.result?.robs ?? 0;
      if (i % 4 === 0) checkSimAgrees(rules, seed, i, outcome, randomActor(seededRng(seed)));
    }
    expect(bombs).toBeGreaterThan(100);
    expect(robs).toBeGreaterThan(20);
  }, 120_000);

  it(`simulateMany plays ${HANDS} hands over every variant in < 60 s, summary consistent`, () => {
    const started = performance.now();
    const summary = simulateMany(HANDS, 'fuzz-many', VARIANTS);
    expect(performance.now() - started).toBeLessThan(60_000);
    expect(summary.hands).toBe(HANDS);
    expect(summary.results).toHaveLength(HANDS);
    const totals = { wins: 0, springs: 0, bombs: 0, redeals: 0, steps: 0 };
    for (const result of summary.results) {
      const outcome = result.state.result;
      const settled = outcome !== null && same(outcome, settle(result.state));
      checks(result.seeds[0] ?? '', {
        'finished and settled': result.state.phase === 'finished' && settled,
        'zero-sum': outcome !== null && sum(outcome.amounts) === 0,
        'one seed per deal': result.seeds.length === result.redeals + 1,
        'the last seed is the finished deal':
          result.state.seed === result.seeds[result.seeds.length - 1],
        'a forced room never redeals':
          result.state.rules.allPass === 'redeal' || result.redeals === 0,
      });
      if (outcome === null) continue;
      totals.wins += outcome.winnerSide === 'landlord' ? 1 : 0;
      totals.springs += outcome.spring === null ? 0 : 1;
      totals.bombs += outcome.bombs;
      totals.redeals += result.redeals;
      totals.steps += result.steps;
    }
    expect(summary.landlordWins).toBe(totals.wins);
    expect(summary.landlordWinRate).toBeCloseTo(totals.wins / HANDS, 12);
    expect(summary.springs + summary.antiSprings).toBe(totals.springs);
    expect(summary.bombs).toBe(totals.bombs);
    expect(summary.redeals).toBe(totals.redeals);
    expect(summary.averageSteps).toBeCloseTo(totals.steps / HANDS, 9);
  }, 120_000);

  it('nextFirstBidder follows the winner, rotates, or draws a seat deterministically', () => {
    for (const rules of [RULES_3P, RULES_4P]) {
      const n = rules.playerCount;
      const previous = simulateHand({ rules, seed: 'next-bidder', firstBidder: 1 }).state;
      const pick = (mode: RuleSettings['firstBidder'], seed: string): number =>
        nextFirstBidder({ ...rules, firstBidder: mode }, previous, seededRng(seed));
      expect(pick('winner', 'x')).toBe(previous.result?.winnerSeat);
      expect(pick('rotate', 'x')).toBe(2 % n);
      const drawn = [pick('random', 'x'), nextFirstBidder(rules, null, seededRng('first'))];
      expect(drawn[0]).toBe(pick('random', 'x'));
      expect(drawn.every((seat) => Number.isInteger(seat) && seat >= 0 && seat < n)).toBe(true);
    }
  });

  it('the harness itself rejects tampered results and histories', () => {
    const state = simulateHand({ rules: RULES_3P, seed: 'teeth', firstBidder: 0 }).state;
    checkFinished(state, 'intact');
    const result = state.result as NonNullable<HandState['result']>;
    const amounts = result.amounts.map((amount, seat) => (seat === 0 ? amount + 1 : amount));
    expect(() => checkFinished({ ...state, result: { ...result, amounts } }, 't')).toThrow(
      /settle/,
    );
    expect(() => checkFinished({ ...state, history: state.history.slice(1) }, 't')).toThrow(
      /history/,
    );
    const history = state.history.map((entry, index) =>
      index === 0 && entry.combo
        ? { ...entry, combo: { ...entry.combo, rank: 17 as const } }
        : entry,
    );
    expect(() => checkHistory({ ...state, history }, 't')).toThrow(/re-reads as/);
  });
});

// ---- findPlays against brute-force subset enumeration ----------------------------------------

/** A small hand biased towards consecutive ranks and multiples, so chains and kickers occur. */
function clumpy(rng: () => number, playerCount: 3 | 4, size: number): Card[] {
  const deck = createDeck(playerCount);
  const byRank = new Map<number, Card[]>();
  for (const card of deck) byRank.set(card.rank, [...(byRank.get(card.rank) ?? []), card]);
  const pool: Card[] = [];
  const start = 3 + Math.floor(rng() * 13);
  const span = 2 + Math.floor(rng() * 6);
  for (let rank = start; rank < start + span && rank <= 15; rank++) {
    const roll = rng();
    const count =
      roll < 0.2 ? 0 : roll < 0.45 ? 1 : roll < 0.65 ? 2 : roll < 0.85 ? 3 : roll < 0.95 ? 4 : 8;
    pool.push(...shuffle(byRank.get(rank) ?? [], rng).slice(0, count));
  }
  for (const joker of [16, 17]) {
    const roll = rng();
    pool.push(...(byRank.get(joker) ?? []).slice(0, roll < 0.35 ? 1 : roll < 0.5 ? 2 : 0));
  }
  const taken = new Set(ids(pool));
  const extras = shuffle(
    deck.filter((card) => !taken.has(card.id)),
    rng,
  );
  return shuffle([...pool, ...extras.slice(0, 1 + Math.floor(rng() * 2))], rng).slice(0, size);
}

function subsets(set: Card[]): Card[][] {
  const out: Card[][] = [];
  for (let mask = 1; mask < 1 << set.length; mask++) {
    out.push(set.filter((_, index) => (mask >> index) & 1));
  }
  return out;
}

/** Every legal play by rank key, found by trying every subset through analyze/analyzeAs + beats. */
function bruteForce(hand: Card[], current: Combo | null, rules: RuleSettings): Map<string, Combo> {
  const out = new Map<string, Combo>();
  for (const subset of subsets(hand)) {
    const combo = current === null ? analyze(subset, rules) : analyzeAs(subset, rules, current);
    if (combo === null || (current !== null && !beats(combo, current, rules))) continue;
    if (!out.has(key(subset))) out.set(key(subset), combo);
  }
  return out;
}

/** Mismatches between findPlays and brute force (empty when they agree). */
function comparePlays(hand: Card[], current: Combo | null, rules: RuleSettings): string[] {
  const against = current === null ? 'lead' : show(current);
  const label = `[${key(hand)}] vs ${against} (${rules.playerCount}p, twos ${rules.chainsThroughTwos})`;
  const problems: string[] = [];
  const plays = findPlays(hand, current, rules);
  const expected = bruteForce(hand, current, rules);
  const keys = plays.map((play) => key(play.cards));
  if (new Set(keys).size !== keys.length) problems.push(`${label}: duplicate rank structures`);
  const missing = [...expected.keys()].filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !expected.has(k));
  if (missing.length > 0) problems.push(`${label}: findPlays misses [${missing.join('] [')}]`);
  if (extra.length > 0) problems.push(`${label}: findPlays invents [${extra.join('] [')}]`);
  const handIds = new Set(ids(hand));
  let lastRank = 0;
  let lastBomb = 0;
  let seenBomb = false;
  for (const play of plays) {
    const at = `${label}: ${show(play)}`;
    if (!play.cards.every((card) => handIds.has(card.id))) problems.push(`${at} not in hand`);
    const defect = comboDefect(play, rules);
    if (defect !== null) problems.push(`${at} ${defect}`);
    const want = expected.get(key(play.cards));
    if (want !== undefined && sig(want) !== sig(play))
      problems.push(`${at} analyze says ${sig(want)}`);
    if (isBomb(play)) {
      const strength = bombStrength(play, rules);
      if (strength < lastBomb) problems.push(`${at} bombs not sorted weakest first`);
      [lastBomb, seenBomb] = [strength, true];
    } else {
      if (seenBomb) problems.push(`${at} listed after a bomb`);
      if (play.rank < lastRank) problems.push(`${at} rank ${play.rank} after ${lastRank}`);
      lastRank = play.rank;
    }
  }
  return problems;
}

/** A random legal combo from a clumpy set, picking the type first so rare types come up. */
function randomCurrent(rng: () => number, playerCount: 3 | 4, rules: RuleSettings): Combo | null {
  if (rng() < 0.2) return null;
  const byType = new Map<ComboType, Combo[]>();
  for (const subset of subsets(clumpy(rng, playerCount, 1 + Math.floor(rng() * 9)))) {
    const combo = analyze(subset, rules);
    if (combo !== null) byType.set(combo.type, [...(byType.get(combo.type) ?? []), combo]);
  }
  const types = [...byType.keys()];
  const combos = byType.get(types[Math.floor(rng() * types.length)] as ComboType) ?? [];
  return combos[Math.floor(rng() * combos.length)] ?? null;
}

const rulesFor = (i: number): RuleSettings => ({
  ...(i % 2 === 0 ? RULES_3P : RULES_4P),
  chainsThroughTwos: i % 4 < 2,
});

describe('findPlays against brute-force subset enumeration', () => {
  it('460 random small hands (3p/4p, chains on/off): exactly the legal plays, well formed', () => {
    const rng = seededRng('brute-force');
    const problems: string[] = [];
    let answers = 0;
    let bombCurrents = 0;
    for (let i = 0; i < 460; i++) {
      const rules = rulesFor(i);
      const hand = clumpy(rng, rules.playerCount, i < 400 ? 1 + Math.floor(rng() * 10) : 12);
      const current = randomCurrent(rng, rules.playerCount, rules);
      answers += current === null ? 0 : 1;
      bombCurrents += current !== null && isBomb(current) ? 1 : 0;
      problems.push(...comparePlays(hand, current, rules));
    }
    expect(answers).toBeGreaterThan(250);
    expect(bombCurrents).toBeGreaterThan(5);
    expect(problems).toEqual([]);
  }, 60_000);

  it('hand-picked: 4p bomb and rocket tiers, ambiguous airplanes, chains through twos', () => {
    const problems: string[] = [];
    const cases: Array<[string, string | null, RuleSettings]> = [
      ['5 5 5 5 5 BJ BJ RJ RJ 3', '2 2 2 2', RULES_4P],
      ['6 6 6 6 6 6 BJ BJ RJ RJ', 'BJ BJ RJ', RULES_4P],
      ['2 2 2 2 2 2 2 2 BJ BJ RJ RJ', '3 3 3 3 3 3 3', RULES_4P],
      ['3 3 3 4 4 4 5 5 5 6 6 6', '7 7 7 8 8 8 9 9 9 3 4 5', RULES_3P],
      ['3 3 3 3 4 4 4 4 5 5 BJ RJ', null, RULES_4P],
      ['J Q K A 2 BJ RJ 10 9', null, { ...RULES_3P, chainsThroughTwos: false }],
      ['A A 2 2 BJ BJ RJ RJ 3', 'K K A A 2 2', RULES_4P],
      ['3 3 3 3 4 4 5 5 6 7 BJ RJ', '8 8 8 8 9 9 10 10', RULES_3P],
    ];
    for (const [hand, current, rules] of cases) {
      const combo = current === null ? null : analyze(cards(current), rules);
      if (current !== null && combo === null) problems.push(`${current} is not a combo`);
      problems.push(...comparePlays(cards(hand), combo, rules));
    }
    expect(problems).toEqual([]);
  });
});

// ---- decompose, hint, analyze, normalizeRules robustness and performance ----------------------

const randomHand = (rng: () => number, playerCount: 3 | 4, size: number): Card[] =>
  shuffle(createDeck(playerCount), rng).slice(0, size);

describe('decompose, hint and robustness on random hands', () => {
  it('decompose covers the hand exactly, keeps bombs whole; hint leads a legal non-bomb part', () => {
    const rng = seededRng('decompose');
    const problems: string[] = [];
    for (let i = 0; i < 600; i++) {
      const rules = rulesFor(i);
      const size = 1 + Math.floor(rng() * (rules.playerCount === 3 ? 20 : 33));
      const hand =
        i % 3 === 0
          ? clumpy(rng, rules.playerCount, size)
          : randomHand(rng, rules.playerCount, size);
      const label = `[${key(hand)}] (${rules.playerCount}p, twos ${rules.chainsThroughTwos})`;
      const parts = decompose(hand, rules);
      const counts = new Map<number, number>();
      for (const card of hand) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
      const jokers = (counts.get(16) ?? 0) + (counts.get(17) ?? 0);
      const rocket = parts.find((part) => part.type === 'rocket');
      const suggestion = hint(hand, null, rules);
      const facts: Facts = {
        'decompose must cover the hand exactly':
          sortedIds(parts.flatMap((p) => p.cards)) === sortedIds(hand),
        'decompose must keep the rocket whole':
          !(counts.has(16) && counts.has(17)) || rocket?.size === jokers,
        'hint(hand, null) must not be null': suggestion !== null,
        'hint must be a part of decompose': parts.some(
          (p) => suggestion !== null && key(p.cards) === key(suggestion.cards),
        ),
        'hint must not be a bomb unless the hand is only bombs':
          suggestion === null || !isBomb(suggestion) || parts.every(isBomb),
      };
      for (const part of parts)
        facts[`part ${show(part)}: ${String(comboDefect(part, rules))}`] =
          comboDefect(part, rules) === null;
      for (const [rank, count] of counts) {
        const bomb = parts.find((part) => part.type === 'bomb' && part.rank === rank);
        facts[`bomb of ${rank} must be whole`] = rank >= 16 || count < 4 || bomb?.size === count;
      }
      try {
        checks(label, facts);
      } catch (error) {
        problems.push(String(error));
      }
    }
    expect(problems).toEqual([]);
    expect(hint([], null, RULES_3P)).toBeNull();
  });

  it('analyze, findPlays, decompose never throw; normalizeRules never throws and is idempotent', () => {
    const rng = seededRng('analyze');
    const deck = createDeck(4);
    expect(analyze([], RULES_3P)).toBeNull();
    expect(analyze(deck, RULES_4P)).toBeNull();
    for (let i = 0; i < 300; i++) {
      const set = shuffle(deck, rng).slice(0, i < 100 ? 40 : Math.floor(rng() * (deck.length + 1)));
      for (const rules of [RULES_3P, RULES_4P]) {
        expect(() => analyze([...set, ...set.slice(0, i % 4)], rules)).not.toThrow();
        expect(() => findPlays(set.slice(0, 20), null, rules)).not.toThrow();
        expect(() => decompose(set, rules)).not.toThrow();
      }
    }
    const hostile = {
      get playerCount(): number {
        throw new Error('boom');
      },
    };
    const values = [4, 3, 5, '4', 0, -1, 2.5, 1e9, NaN, null, true, 'points', 'redeal', 'random'];
    for (let i = 0; i < 300; i++) {
      const input: Record<string, unknown> = { [`junk${i}`]: i };
      for (const k of Object.keys(DEFAULT_RULES)) {
        if (rng() < 0.7) input[k] = values[Math.floor(rng() * values.length)];
      }
      const rules = normalizeRules([input, null, 7, 'x', [], hostile][i % 6]);
      expect(kittySizeOptions(rules.playerCount)).toContain(rules.kittySize);
      expect(rules.turnSeconds).toBeGreaterThanOrEqual(5);
      expect(rules.turnSeconds).toBeLessThanOrEqual(120);
      expect(Number.isInteger(cardsPerPlayer(rules))).toBe(true);
      expect(Object.keys(rules).sort()).toEqual(Object.keys(DEFAULT_RULES).sort());
      expect(normalizeRules(rules)).toEqual(rules);
    }
    expect(normalizeRules({ playerCount: 4, kittySize: 3 }).kittySize).toBe(8);
  });

  it('findPlays leads from 33-card 4-player landlord hands in under 250 ms each', () => {
    const hands = [
      '3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 8 8 8 9 9 9 10 10 10 J J J Q Q Q K K K',
      '3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 8 8 8 9 9 9 10 10 10 J Q K A 2 BJ RJ BJ RJ',
      '3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 8 8 8 9 9 10 10 J J Q Q K K A A 2 2 BJ',
      '3 3 3 3 4 4 4 4 5 5 5 5 6 6 6 6 7 7 7 8 8 8 9 9 9 10 10 10 J Q K A 2',
      '7 7 7 8 8 8 9 9 9 10 10 10 J J J 3 3 4 4 5 5 6 6 Q Q K K A A 2 2 BJ RJ',
    ].map(cards);
    const rng = seededRng('perf');
    for (let i = 0; i < 10; i++) hands.push(randomHand(rng, 4, 33));
    findPlays(hands[0] as Card[], null, RULES_4P);
    for (const hand of hands) {
      const started = performance.now();
      const plays = findPlays(hand, null, RULES_4P);
      const elapsed = performance.now() - started;
      expect(plays.length).toBeGreaterThan(0);
      expect(elapsed, `hand [${key(hand)}] took ${elapsed.toFixed(1)} ms`).toBeLessThan(250);
    }
  });
});
