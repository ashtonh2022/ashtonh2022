import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('../net/session', () => ({
  client: { identity: {}, setName: vi.fn(), joinRoom: vi.fn() },
  ensureConnected: vi.fn(),
  send: (message: unknown) => send(message),
}));

import { Home, normalizeCode } from './Home';

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Home />
    </MemoryRouter>,
  );
}

describe('Home', () => {
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
});
