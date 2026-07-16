import { QueryClient } from '@tanstack/react-query';

/** A fresh QueryClient. On mobile there is no SSR, so this is created once per app
 * launch inside the Providers component. */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 2 },
    },
  });
}
