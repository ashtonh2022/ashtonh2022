# Engine public API (packages/engine/src/index.ts must export all of this)

All functions are pure. No globals, no Date.now(), no Math.random() (take an rng or seed).

## rules.ts
- `DEFAULT_RULES: RuleSettings` (3 players, kitty 3, call, force, doubling off, kittyBonus off, winner, chainsThroughTwos true, 30s)
- `kittySizeOptions(playerCount): number[]` → 3p: [3,6,9,12]; 4p: [4,8,12,16]
- `defaultKittySize(playerCount): number` → 3 / 8
- `normalizeRules(input: unknown): RuleSettings` → fills defaults, clamps turnSeconds to 5..120, snaps kittySize to a valid option (default if invalid), ignores unknown keys. Never throws.
- `cardsPerPlayer(rules): number`

## cards.ts
- `createDeck(playerCount): Card[]` (54 or 108 cards, deterministic order)
- `seededRng(seed: string): () => number` (xmur3 + mulberry32 or similar; deterministic)
- `shuffle<T>(items: T[], rng: () => number): T[]` (Fisher–Yates, returns new array)
- `sortCards(cards): Card[]` (descending rank, then suit order S,H,D,C,J, then deck) – the display order
- `rankLabel(rank): string` → '3'..'10','J','Q','K','A','2','BJ','RJ'
- `cardLabel(card): string` e.g. '10♠', 'A♥', 'Black Joker', 'Red Joker'
- `isJoker(card)`, `isRedJoker(card)`, `isBlackJoker(card)`
- `cardById(cards, id)`, `removeCards(hand, cards)`

## combos.ts
- `analyze(cards: Card[], rules: RuleSettings): Combo | null` – classify a set of cards (any order) or null if not a legal combination under these rules. Ambiguity resolution per RULES.md (longest plain airplane > airplane+pairs > airplane+singles; 6+ of a kind in 4p is a bomb, not four+two).
- `analyzeAs(cards, rules, target: Combo): Combo | null` – prefer the interpretation that has the same type and length as `target` (so `333 444 555 666` answers an airplane_single of length 3), otherwise fall back to `analyze`.
- `beats(candidate: Combo, current: Combo, rules): boolean` – per RULES.md, including 4p bomb/rocket tiers.
- `bombStrength(combo, rules): number` – monotone score comparable across bombs and rockets (used by beats).
- `comboName(combo): string` – English display name, e.g. 'Airplane with pairs', 'Bomb', 'Rocket', 'Straight (5)'.
- `chainRanks(rules): Rank[]` – ranks that may appear in chains in order (3..14, or 3..17 when chainsThroughTwos).

## plays.ts
- `findPlays(hand: Card[], current: Combo | null, rules: RuleSettings): Combo[]` – every legal answer to `current` (or every distinct leadable combo when current is null), deduplicated by rank-structure (cards of equal rank are interchangeable, jokers of equal colour too), sorted weakest first, bombs/rockets last. Must be fast enough for 33-card hands (< 50 ms typical).
- `hint(hand, current, rules): Combo | null` – suggestion: when answering, the weakest legal non-bomb answer, else the weakest bomb; when leading, the weakest combo from `decompose(hand)` that is not a bomb (prefer combos that consume more cards of low rank), never null if the hand is non-empty.
- `decompose(hand, rules): Combo[]` – a greedy split of a hand into few strong combos (bombs/rockets kept whole, airplanes, chains, triples with kickers, pairs, singles). Used by hint and bot.
- `lowestSingle(hand): Combo`

## hand.ts (the state machine)
- `createHand(opts: { rules; seed; handNumber; firstBidder }): HandState` – deals, phase 'bidding', turn = firstBidder.
- `applyAction(state, seat, action): ApplyResult` – immutable; returns new state + events. Implements bidding (both modes incl. force/redeal, rob round and rob-back), doubling round, play/pass rules, trick resolution, end of hand and settlement.
- `legalActions(state, seat): LegalActions`
- `viewHand(state, seat: number | null): HandView` – hides other hands and the face-down kitty; hides other players' doubling choices until the round ends.
- `timeoutAction(state, seat): HandAction` – what the server applies for a human on timeout (pass / keep / pass or lowest single when leading; call when forced last bidder).
- `nextFirstBidder(rules, previous: HandState | null, rng): number`

## scoring.ts
- `kittyBonusMultiplier(kitty: Card[], rules): number`
- `settle(state: HandState): HandResult` – per RULES.md.
- `currentStake(state): number` – base × 2^robs × 2^bombs × kittyBonus (no spring, no doubles), for display.

## bot.ts
- `botBid(state: HandState, seat): BidAction` – hand-strength heuristic (bombs, rockets, 2s, jokers, count of combos in decomposition).
- `botDouble(state, seat): boolean`
- `botPlay(state, seat): HandAction` – heuristic: never beats a partner (peasant) needlessly when partner is winning the trick unless landlord is close to going out; plays weakest beating combo; leads from decomposition, smallest first; uses bombs when the landlord/opponent has <= 2 cards or to win; if it can go out in one play, does.
- `botAction(state, seat): HandAction` – dispatches on phase.

## index.ts
Re-export everything above plus all types and `RANK`.
