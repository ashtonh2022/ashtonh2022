import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TimerRing } from './TimerRing';

describe('TimerRing', () => {
  it('never shows more seconds than the turn has, even with a clock read just before the deadline was set', () => {
    // useNow ticks every 250 ms, so the first render of a fresh deadline can use a `now` from
    // up to 250 ms earlier: 30.2 s "left" of a 30 s turn.
    const now = 1_000_000;
    render(<TimerRing deadline={now + 30_200} turnSeconds={30} now={now} />);
    const timer = screen.getByRole('timer');
    expect(timer).toHaveTextContent('30');
    expect(timer).toHaveAccessibleName('30 seconds left');
  });

  it('counts down in whole seconds, rounding up', () => {
    const now = 1_000_000;
    render(<TimerRing deadline={now + 4_100} turnSeconds={30} now={now} />);
    expect(screen.getByRole('timer')).toHaveTextContent('5');
  });
});
