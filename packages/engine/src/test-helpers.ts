/**
 * Helpers for the engine's own tests. Not exported from the package.
 */
import type {
  ApplyResult,
  Card,
  Combo,
  HandAction,
  HandEvent,
  HandState,
  Rank,
  RuleSettings,
  Suit,
} from './types';
import { makeCard } from './cards';
import { DEFAULT_RULES } from './rules';
import { rankKey } from './cardGroups';
import { applyAction, createHand } from './hand';

const LABEL_TO_RANK: Record<string, Rank> = {
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '10': 10,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
  '2': 15,
  BJ: 16,
  RJ: 17,
};

const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'];

/**
 * Parse a hand such as '3 3 3 4 BJ RJ' into cards. Copies of a rank get suits S H D C from deck 0
 * and then deck 1, so up to 8 copies of a rank and 2 of each joker can be spelled out.
 */
export function cards(spec: string): Card[] {
  const seen = new Map<Rank, number>();
  return spec
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => {
      const rank = LABEL_TO_RANK[token];
      if (rank === undefined) throw new Error(`unknown card token "${token}"`);
      const index = seen.get(rank) ?? 0;
      seen.set(rank, index + 1);
      if (rank >= 16) {
        if (index > 1) throw new Error(`too many copies of ${token}`);
        return makeCard(rank, 'J', index === 0 ? 0 : 1);
      }
      if (index > 7) throw new Error(`too many copies of ${token}`);
      return makeCard(rank, SUITS[index % 4] as Suit, index < 4 ? 0 : 1);
    });
}

export const RULES_3P: RuleSettings = { ...DEFAULT_RULES };
export const RULES_4P: RuleSettings = { ...DEFAULT_RULES, playerCount: 4, kittySize: 8 };

export function withoutTwos(rules: RuleSettings): RuleSettings {
  return { ...rules, chainsThroughTwos: false };
}

/** Rank-structure identity of a set of cards (ascending ranks joined by commas). */
export function key(set: readonly Card[]): string {
  return rankKey(set);
}

/** The part of a combo that tests compare. */
export function shape(combo: Combo | null): {
  type: string;
  rank: number;
  length: number;
  size: number;
} | null {
  return combo === null
    ? null
    : { type: combo.type, rank: combo.rank, length: combo.length, size: combo.size };
}

// ---------------------------------------------------------------------------
// Hand-state builders for the state machine, scoring, bot and simulation tests
// ---------------------------------------------------------------------------

/** Hands spelled out per seat, with card ids unique across all of them. */
export function dealSpecs(specs: string[]): Card[][] {
  const all = cards(specs.join(' '));
  const hands: Card[][] = [];
  let offset = 0;
  for (const spec of specs) {
    const count = spec
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0).length;
    hands.push(all.slice(offset, offset + count));
    offset += count;
  }
  return hands;
}

export interface PlayingStateOptions {
  rules?: RuleSettings;
  /** One spec per seat; the kitty (if any) may be appended as the last spec. */
  hands: string[];
  landlord: number;
  /** Who leads the current trick (defaults to the landlord). */
  leader?: number;
  kitty?: string;
}

/**
 * A hand in the playing phase with exactly these cards (the kitty is only recorded, not added to
 * anyone's hand). Everything else is as a freshly dealt and bid hand would have it.
 */
export function playingState(opts: PlayingStateOptions): HandState {
  const rules = opts.rules ?? (opts.hands.length === 4 ? RULES_4P : RULES_3P);
  const specs = opts.kitty === undefined ? opts.hands : [...opts.hands, opts.kitty];
  const dealt = dealSpecs(specs);
  const hands = dealt.slice(0, opts.hands.length);
  const kitty = opts.kitty === undefined ? [] : (dealt[opts.hands.length] ?? []);
  const leader = opts.leader ?? opts.landlord;
  const base = createHand({ rules, seed: 'scripted', handNumber: 1, firstBidder: opts.landlord });
  return {
    ...base,
    phase: 'playing',
    hands,
    kitty,
    kittyRevealed: true,
    turn: leader,
    landlord: opts.landlord,
    bidding: {
      ...base.bidding,
      records: [{ seat: opts.landlord, action: 'call' }],
      caller: opts.landlord,
      claimant: opts.landlord,
    },
    trick: { leader, plays: [], current: null, currentSeat: null },
  };
}

/** Cards of the hand matching the spec's ranks (first unused card of each rank), as a play. */
export function play(spec: string, hand: Card[]): HandAction {
  const used = new Set<string>();
  const cardIds: string[] = [];
  for (const wanted of cards(spec)) {
    const card = hand.find(
      (candidate) => candidate.rank === wanted.rank && !used.has(candidate.id),
    );
    if (card === undefined) throw new Error(`no unused ${wanted.rank} in the hand for "${spec}"`);
    used.add(card.id);
    cardIds.push(card.id);
  }
  return { type: 'play', cardIds };
}

export const PASS: HandAction = { type: 'pass' };

/** Applies one action that must succeed. */
export function step(
  state: HandState,
  seat: number,
  action: HandAction,
): { state: HandState; events: HandEvent[] } {
  const result = applyAction(state, seat, action);
  if (!result.ok) {
    throw new Error(
      `seat ${seat} ${JSON.stringify(action)} rejected: ${result.code} ${result.error}`,
    );
  }
  return { state: result.state, events: result.events };
}

/** Applies a scripted sequence of actions that must all succeed, collecting every event. */
export function run(
  state: HandState,
  moves: Array<[seat: number, action: HandAction]>,
): { state: HandState; events: HandEvent[] } {
  const events: HandEvent[] = [];
  let current = state;
  for (const [seat, action] of moves) {
    const next = step(current, seat, action);
    current = next.state;
    events.push(...next.events);
  }
  return { state: current, events };
}

export function rejection(result: ApplyResult): string | null {
  return result.ok ? null : result.code;
}

/** Freezes an object graph so any mutation by the reducer throws (modules are strict). */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
