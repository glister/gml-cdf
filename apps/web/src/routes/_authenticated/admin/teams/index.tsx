import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/trpc';
import { z } from 'zod';
import { ChevronLeft, ChevronRight, Search, Users } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Button } from '~/components/ui/button';
import { Callout } from '~/components/feedback/Callout';
import { Modal } from '~/components/feedback/Modal';
import { Field } from '~/components/forms/Field';
import { Input } from '~/components/forms/Input';
import { Select } from '~/components/forms/Select';
import { Textarea } from '~/components/forms/Textarea';
import { StatusPill } from '~/components/data-display/StatusPill';
import { cn } from '~/lib/utils';

export const Route = createFileRoute('/_authenticated/admin/teams/')({
  component: TeamsList,
});

type TeamRow = inferRouterOutputs<AppRouter>['platform']['team']['list']['items'][number];
type SortKey = 'name' | 'updated_at';

/**
 * Form-shaped mirror of `createTeamInput`: the optional fields are `''` here
 * because they are controlled inputs, and the messages are the ones a person
 * should read. The server schema is still the authority — this only stops an
 * obviously-incomplete form being submitted.
 */
const createTeamFormSchema = z.object({
  name: z.string().trim().min(1, 'Give the team a name').max(200),
  description: z.string().trim().max(1000),
  managerPersonId: z.string().uuid('Choose a manager'),
  deputyPersonId: z.string(),
  maxConcurrentLeave: z.string(),
  colour: z.string(),
});

const columnHelper = createColumnHelper<TeamRow>();
const columns = [
  columnHelper.accessor('name', {
    id: 'name',
    header: 'Team',
    meta: { sortKey: 'name' as SortKey },
    cell: (info) => (
      <Link
        to="/admin/teams/$teamId"
        params={{ teamId: info.row.original.id }}
        className="group/team flex items-center gap-2.5"
      >
        {/* The team's calendar colour, where one is set (plan 12 reads the same
            column). A neutral swatch stands in when it is not. */}
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full border border-black/10"
          style={{ backgroundColor: info.row.original.colour ?? 'var(--color-gray-300)' }}
        />
        <span className="flex flex-col">
          <span className="text-sm font-semibold text-strong group-hover/team:text-brand">
            {info.getValue()}
          </span>
          {info.row.original.description && (
            <span className="text-sm text-muted">{info.row.original.description}</span>
          )}
        </span>
      </Link>
    ),
  }),
  columnHelper.accessor('manager_display_name', {
    id: 'manager',
    header: 'Manager',
    cell: (info) => <span className="text-sm text-body">{info.getValue()}</span>,
  }),
  columnHelper.accessor('deputy_display_name', {
    id: 'deputy',
    header: 'Deputy',
    cell: (info) => (
      <span className={cn('text-sm', info.getValue() ? 'text-body' : 'text-muted')}>
        {info.getValue() ?? '—'}
      </span>
    ),
  }),
  columnHelper.accessor('member_count', {
    id: 'members',
    header: 'Members today',
    cell: (info) => (
      <span className="font-mono text-sm tabular-nums text-body">{Number(info.getValue())}</span>
    ),
  }),
  columnHelper.accessor('max_concurrent_leave', {
    id: 'capacity',
    header: 'Max off at once',
    cell: (info) =>
      info.getValue() == null ? (
        <span className="text-sm text-muted">Not set</span>
      ) : (
        <span className="font-mono text-sm tabular-nums text-body">{info.getValue()}</span>
      ),
  }),
  columnHelper.accessor('deleted_at', {
    id: 'state',
    header: 'State',
    cell: (info) =>
      info.getValue() ? (
        <StatusPill tone="neutral">Archived</StatusPill>
      ) : (
        <StatusPill tone="success">Active</StatusPill>
      ),
  }),
];

function TeamsList() {
  const utils = trpcReact.useUtils();
  const [searchInput, setSearchInput] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [includeArchived, setIncludeArchived] = React.useState(false);
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'name',
    dir: 'asc',
  });
  const [cursorStack, setCursorStack] = React.useState<string[]>([]);
  const [createOpen, setCreateOpen] = React.useState(false);

  React.useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  React.useEffect(() => {
    setCursorStack([]);
  }, [search, includeArchived, sort.key, sort.dir]);

  const query = trpcReact.platform.team.list.useQuery({
    limit: 25,
    cursor: cursorStack[cursorStack.length - 1],
    search: search || undefined,
    includeArchived,
    sort: sort.key,
    sortDir: sort.dir,
  });

  // The manager/deputy pickers. Scoped server-side by the caller's reach, so
  // this list is already the correct set — no client-side filtering.
  const people = trpcReact.platform.identity.listPersons.useQuery({ limit: 100 });

  const createMutation = trpcReact.platform.team.create.useMutation({
    onSuccess: async () => {
      setCreateOpen(false);
      await utils.platform.team.list.invalidate();
    },
  });

  const createForm = useForm({
    defaultValues: {
      name: '',
      description: '',
      managerPersonId: '',
      deputyPersonId: '',
      maxConcurrentLeave: '',
      colour: '',
    },
    validators: { onChange: createTeamFormSchema },
    onSubmit: async ({ value }) => {
      await createMutation.mutateAsync({
        name: value.name,
        description: value.description || undefined,
        managerPersonId: value.managerPersonId,
        deputyPersonId: value.deputyPersonId || undefined,
        maxConcurrentLeave: value.maxConcurrentLeave ? Number(value.maxConcurrentLeave) : undefined,
        colour: value.colour || undefined,
      });
    },
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

  const hasNext = Boolean(query.data?.nextCursor);
  const hasPrev = cursorStack.length > 0;
  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <PageHeader
        title="Teams"
        description="Who works together, who manages them, and how many can be off at once. Membership is dated, so past rosters stay answerable."
        primaryAction={
          <Button
            startIcon={<Users size={17} />}
            onClick={() => {
              createForm.reset();
              createMutation.reset();
              setCreateOpen(true);
            }}
          >
            Create a team
          </Button>
        }
      />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-md border border-border-default bg-surface-card px-3 focus-within:border-border-focus focus-within:ring-2 focus-within:ring-brand/40">
            <Search size={16} className="shrink-0 text-muted" />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search team name"
              aria-label="Search teams"
              className="min-w-0 flex-1 bg-transparent font-sans text-sm text-strong outline-none"
            />
          </div>
          <select
            aria-label="Filter by state"
            value={includeArchived ? 'all' : 'active'}
            onChange={(e) => setIncludeArchived(e.target.value === 'all')}
            className="h-9 rounded-md border border-border-default bg-surface-card px-3 font-sans text-sm text-body outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <option value="active">Active teams</option>
            <option value="all">Include archived</option>
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
                              className={cn(
                                'inline-flex items-center gap-1 transition-colors hover:text-body',
                                active ? 'text-brand' : 'text-muted',
                              )}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
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
                      Loading teams…
                    </td>
                  </tr>
                ) : query.error ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="px-4 py-10 text-center font-sans text-sm text-status-danger"
                    >
                      Couldn’t load teams. Try again.
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="px-4 py-10 text-center font-sans text-sm text-muted"
                    >
                      {search ? 'No teams match that search.' : 'No teams yet.'}
                    </td>
                  </tr>
                ) : (
                  table.getRowModel().rows.map((row) => (
                    <tr
                      key={row.id}
                      className={cn(
                        'border-b border-border-subtle transition-colors last:border-0 hover:bg-gray-50',
                        row.original.deleted_at && 'opacity-60',
                      )}
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

          <div className="flex items-center justify-between gap-3 border-t border-border-subtle px-4 py-3">
            <span className="font-sans text-xs text-muted">
              {rows.length > 0 ? `Showing ${rows.length}` : ' '}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setCursorStack((s) => s.slice(0, -1))}
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
                onClick={() => {
                  const next = query.data?.nextCursor;
                  if (next) setCursorStack((s) => [...s, next]);
                }}
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

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create a team"
        description="Members are added afterwards, each from the date they join."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <createForm.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button
                  onClick={() => void createForm.handleSubmit()}
                  disabled={!canSubmit || isSubmitting}
                >
                  {isSubmitting ? 'Creating…' : 'Create team'}
                </Button>
              )}
            </createForm.Subscribe>
          </div>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void createForm.handleSubmit();
          }}
        >
          {createMutation.error && (
            <Callout tone="danger" title="Couldn’t create the team">
              {createMutation.error.message}
            </Callout>
          )}

          <createForm.Field name="name">
            {(field) => (
              <Field
                label="Team name"
                htmlFor={field.name}
                required
                error={field.state.meta.errors[0]?.message}
              >
                <Input
                  id={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="e.g. Fencing Crew A"
                />
              </Field>
            )}
          </createForm.Field>

          <createForm.Field name="description">
            {(field) => (
              <Field label="Description" htmlFor={field.name}>
                <Textarea
                  id={field.name}
                  rows={2}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </createForm.Field>

          <createForm.Field name="managerPersonId">
            {(field) => (
              <Field
                label="Manager"
                htmlFor={field.name}
                required
                hint="Managers and their deputy can see their team's records."
                error={field.state.meta.errors[0]?.message}
              >
                <Select
                  id={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                >
                  <option value="">Choose a manager</option>
                  {(people.data?.items ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.display_name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </createForm.Field>

          <createForm.Field name="deputyPersonId">
            {(field) => (
              <Field
                label="Deputy"
                htmlFor={field.name}
                hint="Optional. Covers for the manager, and sees the same team."
              >
                <Select
                  id={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                >
                  <option value="">No deputy</option>
                  {(people.data?.items ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.display_name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </createForm.Field>

          <div className="flex flex-wrap gap-4">
            <createForm.Field name="maxConcurrentLeave">
              {(field) => (
                <Field
                  label="Max off at once"
                  htmlFor={field.name}
                  hint="Advisory. Exceeding it warns the approver — it never blocks a booking."
                  className="flex-1"
                >
                  <Input
                    id={field.name}
                    type="number"
                    min={1}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="No limit"
                    className="w-32 font-mono"
                  />
                </Field>
              )}
            </createForm.Field>

            <createForm.Field name="colour">
              {(field) => (
                <Field
                  label="Calendar colour"
                  htmlFor={field.name}
                  hint="Optional. Used to colour this team's items on the shared calendar."
                >
                  <input
                    id={field.name}
                    type="color"
                    value={field.state.value || '#1e7e34'}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    className="h-10 w-16 cursor-pointer rounded-md border-[1.5px] border-border-default bg-surface-card p-1"
                  />
                </Field>
              )}
            </createForm.Field>
          </div>
        </form>
      </Modal>
    </div>
  );
}
