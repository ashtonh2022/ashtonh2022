import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_RULES, kittySizeOptions } from '@landlord/engine';

import { RuleOptions, snapKittySize, withPlayerCount } from './RuleOptions';

describe('RuleOptions', () => {
  it('switching to 4 players offers 4/8/12/16 and resets the kitty to 8', () => {
    const onChange = vi.fn();
    const { rerender } = render(<RuleOptions value={DEFAULT_RULES} onChange={onChange} />);

    expect(screen.getByLabelText(/Kitty size/)).toHaveAttribute('max', '3');
    expect(screen.getByText('3 cards')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '4 players' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0];
    expect(next).toMatchObject({ playerCount: 4, kittySize: 8 });

    rerender(<RuleOptions value={next} onChange={onChange} />);
    expect(kittySizeOptions(4)).toEqual([4, 8, 12, 16]);
    expect(screen.getByText('8 cards')).toBeInTheDocument();
    const slider = screen.getByLabelText(/Kitty size/) as HTMLInputElement;
    expect(slider.value).toBe('1');

    // the tick labels under the slider list the four options
    for (const option of [4, 8, 12, 16]) {
      expect(screen.getByText(String(option))).toBeInTheDocument();
    }

    // moving the slider snaps to an option
    fireEvent.change(slider, { target: { value: '3' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ kittySize: 16 }));
  });

  it('switching back to 3 players resets the kitty to 3', () => {
    expect(withPlayerCount({ ...DEFAULT_RULES, playerCount: 4, kittySize: 16 }, 3)).toMatchObject({
      playerCount: 3,
      kittySize: 3,
    });
    expect(withPlayerCount(DEFAULT_RULES, 3)).toBe(DEFAULT_RULES);
  });

  it('snaps raw kitty sizes to the nearest option', () => {
    expect(snapKittySize(3, 5)).toBe(6);
    expect(snapKittySize(3, 4)).toBe(3);
    expect(snapKittySize(4, 15)).toBe(16);
  });

  it('shows every option with a helper text and a timer between 5 and 120', () => {
    render(<RuleOptions value={DEFAULT_RULES} onChange={() => undefined} />);
    const timer = screen.getByLabelText(/Turn timer/) as HTMLInputElement;
    expect(timer.min).toBe('5');
    expect(timer.max).toBe('120');
    expect(timer.value).toBe('30');
    expect(screen.getByRole('switch', { name: 'Doubling round' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('switch', { name: /Chains may include/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});
