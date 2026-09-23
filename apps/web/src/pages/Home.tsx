import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { ROOM_CODE_LENGTH } from '@landlord/protocol';

import { RuleOptions, defaultRules } from '../components/RuleOptions';
import { NameField } from '../components/NameField';
import { KickedBanner, StatusBanner, Toast } from '../components/Notices';
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
  const status = useStore((state) => state.status);
  const creating = useStore((state) => state.creating !== null);
  const createdRoom = useStore((state) => state.createdRoom);
  const [rules, setRules] = useState(defaultRules);
  const [code, setCode] = useState('');

  useEffect(() => {
    ensureConnected();
    // Show a returning player's name at once; the welcome confirms it.
    if (client.identity.name) useStore.getState().restoreName(client.identity.name);
  }, []);

  // A click is only good for this visit to the page.
  useEffect(() => () => useStore.getState().endCreate(), []);

  // Go to the room this click created (the store tells it apart from a returning player's old
  // room, see beginCreate).
  useEffect(() => {
    if (createdRoom === null) return;
    useStore.getState().endCreate();
    navigate(`/room/${createdRoom}`);
  }, [createdRoom, navigate]);

  useEffect(() => {
    if (!creating) return;
    const timer = setTimeout(() => useStore.getState().endCreate(), CREATE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [creating]);

  // The client sends a name change once typing pauses (see NameField); these send it now.
  const flushName = () => client.flushName();

  const createRoom = () => {
    flushName();
    useStore.getState().beginCreate();
    // The pong marks where the server's answers to this click begin.
    send({ type: 'ping' });
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
      <KickedBanner />
      <header className="home-header">
        <h1 className="home-title">{strings.appName}</h1>
        <p className="home-pitch">{strings.pitch}</p>
      </header>

      <section className="panel">
        <NameField id="player-name" />
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
