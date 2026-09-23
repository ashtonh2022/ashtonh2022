import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { resetStore, roomView } from '../test/fixtures';
import { ChatPanel } from './Chat';

function setup() {
  const room = roomView(null);
  act(() => useStore.getState().handleMessage({ type: 'room_state', room }));
  useStore.setState({ chatOpen: true, status: 'open' });
  render(<ChatPanel room={room} />);
  const input = screen.getByRole('textbox', { name: 'Say something...' }) as HTMLInputElement;
  const say = (text: string) => {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
  };
  return { input, say };
}

describe('ChatPanel rate limit (W14)', () => {
  beforeEach(() => {
    resetStore();
    send.mockClear();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the sixth message in five seconds instead of sending it', () => {
    const { input, say } = setup();
    for (let i = 1; i <= 5; i++) say(`msg ${i}`);
    expect(send).toHaveBeenCalledTimes(5);
    expect(input.value).toBe('');

    fireEvent.change(input, { target: { value: 'msg 6' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText('Slow down a moment')).toBeInTheDocument();
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(send).toHaveBeenCalledTimes(5);
    expect(input.value).toBe('msg 6');

    act(() => {
      vi.advanceTimersByTime(5_500);
    });
    expect(screen.queryByText('Slow down a moment')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(send).toHaveBeenLastCalledWith({ type: 'chat', text: 'msg 6' });
  });

  it('puts the text back when the server still says rate_limited', () => {
    const { input, say } = setup();
    say('hello there');
    expect(input.value).toBe('');
    act(() =>
      useStore.getState().handleMessage({
        type: 'error',
        code: 'rate_limited',
        message: 'too many messages, slow down',
      }),
    );
    expect(input.value).toBe('hello there');
  });
});
