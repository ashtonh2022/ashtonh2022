import { comboName, type HandView } from '@landlord/engine';
import type { RoomView } from '@landlord/protocol';

import { fmt } from '../lib/format';
import { seatName } from '../lib/seats';
import { BIDDING_LOG_LINGER_MS, useStore } from '../store';
import { strings } from '../strings';
import { CardBack, CardRow } from './Card';
import { lastBidText } from './OpponentPanel';

interface TableCentreProps {
  room: RoomView;
  hand: HandView;
  now: number;
}

function biddingLog(room: RoomView, hand: HandView): string[] {
  return hand.bidding.records
    .map((record) =>
      lastBidText(room, { ...hand, bidding: { ...hand.bidding, records: [record] } }, record.seat),
    )
    .filter((line): line is string => line !== null);
}

export function TableCentre({ room, hand, now }: TableCentreProps) {
  const landlordChosenAt = useStore((state) => state.landlordChosenAt);
  const mySeat = room.you.seat;
  const current = hand.trick.current;
  const showLog =
    hand.phase === 'bidding' ||
    (landlordChosenAt !== null && now - landlordChosenAt < BIDDING_LOG_LINGER_MS);
  const undecided = hand.doubles.filter((choice) => choice === null).length;

  return (
    <div className="centre" data-testid="centre">
      <div className="centre-meta">
        <span className="chip">{fmt(strings.handNumber, { n: hand.handNumber })}</span>
        <span className="chip chip-stake">{fmt(strings.stake, { n: hand.currentStake })}</span>
      </div>

      <div className="kitty" aria-label={strings.kitty}>
        <span className="kitty-label">{strings.kitty}</span>
        {hand.kitty ? (
          <CardRow cards={hand.kitty} size="mini" />
        ) : (
          <span className="card-row card-row-mini">
            {Array.from({ length: hand.kittySize }, (_, index) => (
              <CardBack key={index} size="mini" />
            ))}
          </span>
        )}
      </div>

      {showLog && (
        <div className="bidding-log" role="log" aria-live="polite">
          <span className="bidding-title">{strings.bidding}</span>
          {biddingLog(room, hand).map((line, index) => (
            <span key={index} className="bidding-line">
              {line}
            </span>
          ))}
          {hand.landlord !== null && (
            <span className="bidding-line bidding-landlord">
              {fmt(strings.landlordChosen, { name: seatName(room, hand.landlord) })}
            </span>
          )}
        </div>
      )}

      {hand.phase === 'doubling' && (
        <div className="doubling-status" role="status">
          <span className="bidding-title">{strings.doubling}</span>
          <span>
            {undecided === 0
              ? strings.doublingDone
              : undecided === 1
                ? strings.doublingWaitingOne
                : fmt(strings.doublingWaiting, { n: undecided })}
          </span>
        </div>
      )}

      {hand.phase === 'playing' && (
        <div className="trick" aria-live="polite">
          {current ? (
            <>
              <CardRow cards={current.cards} size="table" className="trick-cards" />
              <span className="trick-name">
                {comboName(current)}
                <span className="muted">
                  {' · '}
                  {fmt(strings.playedBy, { name: seatName(room, hand.trick.currentSeat) })}
                </span>
              </span>
            </>
          ) : (
            <span className="trick-lead">
              {mySeat !== null && hand.turn === mySeat
                ? strings.yourLead
                : fmt(strings.leads, { name: seatName(room, hand.turn) })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
