import * as React from 'react';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
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
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Button } from '~/components/ui/button';
import { Callout } from '~/components/feedback/Callout';
import { Modal } from '~/components/feedback/Modal';
import { Field } from '~/components/forms/Field';
import { Input } from '~/components/forms/Input';
import { Switch } from '~/components/forms/Switch';
import { Textarea } from '~/components/forms/Textarea';
import { cn } from '~/lib/utils';
import {
  formatTimestamp,
  LOOKUP_LIST_LABELS,
  LOOKUP_LIST_TYPES,
  LOOKUP_LIST_DESCRIPTIONS,
  type LookupListType,
} from '~/lib/reference-data';

export const Route = createFileRoute('/_authenticated/admin/reference-data/$listType')({
  // A URL naming a list that does not exist is a 404, not an empty table — the
  // seven list types are a closed set (PL-005b).
  beforeLoad: ({ params }) => {
    if (!LOOKUP_LIST_TYPES.includes(params.listType as LookupListType)) throw notFound();
  },
  component: LookupValues,
});

type ValueRow = inferRouterOutputs<AppRouter>['platform']['lookup']['adminList']['items'][number];
type SortKey = 'sort_order' | 'label' | 'updated_at';

/**
 * Form-shaped schemas, mirroring the wire schemas in `@repo/trpc/schemas`.
 *
 * They are restated rather than imported because the shapes genuinely differ: a
 * cleared optional field is `''` in a controlled input, not `undefined`. The
 * server schema remains the authority; these only stop an obviously-invalid form
 * being sent.
 *
 * (This note used to give a second reason — that `@repo/trpc`'s schema module
 * reached `@repo/db` and would drag the Postgres driver into the browser bundle.
 * Core plan 07 fixed that: `schemas.ts` is now free of `@repo/db` and exported
 * as the `@repo/trpc/schemas` subpath, so a form that wants the wire schema
 * verbatim may import it.)
 *
 * Keep the code pattern in step with `lookupCodeSchema` and the
 * `lookup_code_format_check` CHECK — it is what migrations and integrations key
 * on, so a divergence here shows up as a confusing server rejection.
 */
const createFormSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, 'Give the value a code')
    .regex(/^[a-z0-9][a-z0-9_]{0,63}$/, 'Lowercase letters, digits and underscores only'),
  label: z.string().trim().min(1, 'Give the value a label').max(200),
  description: z.string().trim().max(1000),
});

const editFormSchema = z.object({
  id: z.string(),
  label: z.string().trim().min(1, 'Give the value a label').max(200),
  description: z.string().trim().max(1000),
  sortOrder: z.number().int().min(0, 'Order cannot be negative').max(9999),
});

const columnHelper = createColumnHelper<ValueRow>();

function LookupValues() {
  const { listType } = Route.useParams() as { listType: LookupListType };
  const utils = trpcReact.useUtils();

  const [searchInput, setSearchInput] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [activeFilter, setActiveFilter] = React.useState('');
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'sort_order',
    dir: 'asc',
  });
  // Forward-only keyset cursors: the stack holds the cursor of each page beyond
  // the first (empty = first page).
  const [cursorStack, setCursorStack] = React.useState<string[]>([]);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ValueRow | null>(null);
  const [removing, setRemoving] = React.useState<ValueRow | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Any change but the cursor resets pagination — the encoded cursor is tied to
  // the current sort expression.
  React.useEffect(() => {
    setCursorStack([]);
  }, [listType, search, activeFilter, sort.key, sort.dir]);

  const query = trpcReact.platform.lookup.adminList.useQuery({
    listType,
    limit: 25,
    cursor: cursorStack[cursorStack.length - 1],
    search: search || undefined,
    active: activeFilter === '' ? undefined : activeFilter === 'true',
    sort: sort.key,
    sortDir: sort.dir,
  });

  /** Every write invalidates the options cache too, so consuming dropdowns
      pick the change up without a reload — the visible half of AC-D1. */
  const refresh = async () => {
    await Promise.all([
      utils.platform.lookup.adminList.invalidate(),
      utils.platform.lookup.options.invalidate(),
      utils.platform.lookup.listTypes.invalidate(),
    ]);
  };

  const createMutation = trpcReact.platform.lookup.create.useMutation({
    onSuccess: async () => {
      setCreateOpen(false);
      await refresh();
    },
  });
  const updateMutation = trpcReact.platform.lookup.update.useMutation({
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });
  const setActiveMutation = trpcReact.platform.lookup.setActive.useMutation({
    onSuccess: refresh,
  });
  const removeMutation = trpcReact.platform.lookup.remove.useMutation({
    onSuccess: async () => {
      setRemoving(null);
      await refresh();
    },
  });

  const editForm = useForm({
    defaultValues: { id: '', label: '', description: '', sortOrder: 0 },
    validators: { onChange: editFormSchema },
    onSubmit: async ({ value }) => {
      await updateMutation.mutateAsync({
        id: value.id,
        label: value.label,
        description: value.description || null,
        sortOrder: value.sortOrder,
      });
    },
  });

  /**
   * Opening the editor. Defined above the column definitions so the Edit button
   * can call it — wiring the button straight to `setEditing` would open the
   * dialog still showing the previous mutation's error.
   */
  const openEdit = React.useCallback(
    (row: ValueRow) => {
      updateMutation.reset();
      setEditing(row);
    },
    [updateMutation],
  );

  /**
   * Load the row into the form once the dialog is open.
   *
   * This has to happen here rather than inside `openEdit`: the form instance is
   * created at component level but its fields only mount when the modal does,
   * and a reset issued before they mount is discarded when they read their
   * defaults — which showed up as an Edit dialog with an empty Label.
   */
  React.useEffect(() => {
    if (!editing) return;
    editForm.reset({
      id: editing.id,
      label: editing.label,
      description: editing.description ?? '',
      sortOrder: editing.sort_order,
    });
  }, [editing, editForm]);

  const columns = React.useMemo(
    () => [
      columnHelper.accessor('label', {
        id: 'label',
        header: 'Label',
        meta: { sortKey: 'label' as SortKey },
        cell: (info) => (
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-strong">{info.getValue()}</span>
            {info.row.original.description && (
              <span className="text-sm text-muted">{info.row.original.description}</span>
            )}
          </div>
        ),
      }),
      columnHelper.accessor('code', {
        id: 'code',
        header: 'Code',
        cell: (info) => (
          <span className="rounded-sm border border-border-subtle bg-gray-100 px-2 py-1 font-mono text-sm tracking-wide text-body">
            {info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor('sort_order', {
        id: 'sort_order',
        header: 'Order',
        meta: { sortKey: 'sort_order' as SortKey },
        cell: (info) => (
          <span className="font-mono text-sm tabular-nums text-muted">{info.getValue()}</span>
        ),
      }),
      columnHelper.accessor('updated_at', {
        id: 'updated_at',
        header: 'Updated',
        meta: { sortKey: 'updated_at' as SortKey },
        cell: (info) => (
          <span className="font-mono text-sm text-muted">{formatTimestamp(info.getValue())}</span>
        ),
      }),
      columnHelper.display({
        id: 'active',
        header: 'Active',
        cell: (info) => (
          <Switch
            checked={info.row.original.active}
            aria-label={`${info.row.original.active ? 'Deactivate' : 'Reactivate'} ${info.row.original.label}`}
            disabled={setActiveMutation.isPending}
            onChange={(e) =>
              setActiveMutation.mutate({ id: info.row.original.id, active: e.target.checked })
            }
          />
        ),
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        cell: (info) => (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              startIcon={<Pencil size={15} />}
              onClick={() => openEdit(info.row.original)}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              startIcon={<Trash2 size={15} />}
              onClick={() => setRemoving(info.row.original)}
            >
              Remove
            </Button>
          </div>
        ),
      }),
    ],
    [setActiveMutation, openEdit],
  );

  const rows = query.data?.items ?? [];
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    // Server-side everything: the table renders the one keyset page it is given.
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
  });

  const createForm = useForm({
    defaultValues: { code: '', label: '', description: '' },
    validators: { onChange: createFormSchema },
    onSubmit: async ({ value }) => {
      await createMutation.mutateAsync({
        listType,
        code: value.code,
        label: value.label,
        description: value.description || undefined,
      });
    },
  });

  const openCreate = () => {
    createForm.reset();
    createMutation.reset();
    setCreateOpen(true);
  };

  const hasNext = Boolean(query.data?.nextCursor);
  const hasPrev = cursorStack.length > 0;
  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <PageHeader
        title={LOOKUP_LIST_LABELS[listType]}
        description={LOOKUP_LIST_DESCRIPTIONS[listType]}
        meta={
          <Link
            to="/admin/reference-data"
            className="inline-flex items-center gap-1 font-sans text-sm text-muted transition-colors hover:text-body"
          >
            <ChevronLeft size={15} /> All reference data
          </Link>
        }
        primaryAction={
          <Button startIcon={<Plus size={17} />} onClick={openCreate}>
            Add a value
          </Button>
        }
      />

      {setActiveMutation.error && (
        <Callout tone="danger" title="Couldn’t change that value">
          {setActiveMutation.error.message}
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
              placeholder="Search label or code"
              aria-label="Search values"
              className="min-w-0 flex-1 bg-transparent font-sans text-sm text-strong outline-none"
            />
          </div>
          <select
            aria-label="Filter by state"
            value={activeFilter}
            onChange={(e) => setActiveFilter(e.target.value)}
            className="h-9 rounded-md border border-border-default bg-surface-card px-3 font-sans text-sm text-body outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <option value="">Active and retired</option>
            <option value="true">Active only</option>
            <option value="false">Retired only</option>
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
                      Loading values…
                    </td>
                  </tr>
                ) : query.error ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="px-4 py-10 text-center font-sans text-sm text-status-danger"
                    >
                      Couldn’t load this list. Try again.
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="px-4 py-10 text-center font-sans text-sm text-muted"
                    >
                      {search || activeFilter
                        ? 'No values match these filters.'
                        : 'This list has no values yet.'}
                    </td>
                  </tr>
                ) : (
                  table.getRowModel().rows.map((row) => (
                    <tr
                      key={row.id}
                      className={cn(
                        'border-b border-border-subtle transition-colors last:border-0 hover:bg-gray-50',
                        !row.original.active && 'opacity-60',
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

        <Callout tone="info" title="Retire rather than remove">
          Turning a value off hides it from new entries; records that already use it keep displaying
          its label. Remove is only for a value added by mistake and never used — and the code stays
          reserved either way, so it can never come back meaning something else.
        </Callout>
      </div>

      {/* Add a value */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={`Add to ${LOOKUP_LIST_LABELS[listType].toLowerCase()}`}
        description="The label is what people see and can be changed later. The code is permanent — it is what migrations, integrations and reports key on."
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
                  {isSubmitting ? 'Adding…' : 'Add value'}
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
            <Callout tone="danger" title="Couldn’t add the value">
              {createMutation.error.message}
            </Callout>
          )}

          <createForm.Field name="label">
            {(field) => (
              <Field
                label="Label"
                htmlFor={field.name}
                required
                error={field.state.meta.errors[0]?.message}
              >
                <Input
                  id={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="e.g. Migraine"
                />
              </Field>
            )}
          </createForm.Field>

          <createForm.Field name="code">
            {(field) => (
              <Field
                label="Code"
                htmlFor={field.name}
                required
                hint="Lowercase letters, digits and underscores. Permanent once saved."
                error={field.state.meta.errors[0]?.message}
              >
                <Input
                  id={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value.toLowerCase())}
                  placeholder="e.g. migraine"
                  className="font-mono"
                />
              </Field>
            )}
          </createForm.Field>

          <createForm.Field name="description">
            {(field) => (
              <Field
                label="Description"
                htmlFor={field.name}
                hint="Optional. Shown to administrators, not on forms."
                error={field.state.meta.errors[0]?.message}
              >
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
        </form>
      </Modal>

      {/* Edit a value */}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Edit value"
        description="The code cannot be changed — renaming means changing the label."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <editForm.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button
                  onClick={() => void editForm.handleSubmit()}
                  disabled={!canSubmit || isSubmitting}
                >
                  {isSubmitting ? 'Saving…' : 'Save changes'}
                </Button>
              )}
            </editForm.Subscribe>
          </div>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void editForm.handleSubmit();
          }}
        >
          {updateMutation.error && (
            <Callout tone="danger" title="Couldn’t save the value">
              {updateMutation.error.message}
            </Callout>
          )}

          {editing && (
            <Field label="Code" hint="Permanent — migrations and reports key on it.">
              <span className="inline-flex w-fit rounded-sm border border-border-subtle bg-gray-100 px-2 py-1.5 font-mono text-sm tracking-wide text-body">
                {editing.code}
              </span>
            </Field>
          )}

          <editForm.Field name="label">
            {(field) => (
              <Field
                label="Label"
                htmlFor={field.name}
                required
                error={field.state.meta.errors[0]?.message}
              >
                <Input
                  id={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </editForm.Field>

          <editForm.Field name="description">
            {(field) => (
              <Field
                label="Description"
                htmlFor={field.name}
                error={field.state.meta.errors[0]?.message}
              >
                <Textarea
                  id={field.name}
                  rows={2}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </editForm.Field>

          <editForm.Field name="sortOrder">
            {(field) => (
              <Field
                label="Order"
                htmlFor={field.name}
                hint="Where the value sits in every dropdown. Lower comes first."
                error={field.state.meta.errors[0]?.message}
              >
                <Input
                  id={field.name}
                  type="number"
                  min={0}
                  value={String(field.state.value)}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(Number(e.target.value))}
                  className="w-28 font-mono"
                />
              </Field>
            )}
          </editForm.Field>
        </form>
      </Modal>

      {/* Remove a value */}
      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove this value?"
        description="Only do this for a value added by mistake that has never been used. To take a value out of circulation, turn it off instead."
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={removeMutation.isPending}
              onClick={() =>
                removing &&
                removeMutation.mutate({ id: removing.id, confirmNeverUsed: true as const })
              }
            >
              {removeMutation.isPending ? 'Removing…' : 'Yes, remove it'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          {removeMutation.error && (
            <Callout tone="danger" title="Couldn’t remove the value">
              {removeMutation.error.message}
            </Callout>
          )}
          {removing && (
            <p className="font-sans text-sm leading-normal text-body">
              <span className="font-semibold text-strong">{removing.label}</span>{' '}
              <span className="font-mono text-sm text-muted">({removing.code})</span> will be
              removed. The code stays reserved, so it cannot be reused for something else.
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
