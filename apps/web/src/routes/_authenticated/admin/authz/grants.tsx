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
import { ChevronLeft, ChevronRight, KeyRound, Search, ShieldOff } from 'lucide-react';
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
import {
  GRANT_STATE_LABELS,
  GRANT_STATE_OPTIONS,
  GRANT_STATE_TONES,
  MODULE_OPTIONS,
  MODULE_SHORT_LABELS,
  ROLE_LABELS,
  ROLE_OPTIONS,
  type GrantState,
  type ModuleKey,
  type RoleKey,
} from '../../../../lib/authz.js';

export const Route = createFileRoute('/_authenticated/admin/authz/grants')({
  component: GrantsScreen,
});

type GrantRow =
  inferRouterOutputs<AppRouter>['platform']['authz']['grants']['list']['items'][number];

/* Local form schemas mirroring `grantRoleInput` / `revokeGrantInput`
   (@repo/trpc). The contract's runtime Zod can't be imported client-side — its
   only entry point pulls the server router — so the shapes are mirrored here,
   as in people/new.tsx. The server re-validates regardless; this is UX. */
const ROLE_KEYS = ROLE_OPTIONS.map(([k]) => k) as [RoleKey, ...RoleKey[]];
const MODULE_KEYS = MODULE_OPTIONS.map(([k]) => k) as [ModuleKey, ...ModuleKey[]];

const grantFormSchema = z
  .object({
    personId: z.string().uuid('Choose a person'),
    roleKey: z.enum(ROLE_KEYS, { message: 'Choose a role' }),
    module: z.enum(MODULE_KEYS, { message: 'Choose a module' }),
    validFrom: z.string(),
    validUntil: z.string(),
  })
  .refine((v) => !v.validFrom || !v.validUntil || v.validUntil > v.validFrom, {
    message: 'The end date must be after the start date',
    path: ['validUntil'],
  });

const revokeFormSchema = z.object({
  reason: z.string().trim().min(1, 'Give a reason — it is recorded in the audit trail').max(500),
});

const columnHelper = createColumnHelper<GrantRow>();
const columns = [
  columnHelper.accessor('personDisplayName', {
    id: 'person',
    header: 'Person',
    cell: (info) => <PersonCell name={info.getValue()} />,
  }),
  columnHelper.accessor('roleKey', {
    id: 'role',
    header: 'Role',
    cell: (info) => (
      <span className="text-sm font-medium text-strong">
        {ROLE_LABELS[info.getValue() as RoleKey]}
      </span>
    ),
  }),
  columnHelper.accessor('module', {
    id: 'module',
    header: 'Module',
    cell: (info) => (
      <span className="text-sm text-body">{MODULE_SHORT_LABELS[info.getValue() as ModuleKey]}</span>
    ),
  }),
  columnHelper.accessor('state', {
    id: 'state',
    header: 'State',
    cell: (info) => {
      const state = info.getValue() as GrantState;
      return <StatusPill tone={GRANT_STATE_TONES[state]}>{GRANT_STATE_LABELS[state]}</StatusPill>;
    },
  }),
  columnHelper.accessor('validUntil', {
    id: 'window',
    header: 'Until',
    cell: (info) => (
      <span className="font-mono text-sm text-body">
        {info.getValue() ? formatDate(info.getValue()) : 'Open-ended'}
      </span>
    ),
  }),
  columnHelper.accessor('createdAt', {
    id: 'granted',
    header: 'Granted',
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

function GrantsScreen() {
  const utils = trpcReact.useUtils();
  const [searchInput, setSearchInput] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [roleKey, setRoleKey] = React.useState('');
  const [moduleKey, setModuleKey] = React.useState('');
  const [state, setState] = React.useState('');
  const [cursorStack, setCursorStack] = React.useState<string[]>([]);
  const [grantOpen, setGrantOpen] = React.useState(false);
  const [revoking, setRevoking] = React.useState<GrantRow | null>(null);
  const cursor = cursorStack[cursorStack.length - 1];

  React.useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Any change to the query except the cursor resets pagination — the encoded
  // cursor is tied to the current filter/sort expression.
  React.useEffect(() => {
    setCursorStack([]);
  }, [search, roleKey, moduleKey, state]);

  const query = trpcReact.platform.authz.grants.list.useQuery({
    limit: 25,
    sortDir: 'desc',
    cursor,
    search: search || undefined,
    roleKey: (roleKey || undefined) as RoleKey | undefined,
    module: (moduleKey || undefined) as ModuleKey | undefined,
    state: (state || undefined) as GrantState | undefined,
  });

  // The person picker's option set. Restricted to what the caller may see —
  // the procedure scopes it server-side, so this list is already correct.
  const people = trpcReact.platform.identity.listPersons.useQuery({ limit: 100 });

  const grantMutation = trpcReact.platform.authz.grants.grant.useMutation({
    onSuccess: async () => {
      setGrantOpen(false);
      await utils.platform.authz.grants.list.invalidate();
      await utils.platform.authz.roles.invalidate();
    },
  });
  const revokeMutation = trpcReact.platform.authz.grants.revoke.useMutation({
    onSuccess: async () => {
      setRevoking(null);
      await utils.platform.authz.grants.list.invalidate();
      await utils.platform.authz.roles.invalidate();
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

  const grantForm = useForm({
    defaultValues: {
      personId: '',
      roleKey: '' as RoleKey | '',
      module: '' as ModuleKey | '',
      validFrom: '',
      validUntil: '',
    },
    validators: { onChange: grantFormSchema },
    onSubmit: async ({ value }) => {
      await grantMutation.mutateAsync({
        personId: value.personId,
        roleKey: value.roleKey as RoleKey,
        module: value.module as ModuleKey,
        validFrom: value.validFrom ? new Date(value.validFrom).toISOString() : undefined,
        validUntil: value.validUntil
          ? new Date(`${value.validUntil}T23:59:59.999Z`).toISOString()
          : undefined,
      });
    },
  });

  const revokeForm = useForm({
    defaultValues: { reason: '' },
    validators: { onChange: revokeFormSchema },
    onSubmit: async ({ value }) => {
      if (!revoking) return;
      await revokeMutation.mutateAsync({ grantId: revoking.id, reason: value.reason });
    },
  });

  const openGrant = () => {
    grantForm.reset();
    grantMutation.reset();
    setGrantOpen(true);
  };
  const openRevoke = (row: GrantRow) => {
    revokeForm.reset();
    revokeMutation.reset();
    setRevoking(row);
  };

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <PageHeader
        title="Role grants"
        description="Who holds which role, in which module. Access is by role only — a grant is the single, audited way anyone gains it."
        primaryAction={
          <Button startIcon={<KeyRound size={17} />} onClick={openGrant}>
            Grant a role
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
              placeholder="Search person name or email"
              aria-label="Search grants by person"
              className="min-w-0 flex-1 bg-transparent font-sans text-sm text-strong outline-none"
            />
          </div>
          <FilterSelect
            label="All roles"
            value={roleKey}
            onChange={setRoleKey}
            options={ROLE_OPTIONS}
          />
          <FilterSelect
            label="All modules"
            value={moduleKey}
            onChange={setModuleKey}
            options={MODULE_OPTIONS}
          />
          <FilterSelect
            label="All states"
            value={state}
            onChange={setState}
            options={GRANT_STATE_OPTIONS}
          />
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
                      Loading grants…
                    </td>
                  </tr>
                ) : query.error ? (
                  <tr>
                    <td
                      colSpan={columns.length + 1}
                      className="px-4 py-10 text-center font-sans text-sm text-status-danger"
                    >
                      Couldn’t load grants. Try again.
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length + 1}
                      className="px-4 py-10 text-center font-sans text-sm text-muted"
                    >
                      No grants match these filters.
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
                        {row.original.revokedAt ? (
                          <span className="font-sans text-xs text-muted">
                            {row.original.revokeReason}
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            startIcon={<ShieldOff size={15} />}
                            onClick={() => openRevoke(row.original)}
                          >
                            Revoke
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

      {/* --- Grant a role ---------------------------------------------- */}
      <Modal
        open={grantOpen}
        onClose={() => setGrantOpen(false)}
        title="Grant a role"
        description="The role applies only in the module you choose. Reaching another module needs its own grant."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setGrantOpen(false)}>
              Cancel
            </Button>
            <grantForm.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button
                  onClick={() => void grantForm.handleSubmit()}
                  disabled={!canSubmit || isSubmitting}
                >
                  {isSubmitting ? 'Granting…' : 'Grant role'}
                </Button>
              )}
            </grantForm.Subscribe>
          </div>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void grantForm.handleSubmit();
          }}
        >
          {grantMutation.error && (
            <Callout tone="danger" title="Couldn’t grant the role">
              {grantMutation.error.message}
            </Callout>
          )}

          <grantForm.Field name="personId">
            {(field) => (
              <Field
                label="Person"
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
          </grantForm.Field>

          <grantForm.Field name="roleKey">
            {(field) => (
              <Field
                label="Role"
                htmlFor={field.name}
                required
                error={field.state.meta.errors[0]?.message}
              >
                <Select
                  id={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value as RoleKey)}
                >
                  <option value="">Choose a role</option>
                  {ROLE_OPTIONS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </grantForm.Field>

          <grantForm.Field name="module">
            {(field) => (
              <Field
                label="Module"
                htmlFor={field.name}
                required
                hint="Where the role applies. There is no wildcard — Platform does not cover the HR modules."
                error={field.state.meta.errors[0]?.message}
              >
                <Select
                  id={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value as ModuleKey)}
                >
                  <option value="">Choose a module</option>
                  {MODULE_OPTIONS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </grantForm.Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <grantForm.Field name="validFrom">
              {(field) => (
                <Field
                  label="Starts"
                  htmlFor={field.name}
                  hint="Leave blank to start now"
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
            </grantForm.Field>
            <grantForm.Field name="validUntil">
              {(field) => (
                <Field
                  label="Ends"
                  htmlFor={field.name}
                  hint="Leave blank for open-ended"
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
            </grantForm.Field>
          </div>
        </form>
      </Modal>

      {/* --- Revoke ------------------------------------------------------ */}
      <Modal
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        closeOnOverlay={false}
        size="sm"
        title="Revoke this grant?"
        description={
          revoking
            ? `${revoking.personDisplayName} loses ${ROLE_LABELS[revoking.roleKey as RoleKey]} in ${MODULE_SHORT_LABELS[revoking.module as ModuleKey]} immediately. The grant is kept as history, never deleted.`
            : undefined
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <revokeForm.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button
                  variant="danger"
                  onClick={() => void revokeForm.handleSubmit()}
                  disabled={!canSubmit || isSubmitting}
                >
                  {isSubmitting ? 'Revoking…' : 'Revoke'}
                </Button>
              )}
            </revokeForm.Subscribe>
          </div>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void revokeForm.handleSubmit();
          }}
        >
          {revokeMutation.error && (
            <Callout tone="danger" title="Couldn’t revoke the grant">
              {revokeMutation.error.message}
            </Callout>
          )}
          <revokeForm.Field name="reason">
            {(field) => (
              <Field
                label="Reason"
                htmlFor={field.name}
                required
                hint="Recorded against the grant and in the audit trail."
                error={field.state.meta.errors[0]?.message}
              >
                <Textarea
                  id={field.name}
                  rows={3}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="e.g. moved to a different team"
                />
              </Field>
            )}
          </revokeForm.Field>
        </form>
      </Modal>
    </div>
  );
}
