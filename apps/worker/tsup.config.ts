import { defineConfig } from 'tsup';

export default defineConfig({
  // publish-sweeps is the entrypoint the scheduled ACA Job runs (core plan 03);
  // kept under src/ so all entries share the base and flatten to dist/*.js.
  entry: ['src/index.ts', 'src/instrument.ts', 'src/publish-sweeps.ts'],
  format: ['esm'],
  target: 'node24',
  clean: true,
  sourcemap: true,
  noExternal: [/@repo\/(env|db|trpc)$/],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});
