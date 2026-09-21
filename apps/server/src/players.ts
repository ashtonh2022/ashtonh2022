import { randomBytes, timingSafeEqual } from 'node:crypto';

import { NAME_MAX } from '@landlord/protocol';

import type { RandomSource } from './clock';
import type { Connection } from './connection';

/**
 * A person as the server knows them: an id the client shows around and a secret token that
 * proves ownership of that id. Both are minted on the first `hello` and kept by the client.
 */
export interface Player {
  readonly id: string;
  readonly token: string;
  name: string;
  /** Code of the room the player is currently in, or null. */
  roomCode: string | null;
  /** Live sockets speaking for this player (a player may have several tabs open). */
  readonly connections: Set<Connection>;
  /** Epoch ms of the last connection change; used to forget players nobody has seen for ages. */
  lastSeen: number;
  /** Epoch ms of recent chat and emote messages, for rate limiting. */
  readonly chatTimes: number[];
}

/** Trims, collapses whitespace, strips control characters and cuts to NAME_MAX. Null when empty. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return name.length > 0 ? name : null;
}

export interface PlayerRegistryOptions {
  random?: RandomSource;
  now?: () => number;
}

export class PlayerRegistry {
  private readonly players = new Map<string, Player>();
  private readonly random: RandomSource;
  private readonly now: () => number;

  constructor(options: PlayerRegistryOptions = {}) {
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.players.size;
  }

  get(id: string): Player | undefined {
    return this.players.get(id);
  }

  /**
   * Resolves a `hello`: a known id with the matching token is the same player again (their name
   * is updated when one is sent); anything else, including a wrong token, gets a fresh identity.
   */
  identify(playerId: string | undefined, token: string | undefined, name: unknown): Player {
    const cleaned = cleanName(name);
    if (playerId !== undefined && token !== undefined) {
      const existing = this.players.get(playerId);
      if (existing !== undefined && tokensMatch(existing.token, token)) {
        if (cleaned !== null) existing.name = cleaned;
        existing.lastSeen = this.now();
        return existing;
      }
    }
    return this.mint(cleaned ?? this.defaultName());
  }

  private mint(name: string): Player {
    let id = randomBytes(8).toString('hex');
    while (this.players.has(id)) id = randomBytes(8).toString('hex');
    const player: Player = {
      id,
      token: randomBytes(16).toString('hex'),
      name,
      roomCode: null,
      connections: new Set(),
      lastSeen: this.now(),
      chatTimes: [],
    };
    this.players.set(id, player);
    return player;
  }

  private defaultName(): string {
    const number = 1000 + Math.min(8999, Math.floor(this.random() * 9000));
    return `Player ${number}`;
  }

  /** Forgets players with no connection and no room that have not been seen for `maxIdleMs`. */
  sweep(now: number, maxIdleMs: number): number {
    let removed = 0;
    for (const [id, player] of this.players) {
      if (player.connections.size > 0 || player.roomCode !== null) continue;
      if (now - player.lastSeen < maxIdleMs) continue;
      this.players.delete(id);
      removed++;
    }
    return removed;
  }
}

function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
