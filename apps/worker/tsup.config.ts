import { defineConfig } from 'tsup';

export default defineConfig({
  // Three entrypoints share this image, so the Jobs that run them need no
  // separate build: `index` is the long-running consumer + relay, `scheduler` is
  // the core plan 07 cron Job draining due `scheduled_action` rows, and
  // `publish-sweeps` is core plan 03's daily identity sweeps. All kept under
  // src/ so they share the base and flatten to dist/*.js.
  entry: ['src/index.ts', 'src/instrument.ts', 'src/scheduler.ts', 'src/publish-sweeps.ts'],
  format: ['esm'],
  target: 'node24',
  clean: true,
  sourcemap: true,
  noExternal: [/@repo\/(env|db|trpc|config|workflow)$/],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});
