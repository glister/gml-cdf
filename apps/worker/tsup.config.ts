import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/instrument.ts'],
  format: ['esm'],
  target: 'node24',
  clean: true,
  sourcemap: true,
  noExternal: [/@repo\/(env|db|trpc)$/],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});
