import { createFileRoute, Link } from '@tanstack/react-router';
import { trpcReact } from '~/trpc';
import { Button } from '~/components/ui/button';
import { authClient } from '~/auth-client';
import { holdsAnyRole } from '~/lib/authz';

export const Route = createFileRoute('/_authenticated/dashboard')({
  component: Dashboard,
});

/** The roles `platform.identity.listPersons` accepts (core plan 04 §9.5). */
const PERSON_READER_ROLES = [
  'administrator',
  'hr_user',
  'director',
  'line_manager',
  'external_administrator',
] as const;

/**
 * Recently added people, for those whose role admits a person read.
 *
 * The rows come from `platform.identity.listPersons`, so record scope and field
 * classification are applied server-side — a Line Manager and an external
 * administrator see different people here, and neither reads a column their
 * classification ceiling excludes. The `grants.mine` check below is **UX only**
 * (ADR-0003): it decides whether to render, never whether access is permitted.
 */
function RecentPeople() {
  const mine = trpcReact.platform.authz.grants.mine.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const canReadPeople = holdsAnyRole(mine.data, [...PERSON_READER_ROLES]);

  const people = trpcReact.platform.identity.listPersons.useQuery(
    { limit: 20, sortDir: 'desc' },
    { enabled: canReadPeople },
  );

  if (!canReadPeople) return null;

  return (
    <section className="rounded-lg border border-border-subtle bg-surface-card p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-semibold text-strong">Recently added people</h2>
        <Link to="/admin/people" className="text-sm text-brand hover:underline">
          View all
        </Link>
      </div>
      {people.isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : people.error ? (
        <p className="text-sm text-status-danger">Failed to load people.</p>
      ) : people.data?.items.length === 0 ? (
        <p className="text-sm text-muted">No people yet.</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {people.data?.items.map((p) => (
            <li key={p.id} className="flex justify-between py-2 text-sm text-body">
              <span>{p.display_name}</span>
              <span className="text-muted">{p.relationship_type}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Dashboard() {
  const { session } = Route.useRouteContext();

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

      <RecentPeople />
    </div>
  );
}
