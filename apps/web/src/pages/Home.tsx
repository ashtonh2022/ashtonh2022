import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { NAME_MAX, ROOM_CODE_LENGTH } from '@landlord/protocol';

import { RuleOptions, defaultRules } from '../components/RuleOptions';
import { StatusBanner, Toast } from '../components/Notices';
import { client, ensureConnected, send } from '../net/session';
import { useStore } from '../store';
import { strings } from '../strings';

const CREATE_TIMEOUT_MS = 10_000;

export function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH);
}

export function Home() {
  const navigate = useNavigate();
  const name = useStore((state) => state.name);
  const setName = useStore((state) => state.setName);
  const room = useStore((state) => state.room);
  const status = useStore((state) => state.status);
  const [rules, setRules] = useState(defaultRules);
  const [code, setCode] = useState('');
  const [creating, setCreating] = useState(false);
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    ensureConnected();
    if (!useStore.getState().name && client.identity.name) setName(client.identity.name);
  }, [setName]);

  useEffect(() => {
    if (creating && room) {
      setCreating(false);
      navigate(`/room/${room.code}`);
    }
  }, [creating, room, navigate]);

  useEffect(() => {
    if (!creating) return;
    const timer = setTimeout(() => setCreating(false), CREATE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [creating]);

  const flushName = () => {
    if (nameTimer.current) {
      clearTimeout(nameTimer.current);
      nameTimer.current = null;
    }
    const current = useStore.getState().name.trim();
    if (current !== (client.identity.name ?? '')) client.setName(current);
  };

  const onNameChange = (value: string) => {
    setName(value.slice(0, NAME_MAX));
    if (nameTimer.current) clearTimeout(nameTimer.current);
    nameTimer.current = setTimeout(flushName, 400);
  };

  const createRoom = () => {
    flushName();
    setCreating(true);
    send({ type: 'create_room', rules });
  };

  const joinRoom = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeCode(code);
    if (normalized.length === 0) return;
    flushName();
    navigate(`/room/${normalized}`);
  };

  return (
    <main className="page home">
      <StatusBanner status={status} />
      <header className="home-header">
        <h1 className="home-title">{strings.appName}</h1>
        <p className="home-pitch">{strings.pitch}</p>
      </header>

      <section className="panel">
        <label className="field-label" htmlFor="player-name">
          {strings.yourName}
        </label>
        <input
          id="player-name"
          className="input"
          type="text"
          value={name}
          maxLength={NAME_MAX}
          placeholder={strings.namePlaceholder}
          autoComplete="nickname"
          onChange={(event) => onNameChange(event.target.value)}
          onBlur={flushName}
        />
      </section>

      <section className="panel" aria-labelledby="create-title">
        <h2 id="create-title" className="panel-title">
          {strings.createRoomTitle}
        </h2>
        <RuleOptions value={rules} onChange={setRules} />
        <button
          type="button"
          className="button button-primary button-block"
          onClick={createRoom}
          disabled={creating}
        >
          {creating ? strings.creatingRoom : strings.createRoomButton}
        </button>
      </section>

      <section className="panel" aria-labelledby="join-title">
        <h2 id="join-title" className="panel-title">
          {strings.joinRoomTitle}
        </h2>
        <form className="join-form" onSubmit={joinRoom}>
          <label className="field-label" htmlFor="join-code">
            {strings.joinCodeLabel}
          </label>
          <div className="join-row">
            <input
              id="join-code"
              className="input input-code"
              type="text"
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              maxLength={ROOM_CODE_LENGTH}
              placeholder={strings.joinCodePlaceholder}
              value={code}
              onChange={(event) => setCode(normalizeCode(event.target.value))}
            />
            <button
              type="submit"
              className="button button-primary"
              disabled={code.length !== ROOM_CODE_LENGTH}
            >
              {strings.joinRoomButton}
            </button>
          </div>
        </form>
      </section>

      <p className="home-footer">
        <a href="/rules" target="_blank" rel="noopener" className="link">
          {strings.howToPlay}
        </a>
      </p>
      <Toast />
    </main>
  );
}
