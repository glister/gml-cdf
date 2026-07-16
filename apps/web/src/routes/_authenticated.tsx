import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

/**
 * Pathless layout that gates its children on an authenticated session. UX-only —
 * real enforcement lives in `@repo/trpc`.
 */
export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ context }) => {
    if (!context.session) {
      throw redirect({ to: '/login' });
    }
    return { session: context.session };
  },
  component: () => <Outlet />,
});
