import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../net/session', () => ({
  client: { identity: {}, setName: vi.fn(), joinRoom: vi.fn() },
  ensureConnected: vi.fn(),
  send: vi.fn(),
}));
vi.mock('../audio', () => ({
  isMuted: () => false,
  loadMuted: () => false,
  play: vi.fn(),
  playAll: vi.fn(),
  setMuted: vi.fn(),
}));

import { useStore } from '../store';
import { resetStore, roomView } from '../test/fixtures';
import { Lobby } from './Lobby';

describe('Lobby spectators (W9)', () => {
  beforeEach(() => {
    resetStore();
  });

  it("shows a spectator's emote next to their name", () => {
    const room = roomView(null, { spectators: [{ playerId: 'watcher', name: 'Sam' }] });
    act(() => useStore.getState().handleMessage({ type: 'room_state', room }));
    render(<Lobby room={room} />);
    act(() =>
      useStore.getState().handleMessage({
        type: 'emote',
        playerId: 'watcher',
        seat: null,
        emote: '👋',
      }),
    );
    const item = within(screen.getByRole('list', { name: 'Watching' })).getByText('Sam');
    expect(item.closest('li')).toHaveTextContent('👋');
  });
});

describe('Lobby while the connection is down', () => {
  beforeEach(() => {
    resetStore();
  });

  it('disables the seat and host controls until the socket is open again', () => {
    // Host at seat 0, Bo at seat 1, seat 2 empty.
    const base = roomView(null);
    const room = {
      ...base,
      seats: base.seats.map((seat) =>
        seat.seat === 2 ? { ...seat, playerId: null, name: null, cardCount: 0 } : seat,
      ),
    };
    useStore.setState({ status: 'reconnecting' });
    const view = render(<Lobby room={room} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit options' }));
    const names = ['Stand up', 'Kick', 'Add bot', 'Fill with bots', 'Save options'];
    for (const name of names) expect(screen.getByRole('button', { name })).toBeDisabled();
    act(() => useStore.setState({ status: 'open' }));
    view.rerender(<Lobby room={room} />);
    for (const name of names) expect(screen.getByRole('button', { name })).toBeEnabled();
  });

  it('disables Remove and Start hand while reconnecting', () => {
    const room = roomView(null, { bots: [2] });
    useStore.setState({ status: 'reconnecting' });
    render(<Lobby room={room} />);
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start hand' })).toBeDisabled();
  });
});
