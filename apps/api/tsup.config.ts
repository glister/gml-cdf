import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/instrument.ts'],
  format: ['esm'],
  target: 'node24',
  clean: true,
  sourcemap: true,
  noExternal: [/@repo\/(env|db|trpc)$/],
  // Some CJS deps (pg, better-auth internals) need `require` in the ESM output.
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});
