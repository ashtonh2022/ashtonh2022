import type { HandView } from '@landlord/engine';
import type { RoomView, SeatView } from '@landlord/protocol';

import { fmt } from '../lib/format';
import type { TablePosition } from '../lib/seats';
import { strings } from '../strings';
import { CardRow } from './Card';
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

/** Whether `seat` must act right now (its turn, or still undecided in the doubling round). */
export function seatIsActing(hand: HandView, seat: number): boolean {
  if (hand.phase === 'doubling') return hand.doubles[seat] === null;
  return (hand.phase === 'bidding' || hand.phase === 'playing') && hand.turn === seat;
}

export function OpponentPanel({ room, seat, hand, now, position }: OpponentPanelProps) {
  const isLandlord = hand.landlord === seat.seat;
  const acting = seatIsActing(hand, seat.seat);
  const count = hand.cardCounts[seat.seat] ?? seat.cardCount;
  const trickPlays = hand.trick.plays.filter((play) => play.seat === seat.seat);
  const lastPlay = trickPlays[trickPlays.length - 1];
  const doubled = hand.phase !== 'doubling' && hand.doubles[seat.seat] === true;
  const isYou = seat.playerId !== null && seat.playerId === room.you.playerId;

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
          {seat.name ?? strings.emptySeat}
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
    </div>
  );
}
