import {
  applyAction,
  botAction,
  createHand,
  nextFirstBidder,
  normalizeRules,
  timeoutAction,
  viewHand,
  type HandAction,
  type HandResult,
  type HandState,
  type RuleSettings,
} from '@landlord/engine';
import {
  CHAT_MAX,
  type ChatEntry,
  type Emote,
  type RoomStatus,
  type RoomView,
  type SeatView,
  type ServerErrorCode,
  type ServerMessage,
  type SpectatorView,
} from '@landlord/protocol';

import { botDelay, botPlayerId, pickBotName } from './bots';
import type { Clock, RandomSource, TimerHandle } from './clock';
import type { Logger } from './log';
import type { Player, PlayerRegistry } from './players';

/** Chat entries kept (and sent) per room. */
export const CHAT_LOG_MAX = 50;
/** Chat and emote messages allowed per player in a sliding window. */
export const CHAT_LIMIT = 5;
export const CHAT_WINDOW_MS = 5_000;
/** Seated humans plus spectators. */
export const ROOM_MEMBER_MAX = 20;

export interface Seat {
  /** Human occupying the seat; null when empty or when a bot sits here. */
  playerId: string | null;
  isBot: boolean;
  botName: string | null;
  /** Running score; stays with the seat for the life of the room. */
  score: number;
}

export interface RoomError {
  code: ServerErrorCode;
  message: string;
}

/** null means the request succeeded (and the room has already broadcast the new state). */
export type RoomResult = RoomError | null;

export interface RoomDeps {
  clock: Clock;
  random: RandomSource;
  players: PlayerRegistry;
  log: Logger;
}

const HEX = '0123456789abcdef';

function fail(code: ServerErrorCode, message: string): RoomError {
  return { code, message };
}

function emptySeat(): Seat {
  return { playerId: null, isBot: false, botName: null, score: 0 };
}

/** Seats that must act now: everyone undecided in the doubling round, otherwise the seat on turn. */
function actors(state: HandState): number[] {
  if (state.phase === 'doubling') {
    const seats: number[] = [];
    state.doubles.forEach((choice, seat) => {
      if (choice === null) seats.push(seat);
    });
    return seats;
  }
  if (state.phase === 'bidding' || state.phase === 'playing') return [state.turn];
  return [];
}

function mustAct(state: HandState, seat: number): boolean {
  if (state.phase === 'doubling') return state.doubles[seat] === null;
  return (state.phase === 'bidding' || state.phase === 'playing') && state.turn === seat;
}

/**
 * One room: host, seats, spectators, rules, the current hand, the running scores, the chat log
 * and the single timer that drives bots and timeouts. Every mutating method validates, applies,
 * and broadcasts a fresh `room_state` to everyone in the room before returning.
 */
export class Room {
  readonly code: string;
  hostId: string;
  status: RoomStatus = 'lobby';
  rules: RuleSettings;
  seats: Seat[];
  /** Player ids of spectators, in join order. */
  spectators: string[] = [];
  hand: HandState | null = null;
  handNumber = 0;
  lastResult: HandResult | null = null;
  /** Epoch ms when the current decision times out; null when no timer runs. */
  deadline: number | null = null;
  chatLog: ChatEntry[] = [];
  readonly createdAt: number;
  /** Epoch ms since when no human has been connected; null while somebody is. */
  emptySince: number | null = null;

  private chatSeq = 0;
  private deadlineTimer: TimerHandle | null = null;
  private botTimers: TimerHandle[] = [];
  private destroyed = false;

  constructor(
    code: string,
    host: Player,
    rulesInput: unknown,
    private readonly deps: RoomDeps,
  ) {
    this.code = code;
    this.hostId = host.id;
    this.rules = normalizeRules(rulesInput);
    this.seats = Array.from({ length: this.rules.playerCount }, emptySeat);
    this.createdAt = deps.clock.now();
    // The creator sits down at seat 0 right away; they can stand up if they only want to watch.
    (this.seats[0] as Seat).playerId = host.id;
    host.roomCode = code;
    this.touch();
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  seatOf(playerId: string): number | null {
    const index = this.seats.findIndex((seat) => seat.playerId === playerId);
    return index === -1 ? null : index;
  }

  isMember(playerId: string): boolean {
    return this.seatOf(playerId) !== null || this.spectators.includes(playerId);
  }

  /** Every human in the room (seated first, then spectators), whether connected or not. */
  humans(): Player[] {
    const ids: string[] = [];
    for (const seat of this.seats) if (seat.playerId !== null) ids.push(seat.playerId);
    ids.push(...this.spectators);
    const players: Player[] = [];
    for (const id of ids) {
      const player = this.deps.players.get(id);
      if (player !== undefined) players.push(player);
    }
    return players;
  }

  humanCount(): number {
    return this.humans().length;
  }

  hasConnectedHuman(): boolean {
    return this.humans().some((player) => player.connections.size > 0);
  }

  /** A player enters (or re-enters) the room: seated players get their seat back, others watch. */
  join(player: Player): RoomResult {
    if (this.destroyed) return fail('room_not_found', 'that room no longer exists');
    if (!this.isMember(player.id)) {
      if (this.humanCount() >= ROOM_MEMBER_MAX) return fail('room_full', 'that room is full');
      this.spectators.push(player.id);
    }
    player.roomCode = this.code;
    this.broadcast();
    return null;
  }

  /**
   * A player leaves for good (leave_room, kicked, or joining another room). During a hand their
   * seat is handed to a bot for the rest of the room's life; otherwise it is simply freed.
   */
  leave(player: Player): void {
    const seat = this.seatOf(player.id);
    let handedToBot = false;
    if (seat !== null) {
      if (this.status === 'playing') {
        this.convertSeatToBot(seat);
        handedToBot = true;
      } else {
        this.vacate(seat);
      }
    }
    this.spectators = this.spectators.filter((id) => id !== player.id);
    if (player.roomCode === this.code) player.roomCode = null;
    this.sendTo(player, { type: 'left_room' });
    if (this.hostId === player.id) this.transferHost();
    if (handedToBot) this.rearmTimers();
    this.broadcast();
  }

  /** A player's connections changed: refresh `connected` flags and drop unplugged spectators. */
  onConnectionChange(player: Player): void {
    if (this.destroyed) return;
    if (player.connections.size === 0 && this.seatOf(player.id) === null) {
      this.spectators = this.spectators.filter((id) => id !== player.id);
      if (player.roomCode === this.code) player.roomCode = null;
    }
    this.broadcast();
  }

  /** Called by the manager when the room is deleted: stops timers and detaches everyone. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimers();
    for (const player of this.humans()) {
      if (player.roomCode === this.code) player.roomCode = null;
    }
    this.spectators = [];
    for (const seat of this.seats) seat.playerId = null;
  }

  // -------------------------------------------------------------------------
  // Lobby actions
  // -------------------------------------------------------------------------

  sit(player: Player, seatIndex: number): RoomResult {
    const idle = this.requireIdle();
    if (idle !== null) return idle;
    const seat = this.seatAt(seatIndex);
    if (seat === null) return fail('bad_message', `there is no seat ${seatIndex}`);
    const current = this.seatOf(player.id);
    if (current === seatIndex) {
      this.broadcast();
      return null;
    }
    if (seat.playerId !== null || seat.isBot) return fail('seat_taken', 'that seat is taken');
    if (current !== null) this.vacate(current);
    seat.playerId = player.id;
    this.spectators = this.spectators.filter((id) => id !== player.id);
    this.broadcast();
    return null;
  }

  stand(player: Player): RoomResult {
    const idle = this.requireIdle();
    if (idle !== null) return idle;
    const current = this.seatOf(player.id);
    if (current === null) return fail('not_seated', 'you are not sitting at the table');
    this.vacate(current);
    this.spectators.push(player.id);
    this.broadcast();
    return null;
  }

  addBot(player: Player, seatIndex: number): RoomResult {
    const blocked = this.requireHost(player) ?? this.requireIdle();
    if (blocked !== null) return blocked;
    const seat = this.seatAt(seatIndex);
    if (seat === null) return fail('bad_message', `there is no seat ${seatIndex}`);
    if (seat.playerId !== null || seat.isBot) return fail('seat_taken', 'that seat is taken');
    this.placeBot(seat);
    this.broadcast();
    return null;
  }

  removeBot(player: Player, seatIndex: number): RoomResult {
    const blocked = this.requireHost(player) ?? this.requireIdle();
    if (blocked !== null) return blocked;
    const seat = this.seatAt(seatIndex);
    if (seat === null) return fail('bad_message', `there is no seat ${seatIndex}`);
    if (!seat.isBot) return fail('bad_message', `there is no bot at seat ${seatIndex}`);
    this.vacate(seatIndex);
    this.broadcast();
    return null;
  }

  fillBots(player: Player): RoomResult {
    const blocked = this.requireHost(player) ?? this.requireIdle();
    if (blocked !== null) return blocked;
    for (const seat of this.seats) {
      if (seat.playerId === null && !seat.isBot) this.placeBot(seat);
    }
    this.broadcast();
    return null;
  }

  /**
   * Host removes whoever is at a seat. A bot is removed (lobby only). A human becomes a spectator
   * in the lobby or between hands (or leaves the room when they are not connected) and is
   * replaced by a bot during a hand.
   */
  kick(player: Player, seatIndex: number): RoomResult {
    const notHost = this.requireHost(player);
    if (notHost !== null) return notHost;
    const seat = this.seatAt(seatIndex);
    if (seat === null) return fail('bad_message', `there is no seat ${seatIndex}`);
    if (seat.isBot) return this.removeBot(player, seatIndex);
    if (seat.playerId === null) return fail('bad_message', `seat ${seatIndex} is empty`);
    if (seat.playerId === player.id) return fail('bad_message', 'you cannot kick yourself');
    const target = this.deps.players.get(seat.playerId);
    if (target === undefined || this.status === 'playing' || target.connections.size === 0) {
      if (target !== undefined) {
        this.leave(target);
      } else {
        // A player the registry has forgotten: treat the seat as abandoned.
        if (this.status === 'playing') {
          this.convertSeatToBot(seatIndex);
          this.rearmTimers();
        } else {
          this.vacate(seatIndex);
        }
        this.broadcast();
      }
      return null;
    }
    this.vacate(seatIndex);
    this.spectators.push(target.id);
    this.broadcast();
    return null;
  }

  updateRules(player: Player, input: unknown): RoomResult {
    const blocked = this.requireHost(player) ?? this.requireIdle();
    if (blocked !== null) return blocked;
    const patch = typeof input === 'object' && input !== null ? (input as object) : {};
    const next = normalizeRules({ ...this.rules, ...patch });
    if (next.playerCount !== this.rules.playerCount) this.resizeSeats(next.playerCount);
    this.rules = next;
    this.broadcast();
    return null;
  }

  private resizeSeats(count: number): void {
    while (this.seats.length < count) this.seats.push(emptySeat());
    while (this.seats.length > count) {
      const removed = this.seats.pop() as Seat;
      if (removed.playerId !== null) this.spectators.push(removed.playerId);
    }
    // A hand played with another number of seats no longer lines up with the table.
    this.hand = null;
    this.lastResult = null;
    this.clearTimers();
  }

  // -------------------------------------------------------------------------
  // Hands
  // -------------------------------------------------------------------------

  startHand(player: Player): RoomResult {
    const blocked = this.requireHost(player) ?? this.requireIdle();
    if (blocked !== null) return blocked;
    if (this.seats.some((seat) => seat.playerId === null && !seat.isBot)) {
      return fail('wrong_status', 'every seat must be filled before a hand can start');
    }
    this.handNumber += 1;
    const firstBidder = nextFirstBidder(this.rules, this.hand, this.deps.random);
    this.hand = this.deal(this.handNumber, firstBidder);
    this.status = 'playing';
    this.deps.log.info(
      `room ${this.code}: hand ${this.handNumber} started (seed ${this.hand.seed})`,
    );
    this.afterChange();
    return null;
  }

  handAction(player: Player, action: HandAction): RoomResult {
    if (this.status !== 'playing' || this.hand === null) {
      return fail('wrong_status', 'no hand is being played');
    }
    const seat = this.seatOf(player.id);
    if (seat === null) return fail('not_seated', 'only seated players can act');
    const result = applyAction(this.hand, seat, action);
    if (!result.ok) {
      return fail(
        result.code === 'not_your_turn' ? 'not_your_turn' : 'illegal_action',
        result.error,
      );
    }
    this.hand = result.state;
    this.afterChange();
    return null;
  }

  private deal(handNumber: number, firstBidder: number): HandState {
    return createHand({ rules: this.rules, seed: this.newSeed(), handNumber, firstBidder });
  }

  private newSeed(): string {
    let seed = '';
    for (let i = 0; i < 16; i++) {
      seed += HEX[Math.min(15, Math.floor(this.deps.random() * 16))];
    }
    return seed;
  }

  /**
   * Runs after every engine transition: redeals at once when everybody passed, settles a
   * finished hand into the seat scores, otherwise arms the timer for the next decision.
   */
  private afterChange(): void {
    let hand = this.hand as HandState;
    if (hand.phase === 'redeal') {
      const firstBidder = nextFirstBidder(hand.rules, hand, this.deps.random);
      hand = createHand({
        rules: hand.rules,
        seed: this.newSeed(),
        handNumber: hand.handNumber,
        firstBidder,
      });
      this.hand = hand;
      this.deps.log.info(`room ${this.code}: hand ${hand.handNumber} redealt (seed ${hand.seed})`);
    }
    if (hand.phase === 'finished' && hand.result !== null) {
      this.status = 'between_hands';
      hand.result.amounts.forEach((amount, index) => {
        const seat = this.seats[index];
        if (seat !== undefined) seat.score += amount;
      });
      this.lastResult = hand.result;
      this.clearTimers();
      this.deps.log.info(
        `room ${this.code}: hand ${hand.handNumber} finished, ${hand.result.winnerSide} won ` +
          `[${hand.result.amounts.join(', ')}]`,
      );
    } else {
      this.armTimers();
    }
    this.broadcast();
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  private clearTimers(): void {
    if (this.deadlineTimer !== null) {
      this.deps.clock.clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
    for (const handle of this.botTimers) this.deps.clock.clearTimeout(handle);
    this.botTimers = [];
    this.deadline = null;
  }

  /** Clears and re-arms the room's timers for the current decision (bots and the deadline). */
  private rearmTimers(): void {
    this.armTimers();
  }

  private armTimers(): void {
    this.clearTimers();
    const hand = this.hand;
    if (this.destroyed || this.status !== 'playing' || hand === null) return;
    const seats = actors(hand);
    if (seats.length === 0) return;
    const ms = hand.rules.turnSeconds * 1000;
    this.deadline = this.deps.clock.now() + ms;
    this.deadlineTimer = this.deps.clock.setTimeout(() => this.onDeadline(hand), ms);
    for (const seat of seats) {
      if (this.seats[seat]?.isBot !== true) continue;
      const delay = botDelay(this.deps.random);
      this.botTimers.push(this.deps.clock.setTimeout(() => this.onBotTurn(hand, seat), delay));
    }
  }

  private onBotTurn(expected: HandState, seat: number): void {
    try {
      if (this.destroyed || this.hand !== expected || this.status !== 'playing') return;
      if (this.seats[seat]?.isBot !== true || !mustAct(expected, seat)) return;
      const next = this.applyForSeat(expected, seat, botAction(expected, seat), 'bot');
      if (next === null) return;
      this.hand = next;
      this.afterChange();
    } catch (err) {
      this.deps.log.error(`room ${this.code}: bot turn failed`, err);
    }
  }

  private onDeadline(expected: HandState): void {
    try {
      if (this.destroyed || this.hand !== expected || this.status !== 'playing') return;
      let state = expected;
      for (const seat of actors(expected)) {
        if (!mustAct(state, seat)) continue;
        const info = this.seats[seat];
        const player =
          info?.playerId !== null && info !== undefined
            ? this.deps.players.get(info.playerId)
            : undefined;
        const connectedHuman =
          info !== undefined && !info.isBot && player !== undefined && player.connections.size > 0;
        const action = connectedHuman ? timeoutAction(state, seat) : botAction(state, seat);
        const next = this.applyForSeat(state, seat, action, connectedHuman ? 'timeout' : 'bot');
        if (next !== null) state = next;
      }
      this.hand = state;
      this.afterChange();
    } catch (err) {
      this.deps.log.error(`room ${this.code}: deadline handling failed`, err);
    }
  }

  /** Applies an automatic action, falling back to the timeout action if the engine refuses it. */
  private applyForSeat(
    state: HandState,
    seat: number,
    action: HandAction,
    source: 'bot' | 'timeout',
  ): HandState | null {
    const result = applyAction(state, seat, action);
    if (result.ok) return result.state;
    this.deps.log.error(
      `room ${this.code}: ${source} action for seat ${seat} rejected (${result.code}: ${result.error})`,
      action,
    );
    if (source === 'timeout') return null;
    const fallback = applyAction(state, seat, timeoutAction(state, seat));
    if (fallback.ok) return fallback.state;
    this.deps.log.error(
      `room ${this.code}: timeout action for seat ${seat} rejected (${fallback.code}: ${fallback.error})`,
    );
    return null;
  }

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------

  chat(player: Player, text: string): RoomResult {
    const cleaned = text.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
    if (cleaned.length === 0) return fail('bad_message', 'nothing to say');
    if (!this.allowChat(player)) return fail('rate_limited', 'too many messages, slow down');
    const entry: ChatEntry = {
      id: ++this.chatSeq,
      playerId: player.id,
      name: player.name,
      seat: this.seatOf(player.id),
      text: cleaned,
      at: this.deps.clock.now(),
    };
    this.chatLog.push(entry);
    if (this.chatLog.length > CHAT_LOG_MAX)
      this.chatLog.splice(0, this.chatLog.length - CHAT_LOG_MAX);
    this.sendAll({ type: 'chat', entry });
    return null;
  }

  emote(player: Player, emote: Emote): RoomResult {
    if (!this.allowChat(player)) return fail('rate_limited', 'too many messages, slow down');
    this.sendAll({ type: 'emote', playerId: player.id, seat: this.seatOf(player.id), emote });
    return null;
  }

  private allowChat(player: Player): boolean {
    const now = this.deps.clock.now();
    const cutoff = now - CHAT_WINDOW_MS;
    const times = player.chatTimes;
    while (times.length > 0 && (times[0] as number) <= cutoff) times.shift();
    if (times.length >= CHAT_LIMIT) return false;
    times.push(now);
    return true;
  }

  // -------------------------------------------------------------------------
  // Views and broadcasting
  // -------------------------------------------------------------------------

  view(viewer: Player): RoomView {
    const seat = this.seatOf(viewer.id);
    const hand = this.hand;
    const seats: SeatView[] = this.seats.map((info, index) => {
      const occupant = info.playerId !== null ? this.deps.players.get(info.playerId) : undefined;
      const won = this.lastResult !== null && (this.lastResult.amounts[index] ?? 0) > 0;
      return {
        seat: index,
        playerId: info.isBot ? botPlayerId(info.botName ?? `Bot ${index}`) : info.playerId,
        name: info.isBot ? info.botName : (occupant?.name ?? null),
        isBot: info.isBot,
        connected: info.isBot ? true : occupant !== undefined && occupant.connections.size > 0,
        isHost: info.playerId !== null && info.playerId === this.hostId,
        score: info.score,
        cardCount: hand?.hands[index]?.length ?? 0,
        ready: won,
      };
    });
    const spectators: SpectatorView[] = [];
    for (const id of this.spectators) {
      const player = this.deps.players.get(id);
      if (player !== undefined) spectators.push({ playerId: id, name: player.name });
    }
    return {
      code: this.code,
      hostId: this.hostId,
      status: this.status,
      rules: this.rules,
      seats,
      spectators,
      you: { playerId: viewer.id, name: viewer.name, seat, isHost: viewer.id === this.hostId },
      hand: hand === null ? null : viewHand(hand, seat),
      handNumber: this.handNumber,
      lastResult: this.lastResult,
      deadline: this.deadline,
      chat: this.chatLog.slice(-CHAT_LOG_MAX),
    };
  }

  /** Sends everyone in the room their own `room_state` snapshot. */
  broadcast(): void {
    if (this.destroyed) return;
    this.touch();
    for (const player of this.humans()) {
      if (player.connections.size === 0) continue;
      this.sendTo(player, { type: 'room_state', room: this.view(player) });
    }
  }

  private sendAll(message: ServerMessage): void {
    for (const player of this.humans()) this.sendTo(player, message);
  }

  private sendTo(player: Player, message: ServerMessage): void {
    for (const connection of player.connections) connection.send(message);
  }

  /** Keeps `emptySince` current: the moment the last connected human went away. */
  touch(): void {
    if (this.hasConnectedHuman()) {
      this.emptySince = null;
    } else if (this.emptySince === null) {
      this.emptySince = this.deps.clock.now();
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requireHost(player: Player): RoomError | null {
    return player.id === this.hostId ? null : fail('not_host', 'only the host can do that');
  }

  private requireIdle(): RoomError | null {
    return this.status === 'playing'
      ? fail('wrong_status', 'not while a hand is being played')
      : null;
  }

  private seatAt(index: number): Seat | null {
    return Number.isInteger(index) ? (this.seats[index] ?? null) : null;
  }

  private vacate(index: number): void {
    const seat = this.seats[index];
    if (seat === undefined) return;
    seat.playerId = null;
    seat.isBot = false;
    seat.botName = null;
  }

  private placeBot(seat: Seat): void {
    seat.playerId = null;
    seat.isBot = true;
    seat.botName = pickBotName(
      this.seats.flatMap((other) => (other.isBot && other.botName !== null ? [other.botName] : [])),
    );
  }

  private convertSeatToBot(index: number): void {
    const seat = this.seats[index];
    if (seat === undefined) return;
    const name = seat.playerId !== null ? this.deps.players.get(seat.playerId)?.name : undefined;
    this.placeBot(seat);
    this.deps.log.info(
      `room ${this.code}: seat ${index} (${name ?? '?'}) handed to ${seat.botName}`,
    );
  }

  /** Passes the host role to the next connected human: seated first, then spectators. */
  private transferHost(): void {
    const humans = this.humans().filter((player) => player.id !== this.hostId);
    const next = humans.find((player) => player.connections.size > 0) ?? humans[0] ?? null;
    if (next !== null) this.hostId = next.id;
  }
}
