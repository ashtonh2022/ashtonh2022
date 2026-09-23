import type { Card, HandResult, HandState, Rank, RuleSettings, SpringKind } from './types';
import { RANK } from './types';
import { chainRanks } from './combos';

/** True when the cards are distinct ranks that run consecutively in the room's chain order. */
function isRun(cards: readonly Card[], rules: RuleSettings): boolean {
  const chain = chainRanks(rules);
  const positions = cards.map((card) => chain.indexOf(card.rank)).sort((a, b) => a - b);
  if (positions.some((position) => position < 0)) return false;
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] !== (positions[i - 1] as number) + 1) return false;
  }
  return true;
}

/**
 * Multiplier the revealed kitty adds to the stake (docs/RULES.md "Kitty bonus"). Only the highest
 * applicable bonus counts; 1 when the option is off or nothing applies.
 */
export function kittyBonusMultiplier(kitty: Card[], rules: RuleSettings): number {
  if (!rules.kittyBonus || kitty.length === 0) return 1;
  const counts = new Map<Rank, number>();
  let reds = 0;
  let blacks = 0;
  for (const card of kitty) {
    counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
    if (card.rank === RANK.RED_JOKER) reds++;
    else if (card.rank === RANK.BLACK_JOKER) blacks++;
  }
  let best = 1;
  if (reds > 0 && blacks > 0) best = 3;
  if ([...counts.values()].some((count) => count >= 3)) best = 3;
  if (kitty.length >= 3 && isRun(kitty, rules)) {
    const firstSuit = (kitty[0] as Card).suit;
    const sameSuit = kitty.every((card) => card.suit === firstSuit);
    best = Math.max(best, sameSuit ? 3 : 2);
  }
  if (reds + blacks === 1) best = Math.max(best, 2);
  return best;
}

/**
 * The stake as it stands right now, for display: base × 2 per rob × 2 per bomb × kitty bonus.
 * The kitty bonus only counts once the kitty has been revealed (it would leak the kitty before).
 * Spring and doubles are not included.
 */
export function currentStake(state: HandState): number {
  const bonus = state.kittyRevealed ? kittyBonusMultiplier(state.kitty, state.rules) : 1;
  return state.base * 2 ** state.bidding.robs * 2 ** state.bombsPlayed * bonus;
}

/**
 * Settles a hand in which one seat has emptied their hand (docs/RULES.md "Scoring").
 * Throws when the hand has no landlord or nobody has gone out yet.
 */
export function settle(state: HandState): HandResult {
  const landlord = state.landlord;
  if (landlord === null) throw new Error('settle: the hand has no landlord');
  const winnerSeat = state.hands.findIndex((hand) => hand.length === 0);
  if (winnerSeat < 0) throw new Error('settle: nobody has gone out yet');

  const seatCount = state.rules.playerCount;
  const peasants: number[] = [];
  for (let seat = 0; seat < seatCount; seat++) if (seat !== landlord) peasants.push(seat);
  const winnerSide = winnerSeat === landlord ? 'landlord' : 'peasants';

  let spring: SpringKind = null;
  if (winnerSide === 'landlord' && peasants.every((seat) => (state.playCounts[seat] ?? 0) === 0)) {
    spring = 'spring';
  } else if (winnerSide === 'peasants' && state.playCounts[landlord] === 1) {
    spring = 'anti_spring';
  }

  const base = state.base;
  const robs = state.bidding.robs;
  const bombs = state.bombsPlayed;
  const kittyBonus = kittyBonusMultiplier(state.kitty, state.rules);
  const stake = base * 2 ** robs * 2 ** bombs * (spring === null ? 1 : 2) * kittyBonus;
  const doubled = state.doubles.map((choice) => choice === true);

  const amounts: number[] = new Array<number>(seatCount).fill(0);
  let landlordTotal = 0;
  for (const seat of peasants) {
    let amount = stake;
    if (doubled[landlord]) amount *= 2;
    if (doubled[seat]) amount *= 2;
    amounts[seat] = winnerSide === 'landlord' ? -amount : amount;
    landlordTotal += amount;
  }
  amounts[landlord] = winnerSide === 'landlord' ? landlordTotal : -landlordTotal;

  return {
    winnerSide,
    landlord,
    winnerSeat,
    base,
    robs,
    bombs,
    spring,
    kittyBonus,
    stake,
    doubled,
    amounts,
  };
}
