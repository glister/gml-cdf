import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/trpc';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  Search,
} from 'lucide-react';
import { trpcReact } from '../../../../trpc.js';
import { PageHeader } from '../../../../components/nav/PageHeader.js';
import { PersonCell } from '../../../../components/data-display/PersonCell.js';
import { StatusPill } from '../../../../components/data-display/StatusPill.js';
import { cn } from '../../../../lib/utils.js';
import {
  formatDate,
  PROFILE_STATUS_LABELS,
  PROFILE_STATUS_TONES,
  RELATIONSHIP_LABELS,
  type ProfileStatus,
  type RelationshipType,
} from '../../../../lib/people.js';

export const Route = createFileRoute('/_authenticated/admin/people/')({
  component: PeopleList,
});

type PersonRow =
  inferRouterOutputs<AppRouter>['platform']['identity']['listPersons']['items'][number];
type SortKey = 'created_at' | 'family_name' | 'access_valid_until';

const RELATIONSHIP_OPTIONS = Object.entries(RELATIONSHIP_LABELS) as [RelationshipType, string][];
const PROFILE_STATUS_OPTIONS = Object.entries(PROFILE_STATUS_LABELS) as [ProfileStatus, string][];

const columnHelper = createColumnHelper<PersonRow>();
const columns = [
  columnHelper.accessor('display_name', {
    id: 'person',
    header: 'Person',
    meta: { sortKey: 'family_name' as SortKey },
    cell: (info) => (
      <PersonCell
        name={info.getValue()}
        secondary={
          info.row.original.contact_email ??
          RELATIONSHIP_LABELS[info.row.original.relationship_type]
        }
      />
    ),
  }),
  columnHelper.accessor('relationship_type', {
    id: 'relationship',
    header: 'Relationship',
    cell: (info) => (
      <span className="text-sm text-body">{RELATIONSHIP_LABELS[info.getValue()]}</span>
    ),
  }),
  columnHelper.accessor('profile_status', {
    id: 'profile',
    header: 'Profile status',
    cell: (info) => (
      <StatusPill tone={PROFILE_STATUS_TONES[info.getValue()]}>
        {PROFILE_STATUS_LABELS[info.getValue()]}
      </StatusPill>
    ),
  }),
  columnHelper.accessor('access_valid_until', {
    id: 'access',
    header: 'Access expiry',
    meta: { sortKey: 'access_valid_until' as SortKey },
    cell: (info) => (
      <span className="font-mono text-sm text-body">{formatDate(info.getValue())}</span>
    ),
  }),
  columnHelper.accessor('created_at', {
    id: 'created',
    header: 'Added',
    meta: { sortKey: 'created_at' as SortKey },
    cell: (info) => (
      <span className="font-mono text-sm text-muted">{formatDate(info.getValue())}</span>
    ),
  }),
];

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-md border border-border-default bg-surface-card px-3 font-sans text-sm text-body outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      <option value="">{label}</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

function PeopleList() {
  const [search, setSearch] = React.useState('');
  const [searchInput, setSearchInput] = React.useState('');
  const [relationshipType, setRelationshipType] = React.useState('');
  const [profileStatus, setProfileStatus] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('');
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'created_at',
    dir: 'desc',
  });
  // Forward-only keyset cursors: the stack holds the cursor of each page beyond
  // the first (empty = first page). Next pushes nextCursor; Prev pops.
  const [cursorStack, setCursorStack] = React.useState<string[]>([]);
  const cursor = cursorStack[cursorStack.length - 1];

  // Debounce the search box.
  React.useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Any change to the query (except the cursor itself) resets pagination — the
  // encoded cursor is tied to the current sort expression.
  React.useEffect(() => {
    setCursorStack([]);
  }, [relationshipType, profileStatus, statusFilter, search, sort.key, sort.dir]);

  const query = trpcReact.platform.identity.listPersons.useQuery({
    limit: 25,
    sort: sort.key,
    sortDir: sort.dir,
    cursor,
    relationshipType: (relationshipType || undefined) as RelationshipType | undefined,
    profileStatus: (profileStatus || undefined) as ProfileStatus | undefined,
    status: (statusFilter || undefined) as 'active' | 'inactive' | 'superseded' | undefined,
    search: search || undefined,
  });

  const rows = query.data?.items ?? [];
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
  const goNext = () => {
    const next = query.data?.nextCursor;
    if (next) setCursorStack((s) => [...s, next]);
  };
  const goPrev = () => setCursorStack((s) => s.slice(0, -1));

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <PageHeader
        title="People"
        description="Everyone with a record at CD Fencing — employees, agency and external workers, and candidates."
      />

      <div className="flex flex-col gap-3">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-md border border-border-default bg-surface-card px-3 focus-within:border-border-focus focus-within:ring-2 focus-within:ring-brand/40">
            <Search size={16} className="shrink-0 text-muted" />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search name, email or reference"
              aria-label="Search people"
              className="min-w-0 flex-1 bg-transparent font-sans text-sm text-strong outline-none"
            />
          </div>
          <FilterSelect
            label="All relationships"
            value={relationshipType}
            onChange={setRelationshipType}
            options={RELATIONSHIP_OPTIONS}
          />
          <FilterSelect
            label="All profile statuses"
            value={profileStatus}
            onChange={setProfileStatus}
            options={PROFILE_STATUS_OPTIONS}
          />
          <FilterSelect
            label="All access states"
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              ['active', 'Active'],
              ['inactive', 'Inactive'],
              ['superseded', 'Superseded'],
            ]}
          />
        </div>

        {/* Table */}
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
                      Loading people…
                    </td>
                  </tr>
                ) : query.error ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="px-4 py-10 text-center font-sans text-sm text-status-danger"
                    >
                      Couldn’t load people. Try again.
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="px-4 py-10 text-center font-sans text-sm text-muted"
                    >
                      No people match these filters.
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

          {/* Keyset pagination */}
          <div className="flex items-center justify-between gap-3 border-t border-border-subtle px-4 py-3">
            <span className="font-sans text-xs text-muted">
              {rows.length > 0 ? `Showing ${rows.length}` : ' '}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={goPrev}
                disabled={!hasPrev}
                className={cn(
                  'inline-flex h-8 items-center gap-1 rounded-md border border-border-default bg-surface-card px-2.5 font-sans text-sm font-medium text-body transition-colors hover:bg-gray-50',
                  !hasPrev && 'pointer-events-none opacity-45',
                )}
              >
                <ChevronLeft size={16} /> Prev
              </button>
              <button
                type="button"
                onClick={goNext}
                disabled={!hasNext}
                className={cn(
                  'inline-flex h-8 items-center gap-1 rounded-md border border-border-default bg-surface-card px-2.5 font-sans text-sm font-medium text-body transition-colors hover:bg-gray-50',
                  !hasNext && 'pointer-events-none opacity-45',
                )}
              >
                Next <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
