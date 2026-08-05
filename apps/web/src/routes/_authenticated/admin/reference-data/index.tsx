import { createFileRoute, Link } from '@tanstack/react-router';
import { ChevronRight, Layers, List, Users } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import {
  LOOKUP_LIST_DESCRIPTIONS,
  LOOKUP_LIST_LABELS,
  LOOKUP_LIST_TYPES,
} from '~/lib/reference-data';

export const Route = createFileRoute('/_authenticated/admin/reference-data/')({
  component: ReferenceDataOverview,
});

/**
 * The reference-data overview (core plan 05 §5.3).
 *
 * Its real job is to make the **tier boundary visible to users**, not just to
 * developers: the flat lists live here and are pure data entry, while the
 * behaviour-bearing and composite entities are administered on their own
 * screens. Without that, the first request for "just add a leave type to the
 * list" arrives at the wrong screen — which is the misclassification the SoW
 * calls the biggest risk to this service (§5.3.1).
 */
function ReferenceDataOverview() {
  const counts = trpcReact.platform.lookup.listTypes.useQuery(undefined, {
    staleTime: 60 * 1000,
  });

  const byType = new Map(
    (counts.data ?? []).map((row) => [
      row.list_type,
      { total: Number(row.total), active: Number(row.active) },
    ]),
  );

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <PageHeader
        title="Reference data"
        description="The shared lists every module chooses from. Adding a value is data entry — no release, and it is usable immediately."
      />

      {counts.error ? (
        <Callout tone="danger" title="Couldn’t load the lists">
          {counts.error.message}
        </Callout>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <List size={17} className="text-muted" />
          <h2 className="font-sans text-sm font-bold tracking-tight text-strong">
            Lists (code and label)
          </h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {LOOKUP_LIST_TYPES.map((listType) => {
            const count = byType.get(listType);
            return (
              <Link
                key={listType}
                to="/admin/reference-data/$listType"
                params={{ listType }}
                className="group flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-card p-4 transition-colors hover:border-border-strong hover:bg-gray-50"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="font-sans text-sm font-bold tracking-tight text-strong">
                    {LOOKUP_LIST_LABELS[listType]}
                  </span>
                  <ChevronRight
                    size={16}
                    className="mt-0.5 shrink-0 text-border-strong transition-colors group-hover:text-brand"
                  />
                </div>
                <p className="font-sans text-sm leading-normal text-muted">
                  {LOOKUP_LIST_DESCRIPTIONS[listType]}
                </p>
                <span className="mt-1 font-mono text-2xs uppercase tracking-wide text-muted">
                  {counts.isLoading
                    ? '…'
                    : count
                      ? `${count.active} active${count.total > count.active ? ` · ${count.total - count.active} retired` : ''}`
                      : 'no values yet'}
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Layers size={17} className="text-muted" />
          <h2 className="font-sans text-sm font-bold tracking-tight text-strong">
            Configuration entities
          </h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Link
            to="/admin/teams"
            className="group flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-card p-4 transition-colors hover:border-border-strong hover:bg-gray-50"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="flex items-center gap-2 font-sans text-sm font-bold tracking-tight text-strong">
                <Users size={16} className="text-muted" />
                Teams
              </span>
              <ChevronRight
                size={16}
                className="mt-0.5 shrink-0 text-border-strong transition-colors group-hover:text-brand"
              />
            </div>
            <p className="font-sans text-sm leading-normal text-muted">
              A manager, a deputy, dated membership and a capacity. Not a list — teams point at
              people, so they have their own screen.
            </p>
          </Link>
          <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border-subtle p-4">
            <span className="font-sans text-sm font-bold tracking-tight text-muted">
              Role types, leave types, working patterns, bank holidays
            </span>
            <p className="font-sans text-sm leading-normal text-muted">
              These carry behaviour the system reads — what a leave type deducts, what a role type
              issues — so each gets its own screen when its module is built, never a row on a list
              here.
            </p>
          </div>
        </div>
      </section>

      <Callout tone="info" title="Retire rather than remove">
        Deactivating a value hides it from new entries while every record that already uses it keeps
        displaying its label. Deleting is reserved for a value added by mistake and never used.
      </Callout>
    </div>
  );
}
