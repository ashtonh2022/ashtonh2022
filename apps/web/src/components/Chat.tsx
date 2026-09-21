import { useEffect, useRef, useState, type FormEvent } from 'react';

import { CHAT_MAX, EMOTES, type RoomView } from '@landlord/protocol';

import { fmt } from '../lib/format';
import { send } from '../net/session';
import { useStore } from '../store';
import { strings } from '../strings';

export function ChatPanel({ room }: { room: RoomView }) {
  const open = useStore((state) => state.chatOpen);
  const setChatOpen = useStore((state) => state.setChatOpen);
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const entries = room.chat;

  useEffect(() => {
    if (!open || !list.current) return;
    list.current.scrollTop = list.current.scrollHeight;
  }, [open, entries.length]);

  if (!open) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim().slice(0, CHAT_MAX);
    if (!trimmed) return;
    send({ type: 'chat', text: trimmed });
    setText('');
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
            onClick={() => send({ type: 'emote', emote })}
          >
            {emote}
          </button>
        ))}
      </div>
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
        <button type="submit" className="button button-primary" disabled={!text.trim()}>
          {strings.send}
        </button>
      </form>
    </aside>
  );
}
