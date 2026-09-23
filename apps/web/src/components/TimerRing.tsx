import { fmt } from '../lib/format';
import { secondsLeft } from '../lib/time';
import { strings } from '../strings';

interface TimerRingProps {
  deadline: number;
  turnSeconds: number;
  now: number;
  size?: number;
}

/** A countdown ring around the remaining seconds. */
export function TimerRing({ deadline, turnSeconds, now, size = 36 }: TimerRingProps) {
  // `now` can be a tick (up to 250 ms) older than the deadline: never show "31" for a 30 s turn.
  const left = Math.min(turnSeconds, secondsLeft(deadline, now));
  const total = Math.max(1, turnSeconds * 1000);
  const fraction = Math.max(0, Math.min(1, (deadline - now) / total));
  const radius = (size - 4) / 2;
  const circumference = 2 * Math.PI * radius;
  const urgent = left <= 5;
  return (
    <span
      className={urgent ? 'timer timer-urgent' : 'timer'}
      role="timer"
      aria-label={fmt(strings.timeLeft, { n: left })}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="timer-track" cx={size / 2} cy={size / 2} r={radius} />
        <circle
          className="timer-arc"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="timer-text" aria-hidden="true">
        {left}
      </span>
    </span>
  );
}
