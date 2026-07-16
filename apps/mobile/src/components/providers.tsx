import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { makeQueryClient } from '@/lib/query-client';
import { makeTrpcClient, trpcReact } from '@/lib/trpc';

/** App-wide providers: tRPC + TanStack Query. Clients are created once per launch
 * (useState initialiser) so they survive re-renders. */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  const [trpcClient] = useState(makeTrpcClient);

  return (
    <trpcReact.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpcReact.Provider>
  );
}
