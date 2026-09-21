import { create } from 'zustand';

import type {
  ChatEntry,
  Emote,
  RoomView,
  ServerErrorCode,
  ServerMessage,
} from '@landlord/protocol';

import { isMuted, loadMuted, play, playAll, setMuted as setAudioMuted } from './audio';
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

export const EMOTE_BUBBLE_MS = 2500;
export const BIDDING_LOG_LINGER_MS = 4000;

export interface StoreState {
  status: ConnectionStatus;
  you: { playerId: string; name: string } | null;
  room: RoomView | null;
  lastError: UiError | null;
  name: string;
  muted: boolean;
  selection: string[];
  hintIndex: number;
  emotes: EmoteBubble[];
  chatOpen: boolean;
  unreadChat: number;
  /** set when the server answered our join with room_not_found */
  roomNotFound: boolean;
  /** epoch ms when the landlord of the current hand was chosen (bidding log lingers a bit) */
  landlordChosenAt: number | null;

  setStatus(status: ConnectionStatus): void;
  handleMessage(message: ServerMessage): void;
  setName(name: string): void;
  setMuted(muted: boolean): void;
  toggleCard(id: string): void;
  setSelection(ids: string[]): void;
  clearSelection(): void;
  setHintIndex(index: number): void;
  setChatOpen(open: boolean): void;
  dismissError(): void;
  clearRoom(): void;
  resetRoomNotFound(): void;
  removeEmote(id: number): void;
}

let emoteCounter = 0;

function sameTrick(prev: RoomView | null, next: RoomView): boolean {
  const a = prev?.hand;
  const b = next.hand;
  if (!a || !b) return false;
  return (
    prev?.code === next.code &&
    a.handNumber === b.handNumber &&
    a.phase === b.phase &&
    a.trick.currentSeat === b.trick.currentSeat &&
    a.trick.plays.length === b.trick.plays.length
  );
}

export const useStore = create<StoreState>((set, get) => ({
  status: 'connecting',
  you: null,
  room: null,
  lastError: null,
  name: '',
  muted: loadMuted(),
  selection: [],
  hintIndex: 0,
  emotes: [],
  chatOpen: false,
  unreadChat: 0,
  roomNotFound: false,
  landlordChosenAt: null,

  setStatus(status) {
    set({ status });
  },

  handleMessage(message) {
    const state = get();
    switch (message.type) {
      case 'welcome': {
        set({
          you: { playerId: message.playerId, name: message.name },
          name: state.name || message.name,
        });
        return;
      }
      case 'room_state': {
        const prev = state.room;
        const next = message.room;
        playAll(soundsForSnapshot(prev, next));

        const handIds = new Set((next.hand?.hand ?? []).map((card) => card.id));
        const keepSelection = sameTrick(prev, next);
        const selection = keepSelection ? state.selection.filter((id) => handIds.has(id)) : [];
        const landlordChosenAt =
          next.hand && next.hand.landlord !== null
            ? prev?.hand &&
              prev.code === next.code &&
              prev.hand.handNumber === next.hand.handNumber &&
              prev.hand.landlord !== null
              ? state.landlordChosenAt
              : Date.now()
            : null;
        set({
          room: next,
          roomNotFound: false,
          selection,
          hintIndex: keepSelection ? state.hintIndex : 0,
          landlordChosenAt,
          you: state.you
            ? { ...state.you, name: next.you.name }
            : { playerId: next.you.playerId, name: next.you.name },
        });
        return;
      }
      case 'left_room': {
        set({ room: null, selection: [], hintIndex: 0, emotes: [], unreadChat: 0 });
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
        set({
          lastError: { code: message.code, message: message.message, at: Date.now() },
          roomNotFound: message.code === 'room_not_found' ? true : state.roomNotFound,
        });
        return;
      }
      case 'pong':
      default:
        return;
    }
  },

  setName(name) {
    set({ name });
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

  clearRoom() {
    set({ room: null, selection: [], hintIndex: 0, emotes: [], unreadChat: 0 });
  },

  resetRoomNotFound() {
    set({ roomNotFound: false });
  },

  removeEmote(id) {
    set({ emotes: get().emotes.filter((emote) => emote.id !== id) });
  },
}));

// Keep the audio module's flag in sync with the persisted preference at startup.
if (isMuted() !== useStore.getState().muted) setAudioMuted(useStore.getState().muted);
