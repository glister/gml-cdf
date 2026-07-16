import { parse, z } from '@repo/env';

/**
 * Client env for the mobile app.
 *
 * Expo statically inlines `EXPO_PUBLIC_*` references at build time, so every var
 * must be referenced literally here — a dynamic `process.env[key]` read would not
 * be inlined. This module is the single sanctioned `process.env` touch-point,
 * mirroring the web app's `env.client.ts`.
 */
const schema = z.object({
  EXPO_PUBLIC_API_URL: z.string().url(),
});

export const env = parse(schema, {
  // eslint-disable-next-line @repo/no-process-env -- Expo inlines EXPO_PUBLIC_* at build; @repo/env is the env boundary
  EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
});
