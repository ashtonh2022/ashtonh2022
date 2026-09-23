import {
  analyze,
  analyzeAs,
  beats,
  comboName,
  findPlays,
  hint,
  rankLabel,
  type Card,
  type Combo,
  type RuleSettings,
} from '@landlord/engine';

import { fmt } from './format';
import { strings } from '../strings';

/** "Pair of 8s", "Straight of 5 to 9", "Bomb of Ks", "Rocket"... */
export function describeCombo(combo: Combo): string {
  const rank = rankLabel(combo.rank);
  switch (combo.type) {
    case 'single':
      return fmt(strings.comboSingle, { rank });
    case 'pair':
      return fmt(strings.comboPair, { rank });
    case 'triple':
      return fmt(strings.comboTriple, { rank });
    case 'triple_single':
      return fmt(strings.comboTripleSingle, { rank });
    case 'triple_pair':
      return fmt(strings.comboTriplePair, { rank });
    case 'straight':
    case 'pair_chain':
    case 'airplane':
      return fmt(strings.comboChainTo, { name: comboName(combo), rank });
    case 'bomb':
      return fmt(strings.comboBomb, { rank });
    case 'rocket':
      return strings.comboRocket;
    default:
      return comboName(combo);
  }
}

export interface SelectionPreview {
  /** what to show above the hand; empty when nothing is selected */
  text: string;
  /** the selection is a combination that may be played right now */
  legal: boolean;
  combo: Combo | null;
}

/**
 * Classifies the selected cards against the combination to beat (null when leading) and gives
 * the one-line preview shown above the hand.
 */
export function previewSelection(
  selected: Card[],
  current: Combo | null,
  rules: RuleSettings,
): SelectionPreview {
  if (selected.length === 0) return { text: '', legal: false, combo: null };
  const combo = current ? analyzeAs(selected, rules, current) : analyze(selected, rules);
  if (!combo) return { text: strings.notValidPlay, legal: false, combo: null };
  if (current && !beats(combo, current, rules)) {
    return {
      text: fmt(strings.doesNotBeat, { combo: comboName(current) }),
      legal: false,
      combo,
    };
  }
  return { text: describeCombo(combo), legal: true, combo };
}

/**
 * Ranks that appear in at least one legal answer to `current`. Cards of the same rank are
 * interchangeable, so a card is playable exactly when its rank is in the set. Returns null when
 * leading (everything is playable).
 */
export function playableRanks(
  hand: Card[],
  current: Combo | null,
  rules: RuleSettings,
): Set<number> | null {
  if (current === null) return null;
  const ranks = new Set<number>();
  for (const play of findPlays(hand, current, rules)) {
    for (const card of play.cards) ranks.add(card.rank);
  }
  return ranks;
}

function sameCards(a: Combo, b: Combo): boolean {
  if (a.cards.length !== b.cards.length) return false;
  const ids = new Set(a.cards.map((card) => card.id));
  return b.cards.every((card) => ids.has(card.id));
}

/** The plays the Hint button cycles through: the engine's hint first, then every other play. */
export function hintCycle(hand: Card[], current: Combo | null, rules: RuleSettings): Combo[] {
  if (hand.length === 0) return [];
  const first = hint(hand, current, rules);
  const rest = findPlays(hand, current, rules);
  if (!first) return rest;
  return [first, ...rest.filter((play) => !sameCards(play, first))];
}
