import {
  act as reactAct,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({
  send: vi.fn(),
  joinRoom: vi.fn(),
}));
vi.mock('../net/session', () => ({
  client: { identity: {}, setName: vi.fn(), flushName: vi.fn(), joinRoom: session.joinRoom },
  ensureConnected: vi.fn(),
  send: (message: unknown) => session.send(message),
}));
vi.mock('../audio', () => ({
  isMuted: () => false,
  loadMuted: () => false,
  play: vi.fn(),
  playAll: vi.fn(),
  setMuted: vi.fn(),
}));

import { App } from '../App';
import { Toast } from '../components/Notices';
import { useStore } from '../store';
import { firstBidderCalls, newHand, resetStore, roomView } from '../test/fixtures';
import { Room } from './Room';

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function renderRoom(path = '/room/ABCDEF') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Where />} />
        <Route path="/room/:code" element={<Room />} />
      </Routes>
    </MemoryRouter>,
  );
}

function receive(message: Parameters<ReturnType<typeof useStore.getState>['handleMessage']>[0]) {
  reactAct(() => useStore.getState().handleMessage(message));
}

describe('Room page', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ status: 'open' });
    session.send.mockClear();
    session.joinRoom.mockClear();
  });

  it('shows a terminal state with the server message when the join is refused (W6)', () => {
    renderRoom();
    expect(screen.getByText('Joining room ABCDEF...')).toBeInTheDocument();
    receive({ type: 'error', code: 'room_full', message: 'that room is full' });
    expect(screen.queryByText('Joining room ABCDEF...')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('that room is full');
    expect(screen.getByRole('link', { name: 'Back to the home page' })).toBeInTheDocument();

    session.joinRoom.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(session.joinRoom).toHaveBeenCalledWith('ABCDEF');
    expect(screen.getByText('Joining room ABCDEF...')).toBeInTheDocument();
    receive({ type: 'room_state', room: roomView(null) });
    expect(screen.getByRole('heading', { name: 'Seats' })).toBeInTheDocument();
  });

  it('still shows the not-found page for room_not_found', () => {
    renderRoom();
    receive({ type: 'error', code: 'room_not_found', message: 'no room with that code' });
    expect(screen.getByRole('alert')).toHaveTextContent('That room does not exist or has closed.');
  });

  it('clears the room from the store when the page unmounts (W1)', async () => {
    receive({ type: 'room_state', room: roomView(null) });
    const view = renderRoom();
    expect(screen.getByRole('heading', { name: 'Seats' })).toBeInTheDocument();
    view.unmount();
    await waitFor(() => expect(useStore.getState().room).toBeNull());
  });

  it('asks before leaving a hand and only leaves on confirm (W13)', () => {
    receive({ type: 'room_state', room: roomView(firstBidderCalls(newHand())) });
    renderRoom();
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(
      'Leave the table? A bot will take your seat for the rest of this room.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(session.send).not.toHaveBeenCalledWith({ type: 'leave_room' });
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Leave' }));
    expect(session.send).toHaveBeenCalledWith({ type: 'leave_room' });
    expect(screen.getByTestId('where')).toHaveTextContent('/');
  });

  it('leaves the lobby without asking', () => {
    receive({ type: 'room_state', room: roomView(null) });
    renderRoom();
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(session.send).toHaveBeenCalledWith({ type: 'leave_room' });
  });
});

describe('Toasts (W5)', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ status: 'open' });
  });

  it('does not carry the not-found error over to the home page', () => {
    render(
      <MemoryRouter initialEntries={['/room/ZZZZZZ']}>
        <App />
      </MemoryRouter>,
    );
    receive({ type: 'error', code: 'room_not_found', message: 'no room with that code' });
    fireEvent.click(screen.getByRole('link', { name: 'Back to the home page' }));
    expect(screen.getByRole('heading', { name: 'Landlord' })).toBeInTheDocument();
    expect(screen.queryByText('no room with that code')).toBeNull();
    expect(useStore.getState().lastError).toBeNull();
  });

  it('never shows an error older than four seconds', () => {
    useStore.setState({
      lastError: { code: 'illegal_action', message: 'old news', at: Date.now() - 4500 },
    });
    render(<Toast />);
    expect(screen.queryByText('old news')).toBeNull();
    expect(useStore.getState().lastError).toBeNull();
  });
});

describe('Removed by the host', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStore();
    useStore.setState({ status: 'open' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderApp(path = '/room/ABCDEF') {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  }

  it('sends a kicked player home and tells them why until they dismiss it', () => {
    renderApp();
    receive({ type: 'room_state', room: roomView(firstBidderCalls(newHand()), { seat: 1 }) });
    receive({ type: 'left_room', reason: 'kicked', code: 'ABCDEF' });
    expect(screen.getByRole('heading', { name: 'Create a room' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The host removed you from room ABCDEF.');
    // not a toast: it outlives the page change clean-up and any toast timeout
    reactAct(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole('alert')).toHaveTextContent('The host removed you from room ABCDEF.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/The host removed you/)).toBeNull();
  });

  it.each([
    ['without a reason', { type: 'left_room' } as const],
    ['that says they left', { type: 'left_room', reason: 'left', code: 'ABCDEF' } as const],
  ])('shows nothing on the home page for a plain left_room %s', (_label, message) => {
    renderApp();
    receive({ type: 'room_state', room: roomView(null) });
    receive(message);
    expect(screen.getByRole('heading', { name: 'Create a room' })).toBeInTheDocument();
    reactAct(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/The host removed you/)).toBeNull();
  });

  it('tells a player the host moved them to the spectators until they dismiss it', () => {
    renderApp();
    receive({ type: 'room_state', room: roomView(null, { seat: 1 }) });
    receive({ type: 'room_state', room: roomView(null, { seat: null }) });
    receive({ type: 'notice', notice: 'moved_to_spectators', code: 'ABCDEF' });
    const text =
      'The host moved you to the spectators. You can take a seat again when one is free.';
    expect(screen.getByRole('heading', { name: 'Seats' })).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
    reactAct(() => vi.advanceTimersByTime(60_000));
    receive({ type: 'room_state', room: roomView(null, { seat: null }) });
    expect(screen.getByText(text)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(text)).toBeNull();
  });

  it('drops the spectators notice once the player has a seat again', () => {
    renderApp();
    receive({ type: 'room_state', room: roomView(null, { seat: null }) });
    receive({ type: 'notice', notice: 'moved_to_spectators', code: 'ABCDEF' });
    expect(screen.getByText(/The host moved you to the spectators/)).toBeInTheDocument();
    receive({ type: 'room_state', room: roomView(null, { seat: 2 }) });
    expect(screen.queryByText(/The host moved you to the spectators/)).toBeNull();
  });
});
