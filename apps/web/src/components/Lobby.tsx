import { useState } from 'react';

import type { RuleSettings } from '@landlord/engine';
import type { RoomView, SeatView } from '@landlord/protocol';

import { send } from '../net/session';
import { useStore } from '../store';
import { strings } from '../strings';
import { EmoteBubble } from './EmoteBubble';
import { ResultPanel } from './ResultPanel';
import { RuleChips } from './RuleChips';
import { RuleOptions } from './RuleOptions';
import { Scoreboard } from './Scoreboard';
import { SharePanel } from './SharePanel';

function SeatCard({ room, seat }: { room: RoomView; seat: SeatView }) {
  const isYou = seat.playerId !== null && seat.playerId === room.you.playerId;
  const isHost = room.you.isHost;
  const seated = room.you.seat !== null;
  const empty = seat.playerId === null;
  const canEdit = room.status === 'lobby' || room.status === 'between_hands';
  // While the socket is down these would act on a room that may have changed: they are not sent.
  const online = useStore((state) => state.status === 'open');

  return (
    <li className={`seat-card${empty ? ' seat-empty' : ''}${isYou ? ' seat-you' : ''}`}>
      <EmoteBubble seat={seat.seat} playerId={seat.playerId} />
      <div className="seat-head">
        <span className="seat-number">{seat.seat + 1}</span>
        <span className="seat-name">{empty ? strings.emptySeat : seat.name}</span>
      </div>
      <div className="seat-tags">
        {seat.isHost && <span className="tag tag-host">{strings.host}</span>}
        {seat.isBot && <span className="tag tag-bot">{strings.bot}</span>}
        {isYou && <span className="tag tag-you">{strings.you}</span>}
        {!empty && !seat.isBot && !seat.connected && (
          <span className="tag tag-away">{strings.away}</span>
        )}
        {seat.ready && <span className="tag tag-ready">★</span>}
      </div>
      {canEdit && (
        <div className="seat-actions">
          {empty && !seated && (
            <button
              type="button"
              className="button button-small button-primary"
              disabled={!online}
              onClick={() => send({ type: 'sit', seat: seat.seat })}
            >
              {strings.sitHere}
            </button>
          )}
          {empty && isHost && (
            <button
              type="button"
              className="button button-small"
              disabled={!online}
              onClick={() => send({ type: 'add_bot', seat: seat.seat })}
            >
              {strings.addBot}
            </button>
          )}
          {isYou && (
            <button
              type="button"
              className="button button-small"
              disabled={!online}
              onClick={() => send({ type: 'stand' })}
            >
              {strings.standUp}
            </button>
          )}
          {!empty && seat.isBot && isHost && (
            <button
              type="button"
              className="button button-small"
              disabled={!online}
              onClick={() => send({ type: 'remove_bot', seat: seat.seat })}
            >
              {strings.removeBot}
            </button>
          )}
          {!empty && !seat.isBot && !isYou && isHost && (
            <button
              type="button"
              className="button button-small button-danger"
              disabled={!online}
              onClick={() => send({ type: 'kick', seat: seat.seat })}
            >
              {strings.kick}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function Lobby({ room }: { room: RoomView }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<RuleSettings>(room.rules);
  const isHost = room.you.isHost;
  const allFilled = room.seats.every((seat) => seat.playerId !== null);
  const anyEmpty = !allFilled;
  const showResult = room.status === 'between_hands' && room.lastResult !== null;
  const you = useStore((state) => state.you);
  const online = useStore((state) => state.status === 'open');

  const startEditing = () => {
    setDraft(room.rules);
    setEditing(true);
  };

  const saveRules = () => {
    send({ type: 'update_rules', rules: draft });
    setEditing(false);
  };

  return (
    <div className="lobby">
      {showResult && room.lastResult && (
        <ResultPanel room={room} result={room.lastResult} showControls />
      )}

      {room.you.seat === null && (
        <p className="notice" role="status">
          {strings.youAreWatching}
        </p>
      )}

      <section className="panel" aria-labelledby="seats-title">
        <h2 id="seats-title" className="panel-title">
          {strings.seatsTitle}
        </h2>
        <ul className={`seat-grid seat-grid-${room.seats.length}`}>
          {room.seats.map((seat) => (
            <SeatCard key={seat.seat} room={room} seat={seat} />
          ))}
        </ul>
        {isHost && anyEmpty && (
          <div className="button-row">
            <button
              type="button"
              className="button"
              disabled={!online}
              onClick={() => send({ type: 'fill_bots' })}
            >
              {strings.fillWithBots}
            </button>
          </div>
        )}
        {/* Between hands the result panel above already carries the "Next hand" control. */}
        {!showResult && (
          <div className="start-row">
            {isHost ? (
              <button
                type="button"
                className="button button-primary button-block"
                disabled={!allFilled || !online}
                onClick={() => send({ type: 'start_hand' })}
              >
                {room.status === 'between_hands' ? strings.nextHand : strings.startHand}
              </button>
            ) : (
              <p className="muted">{strings.waitingForHost}</p>
            )}
            {isHost && !allFilled && <p className="muted small">{strings.waitingForSeats}</p>}
          </div>
        )}
      </section>

      <SharePanel code={room.code} />

      <section className="panel" aria-labelledby="rules-title">
        <h2 id="rules-title" className="panel-title">
          {strings.rulesTitle}
        </h2>
        {editing ? (
          <>
            <RuleOptions value={draft} onChange={setDraft} />
            <div className="button-row">
              <button
                type="button"
                className="button button-primary"
                disabled={!online}
                onClick={saveRules}
              >
                {strings.saveOptions}
              </button>
              <button type="button" className="button" onClick={() => setEditing(false)}>
                {strings.cancel}
              </button>
            </div>
          </>
        ) : (
          <>
            <RuleChips rules={room.rules} />
            {isHost && (
              <div className="button-row">
                <button type="button" className="button button-small" onClick={startEditing}>
                  {strings.editOptions}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <Scoreboard room={room} />

      <section className="panel" aria-labelledby="spectators-title">
        <h2 id="spectators-title" className="panel-title">
          {strings.spectatorsTitle}
        </h2>
        {room.spectators.length === 0 ? (
          <p className="muted">{strings.noSpectators}</p>
        ) : (
          <ul className="spectator-list" aria-label={strings.spectatorsTitle}>
            {room.spectators.map((spectator) => (
              <li key={spectator.playerId}>
                {spectator.name}
                {spectator.playerId === you?.playerId && (
                  <span className="tag tag-you">{strings.you}</span>
                )}
                <EmoteBubble seat={null} playerId={spectator.playerId} inline />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
