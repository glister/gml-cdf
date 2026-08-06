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
// The schemas subpath, never the package root: the root exports the router, so
// importing a runtime value from it would pull `@trpc/server` into the browser
// bundle. Type-only imports from the root (above) are erased and stay fine.
import { cancelScheduledActionInput } from '@repo/trpc/schemas';
import {
  CalendarClock,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  CircleSlash,
  Search,
} from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { Modal } from '~/components/feedback/Modal';
import { StatusPill } from '~/components/data-display/StatusPill';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/forms/Field';
import { Input } from '~/components/forms/Input';
import { Textarea } from '~/components/forms/Textarea';
import {
  formatInstant,
  formatParams,
  formatRelative,
  isTimerOverdue,
  shortWorkflowKey,
  timerTone,
  TIMER_STATUS_LABEL,
} from '~/lib/workflow';

export const Route = createFileRoute('/_authenticated/admin/workflow/scheduled-actions')({
  component: ScheduledActions,
});

type TimerApiRow =
  inferRouterOutputs<AppRouter>['platform']['workflow']['listScheduledActions']['items'][number];

/**
 * The row shape the table sees — declared explicitly rather than derived.
 *
 * Naming the fields rather than deriving them keeps the row contract flat and
 * obvious, and — with `payload` already flattened at the router boundary —
 * keeps TanStack Table's column typing away from any recursive `jsonb` type
 * (TS2589).
 */
interface TimerRow {
  id: string;
  /** Instants arrive from tRPC as ISO strings; `formatInstant` takes either. */
  due_at: string;
  action_type: string;
  payload: Record<string, unknown>;
  status: TimerApiRow['status'];
  source: TimerApiRow['source'];
  subject_stream_type: string | null;
  workflow_instance_id: string | null;
  workflow_key: string | null;
  current_state: string | null;
  executed_at: string | null;
  cancel_reason: string | null;
}
type SortKey = 'due_at' | 'created_at';

const columnHelper = createColumnHelper<TimerRow>();

/**
 * Scheduled actions — the demonstrable face of WF-9 (core plan 07 §5.7).
 *
 * ADR-0013 chose to keep timers in Postgres rather than hand them to the broker
 * for exactly this screen's sake: pending timers must be **queryable, amendable
 * and cancellable**. Against broker-scheduled messages, "what is outstanding for
 * this case, and cancel it" is not a question anyone can ask. Here it is a
 * filter and two buttons.
 *
 * The one piece of operational intelligence the screen adds is the overdue
 * overlay. The scheduler runs every five minutes, so a timer a minute past due
 * is normal; one well past due means the cron Job has not run — and that is
 * something only this view would notice.
 */
function ScheduledActions() {
  const [actionTypeInput, setActionTypeInput] = React.useState('');
  const [actionType, setActionType] = React.useState('');
  const [status, setStatus] = React.useState<'' | TimerRow['status']>('pending');
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'due_at',
    dir: 'asc',
  });
  const [cursorStack, setCursorStack] = React.useState<string[]>([]);
  const cursor = cursorStack[cursorStack.length - 1];

  const [cancelling, setCancelling] = React.useState<TimerRow | null>(null);
  const [rescheduling, setRescheduling] = React.useState<TimerRow | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setActionType(actionTypeInput.trim()), 300);
    return () => clearTimeout(t);
  }, [actionTypeInput]);

  React.useEffect(() => {
    setCursorStack([]);
  }, [actionType, status, sort.key, sort.dir]);

  const query = trpcReact.platform.workflow.listScheduledActions.useQuery({
    limit: 25,
    sort: sort.key,
    sortDir: sort.dir,
    cursor,
    actionType: actionType || undefined,
    status: status || undefined,
  });

  const refetch = React.useCallback(async () => {
    await query.refetch();
  }, [query]);

  const columns = React.useMemo(
    () => [
      columnHelper.accessor('due_at', {
        id: 'due_at',
        header: 'Due',
        meta: { sortKey: 'due_at' as SortKey },
        cell: (info) => (
          <div className="flex flex-col">
            <span className="whitespace-nowrap font-mono text-sm text-strong">
              {formatInstant(info.getValue())}
            </span>
            <span className="font-sans text-2xs text-muted">{formatRelative(info.getValue())}</span>
          </div>
        ),
      }),
      columnHelper.accessor('status', {
        id: 'status',
        header: 'Status',
        cell: (info) => (
          <StatusPill
            tone={timerTone(info.getValue())}
            overdue={isTimerOverdue(info.getValue(), info.row.original.due_at)}
          >
            {TIMER_STATUS_LABEL[info.getValue()] ?? info.getValue()}
          </StatusPill>
        ),
      }),
      columnHelper.accessor('action_type', {
        id: 'action_type',
        header: 'What fires',
        cell: (info) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-sm text-body">{info.getValue()}</span>
            <span className="font-mono text-2xs text-muted">
              {formatParams(info.row.original.payload)}
            </span>
          </div>
        ),
      }),
      columnHelper.display({
        id: 'about',
        header: 'About',
        cell: (info) => {
          const row = info.row.original;
          if (!row.workflow_instance_id) {
            return (
              <span className="font-sans text-sm text-muted">
                {row.subject_stream_type ?? 'Not tied to a case'}
              </span>
            );
          }
          return (
            <Link
              to="/admin/workflow/instances/$instanceId"
              params={{ instanceId: row.workflow_instance_id }}
              className="flex flex-col gap-0.5 text-brand underline-offset-2 hover:underline"
            >
              <span className="font-mono text-sm">
                {row.workflow_key ? shortWorkflowKey(row.workflow_key) : 'Case'}
              </span>
              <span className="font-sans text-2xs text-muted">{row.current_state}</span>
            </Link>
          );
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        cell: (info) => {
          const row = info.row.original;
          // Only a pending timer can be changed. Rendering the buttons disabled
          // rather than hiding them would offer an action the server refuses.
          if (row.status !== 'pending') {
            return (
              <span className="whitespace-nowrap font-sans text-2xs text-muted">
                {row.status === 'cancelled' ? (row.cancel_reason ?? 'Cancelled') : 'Nothing to do'}
              </span>
            );
          }
          return (
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                startIcon={<CalendarClock size={14} />}
                onClick={() => setRescheduling(row)}
              >
                Reschedule
              </Button>
              <Button
                size="sm"
                variant="ghost"
                startIcon={<CircleSlash size={14} />}
                onClick={() => setCancelling(row)}
              >
                Cancel
              </Button>
            </div>
          );
        },
      }),
    ],
    [],
  );

  const rows: TimerRow[] = React.useMemo(
    () =>
      (query.data?.items ?? []).map((row) => ({
        id: row.id,
        due_at: row.due_at,
        action_type: row.action_type,
        payload: row.payload,
        status: row.status,
        source: row.source,
        subject_stream_type: row.subject_stream_type,
        workflow_instance_id: row.workflow_instance_id,
        workflow_key: row.workflow_key,
        current_state: row.current_state,
        executed_at: row.executed_at,
        cancel_reason: row.cancel_reason,
      })),
    [query.data],
  );
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

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <PageHeader
        title="Scheduled actions"
        description="Every timer the platform is holding — reminders, chases, expiry deadlines. Each one is a row in the database rather than a message parked in a queue, which is what makes it possible to see them, move them and cancel them."
      />

      {query.error && (
        <Callout tone="danger" title="Couldn’t load the timers">
          {query.error.message}
        </Callout>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-md border border-border-default bg-surface-card px-3 focus-within:border-border-focus focus-within:ring-2 focus-within:ring-brand/40">
            <Search size={16} className="shrink-0 text-muted" />
            <input
              type="search"
              value={actionTypeInput}
              onChange={(e) => setActionTypeInput(e.target.value)}
              placeholder="What fires, e.g. workflow.transition"
              aria-label="Filter by action type"
              className="min-w-0 flex-1 bg-transparent font-sans text-sm text-strong outline-none"
            />
          </div>
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value as '' | TimerRow['status'])}
            className="h-9 rounded-md border border-border-default bg-surface-card px-3 font-sans text-sm text-body outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <option value="pending">Waiting</option>
            <option value="enqueued">Sent to the worker</option>
            <option value="executed">Fired</option>
            <option value="cancelled">Cancelled</option>
            <option value="">Every status</option>
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
                      Loading timers…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="px-4 py-10 text-center font-sans text-sm text-muted"
                    >
                      {actionType || status !== 'pending'
                        ? 'No timers match these filters.'
                        : 'Nothing is waiting to fire.'}
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

      {cancelling && (
        <CancelTimerDialog
          timer={cancelling}
          onClose={() => setCancelling(null)}
          onDone={refetch}
        />
      )}
      {rescheduling && (
        <RescheduleTimerDialog
          timer={rescheduling}
          onClose={() => setRescheduling(null)}
          onDone={refetch}
        />
      )}
    </div>
  );
}

/** A `datetime-local` value for an instant, in the browser's own zone. */
function toLocalDateTimeInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Cancelling asks for a reason, and the reason is mandatory — it rides the
 * journal event, so it is what explains the cancellation to whoever reads the
 * trail months later.
 */
function CancelTimerDialog({
  timer,
  onClose,
  onDone,
}: {
  timer: TimerRow;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [tooLate, setTooLate] = React.useState(false);
  const mutation = trpcReact.platform.workflow.cancelScheduledAction.useMutation();

  const form = useForm({
    defaultValues: { reason: '' },
    // The shared Zod schema from `@repo/trpc` — the same one the server
    // validates against, so the two can never disagree about what is valid.
    validators: { onChange: cancelScheduledActionInput.pick({ reason: true }) },
    onSubmit: async ({ value }) => {
      const result = await mutation.mutateAsync({ id: timer.id, reason: value.reason });
      await onDone();
      // A timer the scheduler claimed a moment ago cannot be recalled. That is
      // an outcome, not an error, so say it plainly and leave the dialog open.
      if (!result.cancelled) setTooLate(true);
      else onClose();
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Cancel this timer"
      description={`${timer.action_type} · due ${formatInstant(timer.due_at)}`}
    >
      <form
        id="cancel-timer"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        <p className="font-sans text-sm leading-normal text-muted">
          The timer will not fire, and whatever it would have done will not happen. Cancelling is
          recorded against your name with the reason below.
        </p>

        <form.Field name="reason">
          {(field) => (
            <Field
              label="Why is this being cancelled?"
              htmlFor="cancel-reason"
              required
              error={field.state.meta.errors.map((e) => e?.message).join(', ') || undefined}
              hint="Kept with the timer and written to the audit trail."
            >
              <Textarea
                id="cancel-reason"
                rows={3}
                value={field.state.value}
                invalid={field.state.meta.errors.length > 0}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="e.g. handled offline with the manager"
              />
            </Field>
          )}
        </form.Field>

        {tooLate && (
          <Callout tone="warning" title="Too late to cancel">
            The scheduler had already picked this timer up, so it is on its way to the worker. The
            list has been refreshed with its current status.
          </Callout>
        )}
        {mutation.error && (
          <Callout tone="danger" title="Couldn’t cancel the timer">
            {mutation.error.message}
          </Callout>
        )}

        <form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose} disabled={isSubmitting}>
                Keep it
              </Button>
              <Button type="submit" variant="danger" disabled={!canSubmit || isSubmitting}>
                {isSubmitting ? 'Cancelling…' : 'Cancel the timer'}
              </Button>
            </div>
          )}
        </form.Subscribe>
      </form>
    </Modal>
  );
}

/** Moving a due date. Also journalled — AC-D9 wants both admin actions recorded. */
function RescheduleTimerDialog({
  timer,
  onClose,
  onDone,
}: {
  timer: TimerRow;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [tooLate, setTooLate] = React.useState(false);
  const mutation = trpcReact.platform.workflow.rescheduleAction.useMutation();
  const earliest = toLocalDateTimeInput(new Date(Date.now() + 60_000));

  const form = useForm({
    defaultValues: { dueAt: toLocalDateTimeInput(new Date(timer.due_at)) },
    onSubmit: async ({ value }) => {
      const result = await mutation.mutateAsync({
        id: timer.id,
        dueAt: new Date(value.dueAt).toISOString(),
      });
      await onDone();
      if (!result.rescheduled) setTooLate(true);
      else onClose();
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Move this timer"
      description={`${timer.action_type} · currently due ${formatInstant(timer.due_at)}`}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field
          name="dueAt"
          validators={{
            onChange: ({ value }) => {
              if (!value) return 'Pick when this should fire';
              return new Date(value).getTime() <= Date.now()
                ? 'A timer can only be moved to a future instant'
                : undefined;
            },
          }}
        >
          {(field) => (
            <Field
              label="New due date"
              htmlFor="reschedule-due-at"
              required
              error={field.state.meta.errors.join(', ') || undefined}
              hint="The scheduler runs every few minutes, so the timer fires shortly after this instant rather than exactly on it."
            >
              <Input
                id="reschedule-due-at"
                type="datetime-local"
                min={earliest}
                startIcon={<CalendarClock size={16} />}
                value={field.state.value}
                invalid={field.state.meta.errors.length > 0}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>

        {tooLate && (
          <Callout tone="warning" title="Too late to move">
            The scheduler had already picked this timer up. The list has been refreshed with its
            current status.
          </Callout>
        )}
        {mutation.error && (
          <Callout tone="danger" title="Couldn’t move the timer">
            {mutation.error.message}
          </Callout>
        )}

        <form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose} disabled={isSubmitting}>
                Leave it
              </Button>
              <Button type="submit" disabled={!canSubmit || isSubmitting}>
                {isSubmitting ? 'Moving…' : 'Move the timer'}
              </Button>
            </div>
          )}
        </form.Subscribe>
      </form>
    </Modal>
  );
}
