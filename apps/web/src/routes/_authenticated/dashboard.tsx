import { createFileRoute } from '@tanstack/react-router';
import { trpcReact } from '~/trpc';
import { Button } from '~/components/ui/button';
import { authClient } from '~/auth-client';

export const Route = createFileRoute('/_authenticated/dashboard')({
  component: Dashboard,
});

function Dashboard() {
  const { session } = Route.useRouteContext();
  // Server-side filtered/sorted/keyset-paginated list from the tRPC contract.
  const usersQuery = trpcReact.users.list.useQuery({ limit: 20, sortDir: 'desc' });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 font-sans">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-strong">Dashboard</h1>
          <p className="text-sm text-muted">
            {session?.email} · {session?.role}
          </p>
        </div>
        <Button variant="neutral" size="sm" onClick={() => void authClient.signOut()}>
          Sign out
        </Button>
      </header>

      <section className="rounded-lg border border-border-subtle bg-surface-card p-4">
        <h2 className="mb-2 font-semibold text-strong">Users</h2>
        {usersQuery.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : usersQuery.error ? (
          <p className="text-sm text-status-danger">Failed to load users.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {usersQuery.data?.items.map((u) => (
              <li key={u.id} className="flex justify-between py-2 text-sm text-body">
                <span>{u.email}</span>
                <span className="text-muted">{u.role}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
