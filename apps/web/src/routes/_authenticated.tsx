import { createFileRoute, Outlet, redirect, useRouter } from '@tanstack/react-router';
import { AppShell } from '~/components/nav/AppShell';
import { authClient } from '~/auth-client';

/**
 * Pathless layout that gates its children on an authenticated session and wraps
 * them in the Connect application shell (sidebar + top bar). UX-only gate — real
 * enforcement lives in `@repo/trpc`.
 */
export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ context }) => {
    if (!context.session) {
      throw redirect({ to: '/login' });
    }
    return { session: context.session };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { session } = Route.useRouteContext();
  const router = useRouter();
  const roleLabel = session.role === 'admin' ? 'Administrator' : 'Agent';
  const signOut = async () => {
    await authClient.signOut();
    await router.navigate({ to: '/login' });
  };
  return (
    <AppShell user={{ name: session.email, role: roleLabel }} onSignOut={() => void signOut()}>
      <Outlet />
    </AppShell>
  );
}
