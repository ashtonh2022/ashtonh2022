# Landlord: Rules

Landlord is the card game Dou Dizhu (斗地主, "Fight the Landlord"). One player, the **Landlord**, plays alone against the other players, the **Peasants**, who play as a team. The first player to empty their hand wins the hand for their side.

This page is the single source of truth for the rules the game enforces. Sections marked **Room option** can be changed by the host before a room starts. Defaults are shown in bold.

## Players and cards

| | 3 players (**default**) | 4 players |
|---|---|---|
| Decks | 1 deck, 54 cards (52 + black joker + red joker) | 2 decks, 108 cards (2 black jokers, 2 red jokers) |
| Sides | 1 Landlord vs 2 Peasants | 1 Landlord vs 3 Peasants |
| Kitty (face-down cards for the Landlord) | **3** (options: 3, 6, 9, 12) | **8** (options: 4, 8, 12, 16) |
| Cards each | 17 with a 3-card kitty | 25 with an 8-card kitty |

**Room option: Player count** (3 or 4) and **Kitty size** (a slider; the remaining cards always divide evenly).

Suits never matter. Card ranks from lowest to highest:

`3 4 5 6 7 8 9 10 J Q K A 2 Black Joker Red Joker`

Internally ranks are numbered 3 to 17: 3 to 10 are their face value, J = 11, Q = 12, K = 13, A = 14, 2 = 15, Black Joker = 16, Red Joker = 17.

## Jokers

- A red joker and a black joker played together are a **Rocket**, the strongest play. They are never played together in any other way (never as a pair, never as kickers).
- In 4-player games, two jokers of the **same colour** are an ordinary **pair** (a pair of black jokers ranks 16, a pair of red jokers ranks 17). Same-colour joker pairs can be used anywhere a pair is legal, including as kickers.
- A single joker is an ordinary single card of rank 16 or 17 and can be used as a single kicker.

## Flow of a hand

1. **Deal.** The deck is shuffled. Each player receives an equal hand. The kitty stays face down.
2. **Bidding.** Players decide who becomes the Landlord (see Bidding).
3. **Kitty.** The kitty is revealed to everyone and added to the Landlord's hand.
4. **Doubling round** (only if the room option is on).
5. **Play.** The Landlord leads the first trick. Play continues until one player has no cards left.
6. **Scoring.** Points are settled between the Landlord and each Peasant, and the room's running score is updated.

## Bidding

**Room option: Bidding style.**

### Call (**default**)

Players are asked in turn, starting with the first bidder: **Call** (yes, I'll be the Landlord) or **Pass**.

- Once someone calls, each remaining player in turn who has not already passed may **Rob** (take the Landlord seat) or pass. Every rob doubles the stake.
- If anyone robbed, the original caller gets one final chance to rob back (this also doubles the stake).
- The last player to call or rob is the Landlord.
- A player who passes cannot rob later.

The stake starts at 1 and doubles with each rob.

### Points

Each player in turn bids **1**, **2** or **3** points, or passes. A bid must be higher than the current bid. A bid of 3 ends the bidding at once. Each player bids at most once. The highest bidder is the Landlord and the stake starts at the winning bid.

### Everyone passes

**Room option: If everyone passes.**

- **Force** (**default**): the last player in the bidding order becomes the Landlord with a stake of 1. (In practice, if everyone before them passed, that player is simply made Landlord.)
- **Redeal**: the cards are reshuffled and dealt again, and the player after the previous first bidder starts the new bidding.

### Who bids first

**Room option: First bidder.**

- **Previous winner** (**default**): the first hand picks a random player. After that, the player who went out first in the previous hand bids first. If a hand was redealt, the player after the previous first bidder starts.
- **Rotate**: the first bidder moves one seat clockwise every hand.
- **Random**: a random player every hand.

## Doubling round

**Room option: Doubling round** (**off** by default).

After the kitty is revealed, every player secretly chooses **Double** or **Keep** before the timer runs out.

- A Peasant who doubles doubles their own settlement with the Landlord.
- If the Landlord doubles, every settlement doubles.

## Kitty bonus

**Room option: Kitty bonus** (**off** by default). When on, the revealed kitty can multiply the stake for the whole hand. Only the highest applicable bonus applies.

| Kitty contains | Multiplier |
|---|---|
| At least one red joker and at least one black joker | x3 |
| Three or more cards of the same rank | x3 |
| All kitty cards form a run of consecutive ranks (3 or more cards) and are all the same suit | x3 |
| All kitty cards form a run of consecutive ranks (3 or more cards) | x2 |
| Exactly one joker | x2 |

## Play

The Landlord leads the first trick by playing any legal combination. Then, going clockwise:

- Each player must either **beat** the current combination or **pass**.
- To beat a combination you must play the **same type** with the **same number of cards** and a **higher rank**, or play a Bomb or Rocket (see Bombs).
- A player who leads a trick cannot pass.
- Passing does not lock you out. If the trick comes back around to you, you may play again.
- When every other player has passed in a row, the trick ends and the last player who played leads the next trick with any combination.
- The hand ends the moment a player plays their last card.

The Landlord wins if the Landlord goes out first. The Peasants win together if any Peasant goes out first.

## Combinations

"Rank" below is the rank used to compare two combinations of the same type. Kicker cards never affect the comparison.

| Combination | Cards | Rank used to compare | Notes |
|---|---|---|---|
| Single | 1 | the card | |
| Pair | 2 of the same rank | the pair | |
| Triple | 3 of the same rank | the triple | |
| Triple + single | 3 + 1 | the triple | Kicker: any single card |
| Triple + pair | 3 + 2 | the triple | Kicker: any pair |
| Straight | 5 or more consecutive singles | highest card | Same length only |
| Pair chain | 3 or more consecutive pairs | highest pair | Same length only |
| Airplane | 2 or more consecutive triples | highest triple | Same length only |
| Airplane + singles | n consecutive triples + n single kickers | highest triple | Same length only. The kickers may be any cards, including cards that happen to form a pair |
| Airplane + pairs | n consecutive triples + n pair kickers | highest triple | Same length only |
| Four + two singles | 4 of the same rank + 2 single kickers | the four | Not a bomb. The two kickers may form a pair |
| Four + two pairs | 4 of the same rank + 2 pair kickers | the four | Not a bomb |
| Bomb | 4 of the same rank (4 to 8 in 4-player games) | see Bombs | Beats every non-bomb combination |
| Rocket | Red joker + black joker | see Bombs | In 4-player games, 3 or 4 jokers are also Rockets |

Rules for chains (straights, pair chains and airplanes):

- **Room option: Chains may include 2s and jokers** (**on** by default). When on, the chain order continues past the Ace: `... Q K A 2 Black Joker Red Joker`. For example `J Q K A 2` and `K A 2 Black Joker Red Joker` are straights, and `A A 2 2 2 2 2 2`... is not a chain (a chain needs consecutive *different* ranks). When off, chains use `3` to `A` only, as in the standard game.
- Chains never wrap around from the Red Joker back to 3.
- A triple chain (airplane) with kickers must have exactly one kicker per triple, all singles or all pairs.
- Kickers may not include a red joker together with a black joker (that would split a Rocket).

When a set of cards could be read in more than one way (for example `333 444 555 666`, which is an airplane of four triples, or an airplane of three triples with `6 6 6` as single kickers), the game reads it as the longest plain airplane if possible, then as an airplane with pair kickers, then as an airplane with single kickers. When you are answering a combination, the game reads your cards as the type that would beat it if that reading is valid.

## Bombs

A Bomb or Rocket can be played on any combination, including a lower Bomb.

**3-player games:** a higher-ranked Bomb beats a lower-ranked Bomb. The Rocket beats everything.

**4-player games:** with two decks a Bomb is 4 to 8 cards of the same rank, and Rockets can have 2, 3 or 4 jokers (a 2-joker Rocket must be one red and one black). From weakest to strongest:

1. 4-card Bomb (higher rank wins between two)
2. Rocket of 2 jokers
3. 5-card Bomb
4. Rocket of 3 jokers
5. 6-card Bomb
6. 7-card Bomb
7. 8-card Bomb
8. Rocket of 4 jokers

A Bomb with more cards always beats a Bomb with fewer cards, whatever the ranks.

## Scoring

Every hand is settled in points between the Landlord and each Peasant separately.

```
stake  = base
       x 2 for every rob during bidding (Call style only)
       x 2 for every Bomb or Rocket played by anyone during the hand
       x 2 for a Spring or an Anti-spring
       x kitty bonus (if the option is on)

per Peasant:
amount = stake
       x 2 if the Landlord doubled (doubling round only)
       x 2 if that Peasant doubled (doubling round only)
```

`base` is 1 in Call style, or the winning bid (1 to 3) in Points style.

- If the Landlord wins, each Peasant loses their `amount` and the Landlord gains the sum of all of them.
- If the Peasants win, each Peasant gains their `amount` and the Landlord loses the sum.

**Spring:** the Landlord wins and no Peasant ever played a card. **Anti-spring:** the Peasants win and the Landlord played only their opening lead.

The room keeps a running total across hands. There is no money involved.

## Turn timer

**Room option: Turn timer** (a slider from 5 to 120 seconds, **30** by default). Every decision (bid, double, play) must be made before the timer runs out. On timeout:

- Bidding: Pass (or Call, if that player is the forced last bidder).
- Doubling round: Keep.
- Play: Pass. If the player is leading the trick and cannot pass, the lowest single card is played.

## Bots and disconnects

Empty seats can be filled with bots from the lobby, so you can play with fewer than a full table of friends. If a player disconnects, their seat is held for them. A bot plays for them whenever their timer runs out, and they take back control the moment they reconnect.

## Rooms

Create a room from the home screen, choose the player count and options, and share the room link. Friends who open the link join the lobby. When every seat is filled (by people or bots) the host starts the hand. Extra people who join a full room watch as spectators and can take a seat when one opens up. Your running score belongs to you, not your seat: it follows you if you change seats, and it is kept if you leave and come back while the room lasts. The result of a hand counts for whoever was seated when it was dealt, even if they leave before it ends and a bot finishes it for them.
