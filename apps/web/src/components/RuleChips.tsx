import type { RuleSettings } from '@landlord/engine';

import { fmt } from '../lib/format';
import { strings } from '../strings';

export function ruleChips(rules: RuleSettings): string[] {
  return [
    fmt(strings.chipPlayers, { n: rules.playerCount }),
    fmt(strings.chipKitty, { n: rules.kittySize }),
    rules.biddingMode === 'call' ? strings.chipBiddingCall : strings.chipBiddingPoints,
    rules.allPass === 'force' ? strings.chipAllPassForce : strings.chipAllPassRedeal,
    ...(rules.doublingRound ? [strings.chipDoubling] : []),
    ...(rules.kittyBonus ? [strings.chipKittyBonus] : []),
    rules.firstBidder === 'winner'
      ? strings.chipFirstBidderWinner
      : rules.firstBidder === 'rotate'
        ? strings.chipFirstBidderRotate
        : strings.chipFirstBidderRandom,
    rules.chainsThroughTwos ? strings.chipChains : strings.chipChainsOff,
    fmt(strings.chipTimer, { n: rules.turnSeconds }),
  ];
}

export function RuleChips({ rules }: { rules: RuleSettings }) {
  return (
    <ul className="chips" aria-label={strings.rulesTitle}>
      {ruleChips(rules).map((chip) => (
        <li key={chip} className="chip">
          {chip}
        </li>
      ))}
    </ul>
  );
}
