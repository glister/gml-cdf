import { createFileRoute, Outlet } from '@tanstack/react-router';
import { requireAdmin } from '~/lib/route-guards';

/**
 * Admin section layout. Gates all `/admin/*` routes on the admin role (UX-only —
 * every procedure under here is an `adminProcedure`, the real boundary).
 */
export const Route = createFileRoute('/_authenticated/admin')({
  beforeLoad: ({ context }) => {
    requireAdmin(context.session);
  },
  component: () => <Outlet />,
});
