import { create } from 'zustand';

import type {
  ChatEntry,
  Emote,
  NoticeCode,
  RoomView,
  ServerErrorCode,
  ServerMessage,
} from '@landlord/protocol';

import { isMuted, loadMuted, play, playAll, setMuted as setAudioMuted } from './audio';
import { isRedeal } from './lib/redeal';
import { soundsForSnapshot } from './lib/soundDiff';
import type { ConnectionStatus } from './net/client';

export interface UiError {
  code: ServerErrorCode;
  message: string;
  at: number;
}

export interface EmoteBubble {
  id: number;
  playerId: string;
  seat: number | null;
  emote: Emote;
  at: number;
}

/** A one-off notice from the server about the room we are in. */
export interface RoomNotice {
  notice: NoticeCode;
  code: string;
}

export const EMOTE_BUBBLE_MS = 2500;
export const BIDDING_LOG_LINGER_MS = 4000;
/** the "New cards were dealt" notice stays at least this long after a redeal */
export const REDEAL_NOTICE_MS = 4000;

export interface StoreState {
  status: ConnectionStatus;
  you: { playerId: string; name: string } | null;
  room: RoomView | null;
  /** code of the most recent room_state, kept when `room` is cleared (see Home's create flow) */
  lastRoomCode: string | null;
  lastError: UiError | null;
  /** the name field on Home */
  name: string;
  /**
   * true when the player typed in the name field since the last welcome: that welcome then keeps
   * what they typed instead of showing the server's name (the client sends it, see GameClient)
   */
  nameTyped: boolean;
  muted: boolean;
  selection: string[];
  hintIndex: number;
  emotes: EmoteBubble[];
  chatOpen: boolean;
  unreadChat: number;
  /** set when the server answered our join with room_not_found */
  roomNotFound: boolean;
  /** the room the Room page is showing or joining */
  joinTarget: string | null;
  /** any other error that arrived while joining `joinTarget` (room_full...) */
  joinError: UiError | null;
  /** epoch ms when the landlord of the current hand was chosen (bidding log lingers a bit) */
  landlordChosenAt: number | null;
  /** epoch ms of the last redeal of the current hand (everyone passed) */
  redealAt: number | null;
  /** Home's Create click while it waits for the room it makes (see beginCreate) */
  creating: PendingCreate | null;
  /** the room the last Create click made; Home goes there */
  createdRoom: string | null;
  /**
   * The host removed us from a room (code null when nobody said which). Home says so until the
   * player dismisses it or creates or joins a room.
   */
  kickedFrom: { code: string | null } | null;
  /** a one-off notice about the room we are in, shown by the Room page until dismissed */
  roomNotice: RoomNotice | null;

  setStatus(status: ConnectionStatus): void;
  handleMessage(message: ServerMessage): void;
  /** the player typed in the name field */
  setName(name: string): void;
  /** fills an empty name field with the persisted name; not typing, so a welcome may replace it */
  restoreName(name: string): void;
  setMuted(muted: boolean): void;
  toggleCard(id: string): void;
  setSelection(ids: string[]): void;
  clearSelection(): void;
  setHintIndex(index: number): void;
  setChatOpen(open: boolean): void;
  dismissError(): void;
  dismissKicked(): void;
  dismissRoomNotice(): void;
  clearRoom(): void;
  /** the Room page starts (or retries) joining `code` */
  beginJoin(code: string): void;
  /**
   * Home is about to send `ping` then `create_room`. The server answers in order, so its pong
   * comes after everything it sent before it saw the create_room, such as the old room a
   * returning player is put back into on hello. The first room after the pong that is not one
   * of those and that we host is the new one: it becomes `createdRoom`.
   */
  beginCreate(): void;
  /** forgets a pending Create click and the room it made */
  endCreate(): void;
  removeEmote(id: number): void;
}

export interface PendingCreate {
  /** true once the pong for the ping sent with create_room arrived */
  answered: boolean;
  /** rooms that cannot be the new one: known at the click or seen before the pong */
  stale: string[];
}

let emoteCounter = 0;

const NO_ROOM = {
  room: null,
  selection: [],
  hintIndex: 0,
  emotes: [],
  unreadChat: 0,
  landlordChosenAt: null,
  redealAt: null,
  roomNotice: null,
} satisfies Partial<StoreState>;

/** Both snapshots show the same deal of the same room (not a new hand, not a redeal). */
function sameDeal(prev: RoomView | null, next: RoomView): boolean {
  const a = prev?.hand;
  const b = next.hand;
  if (!a || !b || prev?.code !== next.code) return false;
  return a.handNumber === b.handNumber && !isRedeal(prev, next);
}

function sameTrick(prev: RoomView | null, next: RoomView): boolean {
  const a = prev?.hand;
  const b = next.hand;
  if (!a || !b) return false;
  return (
    a.phase === b.phase &&
    a.trick.currentSeat === b.trick.currentSeat &&
    a.trick.plays.length === b.trick.plays.length
  );
}

function sameCards(prev: RoomView | null, next: RoomView): boolean {
  const a = prev?.hand?.hand ?? [];
  const b = next.hand?.hand ?? [];
  return a.length === b.length && a.every((card, index) => card.id === b[index]?.id);
}

export const useStore = create<StoreState>((set, get) => ({
  status: 'connecting',
  you: null,
  room: null,
  lastRoomCode: null,
  lastError: null,
  name: '',
  nameTyped: false,
  muted: loadMuted(),
  selection: [],
  hintIndex: 0,
  emotes: [],
  chatOpen: false,
  unreadChat: 0,
  roomNotFound: false,
  joinTarget: null,
  joinError: null,
  landlordChosenAt: null,
  redealAt: null,
  creating: null,
  createdRoom: null,
  kickedFrom: null,
  roomNotice: null,

  setStatus(status) {
    set({ status });
  },

  handleMessage(message) {
    const state = get();
    switch (message.type) {
      case 'welcome': {
        set({
          you: { playerId: message.playerId, name: message.name },
          name: state.nameTyped ? state.name : message.name,
          nameTyped: false,
        });
        return;
      }
      case 'room_state': {
        const prev = state.room;
        const next = message.room;
        playAll(soundsForSnapshot(prev, next));

        // Keep what the player selected while others act; drop only cards that left the hand.
        // A new deal (next hand or a redeal) reuses card ids, so it starts from nothing.
        const deal = sameDeal(prev, next);
        const handIds = new Set((next.hand?.hand ?? []).map((card) => card.id));
        const selection = deal ? state.selection.filter((id) => handIds.has(id)) : [];
        const keepHint = deal && sameTrick(prev, next) && sameCards(prev, next);
        const redealAt = isRedeal(prev, next) ? Date.now() : deal ? state.redealAt : null;
        const landlordChosenAt =
          next.hand && next.hand.landlord !== null
            ? prev?.hand &&
              prev.code === next.code &&
              prev.hand.handNumber === next.hand.handNumber &&
              prev.hand.landlord !== null
              ? state.landlordChosenAt
              : Date.now()
            : null;
        let creating = state.creating;
        let createdRoom = state.createdRoom;
        if (creating !== null && !creating.answered) {
          creating = { ...creating, stale: [...creating.stale, next.code] };
        } else if (creating !== null && !creating.stale.includes(next.code) && next.you.isHost) {
          creating = null;
          createdRoom = next.code;
        }
        // The spectators notice is done once we are seated again or somewhere else.
        const roomNotice =
          state.roomNotice !== null &&
          state.roomNotice.code === next.code &&
          !(state.roomNotice.notice === 'moved_to_spectators' && next.you.seat !== null)
            ? state.roomNotice
            : null;
        set({
          creating,
          createdRoom,
          roomNotice,
          room: next,
          lastRoomCode: next.code,
          // a broadcast from another room (the server re-attached us to it) ends no join state
          roomNotFound:
            state.joinTarget === null || next.code === state.joinTarget
              ? false
              : state.roomNotFound,
          joinError: next.code === state.joinTarget ? null : state.joinError,
          selection,
          hintIndex: keepHint ? state.hintIndex : 0,
          landlordChosenAt,
          redealAt,
          you: state.you
            ? { ...state.you, name: next.you.name }
            : { playerId: next.you.playerId, name: next.you.name },
        });
        return;
      }
      case 'left_room': {
        // The Room page may still be joining another room (joining one leaves the old one first),
        // so the join bookkeeping stays. The Room page sends the player home; Home says why when
        // the host removed them.
        const kickedFrom =
          message.reason === 'kicked'
            ? { code: message.code ?? state.room?.code ?? state.lastRoomCode }
            : state.kickedFrom;
        set({ ...NO_ROOM, kickedFrom });
        return;
      }
      case 'notice': {
        set({ roomNotice: { notice: message.notice, code: message.code } });
        return;
      }
      case 'chat': {
        const room = state.room;
        if (!room) return;
        const entry: ChatEntry = message.entry;
        if (room.chat.some((existing) => existing.id === entry.id)) return;
        const chat = [...room.chat, entry].slice(-50);
        const mine = state.you?.playerId === entry.playerId;
        if (!state.chatOpen && !mine) play('chat');
        set({
          room: { ...room, chat },
          unreadChat: state.chatOpen || mine ? state.unreadChat : state.unreadChat + 1,
        });
        return;
      }
      case 'emote': {
        const bubble: EmoteBubble = {
          id: ++emoteCounter,
          playerId: message.playerId,
          seat: message.seat,
          emote: message.emote,
          at: Date.now(),
        };
        if (state.you?.playerId !== message.playerId) play('chat');
        set({ emotes: [...state.emotes.filter((e) => e.playerId !== bubble.playerId), bubble] });
        setTimeout(() => get().removeEmote(bubble.id), EMOTE_BUBBLE_MS);
        return;
      }
      case 'error': {
        const error: UiError = { code: message.code, message: message.message, at: Date.now() };
        const joining = state.joinTarget !== null && state.room?.code !== state.joinTarget;
        set({
          lastError: error,
          roomNotFound: message.code === 'room_not_found' ? true : state.roomNotFound,
          joinError: joining && message.code !== 'room_not_found' ? error : state.joinError,
          // A refused create_room (server full, too many creates) answers with an error: stop
          // waiting for a room so the Create button comes back at once.
          creating: state.creating !== null && state.creating.answered ? null : state.creating,
        });
        return;
      }
      case 'pong': {
        if (state.creating !== null && !state.creating.answered) {
          set({ creating: { ...state.creating, answered: true } });
        }
        return;
      }
      default:
        return;
    }
  },

  setName(name) {
    set({ name, nameTyped: true });
  },

  restoreName(name) {
    if (get().name === '') set({ name });
  },

  setMuted(muted) {
    setAudioMuted(muted);
    set({ muted });
  },

  toggleCard(id) {
    const { selection } = get();
    set({
      selection: selection.includes(id)
        ? selection.filter((other) => other !== id)
        : [...selection, id],
      hintIndex: 0,
    });
  },

  setSelection(ids) {
    set({ selection: ids });
  },

  clearSelection() {
    set({ selection: [], hintIndex: 0 });
  },

  setHintIndex(index) {
    set({ hintIndex: index });
  },

  setChatOpen(open) {
    set({ chatOpen: open, unreadChat: open ? 0 : get().unreadChat });
  },

  dismissError() {
    set({ lastError: null });
  },

  dismissKicked() {
    set({ kickedFrom: null });
  },

  dismissRoomNotice() {
    set({ roomNotice: null });
  },

  clearRoom() {
    set({ ...NO_ROOM, joinTarget: null, joinError: null });
  },

  beginJoin(code) {
    set({ joinTarget: code, joinError: null, roomNotFound: false, kickedFrom: null });
  },

  beginCreate() {
    const { room, lastRoomCode } = get();
    const stale = [room?.code, lastRoomCode].filter((code): code is string => Boolean(code));
    set({ creating: { answered: false, stale }, createdRoom: null, kickedFrom: null });
  },

  endCreate() {
    set({ creating: null, createdRoom: null });
  },

  removeEmote(id) {
    set({ emotes: get().emotes.filter((emote) => emote.id !== id) });
  },
}));

// Keep the audio module's flag in sync with the persisted preference at startup.
if (isMuted() !== useStore.getState().muted) setAudioMuted(useStore.getState().muted);
