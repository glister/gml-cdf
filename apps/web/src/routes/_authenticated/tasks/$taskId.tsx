import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import { completeTaskInput } from '@repo/trpc/schemas';
import { ArrowLeft, Check, Hand, Lock, LockOpen, Undo2 } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { Modal } from '~/components/feedback/Modal';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/forms/Field';
import { Textarea } from '~/components/forms/Textarea';
import { StatusPill } from '~/components/data-display/StatusPill';
import { TaskStatusBadge } from '~/components/tasks/TaskStatusBadge';
import {
  anchorPhrase,
  formatDueDate,
  formatInstant,
  formatRelativeDay,
  shortStreamType,
  taskTone,
  TASK_STATUS_LABEL,
} from '~/lib/tasks';

export const Route = createFileRoute('/_authenticated/tasks/$taskId')({
  component: TaskDetail,
});

/**
 * One task (core plan 08 §5.3, PL-013/014).
 *
 * The dependency panel is the part worth building carefully: a person looking at
 * a blocked task wants to know **what** is holding it and **who** they need to
 * chase, and a person looking at an open one wants to know what will fall out
 * when they finish it. Both are on the row already — the engine records edges
 * rather than inferring them — so the screen shows them rather than a bare
 * "blocked" badge.
 *
 * Claim and release are offered only to someone who actually holds the assignee
 * role (`canAct` from the server). Completion is offered more widely, because HR
 * and Administrators may complete on someone's behalf — and when they do, the
 * form says so, since that is what gets journalled.
 */
function TaskDetail() {
  const { taskId } = Route.useParams();
  const [completing, setCompleting] = React.useState(false);
  const query = trpcReact.platform.tasks.byId.useQuery({ taskId });
  const claim = trpcReact.platform.tasks.claim.useMutation();
  const release = trpcReact.platform.tasks.release.useMutation();

  const refetch = React.useCallback(async () => {
    await query.refetch();
  }, [query]);

  if (query.error) {
    return (
      <div className="mx-auto flex max-w-[900px] flex-col gap-4">
        <BackLink />
        <Callout tone="danger" title="Couldn’t open this task">
          {query.error.message}
        </Callout>
      </div>
    );
  }

  const task = query.data;
  if (!task) {
    return (
      <div className="mx-auto max-w-[900px] px-1 py-10 text-center font-sans text-sm text-muted">
        Loading task…
      </div>
    );
  }

  const terminal = task.status === 'done' || task.status === 'cancelled';
  const busy = claim.isPending || release.isPending;

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-4">
      <BackLink />

      <PageHeader
        title={task.title}
        description={`${shortStreamType(task.streamType)} · assigned to ${task.assigneeRoleName}`}
        primaryAction={
          <div className="flex flex-wrap items-center gap-2">
            {task.canAct &&
              !terminal &&
              (task.claimedBy ? (
                <Button
                  variant="ghost"
                  startIcon={<Undo2 size={15} />}
                  disabled={busy}
                  onClick={async () => {
                    await release.mutateAsync({ taskId });
                    await refetch();
                  }}
                >
                  Release
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  startIcon={<Hand size={15} />}
                  disabled={busy}
                  onClick={async () => {
                    await claim.mutateAsync({ taskId });
                    await refetch();
                  }}
                >
                  I’m working on this
                </Button>
              ))}
            {!terminal && task.status === 'open' && (
              <Button startIcon={<Check size={15} />} onClick={() => setCompleting(true)}>
                Mark complete
              </Button>
            )}
          </div>
        }
      />

      {(claim.error ?? release.error) && (
        <Callout tone="danger" title="That didn’t work">
          {(claim.error ?? release.error)?.message}
        </Callout>
      )}

      <div className="flex flex-col gap-4 rounded-lg border border-border-subtle bg-surface-card p-5 shadow-xs">
        <div className="flex flex-wrap items-center gap-3">
          <TaskStatusBadge status={task.status} overdue={task.overdue} />
          {task.lane && (
            <span className="rounded-full border border-state-info-border bg-state-info-bg px-2.5 py-0.5 font-sans text-xs font-semibold text-state-info-text">
              {task.lane}
            </span>
          )}
          {task.claimedByName && (
            <span className="font-sans text-xs text-muted">
              Being worked by {task.claimedByName} since {formatInstant(task.claimedAt)}
            </span>
          )}
        </div>

        {task.description && (
          <p className="font-sans text-sm leading-relaxed text-body">{task.description}</p>
        )}

        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <Detail label="Due">
            {task.dueAt ? (
              <>
                <span
                  className={
                    task.overdue
                      ? 'font-mono text-sm font-bold text-state-danger-text'
                      : 'font-mono text-sm text-strong'
                  }
                >
                  {formatDueDate(task.dueAt)}
                </span>{' '}
                <span className="font-sans text-2xs text-muted">
                  {formatRelativeDay(task.dueAt)}
                </span>
                {/* The *rule*, not just the resolved date: an anchor-relative
                    due date will move again if the anchor does. */}
                {task.dueMode === 'anchor_relative' && (
                  <div className="font-sans text-2xs text-muted">
                    {anchorPhrase(task.anchorName, task.anchorOffsetDays)}
                  </div>
                )}
              </>
            ) : (
              <span className="font-sans text-sm text-muted">No due date</span>
            )}
          </Detail>
          <Detail label="Assigned to">
            <span className="font-sans text-sm text-body">{task.assigneeRoleName}</span>
            <div className="font-sans text-2xs text-muted">
              A role, not a person — whoever holds it sees this task
            </div>
          </Detail>
          <Detail label="Raised">
            <span className="font-sans text-sm text-body">{formatInstant(task.raisedAt)}</span>
            <div className="font-mono text-2xs text-muted">
              {task.source === 'workflow' ? (task.sourceRef ?? 'workflow') : 'created by hand'}
            </div>
          </Detail>
          <Detail label="Case">
            <span className="font-mono text-sm text-body">{shortStreamType(task.streamType)}</span>
            {task.workflowInstanceId && (
              <div>
                <Link
                  to="/admin/workflow/instances/$instanceId"
                  params={{ instanceId: task.workflowInstanceId }}
                  className="font-sans text-2xs text-brand underline-offset-2 hover:underline"
                >
                  Open the case history
                </Link>
              </div>
            )}
          </Detail>
          {task.completedAt && (
            <Detail label="Completed">
              <span className="font-sans text-sm text-body">
                {formatInstant(task.completedAt)}
                {task.completedByName ? ` by ${task.completedByName}` : ''}
              </span>
              {task.completionNote && (
                <div className="mt-1 font-sans text-sm text-muted">{task.completionNote}</div>
              )}
            </Detail>
          )}
          {task.cancelReason && (
            <Detail label="Cancelled because">
              <span className="font-sans text-sm text-body">{task.cancelReason}</span>
            </Detail>
          )}
        </dl>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="What this is waiting for">
          {task.dependencies.length === 0 ? (
            <p className="font-sans text-sm text-muted">Nothing — this task is free to start.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {task.dependencies.map((d) => (
                <li key={d.id} className="flex items-start gap-2.5">
                  <span className="mt-0.5 shrink-0 text-muted">
                    {d.satisfiedAt ? <LockOpen size={14} /> : <Lock size={14} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    {d.kind === 'gate' ? (
                      <span className="font-sans text-sm text-strong">
                        The <span className="font-mono">{d.gateKey}</span> gate
                      </span>
                    ) : (
                      <Link
                        to="/tasks/$taskId"
                        params={{ taskId: d.dependsOnTaskId! }}
                        className="font-sans text-sm text-strong underline-offset-2 hover:underline"
                      >
                        {d.dependsOnTaskTitle}
                      </Link>
                    )}
                    <div className="font-sans text-2xs text-muted">
                      {d.satisfiedAt
                        ? `Cleared ${formatInstant(d.satisfiedAt)}`
                        : 'Still outstanding'}
                    </div>
                  </div>
                  {d.dependsOnTaskStatus && (
                    <StatusPill tone={taskTone(d.dependsOnTaskStatus)} size="sm">
                      {TASK_STATUS_LABEL[d.dependsOnTaskStatus] ?? d.dependsOnTaskStatus}
                    </StatusPill>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="What finishing this unlocks">
          {task.unlocks.length === 0 ? (
            <p className="font-sans text-sm text-muted">Nothing is waiting on this task.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {task.unlocks.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-3">
                  <Link
                    to="/tasks/$taskId"
                    params={{ taskId: u.id }}
                    className="min-w-0 flex-1 truncate font-sans text-sm text-strong underline-offset-2 hover:underline"
                  >
                    {u.title}
                    {u.lane && <span className="ml-2 text-2xs text-muted">{u.lane}</span>}
                  </Link>
                  <TaskStatusBadge status={u.status} size="sm" />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {completing && (
        <CompleteTaskDialog
          taskId={taskId}
          title={task.title}
          override={!task.canAct}
          onClose={() => setCompleting(false)}
          onDone={refetch}
        />
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/tasks"
      className="inline-flex w-fit items-center gap-1.5 font-sans text-sm text-muted transition-colors hover:text-body"
    >
      <ArrowLeft size={15} />
      My tasks
    </Link>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="font-sans text-2xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </dt>
      <dd className="mt-1 min-w-0">{children}</dd>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface-card p-5">
      <h2 className="font-sans text-sm font-semibold text-strong">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Completion, with an optional note.
 *
 * The note is optional because most task completions have nothing to add, and a
 * mandatory field that people fill with "done" is worse than no field. When the
 * completer does not hold the assignee role the dialog says plainly that this is
 * an override — the journal records it as one either way, and a person should
 * not discover that from an audit trail.
 */
function CompleteTaskDialog({
  taskId,
  title,
  override,
  onClose,
  onDone,
}: {
  taskId: string;
  title: string;
  override: boolean;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const mutation = trpcReact.platform.tasks.complete.useMutation();

  const form = useForm({
    defaultValues: { note: '' },
    // The shared Zod schema from `@repo/trpc` — the same one the server
    // validates against, so the two cannot disagree about what is valid.
    // `.required()` because the form field always holds a string (possibly
    // empty) while the wire schema makes `note` optional — the constraint that
    // matters, its length bound, is the server's own either way.
    validators: { onChange: completeTaskInput.pick({ note: true }).required() },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync({
        taskId,
        ...(value.note.trim() ? { note: value.note.trim() } : {}),
      });
      await onDone();
      onClose();
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Mark this task complete"
      description={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
            {([canSubmit, isSubmitting]) => (
              <Button
                onClick={() => void form.handleSubmit()}
                disabled={!canSubmit || isSubmitting}
                startIcon={<Check size={15} />}
              >
                {isSubmitting ? 'Completing…' : 'Mark complete'}
              </Button>
            )}
          </form.Subscribe>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
        className="flex flex-col gap-3"
      >
        {override && (
          <Callout tone="info" title="You’re completing this for another role">
            This task is assigned to a role you don’t hold. Completing it is recorded as an
            override, with your name against it.
          </Callout>
        )}
        {mutation.error && (
          <Callout tone="danger" title="Couldn’t complete this task">
            {mutation.error.message}
          </Callout>
        )}
        <form.Field name="note">
          {(field) => (
            <Field
              label="Note (optional)"
              hint="Anything the next person needs to know. Never personal or medical detail — this is a shared record."
              error={field.state.meta.errors[0]?.message ?? undefined}
            >
              <Textarea
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                invalid={field.state.meta.errors.length > 0}
                rows={3}
              />
            </Field>
          )}
        </form.Field>
      </form>
    </Modal>
  );
}
