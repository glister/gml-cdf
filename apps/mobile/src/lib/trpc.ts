import { createTRPCClient, httpBatchLink, type TRPCLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '@repo/trpc';
import { env } from '../env';
import { authClient } from './auth-client';

/**
 * `@repo/trpc` is imported type-only here — the `AppRouter` type is the API
 * contract. Do NOT import runtime values from the `@repo/trpc` barrel on the
 * client: it re-exports the server router, which would pull server code (and
 * Kysely/DB) into the mobile bundle. Import specific schema modules if you need
 * shared Zod schemas at runtime.
 */
export const trpcReact = createTRPCReact<AppRouter>();

function links(): TRPCLink<AppRouter>[] {
  return [
    httpBatchLink({
      url: `${env.EXPO_PUBLIC_API_URL}/trpc`,
      headers() {
        // Better Auth (Expo) stores the session cookie in SecureStore; RN's fetch
        // does not attach it automatically, so send it explicitly.
        const cookie = authClient.getCookie();
        return cookie ? { Cookie: cookie } : {};
      },
    }),
  ];
}

/** React client (TanStack Query integration) — created inside Providers. */
export function makeTrpcClient() {
  return trpcReact.createClient({ links: links() });
}

/** Vanilla client for non-React usage (utilities, one-off calls). */
export const trpc = createTRPCClient<AppRouter>({ links: links() });
