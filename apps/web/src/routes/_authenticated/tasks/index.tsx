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
import { ChevronDown, ChevronsUpDown, ChevronUp, Search } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { Button } from '~/components/ui/button';
import { Switch } from '~/components/forms/Switch';
import { TaskStatusBadge } from '~/components/tasks/TaskStatusBadge';
import { formatDueDate, formatRelativeDay, shortStreamType } from '~/lib/tasks';

export const Route = createFileRoute('/_authenticated/tasks/')({
  component: MyTasks,
});

type TaskApiRow = inferRouterOutputs<AppRouter>['platform']['tasks']['myTasks']['items'][number];
type SortKey = 'due' | 'raised';
type StatusFilter = 'actionable' | 'blocked' | 'open' | 'done' | 'cancelled';

const columnHelper = createColumnHelper<TaskApiRow>();

/** The status sets behind the filter, spelled once so the query and the empty state agree. */
const STATUS_SETS: Record<StatusFilter, TaskApiRow['status'][] | undefined> = {
  actionable: undefined, // the server's own default: open + blocked
  blocked: ['blocked'],
  open: ['open'],
  done: ['done'],
  cancelled: ['cancelled'],
};

/**
 * My tasks (core plan 08 §5.3, PL-013/014).
 *
 * The list is **self-scoping**: it shows the tasks assigned to roles the caller
 * currently holds, resolved by the server against live grants. Nobody is
 * assigned a task here — a role is — so this page has no "assigned to" filter
 * and no way to see someone else's list, and both of those absences are the
 * model rather than missing features.
 *
 * Every facet below is a query parameter. The table runs in manual mode and
 * renders exactly the page the server returned; filtering or sorting the loaded
 * rows in the browser would operate on one keyset page and quietly give the
 * wrong answer (ADR-0004).
 */
export function MyTasks() {
  const [searchInput, setSearchInput] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('actionable');
  const [overdueOnly, setOverdueOnly] = React.useState(false);
  const [lane, setLane] = React.useState('');
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'due',
    dir: 'asc',
  });
  const [cursorStack, setCursorStack] = React.useState<string[]>([]);
  const cursor = cursorStack[cursorStack.length - 1];

  React.useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  React.useEffect(() => {
    setCursorStack([]);
  }, [search, statusFilter, overdueOnly, lane, sort.key, sort.dir]);

  const query = trpcReact.platform.tasks.myTasks.useQuery({
    limit: 25,
    sort: sort.key,
    sortDir: sort.dir,
    cursor,
    overdueOnly,
    status: STATUS_SETS[statusFilter],
    search: search || undefined,
    lane: lane || undefined,
  });

  const columns = React.useMemo(
    () => [
      columnHelper.accessor('title', {
        id: 'title',
        header: 'Task',
        cell: (info) => (
          <Link
            to="/tasks/$taskId"
            params={{ taskId: info.row.original.id }}
            className="flex flex-col gap-0.5"
          >
            <span className="font-sans text-sm font-semibold text-strong">{info.getValue()}</span>
            <span className="font-sans text-2xs text-muted">
              {shortStreamType(info.row.original.streamType)}
              {info.row.original.lane ? ` · ${info.row.original.lane}` : ''}
            </span>
          </Link>
        ),
      }),
      columnHelper.accessor('status', {
        id: 'status',
        header: 'Status',
        cell: (info) => (
          <div className="flex flex-col items-start gap-1">
            <TaskStatusBadge status={info.getValue()} overdue={info.row.original.overdue} />
            {info.row.original.blockedCount > 0 && info.getValue() === 'blocked' && (
              <span className="font-sans text-2xs text-muted">
                waiting on {info.row.original.blockedCount}
              </span>
            )}
          </div>
        ),
      }),
      columnHelper.accessor('dueAt', {
        id: 'due',
        header: 'Due',
        meta: { sortKey: 'due' as SortKey },
        cell: (info) => {
          const due = info.getValue();
          if (!due) return <span className="font-sans text-sm text-muted">—</span>;
          return (
            <div className="flex flex-col">
              <span
                className={
                  info.row.original.overdue
                    ? 'whitespace-nowrap font-mono text-sm font-bold text-state-danger-text'
                    : 'whitespace-nowrap font-mono text-sm text-strong'
                }
              >
                {formatDueDate(due)}
              </span>
              <span className="font-sans text-2xs text-muted">{formatRelativeDay(due)}</span>
            </div>
          );
        },
      }),
      columnHelper.accessor('assigneeRoleName', {
        id: 'role',
        header: 'Assigned to',
        cell: (info) => (
          <div className="flex flex-col gap-0.5">
            {/* The role, never a person: this column is the model on screen. */}
            <span className="font-sans text-sm text-body">{info.getValue()}</span>
            {info.row.original.claimedByName && (
              <span className="font-sans text-2xs text-muted">
                being worked by {info.row.original.claimedByName}
              </span>
            )}
          </div>
        ),
      }),
      columnHelper.accessor('raisedAt', {
        id: 'raised',
        header: 'Raised',
        meta: { sortKey: 'raised' as SortKey },
        cell: (info) => (
          <span className="whitespace-nowrap font-sans text-2xs text-muted">
            {formatDueDate(info.getValue())}
          </span>
        ),
      }),
    ],
    [],
  );

  const rows = React.useMemo(() => query.data?.items ?? [], [query.data]);
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
  });

  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );

  const hasNext = Boolean(query.data?.nextCursor);
  const hasPrev = cursorStack.length > 0;
  const filtered = Boolean(search) || overdueOnly || Boolean(lane) || statusFilter !== 'actionable';

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <PageHeader
        title="My tasks"
        description="Everything assigned to a role you hold. Tasks are assigned to roles rather than to people, so this list follows your role membership — join a role and its work appears here, leave it and it moves on without anything being reassigned."
      />

      {query.error && (
        <Callout tone="danger" title="Couldn’t load your tasks">
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
              placeholder="Search task titles"
              aria-label="Search task titles"
              className="min-w-0 flex-1 bg-transparent font-sans text-sm text-strong outline-none"
            />
          </div>
          <select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="h-9 rounded-md border border-border-default bg-surface-card px-3 font-sans text-sm text-body outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <option value="actionable">To do and blocked</option>
            <option value="open">To do</option>
            <option value="blocked">Blocked</option>
            <option value="done">Complete</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <input
            type="text"
            value={lane}
            onChange={(e) => setLane(e.target.value)}
            placeholder="Lane"
            aria-label="Filter by lane"
            className="h-9 w-[130px] rounded-md border border-border-default bg-surface-card px-3 font-sans text-sm text-body outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          />
          <div className="flex h-9 items-center rounded-md border border-border-default bg-surface-card px-3">
            <Switch
              label="Overdue only"
              checked={overdueOnly}
              onChange={(e) => setOverdueOnly(e.target.checked)}
            />
          </div>
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
                      Loading your tasks…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="px-4 py-10 text-center font-sans text-sm text-muted"
                    >
                      {filtered
                        ? 'No tasks match these filters.'
                        : 'Nothing is waiting on you right now.'}
                    </td>
                  </tr>
                ) : (
                  table.getRowModel().rows.map((row) => (
                    <tr
                      key={row.id}
                      className={
                        row.original.overdue
                          ? 'border-b border-border-subtle border-l-[3px] border-l-state-danger bg-state-danger-bg/40 transition-colors last:border-b-0 hover:bg-state-danger-bg'
                          : 'border-b border-border-subtle transition-colors last:border-0 hover:bg-gray-50'
                      }
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="px-4 py-3 align-middle">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
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
