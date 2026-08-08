import * as React from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { Search } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { Button } from '~/components/ui/button';
import { Switch } from '~/components/forms/Switch';
import { StatusPill } from '~/components/data-display/StatusPill';
import { IssueModeBadge } from '~/components/documents/IssueModeBadge';
import { formatStamp, TEMPLATE_STATUS, type TemplateRow } from '~/lib/documents';

export const Route = createFileRoute('/_authenticated/admin/templates/')({
  component: TemplateManager,
});

const columnHelper = createColumnHelper<TemplateRow>();

/**
 * The template manager (core plan 11 §9.4, PL-009).
 *
 * **A row is a version, not a template.** By default the list shows one row per
 * family — the current published version, or the latest draft where a family has
 * never been published — and "All versions" widens it. That default is the model
 * on screen: an administrator thinks in terms of "the welcome letter", and the
 * fact that it is really eleven immutable rows should only surface when they ask
 * for the history.
 *
 * Every facet is a query parameter. The table runs in manual mode and renders
 * exactly the page the server returned; `isCurrent` in particular is computed in
 * SQL, because working it out from the loaded rows would be wrong for any family
 * whose versions straddle a page boundary (ADR-0004).
 */
export function TemplateManager() {
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState<'all' | TemplateRow['status']>('all');
  const [allVersions, setAllVersions] = React.useState(false);
  const [cursorStack, setCursorStack] = React.useState<string[]>([]);
  const cursor = cursorStack[cursorStack.length - 1];

  React.useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  React.useEffect(() => {
    setCursorStack([]);
  }, [search, status, allVersions]);

  const query = trpcReact.platform.templates.list.useQuery({
    limit: 25,
    cursor,
    allVersions,
    search: search || undefined,
    status: status === 'all' ? undefined : [status],
  });

  const columns = React.useMemo(
    () => [
      columnHelper.accessor('name', {
        id: 'name',
        header: 'Template',
        cell: (info) => (
          <Link
            to="/admin/templates/$templateId"
            params={{ templateId: info.row.original.id }}
            className="flex flex-col gap-0.5"
          >
            <span className="font-sans text-sm font-semibold text-strong">{info.getValue()}</span>
            <span className="font-mono text-2xs text-muted">
              {info.row.original.templateKey} · v{info.row.original.version}
            </span>
          </Link>
        ),
      }),
      columnHelper.accessor('categoryLabel', {
        id: 'category',
        header: 'Category',
        cell: (info) => <span className="font-sans text-sm text-body">{info.getValue()}</span>,
      }),
      columnHelper.accessor('defaultIssueMode', {
        id: 'mode',
        header: 'Default action',
        cell: (info) => <IssueModeBadge mode={info.getValue()} />,
      }),
      columnHelper.accessor('status', {
        id: 'status',
        header: 'Status',
        cell: (info) => {
          const meta = TEMPLATE_STATUS[info.getValue()];
          return (
            <div className="flex flex-col items-start gap-1">
              <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
              {info.row.original.isCurrent && (
                <span className="font-sans text-2xs text-muted">current version</span>
              )}
            </div>
          );
        },
      }),
      columnHelper.accessor('updatedAt', {
        id: 'updated',
        header: 'Updated',
        cell: (info) => (
          <span className="whitespace-nowrap font-sans text-2xs text-muted">
            {formatStamp(info.getValue())}
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

  const hasNext = Boolean(query.data?.nextCursor);
  const hasPrev = cursorStack.length > 0;
  const filtered = Boolean(search) || status !== 'all';

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <PageHeader
        title="Document templates"
        description="Templates are versioned. Publishing a version freezes it, and a document keeps the exact version it was generated from — so editing a template never changes what somebody has already signed."
        primaryAction={
          <Button onClick={() => void navigate({ to: '/admin/templates/new' })}>
            New template
          </Button>
        }
      />

      {query.error && (
        <Callout tone="danger" title="Couldn’t load templates">
          {query.error.message}
        </Callout>
      )}

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-md border border-border-default bg-surface-card px-3 focus-within:border-border-focus focus-within:ring-2 focus-within:ring-brand/40">
          <Search size={16} className="shrink-0 text-muted" />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search names and keys"
            aria-label="Search templates"
            className="min-w-0 flex-1 bg-transparent font-sans text-sm text-strong outline-none"
          />
        </div>
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          className="h-9 rounded-md border border-border-default bg-surface-card px-3 font-sans text-sm text-body outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <option value="all">All statuses</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
        <div className="flex h-9 items-center rounded-md border border-border-default bg-surface-card px-3">
          <Switch
            label="All versions"
            checked={allVersions}
            onChange={(e) => setAllVersions(e.target.checked)}
          />
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border-default bg-surface-card">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id} className="border-b border-border-default">
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    className="px-4 py-2.5 text-left font-sans text-2xs font-semibold uppercase tracking-wide text-muted"
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className="border-b border-border-subtle last:border-0 hover:bg-surface-sunken"
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-3 align-top">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && !query.isPending && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-10 text-center">
                  <p className="font-sans text-sm text-muted">
                    {filtered
                      ? 'No templates match these filters.'
                      : 'No templates yet. Create one to start issuing documents.'}
                  </p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <span className="font-sans text-2xs text-muted">
          {rows.length} {rows.length === 1 ? 'template' : 'templates'} on this page
        </span>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            disabled={!hasPrev}
            onClick={() => setCursorStack((s) => s.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            disabled={!hasNext}
            onClick={() =>
              setCursorStack((s) => (query.data?.nextCursor ? [...s, query.data.nextCursor] : s))
            }
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
