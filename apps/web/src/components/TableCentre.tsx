import { comboName, type HandView } from '@landlord/engine';
import type { RoomView } from '@landlord/protocol';

import { fmt } from '../lib/format';
import { seatName } from '../lib/seats';
import { BIDDING_LOG_LINGER_MS, REDEAL_NOTICE_MS, useStore } from '../store';
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

/** The last line of the bidding log; says why a seat became the Landlord when nobody competed. */
function landlordLine(room: RoomView, hand: HandView): string | null {
  if (hand.landlord === null) return null;
  const name = seatName(room, hand.landlord);
  const records = hand.bidding.records;
  const claims = records.filter((record) => record.action !== 'pass');
  const single = claims.length === 1 ? claims[0] : undefined;
  if (single && single.action === 'call' && single.seat === hand.landlord) {
    return fmt(strings.landlordEveryoneElsePassed, { name });
  }
  // points bidding with "Force last bidder": nobody bid, the last bidder had to take it
  if (records.length > 0 && claims.length === 0) {
    return fmt(strings.landlordEveryonePassed, { name });
  }
  return fmt(strings.landlordChosen, { name });
}

/** "Waiting for N players" in the doubling round, from the seats the server says are deciding. */
function doublingText(room: RoomView): string {
  // Other seats' choices are hidden until the round ends, so without the server's list the
  // client cannot know how many are left.
  if (!room.acting) return strings.doublingWaitingUnknown;
  const undecided = room.acting.length;
  if (undecided === 0) return strings.doublingDone;
  if (undecided === 1) return strings.doublingWaitingOne;
  return fmt(strings.doublingWaiting, { n: undecided });
}

export function TableCentre({ room, hand, now }: TableCentreProps) {
  const landlordChosenAt = useStore((state) => state.landlordChosenAt);
  const redealAt = useStore((state) => state.redealAt);
  const mySeat = room.you.seat;
  const current = hand.trick.current;
  const showLog =
    hand.phase === 'bidding' ||
    (landlordChosenAt !== null && now - landlordChosenAt < BIDDING_LOG_LINGER_MS);
  const showRedeal =
    hand.phase === 'bidding' &&
    (room.redealt === true || (redealAt !== null && now - redealAt < REDEAL_NOTICE_MS));
  const chosen = landlordLine(room, hand);

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

      {showRedeal && (
        <p className="redeal-notice" role="status">
          {strings.redealNotice}
        </p>
      )}

      {showLog && (
        <div className="bidding-log" role="log" aria-live="polite">
          <span className="bidding-title">{strings.bidding}</span>
          {biddingLog(room, hand).map((line, index) => (
            <span key={index} className="bidding-line">
              {line}
            </span>
          ))}
          {chosen !== null && <span className="bidding-line bidding-landlord">{chosen}</span>}
        </div>
      )}

      {hand.phase === 'doubling' && (
        <div className="doubling-status" role="status">
          <span className="bidding-title">{strings.doubling}</span>
          <span>{doublingText(room)}</span>
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
