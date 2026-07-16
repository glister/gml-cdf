import { defineConfig } from 'tsup';

// Builds the PRODUCTION Node server (not the client bundle — vite builds that).
export default defineConfig({
  entry: ['src/instrument.ts', 'src/server.prod.ts'],
  format: ['esm'],
  target: 'node24',
  clean: false,
  sourcemap: true,
  noExternal: [/@repo\/(env|db|trpc)$/],
  // The SSR handler is emitted by the vite build; don't bundle it here.
  external: ['./server/entry-server.js'],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});
