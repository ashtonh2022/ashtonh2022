import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { NAME_MAX } from '@landlord/protocol';

import type { RandomSource } from './clock';
import type { Connection } from './connection';

/**
 * A person as the server knows them: an id the client shows around and a secret token that
 * proves ownership of that id. Both are minted on the first `hello` and kept by the client. The
 * token is derived from the id, so the server only keeps players somebody needs: connected ones
 * and room members. Anyone else is forgotten and comes back as the same player on their next
 * `hello` (scores are kept by id in the rooms).
 */
export interface Player {
  readonly id: string;
  readonly token: string;
  name: string;
  /** Code of the room the player is currently in, or null. */
  roomCode: string | null;
  /** Live sockets speaking for this player (a player may have several tabs open). */
  readonly connections: Set<Connection>;
  /** Epoch ms of recent chat and emote messages, for rate limiting. */
  readonly chatTimes: number[];
}

/**
 * Characters that draw nothing or reorder the text around them: controls (Cc), format characters
 * such as zero-width spaces and bidi overrides (Cf), line and paragraph separators (Zl, Zp) and
 * the Hangul fillers, which render as blanks.
 */
const INVISIBLE = '\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\u115f\\u1160\\u3164\\uffa0';
const VISIBLE = `[^\\s${INVISIBLE}]`;
/**
 * Removes every invisible character except the format characters visible text is spelled with:
 * an emoji tag sequence (a subdivision flag such as England's) is kept whole, and a zero-width
 * joiner or non-joiner is kept between two visible characters (emoji sequences such as the woman
 * technologist, the non-joiner in Persian and Indic words).
 */
const STRIP_INVISIBLE = new RegExp(
  `(\\u{1F3F4}[\\u{E0020}-\\u{E007E}]+\\u{E007F})|(?<=${VISIBLE})([\\u200c\\u200d])(?=${VISIBLE})|[${INVISIBLE}]`,
  'gu',
);

/**
 * Strips invisible characters, collapses whitespace, trims and cuts to NAME_MAX. Null when
 * nothing visible is left (the caller then keeps the old name or picks the default one).
 */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw
    .replace(
      STRIP_INVISIBLE,
      (_, tagSequence?: string, joiner?: string) => tagSequence ?? joiner ?? '',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return name.length > 0 ? name : null;
}

export interface PlayerRegistryOptions {
  random?: RandomSource;
}

export class PlayerRegistry {
  private readonly players = new Map<string, Player>();
  private readonly random: RandomSource;
  /** Signs player ids into tokens; new on every start, like the rooms themselves. */
  private readonly secret = randomBytes(32);

  constructor(options: PlayerRegistryOptions = {}) {
    this.random = options.random ?? Math.random;
  }

  get size(): number {
    return this.players.size;
  }

  get(id: string): Player | undefined {
    return this.players.get(id);
  }

  /**
   * Resolves a `hello`: an id with its matching token is that player again (their name is updated
   * when one is sent), even if the server had forgotten them in the meantime; anything else,
   * including a wrong token, gets a fresh identity.
   */
  identify(playerId: string | undefined, token: string | undefined, name: unknown): Player {
    const cleaned = cleanName(name);
    if (
      playerId !== undefined &&
      token !== undefined &&
      tokensMatch(this.tokenFor(playerId), token)
    ) {
      const existing = this.players.get(playerId);
      if (existing !== undefined) {
        if (cleaned !== null) existing.name = cleaned;
        return existing;
      }
      return this.add(playerId, cleaned ?? this.defaultName());
    }
    let id = randomBytes(8).toString('hex');
    while (this.players.has(id)) id = randomBytes(8).toString('hex');
    return this.add(id, cleaned ?? this.defaultName());
  }

  /** Forgets a player with no connection and no room. True when they were forgotten. */
  release(player: Player): boolean {
    if (player.connections.size > 0 || player.roomCode !== null) return false;
    if (this.players.get(player.id) !== player) return false;
    this.players.delete(player.id);
    return true;
  }

  /** Forgets every player with no connection and no room. */
  sweep(): number {
    let removed = 0;
    for (const player of [...this.players.values()]) if (this.release(player)) removed++;
    return removed;
  }

  private add(id: string, name: string): Player {
    const player: Player = {
      id,
      token: this.tokenFor(id),
      name,
      roomCode: null,
      connections: new Set(),
      chatTimes: [],
    };
    this.players.set(id, player);
    return player;
  }

  private tokenFor(id: string): string {
    return createHmac('sha256', this.secret).update(id).digest('hex').slice(0, 32);
  }

  private defaultName(): string {
    const number = 1000 + Math.min(8999, Math.floor(this.random() * 9000));
    return `Player ${number}`;
  }
}

function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
