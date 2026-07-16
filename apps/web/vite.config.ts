import { defineConfig, loadEnv, type Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import react from '@vitejs/plugin-react';
import { parse, z } from '@repo/env';

/**
 * Fails the build early if the client env is misconfigured. Reads env via Vite's
 * `loadEnv` (respecting `envDir` → the repo root) and runs `parse()` on a
 * VITE_API_URL schema in `buildStart`.
 */
function envCheck(): Plugin {
  let env: Record<string, string> = {};
  return {
    name: 'env-check',
    configResolved(config) {
      env = loadEnv(config.mode, config.envDir, '');
    },
    buildStart() {
      parse(z.object({ VITE_API_URL: z.string().min(1) }), env);
    },
  };
}

export default defineConfig({
  plugins: [
    envCheck(),
    tailwindcss(),
    tanstackStart({
      client: { entry: './entry-client.tsx' },
      server: { entry: './entry-server.ts' },
      router: {
        quoteStyle: 'single',
        semicolons: true,
        routeFileIgnorePattern: '__tests__',
      },
    }),
    tsconfigPaths(),
    react(),
  ],
  // Env files live at the repo root (committed .env / .env.test).
  envDir: '../..',
  server: {
    port: 3000,
    host: '0.0.0.0',
    fs: { allow: ['../..'] },
  },
  optimizeDeps: {
    exclude: ['@repo/db', '@repo/env', '@repo/logging', '@repo/trpc'],
  },
});
