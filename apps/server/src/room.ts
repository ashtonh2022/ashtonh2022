import {
  applyAction,
  botAction,
  createHand,
  legalActions,
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
  type ResultSeatView,
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
/** How long a disconnected host keeps the role before it passes to a connected human. */
export const HOST_GRACE_MS = 15_000;
/** How long a disconnected spectator stays in the room (so a page refresh keeps their place). */
export const SPECTATOR_GRACE_MS = 60_000;

export interface Seat {
  /** Human occupying the seat; null when empty or when a bot sits here. */
  playerId: string | null;
  isBot: boolean;
  botName: string | null;
}

/** Who was dealt a seat's cards: the one a hand's result there is charged to. */
interface DealtSeat {
  /** player id, or the bot's id */
  id: string;
  /** name when dealt, for anyone the registry no longer knows */
  name: string;
  isBot: boolean;
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
  /**
   * Called after a timer (not a request) dropped a member, so the owner can delete the room when
   * nobody is left in it.
   */
  onMemberDropped?: (room: Room) => void;
}

const HEX = '0123456789abcdef';

function fail(code: ServerErrorCode, message: string): RoomError {
  return { code, message };
}

function emptySeat(): Seat {
  return { playerId: null, isBot: false, botName: null };
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
 * True when the seat on turn in the bidding has exactly one legal action and it is a call: the
 * forced last bidder in call mode, who RULES.md says "is simply made Landlord".
 */
function isForcedCall(state: HandState): boolean {
  if (state.phase !== 'bidding') return false;
  const legal = legalActions(state, state.turn);
  return (
    legal.canCall &&
    !legal.canPassBid &&
    !legal.canRob &&
    legal.bids.length === 0 &&
    !legal.canDouble &&
    !legal.canPlay &&
    !legal.canPass
  );
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
  /** True from a redeal (everyone passed) until the first bid of the new deal. */
  redealt = false;
  chatLog: ChatEntry[] = [];
  readonly createdAt: number;
  /** Epoch ms since when no human has been connected; null while somebody is. */
  emptySince: number | null = null;

  private chatSeq = 0;
  /**
   * Running scores by player id (bots by their bot id). A score belongs to the player, not the
   * seat, and is kept for as long as the room lasts, even while they are away.
   */
  private readonly scores = new Map<string, number>();
  /** Who sat at each seat when the current hand was dealt: they get its result. */
  private dealtTo: Array<DealtSeat | null> = [];
  /** Who the amounts in `lastResult` were charged to, by seat. */
  private resultSeats: Array<DealtSeat | null> = [];
  /** Counts deals (new hands and redeals) so every deal starts a new decision. */
  private dealCount = 0;
  /** Identifies the decision the deadline belongs to; null when no timer runs. */
  private decisionKey: string | null = null;
  private deadlineTimer: TimerHandle | null = null;
  /** Pending bot moves by seat, for the current decision. */
  private readonly botTimers = new Map<number, TimerHandle>();
  private hostTimer: TimerHandle | null = null;
  /** The host's grace ran out while no other human was connected: the next one to connect leads. */
  private hostVacant = false;
  /** Disconnected spectators, each with the timer that drops them from the room. */
  private readonly spectatorTimers = new Map<string, TimerHandle>();
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

  /** Whether `player` could enter the room now (members can always come back). */
  canJoin(player: Player): RoomResult {
    if (this.destroyed) return fail('room_not_found', 'that room no longer exists');
    if (!this.isMember(player.id) && this.humanCount() >= ROOM_MEMBER_MAX) {
      return fail('room_full', 'that room is full');
    }
    return null;
  }

  /** A player enters (or re-enters) the room: seated players get their seat back, others watch. */
  join(player: Player): RoomResult {
    const refused = this.canJoin(player);
    if (refused !== null) return refused;
    if (!this.isMember(player.id)) this.spectators.push(player.id);
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
    // The host role moves on in broadcast() (syncHost) now that they are no longer a member.
    if (handedToBot) this.armTimers();
    this.broadcast();
  }

  /**
   * A player's connections changed: refresh `connected` flags. Seats are held; a spectator who
   * dropped is kept for SPECTATOR_GRACE_MS and the host role waits HOST_GRACE_MS (see syncPresence).
   */
  onConnectionChange(player: Player): void {
    if (this.destroyed) return;
    this.broadcast();
  }

  /** Called by the manager when the room is deleted: stops timers and detaches everyone. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimers();
    this.clearHostTimer();
    for (const handle of this.spectatorTimers.values()) this.deps.clock.clearTimeout(handle);
    this.spectatorTimers.clear();
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
          this.armTimers();
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
      // Scores live with the players, so nobody's points go away with the seat.
      const removed = this.seats.pop() as Seat;
      if (removed.playerId !== null) this.spectators.push(removed.playerId);
    }
    // A hand played with another number of seats no longer lines up with the table.
    this.hand = null;
    this.lastResult = null;
    this.resultSeats = [];
    this.redealt = false;
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
    this.dealtTo = this.seats.map((_, index) => this.dealtSeat(index));
    this.redealt = false;
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
    this.dealCount += 1;
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
   * Runs after every engine transition: redeals at once when everybody passed, makes a forced
   * last bidder Landlord, settles a finished hand into the players' scores, otherwise arms the
   * timer for the next decision.
   */
  private afterChange(): void {
    let hand = this.hand as HandState;
    if (hand.phase === 'redeal') {
      const firstBidder = nextFirstBidder(hand.rules, hand, this.deps.random);
      hand = this.deal(hand.handNumber, firstBidder);
      this.hand = hand;
      this.redealt = true;
      this.deps.log.info(`room ${this.code}: hand ${hand.handNumber} redealt (seed ${hand.seed})`);
    } else if (hand.phase !== 'bidding' || hand.bidding.records.length > 0) {
      this.redealt = false;
    }
    if (isForcedCall(hand)) {
      const seat = hand.turn;
      const forced = applyAction(hand, seat, { type: 'call' });
      if (forced.ok) {
        hand = forced.state;
        this.hand = hand;
        this.deps.log.info(`room ${this.code}: seat ${seat} is the forced last bidder`);
      } else {
        this.deps.log.error(`room ${this.code}: forced call for seat ${seat} rejected`, forced);
      }
    }
    if (hand.phase === 'finished' && hand.result !== null) {
      this.status = 'between_hands';
      // The result belongs to whoever was dealt the hand, even if they left or a bot took over.
      hand.result.amounts.forEach((amount, index) => {
        const id = this.dealtTo[index]?.id;
        if (id !== undefined) this.scores.set(id, this.scoreOf(id) + amount);
      });
      this.lastResult = hand.result;
      this.resultSeats = this.dealtTo;
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
    for (const handle of this.botTimers.values()) this.deps.clock.clearTimeout(handle);
    this.botTimers.clear();
    this.deadline = null;
    this.decisionKey = null;
  }

  /**
   * The decision the hand is waiting for. It changes when the seat on turn changes (every bid,
   * play or pass) or a new deal starts; the whole doubling round is one decision.
   */
  private currentDecision(hand: HandState): string | null {
    if (this.status !== 'playing') return null;
    switch (hand.phase) {
      case 'bidding':
        return `${this.dealCount}:bidding:${hand.turn}:${hand.bidding.records.length}`;
      case 'doubling':
        return `${this.dealCount}:doubling`;
      case 'playing':
        return `${this.dealCount}:playing:${hand.turn}:${hand.history.length}`;
      default:
        return null;
    }
  }

  /**
   * Arms the timers for the current decision. A new decision gets a fresh deadline; for the same
   * decision the deadline stands (so decisions by others, leaves and seats handed to bots never
   * extend it) and only bots that must act and have no move scheduled yet get one.
   */
  private armTimers(): void {
    const hand = this.hand;
    const decision = this.destroyed || hand === null ? null : this.currentDecision(hand);
    if (hand === null || decision === null) {
      this.clearTimers();
      return;
    }
    if (decision !== this.decisionKey) {
      this.clearTimers();
      const ms = hand.rules.turnSeconds * 1000;
      this.decisionKey = decision;
      this.deadline = this.deps.clock.now() + ms;
      this.deadlineTimer = this.deps.clock.setTimeout(() => this.onDeadline(decision), ms);
    }
    const seats = actors(hand);
    for (const [seat, handle] of this.botTimers) {
      if (!seats.includes(seat) || this.seats[seat]?.isBot !== true) {
        this.deps.clock.clearTimeout(handle);
        this.botTimers.delete(seat);
      }
    }
    for (const seat of seats) {
      if (this.seats[seat]?.isBot !== true || this.botTimers.has(seat)) continue;
      const delay = botDelay(this.deps.random);
      const handle = this.deps.clock.setTimeout(() => this.onBotTurn(decision, seat), delay);
      this.botTimers.set(seat, handle);
    }
  }

  private onBotTurn(decision: string, seat: number): void {
    try {
      this.botTimers.delete(seat);
      const hand = this.hand;
      if (this.destroyed || this.status !== 'playing' || hand === null) return;
      if (this.decisionKey !== decision) return;
      if (this.seats[seat]?.isBot !== true || !mustAct(hand, seat)) return;
      const next = this.applyForSeat(hand, seat, botAction(hand, seat), 'bot');
      if (next === null) return;
      this.hand = next;
      this.afterChange();
    } catch (err) {
      this.deps.log.error(`room ${this.code}: bot turn failed`, err);
    }
  }

  private onDeadline(decision: string): void {
    try {
      this.deadlineTimer = null;
      const expected = this.hand;
      if (this.destroyed || this.status !== 'playing' || expected === null) return;
      if (this.decisionKey !== decision) return;
      // The deadline has been used up: whatever happens next gets a fresh one.
      this.decisionKey = null;
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

  /** A player's (or bot's) running score in this room. */
  scoreOf(id: string): number {
    return this.scores.get(id) ?? 0;
  }

  view(viewer: Player): RoomView {
    const seat = this.seatOf(viewer.id);
    const hand = this.hand;
    const seats: SeatView[] = this.seats.map((info, index) => {
      const occupant = info.playerId !== null ? this.deps.players.get(info.playerId) : undefined;
      const occupantId = this.occupantId(index);
      // Only the one who was dealt this seat won or lost the hand in it.
      const won =
        this.lastResult !== null &&
        (this.lastResult.amounts[index] ?? 0) > 0 &&
        occupantId !== null &&
        this.resultSeats[index]?.id === occupantId;
      return {
        seat: index,
        playerId: occupantId,
        name: info.isBot ? info.botName : (occupant?.name ?? null),
        isBot: info.isBot,
        connected: info.isBot ? true : occupant !== undefined && occupant.connections.size > 0,
        isHost: info.playerId !== null && info.playerId === this.hostId,
        score: occupantId === null ? 0 : this.scoreOf(occupantId),
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
      acting: this.deadline !== null && hand !== null ? actors(hand) : [],
      redealt: this.redealt,
      resultSeats: this.lastResult === null ? [] : this.resultSeatViews(),
      chat: this.chatLog.slice(-CHAT_LOG_MAX),
    };
  }

  private resultSeatViews(): ResultSeatView[] {
    return this.resultSeats.flatMap((dealt, seat) => {
      if (dealt === null) return [];
      const name = dealt.isBot ? dealt.name : (this.deps.players.get(dealt.id)?.name ?? dealt.name);
      const { id: playerId, isBot } = dealt;
      return [{ seat, playerId, name, isBot, score: this.scoreOf(playerId) }];
    });
  }

  /** Sends everyone in the room their own `room_state` snapshot. */
  broadcast(): void {
    if (this.destroyed) return;
    this.syncPresence();
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

  /** Who sits at a seat now, as the hand dealt there will record them; null if empty. */
  private dealtSeat(index: number): DealtSeat | null {
    const seat = this.seats[index];
    const id = this.occupantId(index);
    if (seat === undefined || id === null) return null;
    const name = seat.isBot
      ? (seat.botName ?? `Bot ${index}`)
      : (this.deps.players.get(id)?.name ?? '?');
    return { id, name, isBot: seat.isBot };
  }

  /** The id a seat's score is kept under: the human's player id or the bot's id; null if empty. */
  private occupantId(index: number): string | null {
    const seat = this.seats[index];
    if (seat === undefined) return null;
    return seat.isBot ? botPlayerId(seat.botName ?? `Bot ${index}`) : seat.playerId;
  }

  // -------------------------------------------------------------------------
  // Presence: host role and disconnected spectators
  // -------------------------------------------------------------------------

  /** Brings the host role and the spectator grace timers in line with who is connected now. */
  private syncPresence(): void {
    this.syncSpectatorGrace();
    this.syncHost();
  }

  /** Every disconnected spectator has a grace timer; nobody else has one. */
  private syncSpectatorGrace(): void {
    for (const [id, handle] of this.spectatorTimers) {
      const player = this.deps.players.get(id);
      if (!this.spectators.includes(id) || (player !== undefined && player.connections.size > 0)) {
        this.deps.clock.clearTimeout(handle);
        this.spectatorTimers.delete(id);
      }
    }
    for (const id of this.spectators) {
      if (this.spectatorTimers.has(id)) continue;
      const player = this.deps.players.get(id);
      if (player !== undefined && player.connections.size > 0) continue;
      const handle = this.deps.clock.setTimeout(
        () => this.onSpectatorGraceOver(id),
        SPECTATOR_GRACE_MS,
      );
      this.spectatorTimers.set(id, handle);
    }
  }

  private onSpectatorGraceOver(id: string): void {
    try {
      this.spectatorTimers.delete(id);
      if (this.destroyed || !this.spectators.includes(id)) return;
      const player = this.deps.players.get(id);
      if (player !== undefined && player.connections.size > 0) return;
      this.spectators = this.spectators.filter((other) => other !== id);
      if (player !== undefined && player.roomCode === this.code) player.roomCode = null;
      this.broadcast();
      this.deps.onMemberDropped?.(this);
    } catch (err) {
      this.deps.log.error(`room ${this.code}: dropping a spectator failed`, err);
    }
  }

  /**
   * Keeps the host role with someone who can use it. A host who left the room hands it on at
   * once (to a connected human if there is one). A host who is only disconnected keeps it for
   * HOST_GRACE_MS; after that it goes to the next connected human, seated first in seat order,
   * then spectators, or, when nobody else is connected, to the first human who connects.
   */
  private syncHost(): void {
    const humans = this.humans();
    if (humans.length === 0) {
      this.clearHostTimer();
      return;
    }
    const host = humans.find((player) => player.id === this.hostId);
    if (host === undefined) {
      const connected = humans.find((player) => player.connections.size > 0);
      this.setHost(connected ?? (humans[0] as Player));
      // Nobody is connected to take over: whoever connects first becomes the host.
      if (connected === undefined) this.hostVacant = true;
      return;
    }
    if (host.connections.size > 0) {
      this.clearHostTimer();
      this.hostVacant = false;
      return;
    }
    if (this.hostVacant) {
      const next = humans.find((player) => player.connections.size > 0);
      if (next !== undefined) this.setHost(next);
      return;
    }
    if (this.hostTimer === null) {
      this.hostTimer = this.deps.clock.setTimeout(() => this.onHostGraceOver(), HOST_GRACE_MS);
    }
  }

  private onHostGraceOver(): void {
    try {
      this.hostTimer = null;
      if (this.destroyed) return;
      const humans = this.humans();
      const host = humans.find((player) => player.id === this.hostId);
      if (host !== undefined && host.connections.size > 0) return;
      const next = humans.find(
        (player) => player.id !== this.hostId && player.connections.size > 0,
      );
      if (next !== undefined) {
        this.setHost(next);
      } else {
        this.hostVacant = true;
      }
      this.broadcast();
    } catch (err) {
      this.deps.log.error(`room ${this.code}: host transfer failed`, err);
    }
  }

  private setHost(player: Player): void {
    if (player.id !== this.hostId) {
      this.deps.log.info(`room ${this.code}: ${player.name} (${player.id}) is now the host`);
    }
    this.hostId = player.id;
    this.hostVacant = false;
    this.clearHostTimer();
  }

  private clearHostTimer(): void {
    if (this.hostTimer === null) return;
    this.deps.clock.clearTimeout(this.hostTimer);
    this.hostTimer = null;
  }
}
