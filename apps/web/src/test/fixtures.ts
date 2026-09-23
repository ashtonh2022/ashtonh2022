/**
 * Test helpers: real engine hands turned into the RoomView snapshots the server would send.
 */
import {
  DEFAULT_RULES,
  applyAction,
  createHand,
  viewHand,
  type HandAction,
  type HandState,
  type RuleSettings,
} from '@landlord/engine';
import type { RoomStatus, RoomView, SpectatorView } from '@landlord/protocol';

import { useStore } from '../store';

export const NAMES = ['Ada', 'Bo', 'Cy', 'Dee'] as const;

export function resetStore(): void {
  useStore.setState(useStore.getInitialState(), true);
}

export function act(state: HandState, seat: number, action: HandAction): HandState {
  const result = applyAction(state, seat, action);
  if (!result.ok) throw new Error(`${action.type} by seat ${seat}: ${result.error}`);
  return result.state;
}

export function newHand(
  rules: Partial<RuleSettings> = {},
  options: { seed?: string; firstBidder?: number; handNumber?: number } = {},
): HandState {
  return createHand({
    rules: { ...DEFAULT_RULES, ...rules },
    seed: options.seed ?? 'fixture',
    handNumber: options.handNumber ?? 1,
    firstBidder: options.firstBidder ?? 0,
  });
}

/** Call mode: the first bidder calls and everyone else passes, so they become the Landlord. */
export function firstBidderCalls(state: HandState): HandState {
  let next = act(state, state.turn, { type: 'call' });
  while (next.phase === 'bidding') next = act(next, next.turn, { type: 'pass_bid' });
  return next;
}

export interface RoomOptions {
  code?: string;
  /** the viewer's seat; null for a spectator */
  seat?: number | null;
  status?: RoomStatus;
  hostSeat?: number;
  bots?: number[];
  spectators?: SpectatorView[];
  extra?: Partial<RoomView>;
}

export function roomView(state: HandState | null, options: RoomOptions = {}): RoomView {
  const seat = options.seat === undefined ? 0 : options.seat;
  const rules = state?.rules ?? DEFAULT_RULES;
  const hostSeat = options.hostSeat ?? 0;
  const bots = options.bots ?? [];
  const seats = Array.from({ length: rules.playerCount }, (_, index) => ({
    seat: index,
    playerId: `p${index}`,
    name: bots.includes(index) ? `Bot ${NAMES[index] ?? index}` : (NAMES[index] ?? `P${index}`),
    isBot: bots.includes(index),
    connected: true,
    isHost: index === hostSeat,
    score: 0,
    cardCount: state?.hands[index]?.length ?? 0,
    ready: false,
  }));
  const you =
    seat === null
      ? { playerId: 'watcher', name: 'Sam', seat: null, isHost: false }
      : { playerId: `p${seat}`, name: NAMES[seat] ?? '?', seat, isHost: seat === hostSeat };
  return {
    code: options.code ?? 'ABCDEF',
    hostId: `p${hostSeat}`,
    status: options.status ?? (state ? 'playing' : 'lobby'),
    rules,
    seats,
    spectators: options.spectators ?? (seat === null ? [{ playerId: 'watcher', name: 'Sam' }] : []),
    you,
    hand: state ? viewHand(state, seat) : null,
    handNumber: state?.handNumber ?? 0,
    lastResult: null,
    deadline: state ? Date.now() + 30_000 : null,
    chat: [],
    ...options.extra,
  };
}
