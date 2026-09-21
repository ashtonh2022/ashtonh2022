import { randomBytes } from 'node:crypto';

export type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Everything time-related the rooms need, so tests can drive them with fake timers or a stub.
 * The system clock looks the globals up on every call, which is what makes `vi.useFakeTimers`
 * work without any extra wiring.
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
};

/** A source of numbers in [0, 1), like Math.random. Injected so tests can seed it. */
export type RandomSource = () => number;

/** Unpredictable randomness (room codes, shuffle seeds) from the OS entropy pool. */
export const secureRandom: RandomSource = () => randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
