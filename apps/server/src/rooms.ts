import { ROOM_CODE_LENGTH } from '@landlord/protocol';

import type { TimerHandle } from './clock';
import type { Player } from './players';
import { Room, type RoomDeps } from './room';

/** Unambiguous characters only: no 0/O, 1/I. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const DEFAULT_ROOM_TTL_MS = 120 * 60 * 1000;
export const SWEEP_INTERVAL_MS = 60 * 1000;

export interface RoomManagerOptions extends RoomDeps {
  /** How long a room may go without a connected human before it is deleted. */
  ttlMs?: number;
  /** Runs after every periodic sweep (the hub uses it to forget stale players). */
  onSweep?: (now: number) => void;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly deps: RoomDeps;
  private readonly ttlMs: number;
  private readonly onSweep: ((now: number) => void) | undefined;
  private sweeper: TimerHandle | null = null;

  constructor(options: RoomManagerOptions) {
    const { ttlMs, onSweep, ...deps } = options;
    this.deps = deps;
    this.ttlMs = ttlMs ?? DEFAULT_ROOM_TTL_MS;
    this.onSweep = onSweep;
  }

  get size(): number {
    return this.rooms.size;
  }

  codes(): string[] {
    return [...this.rooms.keys()];
  }

  create(host: Player, rulesInput: unknown): Room {
    const room = new Room(this.newCode(), host, rulesInput, {
      ...this.deps,
      // A grace period that runs out may take the last human with it.
      onMemberDropped: (dropped) => this.deleteIfAbandoned(dropped),
    });
    this.rooms.set(room.code, room);
    this.deps.log.info(`room ${room.code}: created by ${host.name} (${host.id})`);
    return room;
  }

  /** Case-insensitive lookup; surrounding whitespace is ignored. */
  get(code: string): Room | undefined {
    return this.rooms.get(normalizeCode(code));
  }

  delete(code: string): boolean {
    const room = this.rooms.get(normalizeCode(code));
    if (room === undefined) return false;
    const members = room.humans();
    this.rooms.delete(room.code);
    room.destroy();
    // Members nobody is connected as are not needed any more (their tokens bring them back).
    for (const player of members) this.deps.players.release(player);
    this.deps.log.info(`room ${room.code}: deleted`);
    return true;
  }

  /** Whether a room can be created under `max`, if need be by closing one (see makeSpace). */
  hasSpace(max: number): boolean {
    return this.rooms.size < max || this.idlest() !== undefined;
  }

  /**
   * Brings the count under `max` by closing the rooms nobody has been connected to for longest.
   * Rooms somebody is connected to are never closed; false when that is all that is left.
   */
  makeSpace(max: number): boolean {
    while (this.rooms.size >= max) {
      const room = this.idlest();
      if (room === undefined) return false;
      this.deps.log.info(`room ${room.code}: closed to make space, nobody is connected to it`);
      this.delete(room.code);
    }
    return true;
  }

  /** The room with no connected human for the longest time; undefined when there is none. */
  private idlest(): Room | undefined {
    let idlest: Room | undefined;
    for (const room of this.rooms.values()) {
      room.touch();
      if (room.emptySince === null) continue;
      if (idlest === undefined || room.emptySince < (idlest.emptySince as number)) idlest = room;
    }
    return idlest;
  }

  /** A room with no humans left in it (seated or watching) has nobody to come back to it. */
  deleteIfAbandoned(room: Room): boolean {
    if (room.isDestroyed || room.humanCount() > 0 || this.rooms.get(room.code) !== room) {
      return false;
    }
    return this.delete(room.code);
  }

  /** Deletes rooms nobody is in, or that no human has been connected to for the TTL. */
  sweep(now = this.deps.clock.now()): string[] {
    const deleted: string[] = [];
    for (const room of [...this.rooms.values()]) {
      room.touch();
      const abandoned = room.humanCount() === 0;
      const expired = room.emptySince !== null && now - room.emptySince >= this.ttlMs;
      if (abandoned || expired) {
        this.delete(room.code);
        deleted.push(room.code);
      }
    }
    return deleted;
  }

  startSweeper(intervalMs = SWEEP_INTERVAL_MS): void {
    if (this.sweeper !== null) return;
    this.sweeper = this.deps.clock.setInterval(() => {
      try {
        const now = this.deps.clock.now();
        const deleted = this.sweep(now);
        if (deleted.length > 0) this.deps.log.info(`swept idle rooms: ${deleted.join(', ')}`);
        this.onSweep?.(now);
      } catch (err) {
        this.deps.log.error('room sweep failed', err);
      }
    }, intervalMs);
  }

  stopSweeper(): void {
    if (this.sweeper === null) return;
    this.deps.clock.clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /** Deletes every room (shutdown). */
  clear(): void {
    for (const code of this.codes()) this.delete(code);
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        const index = Math.min(
          ROOM_CODE_ALPHABET.length - 1,
          Math.floor(this.deps.random() * ROOM_CODE_ALPHABET.length),
        );
        code += ROOM_CODE_ALPHABET[index];
      }
      if (!this.rooms.has(code)) return code;
    }
  }
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}
