import { createIsomorphicFn } from '@tanstack/react-start';
import { createTRPCClient, httpBatchLink, type TRPCLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '@repo/trpc';
import { clientEnv } from './env.js';
import { getServerApiUrl } from './env.server.js';

/**
 * Two clients:
 *  - `trpc` (vanilla) for loaders/server functions/tests.
 *  - `trpcReact` for components (React Query integration).
 *
 * SSR calls the internal API URL; the browser calls VITE_API_URL. `fetch` always
 * forces `credentials: 'include'` so the auth cookie is sent. `createIsomorphicFn`
 * keeps the server-only env read out of the client bundle.
 */
const getBaseUrl = createIsomorphicFn()
  .client(() => clientEnv.VITE_API_URL)
  .server(() => getServerApiUrl());

function links(): TRPCLink<AppRouter>[] {
  return [
    httpBatchLink({
      url: `${getBaseUrl()}/trpc`,
      fetch(url, options) {
        return fetch(url, { ...options, credentials: 'include' });
      },
    }),
  ];
}

export const trpc = createTRPCClient<AppRouter>({ links: links() });

export const trpcReact = createTRPCReact<AppRouter>();

export function makeTrpcReactClient() {
  return trpcReact.createClient({ links: links() });
}
