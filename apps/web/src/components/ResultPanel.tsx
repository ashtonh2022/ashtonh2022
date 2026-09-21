import type { HandResult } from '@landlord/engine';
import type { RoomView } from '@landlord/protocol';

import { fmt } from '../lib/format';
import { seatName } from '../lib/seats';
import { send } from '../net/session';
import { strings } from '../strings';

interface ResultPanelProps {
  room: RoomView;
  result: HandResult;
  /** show "Next hand" / "Waiting for host" */
  showControls: boolean;
}

function points(n: number): string {
  return n >= 0 ? fmt(strings.pointsPlus, { n }) : fmt(strings.pointsMinus, { n: Math.abs(n) });
}

export function ResultPanel({ room, result, showControls }: ResultPanelProps) {
  const mySeat = room.you.seat;
  const iAmLandlord = mySeat !== null && mySeat === result.landlord;
  const landlordWon = result.winnerSide === 'landlord';
  const iWon = mySeat === null ? null : landlordWon === iAmLandlord;
  const handNumber = room.hand?.handNumber ?? room.handNumber;
  const doublers = result.doubled
    .map((doubled, seat) => (doubled ? seatName(room, seat) : null))
    .filter((name): name is string => name !== null);

  const lines: Array<{ label: string; value: string }> = [
    { label: strings.breakdownBase, value: fmt(strings.multiplier, { n: result.base }) },
  ];
  if (result.robs > 0) {
    lines.push({
      label: fmt(strings.breakdownRobs, { n: result.robs }),
      value: fmt(strings.multiplier, { n: 2 ** result.robs }),
    });
  }
  if (result.bombs > 0) {
    lines.push({
      label: fmt(strings.breakdownBombs, { n: result.bombs }),
      value: fmt(strings.multiplier, { n: 2 ** result.bombs }),
    });
  }
  if (result.spring) {
    lines.push({
      label: result.spring === 'spring' ? strings.breakdownSpring : strings.breakdownAntiSpring,
      value: fmt(strings.multiplier, { n: 2 }),
    });
  }
  if (result.kittyBonus > 1) {
    lines.push({
      label: strings.breakdownKittyBonus,
      value: fmt(strings.multiplier, { n: result.kittyBonus }),
    });
  }
  for (const name of doublers) {
    lines.push({
      label: fmt(strings.breakdownDoubled, { name }),
      value: fmt(strings.multiplier, { n: 2 }),
    });
  }

  return (
    <section className="panel result-panel" aria-labelledby="result-title" data-testid="result">
      <h2 id="result-title" className="panel-title">
        {fmt(strings.resultTitle, { n: handNumber })}
      </h2>
      <p className={`result-headline${iWon === null ? '' : iWon ? ' result-win' : ' result-lose'}`}>
        {landlordWon ? strings.landlordWins : strings.peasantsWin}
        {iWon !== null && (
          <span className="result-you">{iWon ? strings.youWin : strings.youLose}</span>
        )}
      </p>
      <p className="muted">{fmt(strings.wentOut, { name: seatName(room, result.winnerSeat) })}</p>

      <dl className="breakdown">
        {lines.map((line) => (
          <div key={line.label} className="breakdown-row">
            <dt>{line.label}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
        <div className="breakdown-row breakdown-total">
          <dt>{strings.breakdownStake}</dt>
          <dd>{result.stake}</dd>
        </div>
      </dl>

      <table className="score-table">
        <tbody>
          {room.seats.map((seat) => (
            <tr key={seat.seat}>
              <td className="score-name">
                {seat.name ?? strings.emptySeat}
                {seat.seat === result.landlord && (
                  <span className="tag tag-landlord">{strings.landlord}</span>
                )}
                {result.doubled[seat.seat] && (
                  <span className="tag tag-double">{strings.doubledBadge}</span>
                )}
              </td>
              <td
                className={
                  (result.amounts[seat.seat] ?? 0) < 0 ? 'score-value negative' : 'score-value'
                }
              >
                {points(result.amounts[seat.seat] ?? 0)}
              </td>
              <td className="score-running muted">{seat.score}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">{strings.runningScore}</p>

      {showControls && (
        <div className="start-row">
          {room.you.isHost ? (
            <button
              type="button"
              className="button button-primary button-block"
              disabled={!room.seats.every((seat) => seat.playerId !== null)}
              onClick={() => send({ type: 'start_hand' })}
            >
              {strings.nextHand}
            </button>
          ) : (
            <p className="muted">{strings.waitingForHost}</p>
          )}
        </div>
      )}
    </section>
  );
}
