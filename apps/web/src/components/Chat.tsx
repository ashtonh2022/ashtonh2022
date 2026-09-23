import { useEffect, useRef, useState, type FormEvent } from 'react';

import { CHAT_MAX, EMOTES, type Emote, type RoomView } from '@landlord/protocol';

import { chatBlockedUntil, recentSends } from '../lib/chatLimit';
import { fmt } from '../lib/format';
import { send } from '../net/session';
import { useStore } from '../store';
import { strings } from '../strings';

/** How the server stores a chat line, to recognise our own message coming back. */
function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function ChatPanel({ room }: { room: RoomView }) {
  const open = useStore((state) => state.chatOpen);
  const setChatOpen = useStore((state) => state.setChatOpen);
  const lastError = useStore((state) => state.lastError);
  const [text, setText] = useState('');
  // Chat lines and emotes share the server's limit; mirror it so nothing typed is thrown away.
  const [sentAt, setSentAt] = useState<number[]>([]);
  const [now, setNow] = useState(() => Date.now());
  /** the last line sent, until the server echoes it or refuses it */
  const pending = useRef<{ text: string; at: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const entries = room.chat;
  const blockedUntil = chatBlockedUntil(sentAt, now);
  const blocked = blockedUntil !== null;

  useEffect(() => {
    if (!open || !list.current) return;
    list.current.scrollTop = list.current.scrollHeight;
  }, [open, entries.length]);

  useEffect(() => {
    if (blockedUntil === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, blockedUntil - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [blockedUntil]);

  // Our line came back: it went through.
  useEffect(() => {
    const last = entries[entries.length - 1];
    const sent = pending.current;
    if (last && sent && last.playerId === room.you.playerId && last.text === cleanText(sent.text)) {
      pending.current = null;
    }
  }, [entries, room.you.playerId]);

  // The server still refused it (its clock is a little different): give the text back.
  useEffect(() => {
    const sent = pending.current;
    if (!lastError || lastError.code !== 'rate_limited' || !sent || lastError.at < sent.at) return;
    pending.current = null;
    setText((current) => (current.trim() === '' ? sent.text : current));
  }, [lastError]);

  if (!open) return null;

  /** Records a chat line or emote against the limit; false when the limit is reached. */
  const spend = (): boolean => {
    const at = Date.now();
    if (chatBlockedUntil(sentAt, at) !== null) {
      setNow(at);
      return false;
    }
    setSentAt([...recentSends(sentAt, at), at]);
    setNow(at);
    return true;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim().slice(0, CHAT_MAX);
    if (!trimmed || !spend()) return;
    send({ type: 'chat', text: trimmed });
    pending.current = { text: trimmed, at: Date.now() };
    setText('');
  };

  const sendEmote = (emote: Emote) => {
    if (!spend()) return;
    pending.current = null;
    send({ type: 'emote', emote });
  };

  return (
    <aside className="chat" aria-label={strings.chatTitle}>
      <div className="chat-head">
        <span className="chat-title">{strings.chatTitle}</span>
        <button
          type="button"
          className="icon-button"
          aria-label={strings.closeChat}
          onClick={() => setChatOpen(false)}
        >
          ×
        </button>
      </div>
      <div className="chat-list" ref={list}>
        {entries.length === 0 ? (
          <p className="muted small">{strings.chatEmpty}</p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className={
                entry.playerId === room.you.playerId ? 'chat-entry chat-mine' : 'chat-entry'
              }
            >
              <span className="chat-name">{entry.name}</span>
              <span className="chat-text">{entry.text}</span>
            </div>
          ))
        )}
      </div>
      <div className="emote-row" role="group" aria-label={strings.emotes}>
        {EMOTES.map((emote) => (
          <button
            key={emote}
            type="button"
            className="emote-button"
            aria-label={fmt(strings.sendEmote, { emote })}
            disabled={blocked}
            onClick={() => sendEmote(emote)}
          >
            {emote}
          </button>
        ))}
      </div>
      {blocked && (
        <p className="chat-limit" role="status">
          {strings.chatSlowDown}
        </p>
      )}
      <form className="chat-form" onSubmit={submit}>
        <input
          className="input"
          type="text"
          value={text}
          maxLength={CHAT_MAX}
          placeholder={strings.chatPlaceholder}
          aria-label={strings.chatPlaceholder}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="button button-primary" disabled={!text.trim() || blocked}>
          {strings.send}
        </button>
      </form>
    </aside>
  );
}
