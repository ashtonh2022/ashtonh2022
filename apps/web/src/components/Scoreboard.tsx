import type { RoomView } from '@landlord/protocol';

import { fmt } from '../lib/format';
import { strings } from '../strings';

export function Scoreboard({ room }: { room: RoomView }) {
  return (
    <section className="panel scoreboard" aria-labelledby="score-title">
      <h2 id="score-title" className="panel-title">
        {strings.scoreboard}
        <span className="muted panel-subtitle">
          {room.handNumber === 1
            ? strings.handPlayedOne
            : fmt(strings.handsPlayed, { n: room.handNumber })}
        </span>
      </h2>
      <table className="score-table">
        <tbody>
          {room.seats.map((seat) => (
            <tr key={seat.seat}>
              <td className="score-name">
                {seat.name ?? strings.emptySeat}
                {seat.playerId === room.you.playerId && (
                  <span className="tag tag-you">{strings.you}</span>
                )}
              </td>
              <td className={seat.score < 0 ? 'score-value negative' : 'score-value'}>
                {seat.score > 0 ? `+${seat.score}` : seat.score}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
