import * as React from 'react';
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import type { RouterContext } from '../router.js';
import { trpcReact, makeTrpcReactClient } from '../trpc.js';
import { resolveSession } from '../lib/resolve-session.js';
import appCss from '../app.css?url';

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'cdf-platform' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  beforeLoad: async () => {
    const session = await resolveSession();
    return { session };
  },
  component: RootComponent,
});

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const [trpcClient] = React.useState(() => makeTrpcReactClient());

  return (
    <RootDocument>
      <trpcReact.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <Outlet />
        </QueryClientProvider>
      </trpcReact.Provider>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
