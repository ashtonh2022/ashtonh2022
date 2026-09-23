import { act as reactAct, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HandState } from '@landlord/engine';
import type { RoomView } from '@landlord/protocol';

const send = vi.hoisted(() => vi.fn());
vi.mock('../net/session', () => ({
  client: { identity: {}, setName: vi.fn(), joinRoom: vi.fn() },
  ensureConnected: vi.fn(),
  send: (message: unknown) => send(message),
}));
vi.mock('../audio', () => ({
  isMuted: () => false,
  loadMuted: () => false,
  play: vi.fn(),
  playAll: vi.fn(),
  setMuted: vi.fn(),
}));

import { useStore } from '../store';
import { act, firstBidderCalls, newHand, resetStore, roomView } from '../test/fixtures';
import { Table } from './Table';

function show(room: RoomView) {
  reactAct(() => useStore.getState().handleMessage({ type: 'room_state', room }));
  const current = useStore.getState().room;
  if (!current?.hand) throw new Error('no hand');
  return render(<Table room={current} hand={current.hand} />);
}

function rerenderWith(view: ReturnType<typeof render>, room: RoomView) {
  reactAct(() => useStore.getState().handleMessage({ type: 'room_state', room }));
  const current = useStore.getState().room;
  if (!current?.hand) throw new Error('no hand');
  view.rerender(<Table room={current} hand={current.hand} />);
}

/** Doubling round: seat 0 is the Landlord, seat 1 has already doubled, seats 0 and 2 decide. */
function doublingAfterSeat1(): HandState {
  const state = firstBidderCalls(newHand({ doublingRound: true }));
  expect(state.phase).toBe('doubling');
  return act(state, 1, { type: 'double', double: true });
}

describe('Table: doubling round (W2)', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ status: 'open' });
  });

  it('counts the undecided seats from room.acting and marks only those seats as acting', () => {
    const state = doublingAfterSeat1();
    show(roomView(state, { seat: 0, extra: { acting: [0, 2] } }));
    expect(screen.getByText('Waiting for 2 players')).toBeInTheDocument();
    const bo = screen.getByTestId('seat-1');
    const cy = screen.getByTestId('seat-2');
    expect(bo).not.toHaveClass('opponent-acting');
    expect(within(bo).queryByRole('timer')).toBeNull();
    expect(cy).toHaveClass('opponent-acting');
    expect(within(cy).getByRole('timer')).toBeInTheDocument();
  });

  it('says one player when only you are left', () => {
    const state = act(doublingAfterSeat1(), 2, { type: 'double', double: false });
    show(roomView(state, { seat: 0, extra: { acting: [0] } }));
    expect(screen.getByText('Waiting for 1 player')).toBeInTheDocument();
    expect(screen.getByTestId('seat-2')).not.toHaveClass('opponent-acting');
  });

  it('does not claim a count it cannot know when the server sends no acting list', () => {
    const state = doublingAfterSeat1();
    show(roomView(state, { seat: 0 }));
    expect(screen.queryByText(/Waiting for \d+ player/)).toBeNull();
  });
});

describe('Table: actions while the connection is down (W4)', () => {
  beforeEach(() => {
    resetStore();
    send.mockClear();
  });

  it('disables the play buttons unless the socket is open', () => {
    const state = firstBidderCalls(newHand());
    useStore.setState({ status: 'reconnecting' });
    const view = show(roomView(state, { seat: 0 }));
    for (const name of ['Hint', 'Play', 'Pass']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    reactAct(() => useStore.setState({ status: 'open' }));
    rerenderWith(view, roomView(state, { seat: 0 }));
    expect(screen.getByRole('button', { name: 'Hint' })).toBeEnabled();
  });

  it('disables the bidding buttons unless the socket is open', () => {
    useStore.setState({ status: 'connecting' });
    show(roomView(newHand(), { seat: 0 }));
    expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pass' })).toBeDisabled();
  });

  it('disables Keep and Double unless the socket is open', () => {
    useStore.setState({ status: 'reconnecting' });
    const state = firstBidderCalls(newHand({ doublingRound: true }));
    show(roomView(state, { seat: 1, extra: { acting: [0, 1, 2] } }));
    expect(screen.getByRole('button', { name: 'Keep' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Double' })).toBeDisabled();
  });
});

describe('Table: redeal notice (W11)', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ status: 'open' });
  });

  it('shows the notice when the server says the cards were redealt', () => {
    const state = newHand({ allPass: 'redeal' }, { firstBidder: 1 });
    show(roomView(state, { seat: 0, extra: { redealt: true } }));
    expect(screen.getByText('Everyone passed. New cards were dealt.')).toBeInTheDocument();
  });

  it('detects the redeal itself when the server sends no flag', () => {
    let before = newHand({ allPass: 'redeal' });
    before = act(before, 0, { type: 'pass_bid' });
    before = act(before, 1, { type: 'pass_bid' });
    const view = show(roomView(before, { seat: 0 }));
    expect(screen.queryByText('Everyone passed. New cards were dealt.')).toBeNull();
    rerenderWith(
      view,
      roomView(newHand({ allPass: 'redeal' }, { seed: 'again', firstBidder: 1 }), { seat: 0 }),
    );
    expect(screen.getByText('Everyone passed. New cards were dealt.')).toBeInTheDocument();
  });
});

describe('Table: bidding log (W12)', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ status: 'open' });
  });

  it('explains that the Landlord was chosen because everyone else passed', () => {
    let state = newHand();
    state = act(state, 0, { type: 'pass_bid' });
    state = act(state, 1, { type: 'pass_bid' });
    state = act(state, 2, { type: 'call' });
    expect(state.landlord).toBe(2);
    show(roomView(state, { seat: 0 }));
    expect(screen.getByText('Everyone else passed, so Cy is the Landlord')).toBeInTheDocument();
  });

  it('keeps the plain line when somebody robbed', () => {
    let state = newHand();
    state = act(state, 0, { type: 'call' });
    state = act(state, 1, { type: 'rob' });
    while (state.phase === 'bidding') state = act(state, state.turn, { type: 'pass_bid' });
    show(roomView(state, { seat: 0 }));
    expect(screen.getByText('Bo is the Landlord')).toBeInTheDocument();
  });
});

describe('Table: host kick during play (W10)', () => {
  beforeEach(() => {
    resetStore();
    send.mockClear();
    useStore.setState({ status: 'open' });
  });

  it('asks for confirmation and then sends kick for that seat', () => {
    const state = firstBidderCalls(newHand());
    show(roomView(state, { seat: 0, bots: [2] }));
    // a Kick control on the human opponent only
    expect(within(screen.getByTestId('seat-2')).queryByRole('button', { name: /Kick/ })).toBeNull();
    fireEvent.click(within(screen.getByTestId('seat-1')).getByRole('button', { name: /Kick/ }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(
      'Kick Bo? A bot will play their seat for the rest of the room.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByTestId('seat-1')).getByRole('button', { name: /Kick/ }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Kick' }));
    expect(send).toHaveBeenCalledWith({ type: 'kick', seat: 1 });
  });

  it('offers no Kick while reconnecting, and closes a confirmation the drop interrupted', () => {
    const state = firstBidderCalls(newHand());
    const view = show(roomView(state, { seat: 0 }));
    fireEvent.click(within(screen.getByTestId('seat-1')).getByRole('button', { name: /Kick/ }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    reactAct(() => useStore.setState({ status: 'reconnecting' }));
    rerenderWith(view, roomView(state, { seat: 0 }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(
      within(screen.getByTestId('seat-1')).getByRole('button', { name: /Kick/ }),
    ).toBeDisabled();
    reactAct(() => useStore.setState({ status: 'open' }));
    rerenderWith(view, roomView(state, { seat: 0 }));
    // Back online, nothing pops up again by itself.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('shows no Kick control to other players', () => {
    const state = firstBidderCalls(newHand());
    show(roomView(state, { seat: 1 }));
    expect(screen.queryByRole('button', { name: /Kick/ })).toBeNull();
  });
});

describe('Table: spectators (W9)', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ status: 'open' });
  });

  it('lists spectators and shows their emotes', () => {
    const state = firstBidderCalls(newHand());
    show(roomView(state, { seat: 0, spectators: [{ playerId: 'watcher', name: 'Sam' }] }));
    const strip = screen.getByRole('list', { name: 'Watching' });
    expect(strip).toHaveTextContent('Sam');
    reactAct(() =>
      useStore
        .getState()
        .handleMessage({ type: 'emote', playerId: 'watcher', seat: null, emote: '🔥' }),
    );
    expect(within(strip).getByText('🔥')).toBeInTheDocument();
  });
});
