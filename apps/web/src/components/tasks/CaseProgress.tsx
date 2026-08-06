import * as React from 'react';
import { AlertTriangle, Lock, LockOpen } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { ProgressBar } from '~/components/data-display/ProgressBar';
import { Callout } from '~/components/feedback/Callout';
import { formatDueDate, formatRelativeDay, lanePercent } from '~/lib/tasks';

/**
 * `<CaseProgress>` — the **generic** case dashboard (core plan 08 §5.3, PL-015).
 *
 * It takes a stream reference and nothing else. There is no onboarding in it, no
 * offboarding, no probation: the HR plans embed this same component for ON-045
 * and OF-001 by passing their own case's `(streamType, streamId)`, and the only
 * thing that changes is which rows come back. A dashboard that knew what an
 * onboarding case was would have to be rewritten for the second process that
 * needed one.
 *
 * **Every number here is computed in SQL** (`platform.tasks.caseProgress`). The
 * component adds no arithmetic beyond turning done/total into a bar width, which
 * is why the figure on a lane and the figure on a filtered task list cannot
 * disagree — there is only one expression, and it is in the query.
 *
 * Translated from the design system's `components/tasks/CaseProgressSummary`
 * and `LaneBoard`: progress bar with completion fraction, counts of open /
 * overdue / blocked, gate chips, and bottleneck callouts in the advisory amber
 * treatment (attention, not error).
 */
export function CaseProgress({
  streamType,
  streamId,
  title,
  subtitle,
}: {
  streamType: string;
  streamId: string;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
}) {
  const query = trpcReact.platform.tasks.caseProgress.useQuery({ streamType, streamId });

  if (query.error) {
    return (
      <Callout tone="danger" title="Couldn’t load this case">
        {query.error.message}
      </Callout>
    );
  }

  if (!query.data) {
    return (
      <div className="rounded-lg border border-border-subtle bg-surface-card px-5 py-8 text-center font-sans text-sm text-muted">
        Loading case progress…
      </div>
    );
  }

  const { lanes, gates, bottlenecks } = query.data;
  const totals = lanes.reduce(
    (sum, lane) => ({
      total: sum.total + lane.total,
      done: sum.done + lane.done,
      open: sum.open + lane.open,
      blocked: sum.blocked + lane.blocked,
      cancelled: sum.cancelled + lane.cancelled,
      overdue: sum.overdue + lane.overdue,
    }),
    { total: 0, done: 0, open: 0, blocked: 0, cancelled: 0, overdue: 0 },
  );

  if (totals.total === 0) {
    return (
      <div className="rounded-lg border border-border-subtle bg-surface-card px-5 py-8 text-center font-sans text-sm text-muted">
        No tasks have been raised for this case yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 rounded-lg border border-border-subtle bg-surface-card p-5 shadow-xs">
        {(title || subtitle) && (
          <div className="min-w-0">
            {title && (
              <div className="font-sans text-lg font-bold tracking-tight text-strong">{title}</div>
            )}
            {subtitle && <div className="mt-0.5 font-sans text-sm text-muted">{subtitle}</div>}
          </div>
        )}

        <div className="flex items-center gap-3.5">
          <ProgressBar
            value={lanePercent(totals)}
            tone={lanePercent(totals) === 100 ? 'success' : 'brand'}
            label="Case progress"
          />
          <span className="whitespace-nowrap font-mono text-sm font-bold text-strong">
            {totals.done}
            <span className="font-medium text-muted">/{totals.total - totals.cancelled}</span>
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Count n={totals.open} label="to do" tone="info" />
          <Count n={totals.blocked} label="blocked" tone="info" />
          <Count n={totals.overdue} label="overdue" tone="danger" />
          {totals.cancelled > 0 && <Count n={totals.cancelled} label="cancelled" tone="neutral" />}
        </div>

        {bottlenecks.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <AlertTriangle size={14} className="shrink-0 text-state-pending-text" />
            <span className="font-sans text-2xs font-semibold uppercase tracking-wide text-muted">
              Bottleneck
            </span>
            {bottlenecks.slice(0, 3).map((b) => (
              <span
                key={`${b.kind}:${b.ref}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-state-pending-border bg-state-pending-bg px-2.5 py-0.5 font-sans text-xs font-semibold text-state-pending-text"
              >
                {b.kind === 'gate' ? `${b.ref} gate` : (b.title ?? 'A task')}
                <span className="font-mono text-2xs opacity-85">
                  {b.blockedCount} blocked · since {formatDueDate(b.oldestBlockedRaisedAt)}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>

      {gates.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {gates.map((gate) => (
            <span
              key={gate.gateKey}
              className={
                gate.open
                  ? 'inline-flex items-center gap-2 rounded-full border border-state-success-border bg-state-success-bg px-3 py-1 font-sans text-xs font-semibold text-state-success-text'
                  : 'inline-flex items-center gap-2 rounded-full border border-state-info-border bg-state-info-bg px-3 py-1 font-sans text-xs font-semibold text-state-info-text'
              }
            >
              {gate.open ? <LockOpen size={13} /> : <Lock size={13} />}
              {gate.gateKey}
              <span className="font-mono text-2xs opacity-85">
                {gate.open
                  ? 'open'
                  : `holding ${gate.blockedTaskCount} task${gate.blockedTaskCount === 1 ? '' : 's'}`}
              </span>
            </span>
          ))}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {lanes.map((lane) => (
          <div
            key={lane.lane ?? '__none__'}
            className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface-card p-4"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate font-sans text-sm font-semibold text-strong">
                {lane.lane ?? 'Unassigned lane'}
              </span>
              <span className="whitespace-nowrap font-mono text-2xs text-muted">
                {lane.done}/{lane.total - lane.cancelled}
              </span>
            </div>
            <ProgressBar
              value={lanePercent(lane)}
              tone={lanePercent(lane) === 100 ? 'success' : 'brand'}
              label={`${lane.lane ?? 'Unassigned'} progress`}
            />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-sans text-2xs text-muted">
              {lane.open > 0 && <span>{lane.open} to do</span>}
              {lane.blocked > 0 && <span>{lane.blocked} blocked</span>}
              {lane.overdue > 0 && (
                <span className="font-bold text-state-danger-text">{lane.overdue} overdue</span>
              )}
              {lane.cancelled > 0 && <span>{lane.cancelled} cancelled</span>}
            </div>
            {lane.nextDueAt && (
              <div className="font-sans text-2xs text-muted">
                Next due{' '}
                <span className="font-mono text-body">{formatDueDate(lane.nextDueAt)}</span>{' '}
                {formatRelativeDay(lane.nextDueAt)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One counter: a dot, the number in mono, the word. Zero greys the dot out. */
function Count({
  n,
  label,
  tone,
}: {
  n: number;
  label: string;
  tone: 'info' | 'danger' | 'neutral';
}) {
  const dot =
    n === 0
      ? 'bg-gray-300'
      : tone === 'danger'
        ? 'bg-state-danger'
        : tone === 'info'
          ? 'bg-state-info'
          : 'bg-state-neutral';
  // Danger text only when the count is non-zero: "0 overdue" is good news, and
  // colouring it red would make good news look like a problem.
  const value = tone === 'danger' && n > 0 ? 'text-state-danger-text' : 'text-strong';
  return (
    <div className="flex items-baseline gap-1.5">
      <span aria-hidden="true" className={`size-2 self-center rounded-full ${dot}`} />
      <span className={`font-mono text-lg font-bold leading-none ${value}`}>{n}</span>
      <span className="font-sans text-xs font-medium text-muted">{label}</span>
    </div>
  );
}
