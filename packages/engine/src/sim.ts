import type { HandAction, HandEvent, HandState, RuleSettings } from './types';
import { seededRng } from './cards';
import { applyAction, createHand, nextFirstBidder } from './hand';
import { botAction } from './bot';

export interface SimulateOptions {
  rules: RuleSettings;
  seed: string;
  /** Defaults to seat 0. */
  firstBidder?: number;
  /** Defaults to 1. */
  handNumber?: number;
  /** Who decides for a seat; defaults to `botAction`. Every action must be legal. */
  actor?: (state: HandState, seat: number) => HandAction;
}

export interface SimulationResult {
  /** The finished hand (the last deal when there were redeals). */
  state: HandState;
  /** Every event of every deal, in order. */
  events: HandEvent[];
  /** Number of actions applied across all deals. */
  steps: number;
  /** Number of deals thrown in because everyone passed. */
  redeals: number;
  /** Seeds of every deal, the last one being the finished hand's. */
  seeds: string[];
}

export interface SimulationSummary {
  hands: number;
  landlordWins: number;
  landlordWinRate: number;
  averageSteps: number;
  springs: number;
  antiSprings: number;
  redeals: number;
  bombs: number;
  results: SimulationResult[];
}

const MAX_REDEALS = 100;
const MAX_STEPS_PER_DEAL = 2000;

/** Seats that must act now: everyone still undecided in the doubling round, else the seat on turn. */
function actors(state: HandState): number[] {
  if (state.phase === 'doubling') {
    const seats: number[] = [];
    state.doubles.forEach((choice, seat) => {
      if (choice === null) seats.push(seat);
    });
    return seats;
  }
  return [state.turn];
}

/**
 * Plays one hand from the deal to the settlement with bots in every seat. A deal in which
 * everyone passes is redealt with the seed suffixed by the redeal number (`seed-1`, `seed-2`, ...).
 * Throws when the engine rejects a bot action, which is a bug in the bot or the engine.
 */
export function simulateHand(opts: SimulateOptions): SimulationResult {
  const { rules, seed } = opts;
  const actor = opts.actor ?? botAction;
  let firstBidder = opts.firstBidder ?? 0;
  const handNumber = opts.handNumber ?? 1;
  const events: HandEvent[] = [];
  const seeds: string[] = [];
  let steps = 0;
  let redeals = 0;
  let state = createHand({ rules, seed, handNumber, firstBidder });
  seeds.push(seed);

  for (;;) {
    let dealSteps = 0;
    while (state.phase !== 'finished' && state.phase !== 'redeal') {
      for (const seat of actors(state)) {
        const action = actor(state, seat);
        const result = applyAction(state, seat, action);
        if (!result.ok) {
          throw new Error(
            `action rejected (seed ${state.seed}, seat ${seat}, ${JSON.stringify(action)}): ` +
              `${result.code}: ${result.error}`,
          );
        }
        state = result.state;
        events.push(...result.events);
        steps++;
        dealSteps++;
        if (state.phase === 'finished' || state.phase === 'redeal') break;
      }
      if (dealSteps > MAX_STEPS_PER_DEAL) {
        throw new Error(`hand ${state.seed} did not finish within ${MAX_STEPS_PER_DEAL} steps`);
      }
    }
    if (state.phase === 'finished') return { state, events, steps, redeals, seeds };
    redeals++;
    if (redeals > MAX_REDEALS) throw new Error(`hand ${seed} was redealt ${MAX_REDEALS} times`);
    const nextSeed = `${seed}-${redeals}`;
    firstBidder = nextFirstBidder(rules, state, seededRng(nextSeed));
    state = createHand({ rules, seed: nextSeed, handNumber, firstBidder });
    seeds.push(nextSeed);
  }
}

/**
 * Plays `count` hands, cycling through `rulesVariants` (seed `${baseSeed}-${i}`, first bidder
 * rotating), and summarises them. Every result is kept for closer inspection.
 */
export function simulateMany(
  count: number,
  baseSeed: string,
  rulesVariants: RuleSettings[],
): SimulationSummary {
  if (rulesVariants.length === 0) throw new Error('simulateMany needs at least one rules variant');
  const results: SimulationResult[] = [];
  let landlordWins = 0;
  let springs = 0;
  let antiSprings = 0;
  let redeals = 0;
  let bombs = 0;
  let totalSteps = 0;
  for (let i = 0; i < count; i++) {
    const rules = rulesVariants[i % rulesVariants.length] as RuleSettings;
    const result = simulateHand({
      rules,
      seed: `${baseSeed}-${i}`,
      firstBidder: i % rules.playerCount,
      handNumber: i + 1,
    });
    results.push(result);
    const outcome = result.state.result;
    if (outcome !== null) {
      if (outcome.winnerSide === 'landlord') landlordWins++;
      if (outcome.spring === 'spring') springs++;
      if (outcome.spring === 'anti_spring') antiSprings++;
      bombs += outcome.bombs;
    }
    redeals += result.redeals;
    totalSteps += result.steps;
  }
  return {
    hands: count,
    landlordWins,
    landlordWinRate: count === 0 ? 0 : landlordWins / count,
    averageSteps: count === 0 ? 0 : totalSteps / count,
    springs,
    antiSprings,
    redeals,
    bombs,
    results,
  };
}
