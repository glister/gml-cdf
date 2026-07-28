import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
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
import { ChevronLeft, ChevronRight, UserMinus, UserPlus } from 'lucide-react';
import { trpcReact } from '../../../../trpc.js';
import { PageHeader } from '../../../../components/nav/PageHeader.js';
import { PersonCell } from '../../../../components/data-display/PersonCell.js';
import { StatusPill } from '../../../../components/data-display/StatusPill.js';
import { Callout } from '../../../../components/feedback/Callout.js';
import { Modal } from '../../../../components/feedback/Modal.js';
import { Field } from '../../../../components/forms/Field.js';
import { Input } from '../../../../components/forms/Input.js';
import { Select } from '../../../../components/forms/Select.js';
import { Textarea } from '../../../../components/forms/Textarea.js';
import { Button } from '../../../../components/ui/button.js';
import { cn } from '../../../../lib/utils.js';
import { formatDate } from '../../../../lib/people.js';

export const Route = createFileRoute('/_authenticated/admin/authz/allocations')({
  component: AllocationsScreen,
});

type AllocationRow =
  inferRouterOutputs<AppRouter>['platform']['authz']['allocations']['list']['items'][number];

/* Local form schemas mirroring `addAllocationInput` / `endAllocationInput`
   (@repo/trpc) — the contract's runtime Zod can't be imported client-side. */
const addFormSchema = z
  .object({
    adminPersonId: z.string().uuid('Choose an external administrator'),
    personId: z.string().uuid('Choose the person to allocate'),
    validUntil: z.string(),
  })
  .refine((v) => v.adminPersonId !== v.personId, {
    message: 'A person cannot be allocated to themselves',
    path: ['personId'],
  });

const endFormSchema = z.object({
  reason: z.string().trim().min(1, 'Give a reason — it is recorded in the audit trail').max(500),
});

const columnHelper = createColumnHelper<AllocationRow>();
const columns = [
  columnHelper.accessor('adminDisplayName', {
    id: 'admin',
    header: 'External administrator',
    cell: (info) => <PersonCell name={info.getValue()} />,
  }),
  columnHelper.accessor('personDisplayName', {
    id: 'person',
    header: 'Allocated person',
    cell: (info) => <PersonCell name={info.getValue()} />,
  }),
  columnHelper.accessor('validUntil', {
    id: 'until',
    header: 'Until',
    cell: (info) => (
      <span className="font-mono text-sm text-body">
        {info.getValue() ? formatDate(info.getValue()) : 'Open-ended'}
      </span>
    ),
  }),
  columnHelper.accessor('endedAt', {
    id: 'state',
    header: 'State',
    cell: (info) =>
      info.getValue() ? (
        <StatusPill tone="neutral">Ended</StatusPill>
      ) : (
        <StatusPill tone="success">Live</StatusPill>
      ),
  }),
  columnHelper.accessor('createdAt', {
    id: 'created',
    header: 'Allocated',
    cell: (info) => (
      <span className="font-mono text-sm text-muted">{formatDate(info.getValue())}</span>
    ),
  }),
];

function AllocationsScreen() {
  const utils = trpcReact.useUtils();
  const [liveOnly, setLiveOnly] = React.useState(true);
  const [cursorStack, setCursorStack] = React.useState<string[]>([]);
  const [addOpen, setAddOpen] = React.useState(false);
  const [ending, setEnding] = React.useState<AllocationRow | null>(null);
  const cursor = cursorStack[cursorStack.length - 1];

  React.useEffect(() => {
    setCursorStack([]);
  }, [liveOnly]);

  const query = trpcReact.platform.authz.allocations.list.useQuery({
    limit: 25,
    sortDir: 'desc',
    cursor,
    liveOnly,
  });
  const people = trpcReact.platform.identity.listPersons.useQuery({ limit: 100 });
  // Everyone currently holding the external_administrator role — the only
  // people an allocation can attach to (the server enforces this too).
  const externalAdmins = trpcReact.platform.authz.grants.list.useQuery({
    roleKey: 'external_administrator',
    state: 'active',
    limit: 100,
  });

  const addMutation = trpcReact.platform.authz.allocations.add.useMutation({
    onSuccess: async () => {
      setAddOpen(false);
      await utils.platform.authz.allocations.list.invalidate();
    },
  });
  const endMutation = trpcReact.platform.authz.allocations.end.useMutation({
    onSuccess: async () => {
      setEnding(null);
      await utils.platform.authz.allocations.list.invalidate();
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

  const addForm = useForm({
    defaultValues: { adminPersonId: '', personId: '', validUntil: '' },
    validators: { onChange: addFormSchema },
    onSubmit: async ({ value }) => {
      await addMutation.mutateAsync({
        adminPersonId: value.adminPersonId,
        personId: value.personId,
        validUntil: value.validUntil
          ? new Date(`${value.validUntil}T23:59:59.999Z`).toISOString()
          : undefined,
      });
    },
  });

  const endForm = useForm({
    defaultValues: { reason: '' },
    validators: { onChange: endFormSchema },
    onSubmit: async ({ value }) => {
      if (!ending) return;
      await endMutation.mutateAsync({ allocationId: ending.id, reason: value.reason });
    },
  });

  const hasNext = Boolean(query.data?.nextCursor);
  const hasPrev = cursorStack.length > 0;

  // De-duplicate: one person may hold the role in several modules.
  const adminOptions = Array.from(
    new Map(
      (externalAdmins.data?.items ?? []).map((g) => [g.personId, g.personDisplayName]),
    ).entries(),
  );

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <PageHeader
        title="External administrator allocations"
        description="Which people each restricted external administrator may reach. Nothing else is visible to them — and ending an allocation closes that window immediately."
        primaryAction={
          <Button
            startIcon={<UserPlus size={17} />}
            onClick={() => {
              addForm.reset();
              addMutation.reset();
              setAddOpen(true);
            }}
          >
            Allocate a person
          </Button>
        }
      />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border-default bg-surface-card px-3 font-sans text-sm text-body">
            <input
              type="checkbox"
              checked={liveOnly}
              onChange={(e) => setLiveOnly(e.target.checked)}
              className="size-4 accent-brand"
            />
            Live allocations only
          </label>
        </div>

        <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface-card">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id} className="border-b border-border-subtle">
                    {hg.headers.map((header) => (
                      <th
                        key={header.id}
                        className="whitespace-nowrap px-4 py-3 text-left font-sans text-xs font-semibold uppercase tracking-wide text-muted"
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                    <th className="w-px px-4 py-3" />
                  </tr>
                ))}
              </thead>
              <tbody>
                {query.isLoading ? (
                  <tr>
                    <td
                      colSpan={columns.length + 1}
                      className="px-4 py-10 text-center font-sans text-sm text-muted"
                    >
                      Loading allocations…
                    </td>
                  </tr>
                ) : query.error ? (
                  <tr>
                    <td
                      colSpan={columns.length + 1}
                      className="px-4 py-10 text-center font-sans text-sm text-status-danger"
                    >
                      Couldn’t load allocations. Try again.
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length + 1}
                      className="px-4 py-10 text-center font-sans text-sm text-muted"
                    >
                      No allocations yet.
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
                      <td className="px-4 py-3 text-right">
                        {row.original.endedAt ? (
                          <span className="font-sans text-xs text-muted">
                            {row.original.endReason}
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            startIcon={<UserMinus size={15} />}
                            onClick={() => {
                              endForm.reset();
                              endMutation.reset();
                              setEnding(row.original);
                            }}
                          >
                            End
                          </Button>
                        )}
                      </td>
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

      {/* --- Allocate ---------------------------------------------------- */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Allocate a person"
        description="The external administrator will be able to reach this person, and only the people allocated to them."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <addForm.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button
                  onClick={() => void addForm.handleSubmit()}
                  disabled={!canSubmit || isSubmitting}
                >
                  {isSubmitting ? 'Allocating…' : 'Allocate'}
                </Button>
              )}
            </addForm.Subscribe>
          </div>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void addForm.handleSubmit();
          }}
        >
          {addMutation.error && (
            <Callout tone="danger" title="Couldn’t allocate">
              {addMutation.error.message}
            </Callout>
          )}
          {adminOptions.length === 0 && (
            <Callout tone="warning" title="No external administrators yet">
              Grant someone the External Administrator role before allocating people to them.
            </Callout>
          )}

          <addForm.Field name="adminPersonId">
            {(field) => (
              <Field
                label="External administrator"
                htmlFor={field.name}
                required
                error={field.state.meta.errors[0]?.message}
              >
                <Select
                  id={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                >
                  <option value="">Choose an administrator</option>
                  {adminOptions.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </addForm.Field>

          <addForm.Field name="personId">
            {(field) => (
              <Field
                label="Person to allocate"
                htmlFor={field.name}
                required
                error={field.state.meta.errors[0]?.message}
              >
                <Select
                  id={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                >
                  <option value="">Choose a person</option>
                  {(people.data?.items ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.display_name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </addForm.Field>

          <addForm.Field name="validUntil">
            {(field) => (
              <Field
                label="Ends"
                htmlFor={field.name}
                hint="Leave blank for open-ended. Usually aligned with the administrator's own access window."
                error={field.state.meta.errors[0]?.message}
              >
                <Input
                  id={field.name}
                  type="date"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </addForm.Field>
        </form>
      </Modal>

      {/* --- End an allocation ------------------------------------------ */}
      <Modal
        open={Boolean(ending)}
        onClose={() => setEnding(null)}
        closeOnOverlay={false}
        size="sm"
        title="End this allocation?"
        description={
          ending
            ? `${ending.adminDisplayName} loses access to ${ending.personDisplayName} immediately. The allocation is kept as history, never deleted.`
            : undefined
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEnding(null)}>
              Cancel
            </Button>
            <endForm.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button
                  variant="danger"
                  onClick={() => void endForm.handleSubmit()}
                  disabled={!canSubmit || isSubmitting}
                >
                  {isSubmitting ? 'Ending…' : 'End allocation'}
                </Button>
              )}
            </endForm.Subscribe>
          </div>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void endForm.handleSubmit();
          }}
        >
          {endMutation.error && (
            <Callout tone="danger" title="Couldn’t end the allocation">
              {endMutation.error.message}
            </Callout>
          )}
          <endForm.Field name="reason">
            {(field) => (
              <Field
                label="Reason"
                htmlFor={field.name}
                required
                hint="Recorded against the allocation and in the audit trail."
                error={field.state.meta.errors[0]?.message}
              >
                <Textarea
                  id={field.name}
                  rows={3}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="e.g. engagement finished"
                />
              </Field>
            )}
          </endForm.Field>
        </form>
      </Modal>
    </div>
  );
}
