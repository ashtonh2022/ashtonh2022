import { describe, expect, it } from 'vitest';

import * as engine from './index';

describe('engine index', () => {
  it('exposes a version', () => {
    expect(engine.ENGINE_VERSION).toBe('0.1.0');
  });

  it('exports the types module constants', () => {
    expect(engine.RANK.RED_JOKER).toBe(17);
    expect(engine.RANK.THREE).toBe(3);
  });

  it('exports every function from ENGINE_API.md plus the simulator', () => {
    const expected = [
      'DEFAULT_RULES',
      'kittySizeOptions',
      'defaultKittySize',
      'normalizeRules',
      'cardsPerPlayer',
      'createDeck',
      'seededRng',
      'shuffle',
      'sortCards',
      'rankLabel',
      'cardLabel',
      'isJoker',
      'isRedJoker',
      'isBlackJoker',
      'cardById',
      'removeCards',
      'analyze',
      'analyzeAs',
      'beats',
      'bombStrength',
      'comboName',
      'chainRanks',
      'findPlays',
      'hint',
      'decompose',
      'lowestSingle',
      'createHand',
      'applyAction',
      'legalActions',
      'viewHand',
      'timeoutAction',
      'nextFirstBidder',
      'kittyBonusMultiplier',
      'settle',
      'currentStake',
      'botBid',
      'botDouble',
      'botPlay',
      'botAction',
      'simulateHand',
      'simulateMany',
    ] as const;
    for (const name of expected) {
      expect(name in engine, `${name} is exported`).toBe(true);
    }
    expect(typeof engine.findPlays).toBe('function');
    expect(typeof engine.DEFAULT_RULES).toBe('object');
  });
});
