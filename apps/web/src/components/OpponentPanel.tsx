import { useEffect, useState } from 'react';

import type { HandView } from '@landlord/engine';
import type { RoomView, SeatView } from '@landlord/protocol';

import { fmt } from '../lib/format';
import type { TablePosition } from '../lib/seats';
import { send } from '../net/session';
import { useStore } from '../store';
import { strings } from '../strings';
import { CardRow } from './Card';
import { ConfirmDialog } from './ConfirmDialog';
import { EmoteBubble } from './EmoteBubble';
import { TimerRing } from './TimerRing';

interface OpponentPanelProps {
  room: RoomView;
  seat: SeatView;
  hand: HandView;
  now: number;
  position: TablePosition;
}

export function lastBidText(room: RoomView, hand: HandView, seat: number): string | null {
  const records = hand.bidding.records.filter((record) => record.seat === seat);
  const last = records[records.length - 1];
  if (!last) return null;
  const name = room.seats[seat]?.name ?? '?';
  switch (last.action) {
    case 'call':
      return fmt(strings.bidCalled, { name });
    case 'rob':
      return fmt(strings.bidRobbed, { name });
    case 'pass':
      return fmt(strings.bidPassed, { name });
    case 'bid':
      return fmt(strings.bidPoints, { name, value: last.value ?? '' });
    default:
      return null;
  }
}

/**
 * Whether `seat` must act right now: its turn, or still undecided in the doubling round. Other
 * seats' doubling choices are hidden until the round ends, so the round relies on the server's
 * `acting` list; without it (older servers) every hidden choice counts as undecided.
 */
export function seatIsActing(room: RoomView, hand: HandView, seat: number): boolean {
  if (hand.phase === 'doubling') {
    if (room.acting) return room.acting.includes(seat);
    return hand.doubles[seat] === null;
  }
  return (hand.phase === 'bidding' || hand.phase === 'playing') && hand.turn === seat;
}

export function OpponentPanel({ room, seat, hand, now, position }: OpponentPanelProps) {
  /** the player the host asked to kick; the question lapses if the seat changes hands */
  const [confirmKickFor, setConfirmKickFor] = useState<string | null>(null);
  // Kick addresses a seat, so it is only sent while connected (see LIVE_ONLY in net/client).
  const online = useStore((state) => state.status === 'open');
  useEffect(() => {
    if (!online) setConfirmKickFor(null);
  }, [online]);
  const isLandlord = hand.landlord === seat.seat;
  const acting = seatIsActing(room, hand, seat.seat);
  const count = hand.cardCounts[seat.seat] ?? seat.cardCount;
  const trickPlays = hand.trick.plays.filter((play) => play.seat === seat.seat);
  const lastPlay = trickPlays[trickPlays.length - 1];
  const doubled = hand.phase !== 'doubling' && hand.doubles[seat.seat] === true;
  const isYou = seat.playerId !== null && seat.playerId === room.you.playerId;
  const canKick = room.you.isHost && !isYou && !seat.isBot && seat.playerId !== null;
  const name = seat.name ?? strings.emptySeat;

  return (
    <div
      className={`opponent opponent-${position}${acting ? ' opponent-acting' : ''}${
        isLandlord ? ' opponent-landlord' : ''
      }`}
      data-testid={`seat-${seat.seat}`}
    >
      <EmoteBubble seat={seat.seat} playerId={seat.playerId} />
      <div className="opponent-head">
        <span className="opponent-name">
          {name}
          {isYou && <span className="tag tag-you">{strings.you}</span>}
        </span>
        {acting && room.deadline !== null && (
          <TimerRing
            deadline={room.deadline}
            turnSeconds={room.rules.turnSeconds}
            now={now}
            size={32}
          />
        )}
      </div>
      <div className="opponent-meta">
        {isLandlord && (
          <span className="tag tag-landlord">
            <span aria-hidden="true">🏠</span> {strings.landlord}
          </span>
        )}
        {seat.isBot && <span className="tag tag-bot">{strings.bot}</span>}
        {doubled && <span className="tag tag-double">{strings.doubledBadge}</span>}
        {!seat.isBot && !seat.connected && (
          <span className="conn-dot" role="img" aria-label={strings.disconnected} />
        )}
        {canKick && (
          <button
            type="button"
            className="kick-button"
            aria-label={fmt(strings.kickName, { name })}
            disabled={!online}
            onClick={() => setConfirmKickFor(seat.playerId)}
          >
            {strings.kick}
          </button>
        )}
        <span className="card-count" aria-label={fmt(strings.cards, { n: count })}>
          <span className="card-count-icon" aria-hidden="true" />
          {count}
        </span>
      </div>
      <div className="opponent-action">
        {hand.phase === 'playing' &&
          lastPlay &&
          (lastPlay.combo ? (
            <CardRow cards={lastPlay.combo.cards} size="mini" />
          ) : (
            <span className="pass-label">{strings.pass}</span>
          ))}
        {hand.phase === 'bidding' && (
          <span className="muted small">{lastBidText(room, hand, seat.seat) ?? ''}</span>
        )}
      </div>
      {confirmKickFor === seat.playerId && canKick && (
        <ConfirmDialog
          message={fmt(strings.kickConfirm, { name })}
          confirmLabel={strings.kick}
          onCancel={() => setConfirmKickFor(null)}
          onConfirm={() => {
            setConfirmKickFor(null);
            send({ type: 'kick', seat: seat.seat });
          }}
        />
      )}
    </div>
  );
}
