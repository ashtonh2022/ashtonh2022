import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('../net/session', () => ({
  client: { identity: {}, setName: vi.fn(), joinRoom: vi.fn() },
  ensureConnected: vi.fn(),
  send: (message: unknown) => send(message),
}));

import { useStore } from '../store';
import { resetStore, roomView } from '../test/fixtures';
import { Home, normalizeCode } from './Home';

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function renderWithRoutes() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/room/:code" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

function receive(message: Parameters<ReturnType<typeof useStore.getState>['handleMessage']>[0]) {
  act(() => useStore.getState().handleMessage(message));
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Home />
    </MemoryRouter>,
  );
}

describe('Home', () => {
  beforeEach(() => {
    resetStore();
    send.mockClear();
  });

  it('renders the create and join cards and a rules link that opens a new tab', () => {
    renderHome();
    expect(screen.getByRole('heading', { name: 'Landlord' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create a room' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create room' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Join a room' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'How to play' });
    expect(link).toHaveAttribute('href', '/rules');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener');
  });

  it('sends create_room with the chosen rules', () => {
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: '4 players' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect(send).toHaveBeenCalledWith({
      type: 'create_room',
      rules: expect.objectContaining({ playerCount: 4, kittySize: 8 }),
    });
    expect(screen.getByRole('button', { name: 'Creating room...' })).toBeDisabled();
  });

  it('uppercases and limits the room code', () => {
    renderHome();
    const input = screen.getByLabelText('Room code') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ab c1-2z9' } });
    expect(input.value).toBe('ABC12Z');
    expect(screen.getByRole('button', { name: 'Join' })).toBeEnabled();
    expect(normalizeCode('xy')).toBe('XY');
  });

  it('navigates to the room this click created, not a stale room still in the store (W1)', () => {
    // a returning player: the server re-attached them to OLDOLD and broadcast it after hello
    receive({ type: 'room_state', room: roomView(null, { code: 'OLDOLD' }) });
    renderWithRoutes();
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect(send.mock.calls.map(([message]) => message.type)).toEqual(['ping', 'create_room']);
    expect(screen.queryByTestId('where')).toBeNull();
    // another broadcast of the old room still in flight
    receive({ type: 'room_state', room: roomView(null, { code: 'OLDOLD' }) });
    expect(screen.queryByTestId('where')).toBeNull();
    receive({ type: 'pong' });
    receive({ type: 'left_room' });
    receive({ type: 'room_state', room: roomView(null, { code: 'NEWNEW' }) });
    expect(screen.getByTestId('where')).toHaveTextContent('/room/NEWNEW');
  });

  it('ignores the old room even after the store let go of it (W1)', () => {
    receive({ type: 'room_state', room: roomView(null, { code: 'OLDOLD' }) });
    act(() => useStore.getState().clearRoom());
    renderWithRoutes();
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    receive({ type: 'room_state', room: roomView(null, { code: 'OLDOLD' }) });
    expect(screen.queryByTestId('where')).toBeNull();
    receive({ type: 'pong' });
    // a room where somebody else is host is not the one we created
    receive({ type: 'room_state', room: roomView(null, { code: 'THEIRS', hostSeat: 1 }) });
    expect(screen.queryByTestId('where')).toBeNull();
    receive({ type: 'room_state', room: roomView(null, { code: 'NEWNEW' }) });
    expect(screen.getByTestId('where')).toHaveTextContent('/room/NEWNEW');
  });

  it('ignores the old room of a returning player who clicked before the welcome', () => {
    // A fresh load of "/": the store knows no room yet and the click is queued until the welcome.
    renderWithRoutes();
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect(send.mock.calls.map(([message]) => message.type)).toEqual(['ping', 'create_room']);
    // The server answers hello, puts the player back into their old room (they host it), then
    // answers the ping and only then the create_room.
    receive({ type: 'welcome', playerId: 'p0', token: 't', name: 'Ada', protocol: 1 });
    receive({ type: 'room_state', room: roomView(null, { code: 'OLDOLD' }) });
    expect(screen.queryByTestId('where')).toBeNull();
    receive({ type: 'pong' });
    receive({ type: 'left_room' });
    receive({ type: 'room_state', room: roomView(null, { code: 'NEWNEW' }) });
    expect(screen.getByTestId('where')).toHaveTextContent('/room/NEWNEW');
  });

  it('goes to the new room of a player who was in no room', () => {
    renderWithRoutes();
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    receive({ type: 'welcome', playerId: 'p0', token: 't', name: 'Ada', protocol: 1 });
    receive({ type: 'pong' });
    receive({ type: 'room_state', room: roomView(null, { code: 'NEWNEW' }) });
    expect(screen.getByTestId('where')).toHaveTextContent('/room/NEWNEW');
  });
});
