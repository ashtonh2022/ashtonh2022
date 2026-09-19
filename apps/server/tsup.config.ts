import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  // Workspace packages are published as TypeScript source, so bundle them in.
  noExternal: ['@landlord/engine', '@landlord/protocol'],
});
