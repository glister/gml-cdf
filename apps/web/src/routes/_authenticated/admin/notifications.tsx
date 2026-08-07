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
import { sendTestNotificationInput } from '@repo/trpc/schemas';
import { ChevronDown, ChevronsUpDown, ChevronUp, Send } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/forms/Field';
import { Input } from '~/components/forms/Input';
import { Select } from '~/components/forms/Select';
import { StatusPill } from '~/components/data-display/StatusPill';
import { CHANNEL_LABEL, DELIVERY_STATUS_LABEL, deliveryTone } from '~/lib/notifications';

export const Route = createFileRoute('/_authenticated/admin/notifications')({
  component: NotificationDiagnostics,
});

type Row =
  inferRouterOutputs<AppRouter>['platform']['notifications']['adminDeliveries']['items'][number];
type SortKey = 'created_at' | 'attempted_at';
type StatusFilter = 'all' | Row['status'];
type ChannelFilter = 'all' | Row['channel'];

const columnHelper = createColumnHelper<Row>();

/**
 * Notification diagnostics and the send test (core plan 10 §5.5, §9.7).
 *
 * This screen is where the two failures a notification service actually has go
 * to be seen. **`dead` deliveries** — an address that bounced five times — and
 * **`suppressed` ones**, which are the answer to "why didn't I get an email?"
 * when a channel is off in configuration. Neither is visible anywhere else, and
 * a notification service whose failures live only in logs is one nobody trusts.
 *
 * The send test is the pilot slice (§9.7): pick a role, send, and the result
 * reports **how many people it resolved to — including zero**. Zero is the
 * answer that matters. A test reporting success against an empty role would
 * hide exactly the misconfiguration it exists to surface, so the count is on
 * the response rather than inferred from the absence of an error.
 *
 * It shows the notification's own title and no more. An administrator debugging
 * delivery sees exactly what the recipient saw, which is already PII-minimal by
 * construction (§4.6) — there is no "view content" affordance to add later.
 */
function NotificationDiagnostics() {
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('all');
  const [channelFilter, setChannelFilter] = React.useState<ChannelFilter>('all');
  const [kind, setKind] = React.useState('');
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'created_at',
    dir: 'desc',
  });
  const [cursorStack, setCursorStack] = React.useState<string[]>([]);
  const cursor = cursorStack[cursorStack.length - 1];

  React.useEffect(() => {
    setCursorStack([]);
  }, [statusFilter, channelFilter, kind, sort.key, sort.dir]);

  const utils = trpcReact.useUtils();
  const query = trpcReact.platform.notifications.adminDeliveries.useQuery({
    limit: 25,
    sort: sort.key,
    sortDir: sort.dir,
    cursor,
    status: statusFilter === 'all' ? undefined : [statusFilter],
    channel: channelFilter === 'all' ? undefined : [channelFilter],
    kind: kind || undefined,
  });

  const [testResult, setTestResult] = React.useState<{
    resolvedRecipients: number;
  } | null>(null);

  const sendTest = trpcReact.platform.notifications.sendTest.useMutation({
    onSuccess: async (result) => {
      setTestResult(result);
      await utils.platform.notifications.adminDeliveries.invalidate();
    },
  });

  const roles = trpcReact.platform.authz.roles.list.useQuery();

  const form = useForm({
    defaultValues: { roleId: '', note: '' },
    // The shared schema from `@repo/trpc` — the same object the procedure
    // validates against, so the form and the server cannot disagree about what
    // is valid. Narrowed to the two fields this form collects.
    validators: {
      // `.required()` for the same reason core plan 08's completion form needs
      // it: the field always holds a string (possibly empty) while the wire
      // schema makes `note` optional. The constraint that matters — its length
      // bound — is the server's own either way.
      onChange: sendTestNotificationInput
        .pick({ note: true })
        .extend({ roleId: sendTestNotificationInput.shape.recipient.options[0].shape.roleId })
        .required(),
    },
    onSubmit: async ({ value }) => {
      setTestResult(null);
      await sendTest.mutateAsync({
        recipient: { kind: 'role', roleId: value.roleId },
        ...(value.note.trim() ? { note: value.note.trim() } : {}),
      });
    },
  });

  const columns = React.useMemo(
    () => [
      columnHelper.accessor('title', {
        id: 'notification',
        header: 'Notification',
        cell: (info) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-sans text-sm font-semibold text-strong">{info.getValue()}</span>
            <span className="font-mono text-2xs text-muted">{info.row.original.kind}</span>
          </div>
        ),
      }),
      columnHelper.accessor('personName', {
        id: 'recipient',
        header: 'Recipient',
        cell: (info) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-sans text-sm text-body">{info.getValue() ?? '—'}</span>
            {/* *Why* this person: which half of the spec matched. Without it a
                role that has since changed makes an old list unexplainable. */}
            <span className="font-sans text-2xs text-muted">
              resolved by {info.row.original.resolvedVia}
            </span>
          </div>
        ),
      }),
      columnHelper.accessor('channel', {
        id: 'channel',
        header: 'Channel',
        cell: (info) => (
          <span className="font-sans text-sm text-body">
            {CHANNEL_LABEL[info.getValue()] ?? info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor('status', {
        id: 'status',
        header: 'Status',
        cell: (info) => (
          <div className="flex flex-col items-start gap-1">
            <StatusPill tone={deliveryTone(info.getValue())} size="sm">
              {DELIVERY_STATUS_LABEL[info.getValue()] ?? info.getValue()}
            </StatusPill>
            {info.row.original.lastError && (
              <span
                className="max-w-[280px] truncate font-sans text-2xs text-muted"
                title={info.row.original.lastError}
              >
                {info.row.original.lastError}
              </span>
            )}
          </div>
        ),
      }),
      columnHelper.accessor('attemptCount', {
        id: 'attempts',
        header: 'Attempts',
        meta: { sortKey: 'attempted_at' as SortKey },
        cell: (info) => (
          <span className="whitespace-nowrap font-mono text-2xs text-body">
            {info.getValue()}
            {info.row.original.attemptedAt && (
              <span className="ml-1.5 text-muted">
                {new Date(info.row.original.attemptedAt).toLocaleString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            )}
          </span>
        ),
      }),
      columnHelper.accessor('createdAt', {
        id: 'created',
        header: 'Created',
        meta: { sortKey: 'created_at' as SortKey },
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
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' },
    );
  }

  const hasNext = Boolean(query.data?.nextCursor);
  const hasPrev = cursorStack.length > 0;

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-5">
      <PageHeader
        title="Notifications"
        description="Every delivery the platform has attempted, and a send test that proves recipient resolution end to end. A notification names a role, never a person — so changing who holds a role redirects the next send with nothing else to update."
      />

      {/* --- Send test (§9.7) ------------------------------------------------ */}
      <section className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface-card p-4">
        <div>
          <h2 className="font-sans text-base font-bold tracking-tight text-strong">
            Send a test notification
          </h2>
          <p className="mt-1 font-sans text-sm text-muted">
            Sent to everyone currently holding the role. Change the role&rsquo;s membership and send
            again — the new holder receives it and the old one does not, with nothing else changed.
          </p>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
          className="flex flex-col gap-3"
        >
          <div className="grid gap-3 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)_auto] sm:items-end">
            <form.Field name="roleId">
              {(field) => (
                <Field
                  label="Role"
                  htmlFor={field.name}
                  required
                  error={field.state.meta.errors[0]?.message ?? undefined}
                >
                  <Select
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    <option value="">Choose a role…</option>
                    {(roles.data ?? []).map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </form.Field>

            <form.Field name="note">
              {(field) => (
                <Field
                  label="Note"
                  htmlFor={field.name}
                  hint="Optional. Shown in the test message body."
                  error={field.state.meta.errors[0]?.message ?? undefined}
                >
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    placeholder="Checking the on-call rota resolves"
                  />
                </Field>
              )}
            </form.Field>

            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button type="submit" disabled={!canSubmit || isSubmitting} className="sm:mb-6">
                  <Send size={16} aria-hidden="true" />
                  {isSubmitting ? 'Sending…' : 'Send test'}
                </Button>
              )}
            </form.Subscribe>
          </div>
        </form>

        {sendTest.error && (
          <Callout tone="danger" title="Couldn’t send the test">
            {sendTest.error.message}
          </Callout>
        )}
        {testResult && (
          // Zero is a real, reportable answer — and the one worth surfacing
          // loudly, because it means a role nobody holds.
          <Callout
            tone={testResult.resolvedRecipients === 0 ? 'warning' : 'success'}
            title={
              testResult.resolvedRecipients === 0
                ? 'That role resolved to nobody'
                : `Resolved to ${testResult.resolvedRecipients} ${
                    testResult.resolvedRecipients === 1 ? 'person' : 'people'
                  }`
            }
          >
            {testResult.resolvedRecipients === 0
              ? 'Nothing was delivered, and the platform has recorded why. Grant the role to someone and send again.'
              : 'Delivery runs in the background. The table below updates as each channel is attempted.'}
          </Callout>
        )}
      </section>

      {/* --- Delivery diagnostics ------------------------------------------- */}
      {query.error && (
        <Callout tone="danger" title="Couldn’t load deliveries">
          {query.error.message}
        </Callout>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <Select
            aria-label="Filter by delivery status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            className="h-9 w-[190px]"
          >
            <option value="all">Every status</option>
            <option value="sent">Sent</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed</option>
            <option value="dead">Given up</option>
            <option value="suppressed">Suppressed</option>
          </Select>
          <Select
            aria-label="Filter by channel"
            value={channelFilter}
            onChange={(event) => setChannelFilter(event.target.value as ChannelFilter)}
            className="h-9 w-[160px]"
          >
            <option value="all">Every channel</option>
            <option value="in_app">In-app</option>
            <option value="email">Email</option>
            <option value="push">Push</option>
          </Select>
          <Input
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            placeholder="Notification kind"
            aria-label="Filter by notification kind"
            className="h-9 w-[200px]"
          />
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
                      Loading deliveries…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="px-4 py-10 text-center font-sans text-sm text-muted"
                    >
                      No deliveries match these filters.
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
              onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              disabled={!hasNext}
              onClick={() => {
                const next = query.data?.nextCursor;
                if (next) setCursorStack((stack) => [...stack, next]);
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
