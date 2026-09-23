import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  // Bundle every dependency (workspace packages, zod, ws) so the runtime image needs no
  // node_modules. tsup checks `noExternal` before `external`, so the pattern itself must leave
  // out the optional native add-ons that `ws` probes for; they are then kept external.
  noExternal: [/^(?!bufferutil$|utf-8-validate$).*/],
  external: ['bufferutil', 'utf-8-validate'],
  // `ws` only requires the native add-ons when these are unset; defining them removes the
  // probes from the bundle altogether, so nothing looks for them at runtime.
  define: {
    'process.env.WS_NO_BUFFER_UTIL': '"1"',
    'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
  },
  // CommonJS dependencies (ws) call require() for Node built-ins; give the ESM bundle one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
});
