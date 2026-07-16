import { createFileRoute } from '@tanstack/react-router';
import { trpcReact } from '../../trpc.js';
import { Button } from '../../components/ui/button.js';
import { authClient } from '../../auth-client.js';

export const Route = createFileRoute('/_authenticated/dashboard')({
  component: Dashboard,
});

function Dashboard() {
  const { session } = Route.useRouteContext();
  // Server-side filtered/sorted/keyset-paginated list from the tRPC contract.
  const usersQuery = trpcReact.users.list.useQuery({ limit: 20, sortDir: 'desc' });

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-zinc-500">
            {session?.email} · {session?.role}
          </p>
        </div>
        <Button variant="outline" onClick={() => void authClient.signOut()}>
          Sign out
        </Button>
      </header>

      <section className="rounded-lg border border-zinc-200 p-4">
        <h2 className="mb-2 font-medium">Users</h2>
        {usersQuery.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : usersQuery.error ? (
          <p className="text-sm text-red-600">Failed to load users.</p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {usersQuery.data?.items.map((u) => (
              <li key={u.id} className="flex justify-between py-2 text-sm">
                <span>{u.email}</span>
                <span className="text-zinc-500">{u.role}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
