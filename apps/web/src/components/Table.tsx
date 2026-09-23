import type { HandView } from '@landlord/engine';
import type { RoomView } from '@landlord/protocol';

import { seatPositions } from '../lib/seats';
import { useNow } from '../lib/time';
import { send } from '../net/session';
import { useStore } from '../store';
import { strings } from '../strings';
import { EmoteBubble } from './EmoteBubble';
import { HandArea } from './HandArea';
import { OpponentPanel } from './OpponentPanel';
import { ResultPanel } from './ResultPanel';
import { TableCentre } from './TableCentre';

export function Table({ room, hand }: { room: RoomView; hand: HandView }) {
  const now = useNow(room.deadline !== null);
  const positions = seatPositions(room);
  const spectator = room.you.seat === null;
  const bottom = positions.find((entry) => entry.position === 'bottom');
  const others = positions.filter((entry) => entry.position !== 'bottom');
  const finished = hand.phase === 'finished' && hand.result !== null;
  const emptySeats = room.seats.filter((seat) => seat.playerId === null);
  const online = useStore((state) => state.status === 'open');

  return (
    <div className={`table table-${room.seats.length}`}>
      <div className="table-grid">
        {others.map(({ seat, position }) => (
          <OpponentPanel
            key={seat.seat}
            room={room}
            seat={seat}
            hand={hand}
            now={now}
            position={position}
          />
        ))}
        <TableCentre room={room} hand={hand} now={now} />
      </div>

      {room.spectators.length > 0 && (
        <div className="spectator-strip">
          <span className="spectator-strip-label" aria-hidden="true">
            {strings.spectatorsTitle}
          </span>
          <ul className="spectator-strip-list" aria-label={strings.spectatorsTitle}>
            {room.spectators.map((spectator) => (
              <li key={spectator.playerId} className="spectator-chip">
                {spectator.name}
                {spectator.playerId === room.you.playerId && (
                  <span className="tag tag-you">{strings.you}</span>
                )}
                <EmoteBubble seat={null} playerId={spectator.playerId} inline />
              </li>
            ))}
          </ul>
        </div>
      )}

      {spectator ? (
        <section className="you-area spectator-area" aria-label={strings.youAreWatching}>
          <p className="notice">{strings.youAreWatching}</p>
          {bottom && (
            <OpponentPanel room={room} seat={bottom.seat} hand={hand} now={now} position="bottom" />
          )}
          {emptySeats.length > 0 && (
            <div className="button-row">
              {emptySeats.map((seat) => (
                <button
                  key={seat.seat}
                  type="button"
                  className="button button-small"
                  disabled={!online}
                  onClick={() => send({ type: 'sit', seat: seat.seat })}
                >
                  {strings.sit} {seat.seat + 1}
                </button>
              ))}
            </div>
          )}
        </section>
      ) : (
        <HandArea room={room} hand={hand} now={now} />
      )}

      {finished && hand.result && (
        <div className="modal-backdrop">
          <div className="modal">
            <ResultPanel
              room={room}
              result={hand.result}
              showControls={room.status !== 'playing'}
            />
          </div>
        </div>
      )}
    </div>
  );
}
