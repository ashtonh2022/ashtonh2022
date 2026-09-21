import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./net/session', () => ({
  client: { identity: {}, setName: vi.fn(), joinRoom: vi.fn() },
  ensureConnected: vi.fn(),
  send: vi.fn(),
}));

import { App } from './App';

describe('App', () => {
  it('renders the home page', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Landlord' })).toBeInTheDocument();
  });

  it('renders the rules page with the Bombs section', () => {
    render(
      <MemoryRouter initialEntries={['/rules']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Bombs' })).toBeInTheDocument();
  });

  it('shows the joining state for a room', () => {
    render(
      <MemoryRouter initialEntries={['/room/abc123']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText('Joining room ABC123...')).toBeInTheDocument();
  });
});
