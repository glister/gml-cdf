import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/trpc';
import { ChevronDown, ChevronRight, ChevronsUpDown, ChevronUp, Search } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { StatusPill } from '~/components/data-display/StatusPill';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';
import { formatInstant, instanceTone, shortWorkflowKey } from '~/lib/workflow';

export const Route = createFileRoute('/_authenticated/admin/workflow/instances/')({
  component: WorkflowInstances,
});

type InstanceRow =
  inferRouterOutputs<AppRouter>['platform']['workflow']['listInstances']['items'][number];
type SortKey = 'created_at' | 'updated_at';

const columnHelper = createColumnHelper<InstanceRow>();

/**
 * The workflow instance list (core plan 07 §5.7, WF-5).
 *
 * The runtime is substrate, not a product surface — nobody comes here to do
 * their job. They come to answer an operational question: what is running, what
 * is stuck, and where did this case get to. So the screen is deliberately plain,
 * and its one piece of judgement is in the colouring: a state pill is tinted by
 * whether the case is still **running**, never by whether its state name sounds
 * good. The runtime executes shapes it knows nothing about, and `rejected` on an
 * expenses claim is a routine outcome, not a failure.
 *
 * Every facet is applied in SQL by `platform.workflow.listInstances` and the
 * table runs in manual mode over one keyset page — nothing here sorts or filters
 * the fetched rows.
 */
function WorkflowInstances() {
  const [searchInput, setSearchInput] = React.useState('');
  const [workflowKey, setWorkflowKey] = React.useState('');
  const [currentState, setCurrentState] = React.useState('');
  const [activity, setActivity] = React.useState<'' | 'active' | 'completed'>('active');
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'created_at',
    dir: 'desc',
  });
  // Forward-only keyset cursors: the stack holds the cursor of each page beyond
  // the first (empty = first page). Next pushes nextCursor; Prev pops.
  const [cursorStack, setCursorStack] = React.useState<string[]>([]);
  const cursor = cursorStack[cursorStack.length - 1];

  React.useEffect(() => {
    const t = setTimeout(() => setWorkflowKey(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // The encoded cursor is tied to the current sort expression, so any change to
  // the query except the cursor itself starts again from the first page.
  React.useEffect(() => {
    setCursorStack([]);
  }, [workflowKey, currentState, activity, sort.key, sort.dir]);

  const query = trpcReact.platform.workflow.listInstances.useQuery({
    limit: 25,
    sort: sort.key,
    sortDir: sort.dir,
    cursor,
    workflowKey: workflowKey || undefined,
    currentState: currentState || undefined,
    active: activity === '' ? undefined : activity === 'active',
  });

  const columns = React.useMemo(
    () => [
      columnHelper.accessor('workflow_key', {
        id: 'workflow_key',
        header: 'Workflow',
        cell: (info) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-sm font-semibold tracking-tight text-strong">
              {shortWorkflowKey(info.getValue())}
            </span>
            <span className="font-sans text-2xs text-muted">
              Version {info.row.original.definition_version}
            </span>
          </div>
        ),
      }),
      columnHelper.accessor('current_state', {
        id: 'current_state',
        header: 'State',
        cell: (info) => (
          <StatusPill tone={instanceTone(info.row.original.completed_at)}>
            {info.getValue()}
          </StatusPill>
        ),
      }),
      columnHelper.display({
        id: 'subject',
        header: 'About',
        cell: (info) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-sm text-body">
              {info.row.original.subject_stream_type}
            </span>
            <span className="font-mono text-2xs text-muted">
              {info.row.original.subject_stream_id.slice(0, 8)}…
            </span>
          </div>
        ),
      }),
      columnHelper.accessor('created_at', {
        id: 'created_at',
        header: 'Started',
        meta: { sortKey: 'created_at' as SortKey },
        cell: (info) => (
          <div className="flex flex-col">
            <span className="whitespace-nowrap font-mono text-sm text-muted">
              {formatInstant(info.getValue())}
            </span>
            <span className="font-sans text-2xs text-muted">
              {info.row.original.started_by_name ?? 'System'}
            </span>
          </div>
        ),
      }),
      columnHelper.accessor('updated_at', {
        id: 'updated_at',
        header: 'Last moved',
        meta: { sortKey: 'updated_at' as SortKey },
        cell: (info) => (
          <span className="whitespace-nowrap font-mono text-sm text-muted">
            {formatInstant(info.getValue())}
          </span>
        ),
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        cell: () => <ChevronRight size={16} className="shrink-0 text-border-strong" />,
      }),
    ],
    [],
  );

  const rows = query.data?.items ?? [];
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    // Server-side everything: the table renders exactly the page it is given.
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
  });

  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' },
    );

  const hasNext = Boolean(query.data?.nextCursor);
  const hasPrev = cursorStack.length > 0;

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <PageHeader
        title="Workflow instances"
        description="Every case the workflow runtime is driving — approvals, onboarding chains, absence lifecycles. Each one is pinned to the version of its definition it started on, and every move it has made is recorded."
      />

      {query.error && (
        <Callout tone="danger" title="Couldn’t load the instances">
          {query.error.message}
        </Callout>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-md border border-border-default bg-surface-card px-3 focus-within:border-border-focus focus-within:ring-2 focus-within:ring-brand/40">
            <Search size={16} className="shrink-0 text-muted" />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Workflow key, e.g. platform.demo.request"
              aria-label="Filter by workflow key"
              className="min-w-0 flex-1 bg-transparent font-sans text-sm text-strong outline-none"
            />
          </div>
          <input
            type="search"
            value={currentState}
            onChange={(e) => setCurrentState(e.target.value)}
            placeholder="State"
            aria-label="Filter by state"
            className="h-9 w-[150px] rounded-md border border-border-default bg-surface-card px-3 font-sans text-sm text-strong outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          />
          <select
            aria-label="Filter by activity"
            value={activity}
            onChange={(e) => setActivity(e.target.value as '' | 'active' | 'completed')}
            className="h-9 rounded-md border border-border-default bg-surface-card px-3 font-sans text-sm text-body outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <option value="active">Still running</option>
            <option value="completed">Completed</option>
            <option value="">Running and completed</option>
          </select>
        </div>

        <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface-card">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id} className="border-b border-border-subtle">
                    {hg.headers.map((header) => {
                      const sortKey = (
                        header.column.columnDef.meta as { sortKey?: SortKey } | undefined
                      )?.sortKey;
                      const active = sortKey && sort.key === sortKey;
                      return (
                        <th
                          key={header.id}
                          className="whitespace-nowrap px-4 py-3 text-left font-sans text-xs font-semibold uppercase tracking-wide text-muted"
                        >
                          {sortKey ? (
                            <button
                              type="button"
                              onClick={() => toggleSort(sortKey)}
                              className="inline-flex items-center gap-1 text-muted transition-colors hover:text-body"
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              {active ? (
                                sort.dir === 'asc' ? (
                                  <ChevronUp size={14} className="text-brand" />
                                ) : (
                                  <ChevronDown size={14} className="text-brand" />
                                )
                              ) : (
                                <ChevronsUpDown size={14} className="text-border-strong" />
                              )}
                            </button>
                          ) : (
                            flexRender(header.column.columnDef.header, header.getContext())
                          )}
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {query.isLoading ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="px-4 py-10 text-center font-sans text-sm text-muted"
                    >
                      Loading instances…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="px-4 py-10 text-center font-sans text-sm text-muted"
                    >
                      {workflowKey || currentState || activity !== 'active'
                        ? 'No instances match these filters.'
                        : 'Nothing is running. Instances appear here as soon as a process starts one.'}
                    </td>
                  </tr>
                ) : (
                  table.getRowModel().rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-border-subtle transition-colors last:border-0 hover:bg-gray-50"
                    >
                      {row.getVisibleCells().map((cell, i) => (
                        <td key={cell.id} className="p-0 align-middle">
                          {/* The whole row is the link, but each cell gets its
                              own anchor so the table markup stays valid. */}
                          <Link
                            to="/admin/workflow/instances/$instanceId"
                            params={{ instanceId: row.original.id }}
                            className={cn(
                              'block px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/40',
                              i === 0 && 'font-sans',
                            )}
                            aria-label={i === 0 ? `Open ${row.original.workflow_key}` : undefined}
                            tabIndex={i === 0 ? 0 : -1}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </Link>
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {(hasPrev || hasNext) && (
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              disabled={!hasPrev}
              onClick={() => setCursorStack((s) => s.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              disabled={!hasNext}
              onClick={() => {
                const next = query.data?.nextCursor;
                if (next) setCursorStack((s) => [...s, next]);
              }}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
