import { createRouter } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { routeTree } from './routeTree.gen';
import { getQueryClient } from './query-client.js';
import type { SessionData } from './lib/resolve-session.js';

export interface RouterContext {
  queryClient: QueryClient;
  session: SessionData | null;
}

/**
 * The framework calls `getRouter()` (client and server). Builds a QueryClient and
 * seeds the router context; `session` is populated by `__root`'s beforeLoad.
 */
export function getRouter() {
  const queryClient = getQueryClient();

  return createRouter({
    routeTree,
    context: { queryClient, session: null } satisfies RouterContext,
    defaultPreload: 'intent',
    scrollRestoration: true,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
