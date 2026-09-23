import { useEffect, useMemo, useRef, useState } from 'react';

import type { Card as CardData, Combo, HandAction, HandView } from '@landlord/engine';
import type { RoomView } from '@landlord/protocol';

import { play as playSound } from '../audio';
import { fmt } from '../lib/format';
import { seatName } from '../lib/seats';
import { hintCycle, playableRanks, previewSelection } from '../lib/selection';
import { secondsLeft } from '../lib/time';
import { send } from '../net/session';
import { useStore } from '../store';
import { strings } from '../strings';
import { Card } from './Card';
import { EmoteBubble } from './EmoteBubble';
import { seatIsActing } from './OpponentPanel';
import { TimerRing } from './TimerRing';

interface HandAreaProps {
  room: RoomView;
  hand: HandView;
  now: number;
}

const TICK_FROM_SECONDS = 5;

function cycleKey(hand: CardData[], current: Combo | null): string {
  return `${hand.map((card) => card.id).join(',')}|${
    current ? current.cards.map((card) => card.id).join(',') : ''
  }`;
}

export function HandArea({ room, hand, now }: HandAreaProps) {
  const mySeat = room.you.seat ?? -1;
  const seat = room.seats[mySeat];
  const selection = useStore((state) => state.selection);
  const hintIndex = useStore((state) => state.hintIndex);
  const toggleCard = useStore((state) => state.toggleCard);
  const setSelection = useStore((state) => state.setSelection);
  const clearSelection = useStore((state) => state.clearSelection);
  const setHintIndex = useStore((state) => state.setHintIndex);
  // While the socket is down the table may be out of date: nothing is sent from it.
  const online = useStore((state) => state.status === 'open');
  const [noHint, setNoHint] = useState(false);
  const cycleCache = useRef<{ key: string; plays: Combo[] } | null>(null);

  const legal = hand.legal;
  const rules = hand.rules;
  const current = hand.trick.current;
  const myTurn = hand.phase === 'playing' && legal.canPlay;
  const acting = seatIsActing(room, hand, mySeat);
  const isLandlord = hand.landlord === mySeat;

  const selectedCards = useMemo(
    () => hand.hand.filter((card) => selection.includes(card.id)),
    [hand.hand, selection],
  );
  const preview = useMemo(
    () => previewSelection(selectedCards, myTurn ? current : null, rules),
    [selectedCards, myTurn, current, rules],
  );
  const playable = useMemo(
    () => (myTurn ? playableRanks(hand.hand, current, rules) : null),
    [myTurn, hand.hand, current, rules],
  );

  useEffect(() => {
    setNoHint(false);
  }, [hand.trick.plays.length, hand.turn, hand.phase]);

  // Tick in the last seconds of *your* decision only.
  const left = secondsLeft(room.deadline, now);
  useEffect(() => {
    if (!acting || room.deadline === null) return;
    if (left > 0 && left <= TICK_FROM_SECONDS) playSound('tick');
  }, [left, acting, room.deadline]);

  const showHint = () => {
    if (!online) return;
    const key = cycleKey(hand.hand, current);
    if (!cycleCache.current || cycleCache.current.key !== key) {
      cycleCache.current = { key, plays: hintCycle(hand.hand, current, rules) };
    }
    const plays = cycleCache.current.plays;
    if (plays.length === 0) {
      setNoHint(true);
      clearSelection();
      return;
    }
    const combo = plays[hintIndex % plays.length];
    if (!combo) return;
    setSelection(combo.cards.map((card) => card.id));
    setHintIndex(hintIndex + 1);
    setNoHint(false);
  };

  const playSelection = () => {
    if (!online || !preview.legal || !preview.combo) return;
    send({
      type: 'hand_action',
      action: { type: 'play', cardIds: preview.combo.cards.map((c) => c.id) },
    });
  };

  const act = (action: HandAction) => {
    if (online) send({ type: 'hand_action', action });
  };

  const statusText = (() => {
    if (hand.phase === 'doubling') {
      const mine = hand.doubles[mySeat];
      if (mine === null || mine === undefined) return strings.doubling;
      return mine ? strings.youDoubled : strings.youKept;
    }
    if (hand.phase === 'bidding' || hand.phase === 'playing') {
      if (hand.turn === mySeat) return strings.yourTurn;
      return fmt(strings.waitingFor, { name: seatName(room, hand.turn) });
    }
    return '';
  })();

  const previewText = noHint
    ? strings.noPlayBeats
    : preview.text || (myTurn ? strings.selectCards : '');

  return (
    <section className={`you-area${acting ? ' you-acting' : ''}`} aria-label={strings.yourHand}>
      <div className="you-head">
        <EmoteBubble seat={mySeat} playerId={room.you.playerId} />
        <span className="you-name">
          {seat?.name ?? room.you.name}
          {isLandlord && (
            <span className="tag tag-landlord">
              <span aria-hidden="true">🏠</span> {strings.landlord}
            </span>
          )}
          {hand.phase !== 'doubling' && hand.doubles[mySeat] === true && (
            <span className="tag tag-double">{strings.doubledBadge}</span>
          )}
        </span>
        <span className="you-status" role="status">
          {statusText}
        </span>
        {acting && room.deadline !== null && (
          <TimerRing deadline={room.deadline} turnSeconds={rules.turnSeconds} now={now} />
        )}
      </div>

      <p
        className={`preview${preview.legal ? ' preview-legal' : ''}`}
        data-testid="preview"
        aria-live="polite"
      >
        {previewText}
      </p>

      <div
        className={hand.hand.length > 20 ? 'hand hand-dense' : 'hand'}
        role="group"
        aria-label={strings.yourHand}
      >
        {hand.hand.length === 0 ? (
          <span className="muted small">{strings.yourHandEmpty}</span>
        ) : (
          hand.hand.map((card) => (
            <Card
              key={card.id}
              card={card}
              size="hand"
              selected={selection.includes(card.id)}
              dimmed={playable !== null && !playable.has(card.rank)}
              onToggle={toggleCard}
            />
          ))
        )}
      </div>

      <div className="action-bar">
        {hand.phase === 'bidding' && hand.turn === mySeat && (
          <>
            {legal.canPassBid && (
              <button
                type="button"
                className="button"
                disabled={!online}
                onClick={() => act({ type: 'pass_bid' })}
              >
                {strings.pass}
              </button>
            )}
            {legal.canCall && (
              <button
                type="button"
                className="button button-primary"
                disabled={!online}
                onClick={() => act({ type: 'call' })}
              >
                {strings.call}
              </button>
            )}
            {legal.canRob && (
              <button
                type="button"
                className="button button-primary"
                disabled={!online}
                onClick={() => act({ type: 'rob' })}
              >
                {strings.rob}
              </button>
            )}
            {legal.bids.map((value) => (
              <button
                key={value}
                type="button"
                className="button button-primary"
                disabled={!online}
                onClick={() => act({ type: 'bid', value })}
              >
                {fmt(strings.bidValue, { value })}
              </button>
            ))}
          </>
        )}

        {hand.phase === 'doubling' && legal.canDouble && (
          <>
            <button
              type="button"
              className="button"
              disabled={!online}
              onClick={() => act({ type: 'double', double: false })}
            >
              {strings.keep}
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={!online}
              onClick={() => act({ type: 'double', double: true })}
            >
              {strings.double}
            </button>
          </>
        )}

        {myTurn && (
          <>
            <button
              type="button"
              className="button"
              disabled={!online || !legal.canPass}
              onClick={() => act({ type: 'pass' })}
            >
              {strings.pass}
            </button>
            <button type="button" className="button" disabled={!online} onClick={showHint}>
              {strings.hint}
            </button>
            <button
              type="button"
              className="button"
              disabled={selection.length === 0}
              onClick={clearSelection}
            >
              {strings.clear}
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={!online || !preview.legal}
              onClick={playSelection}
            >
              {strings.play}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
