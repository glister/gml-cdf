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
import { ChevronDown, ChevronRight, ChevronsUpDown, ChevronUp, Lock, Search } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { cn } from '~/lib/utils';
import { formatConfigValue, formatInstant, formatNamespace } from '~/lib/config-store';

export const Route = createFileRoute('/_authenticated/admin/config/')({
  component: ConfigBrowser,
});

type ConfigRow = inferRouterOutputs<AppRouter>['platform']['config']['list']['items'][number];
type SortKey = 'key' | 'updated_at';

const columnHelper = createColumnHelper<ConfigRow>();

/**
 * The configuration browser (core plan 06 §5.3, PL-029).
 *
 * Its job is to make "the rules that govern behaviour are data" visible: every
 * decision point the platform reads is a row here, editable by an authorised
 * role with no release. Two things the screen has to be honest about, because
 * both are load-bearing in the store's design:
 *
 *  - a key that has never been set shows its **frozen code default**, marked as
 *    such, rather than pretending nobody has chosen a value; and
 *  - a key this viewer cannot edit says so, rather than offering a control the
 *    server would refuse.
 *
 * The listing is registry-driven, so it is not paginated — the key set is code
 * and cannot grow at runtime. Filtering and sorting are still entirely
 * server-side (`platform.config.list`), never over the fetched rows.
 */
function ConfigBrowser() {
  const [searchInput, setSearchInput] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [namespace, setNamespace] = React.useState('');
  const [editableOnly, setEditableOnly] = React.useState(false);
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'key',
    dir: 'asc',
  });

  React.useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const query = trpcReact.platform.config.list.useQuery({
    search: search || undefined,
    namespace: namespace || undefined,
    editableOnly,
    sort: sort.key,
    sortDir: sort.dir,
  });

  const columns = React.useMemo(
    () => [
      columnHelper.accessor('key', {
        id: 'key',
        header: 'Decision point',
        meta: { sortKey: 'key' as SortKey },
        cell: (info) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-sm font-semibold tracking-tight text-strong">
              {info.getValue()}
            </span>
            <span className="text-sm leading-normal text-muted">
              {info.row.original.description}
            </span>
          </div>
        ),
      }),
      columnHelper.accessor('namespace', {
        id: 'namespace',
        header: 'Area',
        cell: (info) => (
          <span className="whitespace-nowrap font-sans text-sm text-muted">
            {formatNamespace(info.getValue())}
          </span>
        ),
      }),
      columnHelper.display({
        id: 'value',
        header: 'In force',
        cell: (info) => (
          <div className="flex items-center gap-2">
            <span className="rounded-sm border border-border-subtle bg-gray-100 px-2 py-1 font-mono text-sm tracking-wide text-body">
              {formatConfigValue(info.row.original.value)}
            </span>
            {info.row.original.isDefault && (
              <span className="shrink-0 rounded-full border border-border-subtle bg-gray-100 px-2 py-px font-mono text-2xs font-semibold uppercase tracking-wide text-muted">
                Default
              </span>
            )}
          </div>
        ),
      }),
      columnHelper.accessor('updatedAt', {
        id: 'updated_at',
        header: 'Last changed',
        meta: { sortKey: 'updated_at' as SortKey },
        cell: (info) => {
          const row = info.row.original;
          if (row.isDefault) {
            // "Never changed" is not a date. Saying so beats an em dash the
            // reader has to interpret.
            return <span className="font-sans text-sm text-muted">Never changed</span>;
          }
          return (
            <div className="flex flex-col">
              <span className="font-mono text-sm text-muted">{formatInstant(info.getValue())}</span>
              <span className="font-sans text-sm text-muted">
                {row.updatedByName ?? 'System'} · v{row.version}
              </span>
            </div>
          );
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        cell: (info) => (
          <div className="flex items-center justify-end gap-2">
            {!info.row.original.canEdit && (
              <span
                title={`Editable by ${info.row.original.editableBy.join(', ')}`}
                className="inline-flex items-center gap-1 font-sans text-2xs text-muted"
              >
                <Lock size={12} /> Read only
              </span>
            )}
            <ChevronRight size={16} className="shrink-0 text-border-strong" />
          </div>
        ),
      }),
    ],
    [],
  );

  const rows = query.data?.items ?? [];
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    // Server-side everything: the table renders exactly the set it is given.
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
  });

  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <PageHeader
        title="Configuration"
        description="The decision points the platform reads — thresholds, cadences, lead times and policies. Changing one takes effect on the next decision, with no release, and every change is audited."
      />

      {query.error && (
        <Callout tone="danger" title="Couldn’t load the configuration">
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
              placeholder="Search key or description"
              aria-label="Search configuration"
              className="min-w-0 flex-1 bg-transparent font-sans text-sm text-strong outline-none"
            />
          </div>
          <select
            aria-label="Filter by area"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            className="h-9 rounded-md border border-border-default bg-surface-card px-3 font-sans text-sm text-body outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <option value="">All areas</option>
            {(query.data?.namespaces ?? []).map((ns) => (
              <option key={ns} value={ns}>
                {formatNamespace(ns)}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by what I can change"
            value={editableOnly ? 'editable' : ''}
            onChange={(e) => setEditableOnly(e.target.value === 'editable')}
            className="h-9 rounded-md border border-border-default bg-surface-card px-3 font-sans text-sm text-body outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <option value="">Everything I can see</option>
            <option value="editable">Only what I can change</option>
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
                      Loading configuration…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="px-4 py-10 text-center font-sans text-sm text-muted"
                    >
                      {search || namespace || editableOnly
                        ? 'No decision points match these filters.'
                        : 'No decision points are registered yet.'}
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
                          {/* The whole row is the link, so a click anywhere
                              opens the key — but each cell gets its own anchor
                              so the table markup stays valid. */}
                          <Link
                            to="/admin/config/$qualifiedKey"
                            params={{ qualifiedKey: row.original.qualifiedName }}
                            className={cn(
                              'block px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/40',
                              i === 0 && 'font-sans',
                            )}
                            aria-label={i === 0 ? `Open ${row.original.qualifiedName}` : undefined}
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

        <Callout tone="info" title="Why there is no “add a key” button">
          A configuration key is a decision point the code reads by name, so adding one is a code
          change — a key nothing reads would do nothing. What is data here is the <em>value</em>:
          changing it needs no release, takes effect on the next decision, and never rewrites a
          decision already made.
        </Callout>
      </div>
    </div>
  );
}
