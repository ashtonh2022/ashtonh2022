import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The verification suites brute-force thousands of hands; give them room when every
    // file runs in parallel on a small machine.
    testTimeout: 60_000,
  },
});
