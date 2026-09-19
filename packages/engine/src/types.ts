/**
 * Shared engine types. This file is the contract between the engine, the server and the web client.
 * Keep it dependency-free. Everything here is plain data (JSON-serialisable).
 * The rules these types encode are described in docs/RULES.md.
 */

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** 3..10 face value, J=11, Q=12, K=13, A=14, 2=15, Black Joker=16, Red Joker=17 */
export type Rank = 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17;

export const RANK = {
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
  SIX: 6,
  SEVEN: 7,
  EIGHT: 8,
  NINE: 9,
  TEN: 10,
  JACK: 11,
  QUEEN: 12,
  KING: 13,
  ACE: 14,
  TWO: 15,
  BLACK_JOKER: 16,
  RED_JOKER: 17,
} as const satisfies Record<string, Rank>;

/** S=spades, H=hearts, D=diamonds, C=clubs, J=joker (jokers use rank 16/17 for colour) */
export type Suit = 'S' | 'H' | 'D' | 'C' | 'J';

export interface Card {
  /** Unique within a game: `${rank}-${suit}-${deck}` e.g. "14-S-0", "16-J-1" */
  id: string;
  rank: Rank;
  suit: Suit;
  /** 0 for the first deck, 1 for the second deck (4-player games only) */
  deck: 0 | 1;
}

// ---------------------------------------------------------------------------
// Rules / room options
// ---------------------------------------------------------------------------

export type PlayerCount = 3 | 4;
export type BiddingMode = 'call' | 'points';
export type AllPassRule = 'force' | 'redeal';
export type FirstBidderRule = 'winner' | 'rotate' | 'random';

export interface RuleSettings {
  playerCount: PlayerCount;
  /** Must be one of kittySizeOptions(playerCount). Default 3 (3p) / 8 (4p). */
  kittySize: number;
  /** 'call' = Call / Rob (default). 'points' = bid 1/2/3. */
  biddingMode: BiddingMode;
  /** What happens when everybody passes. Default 'force'. */
  allPass: AllPassRule;
  /** Doubling round after the kitty is revealed. Default false. */
  doublingRound: boolean;
  /** Kitty bonus multipliers. Default false. */
  kittyBonus: boolean;
  /** Who bids first on later hands. Default 'winner'. */
  firstBidder: FirstBidderRule;
  /** Chains (straights, pair chains, airplanes) may run past A through 2 and the jokers. Default true. */
  chainsThroughTwos: boolean;
  /** Seconds per decision, 5..120. Default 30. */
  turnSeconds: number;
}

// ---------------------------------------------------------------------------
// Combinations
// ---------------------------------------------------------------------------

export type ComboType =
  | 'single'
  | 'pair'
  | 'triple'
  | 'triple_single'
  | 'triple_pair'
  | 'straight'
  | 'pair_chain'
  | 'airplane'
  | 'airplane_single'
  | 'airplane_pair'
  | 'four_two_single'
  | 'four_two_pair'
  | 'bomb'
  | 'rocket';

export interface Combo {
  type: ComboType;
  /** The exact cards, in the order they should be displayed (chain/main cards first, kickers last). */
  cards: Card[];
  /**
   * Rank used for comparison: the card for a single, the pair/triple/four rank for those types,
   * the highest rank of the chain for chains, the bomb rank for bombs. For rockets: 17.
   */
  rank: Rank;
  /**
   * Chain length in units: number of cards in a straight, pairs in a pair chain, triples in an airplane
   * (with or without kickers). 1 for everything else.
   */
  length: number;
  /**
   * For bombs: number of same-rank cards (4..8). For rockets: number of jokers (2..4). Otherwise cards.length.
   */
  size: number;
}

// ---------------------------------------------------------------------------
// Hand (one deal) state machine
// ---------------------------------------------------------------------------

export type Phase = 'bidding' | 'doubling' | 'playing' | 'finished' | 'redeal';

export type BidAction =
  | { type: 'call' }
  | { type: 'rob' }
  | { type: 'pass_bid' }
  | { type: 'bid'; value: 1 | 2 | 3 };

export type HandAction =
  | BidAction
  | { type: 'double'; double: boolean }
  | { type: 'play'; cardIds: string[] }
  | { type: 'pass' };

export interface BidRecord {
  seat: number;
  action: 'call' | 'rob' | 'pass' | 'bid';
  /** points mode only */
  value?: 1 | 2 | 3;
}

export interface BiddingState {
  records: BidRecord[];
  /** Seat of the first caller (call mode) */
  caller: number | null;
  /** Seat currently holding the landlord claim (last call/rob, or highest bid) */
  claimant: number | null;
  /** Points mode: the current highest bid, 0 if none */
  highestBid: number;
  /** Call mode: number of robs so far (each doubles the stake) */
  robs: number;
  /** Seats that have passed (cannot rob later) */
  passed: boolean[];
  /** Seats that have acted in the rob round (call mode) */
  robDecided: boolean[];
  /** Call mode: true once the original caller has been offered the final rob-back */
  robBackOffered: boolean;
}

export interface TrickPlay {
  seat: number;
  /** null means the player passed */
  combo: Combo | null;
}

export interface TrickState {
  leader: number;
  plays: TrickPlay[];
  /** The combination currently to beat (null when the leader is yet to play) */
  current: Combo | null;
  /** Seat that played `current` */
  currentSeat: number | null;
}

export type SpringKind = 'spring' | 'anti_spring' | null;

export interface HandResult {
  winnerSide: 'landlord' | 'peasants';
  landlord: number;
  /** Seat that went out */
  winnerSeat: number;
  base: number;
  robs: number;
  bombs: number;
  spring: SpringKind;
  kittyBonus: number;
  /** stake after all shared multipliers (before doubles) */
  stake: number;
  /** per-seat doubling flags (false when doubling round is off) */
  doubled: boolean[];
  /** per-seat point change; sums to zero */
  amounts: number[];
}

export interface HandState {
  rules: RuleSettings;
  /** RNG seed used to shuffle; lets a hand be replayed */
  seed: string;
  /** Hand number within the room, starting at 1 */
  handNumber: number;
  phase: Phase;
  /** Per-seat hands (sorted descending by rank). Only the engine and server see all of them. */
  hands: Card[][];
  kitty: Card[];
  /** true once the kitty has been shown (landlord chosen) */
  kittyRevealed: boolean;
  firstBidder: number;
  /** Seat that must act now. -1 during the doubling phase (simultaneous) and when the hand is over. */
  turn: number;
  bidding: BiddingState;
  landlord: number | null;
  /** base stake: 1 in call mode, the winning bid in points mode */
  base: number;
  /** doubling round choices; null = not decided yet. All false when the option is off. */
  doubles: (boolean | null)[];
  trick: TrickState;
  /** Every play and pass of the hand in order, with trick numbers for display */
  history: Array<TrickPlay & { trickNumber: number }>;
  /** Number of combos (not passes) each seat has played */
  playCounts: number[];
  bombsPlayed: number;
  result: HandResult | null;
}

/** What one seat (or a spectator, seat = null) is allowed to see. */
export interface HandView {
  rules: RuleSettings;
  handNumber: number;
  phase: Phase;
  /** null for spectators */
  seat: number | null;
  /** your cards, sorted (empty for spectators) */
  hand: Card[];
  cardCounts: number[];
  /** revealed kitty, or null while face down */
  kitty: Card[] | null;
  kittySize: number;
  firstBidder: number;
  turn: number;
  bidding: BiddingState;
  landlord: number | null;
  base: number;
  /** null while undecided; own choice visible immediately, others revealed when the round ends */
  doubles: (boolean | null)[];
  trick: TrickState;
  history: Array<TrickPlay & { trickNumber: number }>;
  playCounts: number[];
  bombsPlayed: number;
  /** current stake including robs and bombs so far (for display) */
  currentStake: number;
  result: HandResult | null;
  /** Actions this viewer may take right now */
  legal: LegalActions;
}

export interface LegalActions {
  canCall: boolean;
  canRob: boolean;
  canPassBid: boolean;
  /** points mode: bids currently allowed */
  bids: Array<1 | 2 | 3>;
  canDouble: boolean;
  canPlay: boolean;
  canPass: boolean;
}

export type HandEvent =
  | { type: 'bid'; seat: number; record: BidRecord }
  | { type: 'landlord_chosen'; seat: number; base: number; kitty: Card[] }
  | { type: 'redeal' }
  | { type: 'doubling_started' }
  | { type: 'double'; seat: number; double: boolean }
  | { type: 'doubling_finished'; doubles: boolean[] }
  | { type: 'play'; seat: number; combo: Combo }
  | { type: 'pass'; seat: number }
  | { type: 'trick_won'; seat: number }
  | { type: 'hand_finished'; result: HandResult };

export type ApplyResult =
  | { ok: true; state: HandState; events: HandEvent[] }
  | { ok: false; error: string; code: EngineErrorCode };

export type EngineErrorCode =
  | 'not_your_turn'
  | 'wrong_phase'
  | 'invalid_action'
  | 'cards_not_in_hand'
  | 'invalid_combo'
  | 'does_not_beat'
  | 'cannot_pass';
