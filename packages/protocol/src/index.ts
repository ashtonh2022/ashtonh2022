/**
 * Wire protocol between the web client and the game server (JSON over WebSocket at /ws).
 * zod schemas validate everything the client sends. Types for server -> client messages are plain.
 * The server is authoritative: the client never runs the state machine, it only renders RoomView
 * and uses the engine for local helpers (sorting, analysing a selection, hints).
 *
 * Changes since the first version (all backwards compatible, PROTOCOL_VERSION unchanged):
 * - RoomView.acting: the seats the current deadline applies to. In the doubling round this tells
 *   everyone who is still deciding without revealing anyone's choice.
 * - RoomView.redealt: true on the first snapshot after everyone passed and the cards were redealt.
 * - RoomView.resultSeats: who each seat's share of lastResult was charged to (whoever was seated
 *   when the hand was dealt). Seats may have changed hands since, so SeatView cannot say.
 * - left_room.reason / left_room.code: why you are no longer in a room ('kicked' by the host, or
 *   'left' yourself) and which room it was. Absent means 'left'.
 * - notice: one-off information for you alone, e.g. the host moved you from your seat to the
 *   spectators in the lobby.
 */
import { z } from 'zod';
import type { HandAction, HandResult, HandView, RuleSettings } from '@landlord/engine';

export const PROTOCOL_VERSION = 1;

export const NAME_MAX = 20;
export const CHAT_MAX = 200;
export const ROOM_CODE_LENGTH = 6;
export const EMOTES = ['👍', '😂', '😮', '😭', '🔥', '💣', '🐢', '👋'] as const;
export type Emote = (typeof EMOTES)[number];

const ruleSettingsSchema = z
  .object({
    playerCount: z.union([z.literal(3), z.literal(4)]),
    kittySize: z.number().int(),
    biddingMode: z.enum(['call', 'points']),
    allPass: z.enum(['force', 'redeal']),
    doublingRound: z.boolean(),
    kittyBonus: z.boolean(),
    firstBidder: z.enum(['winner', 'rotate', 'random']),
    chainsThroughTwos: z.boolean(),
    turnSeconds: z.number().int(),
  })
  .partial();
export type RuleSettingsInput = z.infer<typeof ruleSettingsSchema>;

const handActionSchema: z.ZodType<HandAction> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('call') }),
  z.object({ type: z.literal('rob') }),
  z.object({ type: z.literal('pass_bid') }),
  z.object({ type: z.literal('bid'), value: z.union([z.literal(1), z.literal(2), z.literal(3)]) }),
  z.object({ type: z.literal('double'), double: z.boolean() }),
  z.object({ type: z.literal('play'), cardIds: z.array(z.string().max(16)).min(1).max(40) }),
  z.object({ type: z.literal('pass') }),
]);

export const clientMessageSchema = z.discriminatedUnion('type', [
  /** First message on every connection. playerId/token are omitted by brand-new players. */
  z.object({
    type: z.literal('hello'),
    playerId: z.string().max(64).optional(),
    token: z.string().max(128).optional(),
    name: z.string().max(NAME_MAX).optional(),
    protocol: z.number().int(),
  }),
  z.object({ type: z.literal('set_name'), name: z.string().min(1).max(NAME_MAX) }),
  z.object({ type: z.literal('create_room'), rules: ruleSettingsSchema }),
  z.object({ type: z.literal('join_room'), code: z.string().min(1).max(ROOM_CODE_LENGTH) }),
  z.object({ type: z.literal('leave_room') }),
  /** host only, lobby or between hands */
  z.object({ type: z.literal('update_rules'), rules: ruleSettingsSchema }),
  z.object({ type: z.literal('sit'), seat: z.number().int().min(0).max(3) }),
  z.object({ type: z.literal('stand') }),
  /** host only */
  z.object({ type: z.literal('add_bot'), seat: z.number().int().min(0).max(3) }),
  z.object({ type: z.literal('remove_bot'), seat: z.number().int().min(0).max(3) }),
  z.object({ type: z.literal('fill_bots') }),
  z.object({ type: z.literal('kick'), seat: z.number().int().min(0).max(3) }),
  z.object({ type: z.literal('start_hand') }),
  z.object({ type: z.literal('hand_action'), action: handActionSchema }),
  z.object({ type: z.literal('chat'), text: z.string().min(1).max(CHAT_MAX) }),
  z.object({ type: z.literal('emote'), emote: z.enum(EMOTES) }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export type RoomStatus = 'lobby' | 'playing' | 'between_hands';

export interface SeatView {
  seat: number;
  /** null = empty seat */
  playerId: string | null;
  name: string | null;
  isBot: boolean;
  connected: boolean;
  isHost: boolean;
  /** running score in this room */
  score: number;
  cardCount: number;
  /** true when whoever sits here now won the last hand in this seat (for display) */
  ready: boolean;
}

/** Who a seat's share of `lastResult` belongs to: whoever sat there when the hand was dealt. */
export interface ResultSeatView {
  seat: number;
  /** the player's id, or the bot's id for a bot */
  playerId: string;
  name: string;
  isBot: boolean;
  /** their running score in this room now */
  score: number;
}

export interface SpectatorView {
  playerId: string;
  name: string;
}

export interface ChatEntry {
  id: number;
  playerId: string;
  name: string;
  seat: number | null;
  text: string;
  /** epoch ms */
  at: number;
}

export interface RoomView {
  code: string;
  /** absolute share URL is built by the client: `${location.origin}/room/${code}` */
  hostId: string;
  status: RoomStatus;
  rules: RuleSettings;
  seats: SeatView[];
  spectators: SpectatorView[];
  you: { playerId: string; name: string; seat: number | null; isHost: boolean };
  /** current or last hand as seen by you; null in the lobby before the first hand */
  hand: HandView | null;
  handNumber: number;
  lastResult: HandResult | null;
  /** epoch ms when the current decision times out, null when no timer is running */
  deadline: number | null;
  /**
   * Seats whose decision the deadline applies to: the seat on turn, or during the doubling round
   * every seat that has not decided yet (choices stay hidden). Empty when no timer is running.
   */
  acting?: number[];
  /** true on snapshots of a hand that was just redealt because everyone passed */
  redealt?: boolean;
  /** who each seat's share of `lastResult` was charged to, by seat; empty when there is none */
  resultSeats?: ResultSeatView[];
  /** last 50 chat entries */
  chat: ChatEntry[];
}

/** Why you are no longer in a room: you left (or joined another room), or the host kicked you. */
export type LeaveReason = 'left' | 'kicked';

/** One-off notices sent to a single player. `code` is the room code. */
export type NoticeCode = 'moved_to_spectators';

export type ServerMessage =
  | { type: 'welcome'; playerId: string; token: string; name: string; protocol: number }
  | { type: 'room_state'; room: RoomView }
  | { type: 'left_room'; reason?: LeaveReason; code?: string }
  | { type: 'notice'; notice: NoticeCode; code: string }
  | { type: 'chat'; entry: ChatEntry }
  | { type: 'emote'; playerId: string; seat: number | null; emote: Emote }
  | { type: 'error'; code: ServerErrorCode; message: string }
  | { type: 'pong' };

export type ServerErrorCode =
  | 'bad_message'
  | 'not_in_room'
  | 'room_not_found'
  | 'room_full'
  | 'not_host'
  | 'seat_taken'
  | 'not_seated'
  | 'wrong_status'
  | 'not_your_turn'
  | 'illegal_action'
  | 'rate_limited';

export function encode(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message);
}

/** Returns null when the payload is not a valid client message. */
export function decodeClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = clientMessageSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
