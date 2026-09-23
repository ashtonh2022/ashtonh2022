import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HandResult } from '@landlord/engine';
import type { RoomView } from '@landlord/protocol';

vi.mock('../net/session', () => ({
  client: { identity: {}, setName: vi.fn(), joinRoom: vi.fn() },
  ensureConnected: vi.fn(),
  send: vi.fn(),
}));

import { useStore } from '../store';
import { resetStore, roomView } from '../test/fixtures';
import { ResultPanel } from './ResultPanel';

/** Seat 0 (Landlord) lost 4 to the Peasants at seats 1 and 2; seat 1 went out. */
const result: HandResult = {
  winnerSide: 'peasants',
  winnerSeat: 1,
  landlord: 0,
  base: 1,
  robs: 0,
  bombs: 0,
  spring: null,
  kittyBonus: 1,
  stake: 2,
  doubled: [false, true, false],
  amounts: [-6, 4, 2],
};

function rowTexts(): string[] {
  return screen.getAllByRole('row').map((row) => row.textContent ?? '');
}

describe('ResultPanel (who the result belongs to)', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ status: 'open' });
  });

  it('lists the players who were dealt the hand, even after a bot took over a seat', () => {
    // Bo left mid-hand; a bot finished for them and still sits at seat 1.
    const base = roomView(null, { status: 'between_hands', bots: [1] });
    const room: RoomView = {
      ...base,
      lastResult: result,
      seats: base.seats.map((seat) =>
        seat.seat === 1 ? { ...seat, playerId: 'bot:Bot Bo', score: 0 } : seat,
      ),
      resultSeats: [
        { seat: 0, playerId: 'p0', name: 'Ada', isBot: false, score: -6 },
        { seat: 1, playerId: 'p1', name: 'Bo', isBot: false, score: 4 },
        { seat: 2, playerId: 'p2', name: 'Cy', isBot: false, score: 2 },
      ],
    };
    render(<ResultPanel room={room} result={result} showControls={false} />);
    expect(rowTexts()).toEqual(['AdaLandlord-6-6', 'Box2+44', 'Cy+22']);
    expect(screen.queryByText(/Bot Bo/)).toBeNull();
    expect(screen.getByText('Bo went out first')).toBeInTheDocument();
    expect(screen.getByText('Bo doubled')).toBeInTheDocument();
  });

  it('says "you" won or lost by the seat you were dealt, not the one you sit in now', () => {
    // Bo was dealt seat 1 and won with the Peasants; after the hand Bo and Ada swapped seats, so
    // Bo now sits where the losing Landlord sat.
    const base = roomView(null, { status: 'between_hands', seat: 0 });
    const room: RoomView = {
      ...base,
      you: { ...base.you, playerId: 'p1', name: 'Bo' },
      lastResult: result,
      seats: base.seats.map((seat) =>
        seat.seat === 0
          ? { ...seat, playerId: 'p1', name: 'Bo', score: 4 }
          : seat.seat === 1
            ? { ...seat, playerId: 'p0', name: 'Ada', score: -6 }
            : seat,
      ),
      resultSeats: [
        { seat: 0, playerId: 'p0', name: 'Ada', isBot: false, score: -6 },
        { seat: 1, playerId: 'p1', name: 'Bo', isBot: false, score: 4 },
        { seat: 2, playerId: 'p2', name: 'Cy', isBot: false, score: 2 },
      ],
    };
    render(<ResultPanel room={room} result={result} showControls={false} />);
    expect(screen.getByText('You win!')).toBeInTheDocument();
    expect(rowTexts()).toEqual(['AdaLandlord-6-6', 'Box2+44', 'Cy+22']);
  });

  it('falls back to the seats for a server that does not say', () => {
    const room: RoomView = { ...roomView(null, { status: 'between_hands' }), lastResult: result };
    render(<ResultPanel room={room} result={result} showControls={false} />);
    expect(rowTexts()).toEqual(['AdaLandlord-60', 'Box2+40', 'Cy+20']);
    expect(screen.getByText('You lose')).toBeInTheDocument();
  });
});
