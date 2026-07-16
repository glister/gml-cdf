import { QueryClient } from '@tanstack/react-query';

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000 },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

/** SSR-safe: a fresh client on the server, a cached singleton in the browser. */
export function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') {
    return makeQueryClient();
  }
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}
