import type { AllPassRule, BiddingMode, FirstBidderRule, PlayerCount, RuleSettings } from './types';

/** The room options a freshly created room starts with (see docs/RULES.md). */
export const DEFAULT_RULES: RuleSettings = {
  playerCount: 3,
  kittySize: 3,
  biddingMode: 'call',
  allPass: 'force',
  doublingRound: false,
  kittyBonus: false,
  firstBidder: 'winner',
  chainsThroughTwos: true,
  turnSeconds: 30,
};

export const MIN_TURN_SECONDS = 5;
export const MAX_TURN_SECONDS = 120;

/** Kitty sizes the host may pick for a player count. */
export function kittySizeOptions(playerCount: PlayerCount): number[] {
  return playerCount === 4 ? [4, 8, 12, 16] : [3, 6, 9, 12];
}

export function defaultKittySize(playerCount: PlayerCount): number {
  return playerCount === 4 ? 8 : 3;
}

/** Number of cards dealt to each player (the kitty is dealt separately). */
export function cardsPerPlayer(rules: RuleSettings): number {
  const deckSize = rules.playerCount === 4 ? 108 : 54;
  return (deckSize - rules.kittySize) / rules.playerCount;
}

function pickOneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Turns untrusted input (a client message, a stored room, garbage) into valid rule settings.
 * Unknown keys are dropped, missing or invalid values fall back to the defaults, turnSeconds is
 * clamped and kittySize must be one of the options for the player count. Never throws.
 */
export function normalizeRules(input: unknown): RuleSettings {
  try {
    return normalizeRulesUnsafe(input);
  } catch {
    // Only reachable with hostile objects (e.g. throwing getters); garbage never gets this far.
    return { ...DEFAULT_RULES };
  }
}

function normalizeRulesUnsafe(input: unknown): RuleSettings {
  const source: Record<string, unknown> =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  const playerCount: PlayerCount = source['playerCount'] === 4 ? 4 : 3;

  const rawKitty = source['kittySize'];
  const kittySize =
    typeof rawKitty === 'number' && kittySizeOptions(playerCount).includes(rawKitty)
      ? rawKitty
      : defaultKittySize(playerCount);

  const rawSeconds = source['turnSeconds'];
  const turnSeconds =
    typeof rawSeconds === 'number' && Number.isFinite(rawSeconds)
      ? Math.min(MAX_TURN_SECONDS, Math.max(MIN_TURN_SECONDS, rawSeconds))
      : DEFAULT_RULES.turnSeconds;

  return {
    playerCount,
    kittySize,
    biddingMode: pickOneOf<BiddingMode>(
      source['biddingMode'],
      ['call', 'points'],
      DEFAULT_RULES.biddingMode,
    ),
    allPass: pickOneOf<AllPassRule>(source['allPass'], ['force', 'redeal'], DEFAULT_RULES.allPass),
    doublingRound: pickBoolean(source['doublingRound'], DEFAULT_RULES.doublingRound),
    kittyBonus: pickBoolean(source['kittyBonus'], DEFAULT_RULES.kittyBonus),
    firstBidder: pickOneOf<FirstBidderRule>(
      source['firstBidder'],
      ['winner', 'rotate', 'random'],
      DEFAULT_RULES.firstBidder,
    ),
    chainsThroughTwos: pickBoolean(source['chainsThroughTwos'], DEFAULT_RULES.chainsThroughTwos),
    turnSeconds,
  };
}
