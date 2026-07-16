import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts', 'init.ts'],
  format: ['esm'],
  target: 'node24',
  dts: true,
  clean: true,
  sourcemap: true,
  noExternal: [/@repo\/(env|db|trpc)$/],
});
