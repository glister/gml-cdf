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
import { ChevronDown, ChevronsUpDown, ChevronUp, UserCheck } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { Button } from '~/components/ui/button';
import { Switch } from '~/components/forms/Switch';
import { StatusPill } from '~/components/data-display/StatusPill';
import { approvalTone, APPROVAL_STATUS_LABEL, shortSubjectType } from '~/lib/approvals';

export const Route = createFileRoute('/_authenticated/approvals/')({
  component: ApprovalsInbox,
});

type Row = inferRouterOutputs<AppRouter>['platform']['approvals']['inbox']['items'][number];
type SortKey = 'submitted' | 'decided';
type StatusFilter = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'all';

const columnHelper = createColumnHelper<Row>();

const STATUS_SETS: Record<StatusFilter, Row['status'][] | undefined> = {
  pending: undefined, // the server's own default
  approved: ['approved'],
  rejected: ['rejected'],
  cancelled: ['cancelled'],
  all: ['pending', 'approved', 'rejected', 'cancelled'],
};

/**
 * The approvals inbox (core plan 09 §5.3, PL-016).
 *
 * The list is **self-scoping**, and more strongly than the task list is: it
 * shows the requests the caller may act on *right now*, computed by the server
 * from the approver policy over their live role grants and delegations. There is
 * no "assigned to" filter and no way to see someone else's queue, and both
 * absences are the model rather than missing features — nobody is assigned an
 * approval here, a policy resolves to them.
 *
 * The consequence worth understanding when reading this screen: a request can
 * leave your inbox without anyone touching it, because someone changed a role's
 * membership. That is §4.5 working, not a bug.
 *
 * Every facet is a query parameter, eligibility included. The table runs in
 * manual mode and renders exactly the page the server returned; filtering the
 * loaded rows in the browser would operate on one keyset page and quietly give
 * the wrong answer (ADR-0004).
 */
export function ApprovalsInbox() {
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('pending');
  const [subjectType, setSubjectType] = React.useState('');
  const [includeOverride, setIncludeOverride] = React.useState(false);
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'submitted',
    dir: 'asc',
  });
  const [cursorStack, setCursorStack] = React.useState<string[]>([]);
  const cursor = cursorStack[cursorStack.length - 1];

  React.useEffect(() => {
    setCursorStack([]);
  }, [statusFilter, subjectType, includeOverride, sort.key, sort.dir]);

  const query = trpcReact.platform.approvals.inbox.useQuery({
    limit: 25,
    sort: sort.key,
    sortDir: sort.dir,
    cursor,
    includeOverride,
    status: STATUS_SETS[statusFilter],
    subjectType: subjectType || undefined,
  });

  const columns = React.useMemo(
    () => [
      columnHelper.accessor('subjectType', {
        id: 'subject',
        header: 'Request',
        cell: (info) => (
          <Link
            to="/approvals/$requestId"
            params={{ requestId: info.row.original.id }}
            className="flex flex-col gap-0.5"
          >
            <span className="font-sans text-sm font-semibold text-strong">
              {shortSubjectType(info.getValue())}
            </span>
            <span className="font-sans text-2xs text-muted">
              raised by {info.row.original.requestedByName ?? 'the system'}
            </span>
          </Link>
        ),
      }),
      columnHelper.accessor('status', {
        id: 'status',
        header: 'Status',
        cell: (info) => (
          <StatusPill tone={approvalTone(info.getValue())}>
            {APPROVAL_STATUS_LABEL[info.getValue()]}
          </StatusPill>
        ),
      }),
      columnHelper.accessor('waitingDays', {
        id: 'waiting',
        header: 'Waiting',
        cell: (info) => {
          const days = info.getValue();
          const pending = info.row.original.status === 'pending';
          return (
            <span
              className={
                pending && days >= 3
                  ? 'font-sans text-sm font-semibold text-state-pending-text'
                  : 'font-sans text-sm text-body'
              }
            >
              {days === 0 ? 'Today' : days === 1 ? '1 day' : `${days} days`}
            </span>
          );
        },
      }),
      columnHelper.display({
        id: 'how',
        header: 'Your authority',
        cell: (info) => {
          const row = info.row.original;
          // Why this request is in *your* list — the question someone asks when
          // an unfamiliar one appears, and one only the server can answer.
          if (row.viaOverride) {
            return (
              <span className="font-sans text-2xs text-muted">Override — you were not asked</span>
            );
          }
          if (row.viaDelegationId) {
            return (
              <span className="inline-flex items-center gap-1.5 font-sans text-2xs text-state-info-text">
                <UserCheck size={13} aria-hidden="true" />
                Covering
              </span>
            );
          }
          return <span className="font-sans text-2xs text-muted">Approver</span>;
        },
      }),
      columnHelper.accessor('submittedAt', {
        id: 'submitted',
        header: 'Raised',
        meta: { sortKey: 'submitted' as SortKey },
        cell: (info) => (
          <span className="whitespace-nowrap font-sans text-sm text-body">
            {new Date(info.getValue()).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
            })}
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

  function toggleSort(key: SortKey): void {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  }

  const hasNext = Boolean(query.data?.nextCursor);
  const hasPrev = cursorStack.length > 0;
  const filtered = statusFilter !== 'pending' || subjectType !== '' || includeOverride;

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <PageHeader
        title="Approvals"
        description="Requests you can decide right now. Who may approve something is a policy over roles rather than a list of names, so this queue follows your role membership and any delegations you are covering — nothing is reassigned when it changes."
        primaryAction={
          <Link
            to="/approvals/delegations"
            className="inline-flex h-9 items-center rounded-full px-4 font-sans text-sm font-semibold text-body transition-colors hover:bg-gray-100"
          >
            Delegations
          </Link>
        }
      />

      {query.error && (
        <Callout tone="danger" title="Couldn’t load your approvals">
          {query.error.message}
        </Callout>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="h-9 rounded-md border border-border-default bg-surface-card px-3 font-sans text-sm text-body outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <option value="pending">Waiting on a decision</option>
            <option value="approved">Approved</option>
            <option value="rejected">Declined</option>
            <option value="cancelled">Withdrawn</option>
            <option value="all">All</option>
          </select>
          <input
            type="text"
            value={subjectType}
            onChange={(e) => setSubjectType(e.target.value)}
            placeholder="Request type"
            aria-label="Filter by request type"
            className="h-9 w-[190px] rounded-md border border-border-default bg-surface-card px-3 font-sans text-sm text-body outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          />
          {/* HL-033: an override role may act on anything without being shown
              everything. Off by default, so HR's inbox is their own work. */}
          <div className="flex h-9 items-center rounded-md border border-border-default bg-surface-card px-3">
            <Switch
              label="Include ones I can override"
              checked={includeOverride}
              onChange={(e) => setIncludeOverride(e.target.checked)}
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
                      Loading your approvals…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="px-4 py-10 text-center font-sans text-sm text-muted"
                    >
                      {filtered
                        ? 'No approvals match these filters.'
                        : 'Nothing is waiting on your decision.'}
                    </td>
                  </tr>
                ) : (
                  table.getRowModel().rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-border-subtle transition-colors last:border-0 hover:bg-gray-50"
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
