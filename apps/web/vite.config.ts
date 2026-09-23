import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // docs/RULES.md is imported as raw text by the rules page
    fs: { allow: [repoRoot] },
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/healthz': { target: 'http://localhost:8080' },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
