/**
 * The pages driven by a real GameClient wired to the store the way net/session.ts wires it, over a
 * fake socket: what the player sees and what goes on the wire between page load and the welcome.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@landlord/protocol';

import type { GameClient } from '../net/client';

const session = vi.hoisted(() => {
  const holder = {
    client: null as unknown as GameClient,
    ensureConnected: () => holder.client.connect(),
    send: (message: ClientMessage) => holder.client.send(message),
  };
  return holder;
});
vi.mock('../net/session', () => session);
vi.mock('../audio', () => ({
  isMuted: () => false,
  loadMuted: () => false,
  play: vi.fn(),
  playAll: vi.fn(),
  setMuted: vi.fn(),
}));

import { App } from '../App';
import { GameClient as RealClient, IDENTITY_KEY } from '../net/client';
import { useStore } from '../store';
import { FakeSocket, MemoryStorage } from '../test/fakeSocket';
import { newHand, resetStore, roomView } from '../test/fixtures';

const sockets: FakeSocket[] = [];
let storage: MemoryStorage;

function welcome(name: string, playerId = 'p0'): ServerMessage {
  return { type: 'welcome', playerId, token: 't0', name, protocol: PROTOCOL_VERSION };
}

function socketAt(index: number): FakeSocket {
  const socket = sockets[index];
  if (!socket) throw new Error(`no socket ${index}`);
  return socket;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

function nameInput(): HTMLInputElement {
  return screen.getByLabelText('Your name') as HTMLInputElement;
}

function stored(): unknown {
  return JSON.parse(storage.getItem(IDENTITY_KEY) ?? '{}');
}

/** A client over fake sockets and `storage`, wired to the store like net/session.ts. */
function makeClient(): GameClient {
  return new RealClient({
    url: 'ws://test/ws',
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    storage,
    onMessage: (message) => useStore.getState().handleMessage(message),
    onStatus: (status) => useStore.getState().setStatus(status),
    pingIntervalMs: 0,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
  sockets.length = 0;
  storage = new MemoryStorage();
  session.client = makeClient();
});

afterEach(() => {
  session.client.disconnect();
  vi.useRealTimers();
});

describe('Home: a name typed right after the page loads', () => {
  it.each([
    ['while the change still waits for typing to pause', 0],
    ['after the change was handed to the client', 400],
  ])('is kept and sent when the welcome arrives %s', (_label, waitMs) => {
    renderAt('/');
    act(() => socketAt(0).open());
    fireEvent.change(nameInput(), { target: { value: 'Bob' } });
    act(() => vi.advanceTimersByTime(waitMs));
    act(() => socketAt(0).receive(welcome('Player 1234')));

    expect(nameInput().value).toBe('Bob');
    expect(socketAt(0).parsed()).toEqual([
      { type: 'hello', protocol: PROTOCOL_VERSION },
      { type: 'set_name', name: 'Bob' },
    ]);
    expect(stored()).toEqual({ playerId: 'p0', token: 't0', name: 'Bob' });
  });

  it('reaches the server before a room created before the welcome', () => {
    renderAt('/');
    act(() => socketAt(0).open());
    fireEvent.change(nameInput(), { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    act(() => socketAt(0).receive(welcome('Player 1234')));
    expect(socketAt(0).types()).toEqual(['hello', 'set_name', 'ping', 'create_room']);
    expect(nameInput().value).toBe('Bob');
  });

  it('keeps the exact text in the field while the player is still typing', () => {
    renderAt('/');
    act(() => socketAt(0).open());
    fireEvent.change(nameInput(), { target: { value: 'Bob ' } });
    act(() => socketAt(0).receive(welcome('Player 1234')));
    expect(nameInput().value).toBe('Bob ');
    expect(socketAt(0).parsed()[1]).toEqual({ type: 'set_name', name: 'Bob' });
  });

  it("adopts the server's name when nothing was typed", () => {
    renderAt('/');
    act(() => socketAt(0).open());
    act(() => socketAt(0).receive(welcome('Player 1234')));
    expect(nameInput().value).toBe('Player 1234');
    expect(socketAt(0).types()).toEqual(['hello']);
    expect(stored()).toEqual({ playerId: 'p0', token: 't0', name: 'Player 1234' });
  });

  it("keeps a returning player's stored name", () => {
    storage.setItem(IDENTITY_KEY, JSON.stringify({ playerId: 'p0', token: 't0', name: 'Zed' }));
    session.client = makeClient();
    renderAt('/');
    expect(nameInput().value).toBe('Zed');
    act(() => socketAt(0).open());
    expect(socketAt(0).parsed()[0]).toEqual({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      playerId: 'p0',
      token: 't0',
      name: 'Zed',
    });
    act(() => socketAt(0).receive(welcome('Zed')));
    expect(nameInput().value).toBe('Zed');
    expect(socketAt(0).types()).toEqual(['hello']);
    expect(stored()).toEqual({ playerId: 'p0', token: 't0', name: 'Zed' });
  });
});

describe('Room: actions wait for the welcome', () => {
  it('shows connecting, not connected, between the socket opening and the welcome', () => {
    renderAt('/room/ABCDEF');
    expect(useStore.getState().status).toBe('connecting');
    act(() => socketAt(0).open());
    expect(useStore.getState().status).toBe('connecting');
    expect(screen.getByText('Connecting...')).toBeInTheDocument();
    act(() => socketAt(0).receive(welcome('Ada')));
    expect(useStore.getState().status).toBe('open');
    expect(screen.queryByText('Connecting...')).toBeNull();
    expect(socketAt(0).types()).toEqual(['hello', 'join_room']);
  });

  it('keeps the action buttons disabled after a reconnect until the server welcomes us again', () => {
    renderAt('/room/ABCDEF');
    act(() => socketAt(0).open());
    act(() => socketAt(0).receive(welcome('Ada')));
    act(() => socketAt(0).receive({ type: 'room_state', room: roomView(newHand(), { seat: 0 }) }));
    expect(screen.getByRole('button', { name: 'Call' })).toBeEnabled();

    act(() => socketAt(0).drop());
    expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled();
    act(() => vi.advanceTimersByTime(1000));
    act(() => socketAt(1).open());
    // The socket is open but the server has not accepted us yet: a click would be dropped.
    expect(useStore.getState().status).toBe('reconnecting');
    expect(screen.getByText('Reconnecting...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pass' })).toBeDisabled();

    act(() => socketAt(1).receive(welcome('Ada')));
    expect(screen.getByRole('button', { name: 'Call' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));
    expect(socketAt(1).parsed().at(-1)).toEqual({
      type: 'hand_action',
      action: { type: 'call' },
    });
  });

  it('keeps the lobby host controls disabled after a reconnect until the welcome', () => {
    renderAt('/room/ABCDEF');
    act(() => socketAt(0).open());
    act(() => socketAt(0).receive(welcome('Ada')));
    act(() => socketAt(0).receive({ type: 'room_state', room: roomView(null, { bots: [2] }) }));
    expect(screen.getByRole('button', { name: 'Start hand' })).toBeEnabled();

    act(() => socketAt(0).drop());
    act(() => vi.advanceTimersByTime(1000));
    act(() => socketAt(1).open());
    expect(screen.getByRole('button', { name: 'Start hand' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();

    act(() => socketAt(1).receive(welcome('Ada')));
    expect(screen.getByRole('button', { name: 'Start hand' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
  });
});

describe('Room: kicked while away', () => {
  const kicked: ServerMessage = { type: 'left_room', reason: 'kicked', code: 'ABCDEF' };

  it('goes home and says why when the room link is reopened, without rejoining', () => {
    renderAt('/room/ABCDEF');
    act(() => socketAt(0).open());
    // The server reports a kick from while the player was away before it welcomes them.
    act(() => {
      socketAt(0).receive(kicked);
      socketAt(0).receive(welcome('Bo', 'p1'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('The host removed you from room ABCDEF.');
    expect(screen.getByRole('button', { name: 'Create room' })).toBeInTheDocument();
    expect(socketAt(0).types()).toEqual(['hello']);
  });

  it('goes home and says why when the connection comes back, without rejoining', () => {
    renderAt('/room/ABCDEF');
    act(() => socketAt(0).open());
    act(() => socketAt(0).receive(welcome('Bo', 'p1')));
    act(() => socketAt(0).receive({ type: 'room_state', room: roomView(newHand(), { seat: 1 }) }));
    expect(screen.getByRole('group', { name: 'Your hand' })).toBeInTheDocument();

    act(() => socketAt(0).drop());
    act(() => vi.advanceTimersByTime(1000));
    act(() => socketAt(1).open());
    // Both arrive before React gets to render, as they do from one server tick.
    act(() => {
      socketAt(1).receive(kicked);
      socketAt(1).receive(welcome('Bo', 'p1'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('The host removed you from room ABCDEF.');
    expect(socketAt(1).types()).toEqual(['hello']);
  });

  it('lets the player open that room again from the home page', () => {
    renderAt('/room/ABCDEF');
    act(() => socketAt(0).open());
    act(() => {
      socketAt(0).receive(kicked);
      socketAt(0).receive(welcome('Bo', 'p1'));
    });
    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'abcdef' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(screen.getByText('Joining room ABCDEF...')).toBeInTheDocument();
    expect(socketAt(0).parsed().at(-1)).toEqual({ type: 'join_room', code: 'ABCDEF' });
    act(() => socketAt(0).receive({ type: 'room_state', room: roomView(null, { seat: null }) }));
    expect(screen.getByRole('heading', { name: 'Seats' })).toBeInTheDocument();
    expect(screen.queryByText('The host removed you from room ABCDEF.')).toBeNull();
  });
});

describe('Room: a player who came by the share link names themselves in the lobby', () => {
  function enterLobbyAsNewcomer(): void {
    renderAt('/room/ABCDEF');
    act(() => socketAt(0).open());
    act(() => socketAt(0).receive(welcome('Player 1234', 'watcher')));
    act(() => socketAt(0).receive({ type: 'room_state', room: roomView(null, { seat: null }) }));
  }

  it('shows the name the server gave them and sends the one they type once typing pauses', () => {
    enterLobbyAsNewcomer();
    expect(nameInput().value).toBe('Player 1234');
    fireEvent.change(nameInput(), { target: { value: 'Bo' } });
    act(() => vi.advanceTimersByTime(399));
    expect(socketAt(0).types()).toEqual(['hello', 'join_room']);
    act(() => vi.advanceTimersByTime(1));
    expect(socketAt(0).parsed().at(-1)).toEqual({ type: 'set_name', name: 'Bo' });
    expect(stored()).toEqual({ playerId: 'watcher', token: 't0', name: 'Bo' });
    // The next snapshot does not touch what they typed.
    act(() => socketAt(0).receive({ type: 'room_state', room: roomView(null, { seat: null }) }));
    expect(nameInput().value).toBe('Bo');
  });

  it('sends the name at once when the field loses focus', () => {
    enterLobbyAsNewcomer();
    fireEvent.change(nameInput(), { target: { value: 'Bo' } });
    fireEvent.blur(nameInput());
    expect(socketAt(0).parsed().at(-1)).toEqual({ type: 'set_name', name: 'Bo' });
  });
});
