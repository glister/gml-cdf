import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Play, ShieldCheck, CalendarClock, Rocket } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { Button } from '~/components/ui/button';
import { CaseProgress } from '~/components/tasks/CaseProgress';
import { formatInstant } from '~/lib/tasks';

export const Route = createFileRoute('/_authenticated/tasks/pilot')({
  component: PilotChecklist,
});

const PILOT_WORKFLOW_KEY = 'platform.pilot.checklist';
const PILOT_CASE_STREAM_TYPE = 'platform.pilot_case';

/**
 * The pilot checklist harness (core plan 08 §5.3/§9.6).
 *
 * The task engine is generic, so demonstrating it needs *some* case — and Phase
 * 1 has no HR module to supply one. This page is that case: it starts a
 * `platform.pilot.checklist` workflow, drives its three transitions, and embeds
 * the same `<CaseProgress>` component the onboarding and offboarding dashboards
 * will embed for ON-045 and OF-001. Nothing on this page knows anything about
 * onboarding; if it did, the demonstration would be worthless.
 *
 * Each button below fires a workflow transition, whose **effects run
 * asynchronously** through the outbox and the worker (plan 07 §5.4). So the
 * tasks appear a moment after "Begin", not instantly — which is the honest
 * behaviour of the real system, and worth seeing rather than hiding behind a
 * synchronous shortcut.
 */
function PilotChecklist() {
  const [selected, setSelected] = React.useState<string | null>(null);

  const utils = trpcReact.useUtils();
  const instances = trpcReact.platform.workflow.listInstances.useQuery({
    workflowKey: PILOT_WORKFLOW_KEY,
    limit: 25,
    sort: 'created_at',
    sortDir: 'desc',
  });
  const start = trpcReact.platform.tasks.startPilotCase.useMutation();
  const transition = trpcReact.platform.workflow.transition.useMutation();

  const cases = instances.data?.items ?? [];
  const current = cases.find((c) => c.subject_stream_id === selected) ?? cases[0];

  /**
   * Refetch both halves. The case list and the case progress are separate
   * queries, and an effect that has just landed changes the second without
   * touching the first — so refetching only the list would show a case that had
   * moved on with a dashboard that had not.
   */
  const refresh = React.useCallback(async () => {
    await Promise.all([instances.refetch(), utils.platform.tasks.caseProgress.invalidate()]);
  }, [instances, utils]);

  const fire = async (action: string) => {
    if (!current) return;
    await transition.mutateAsync({ instanceId: current.id, action });
    await refresh();
  };

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <PageHeader
        title="Pilot checklist"
        description="A demonstration case with no HR content: one workflow raises three tasks — one ready, one waiting on it, one held by a gate — so the task engine can be seen working before onboarding exists to use it."
        primaryAction={
          <Button
            startIcon={<Rocket size={15} />}
            disabled={start.isPending}
            onClick={async () => {
              const created = await start.mutateAsync();
              setSelected(created.streamId);
              await refresh();
            }}
          >
            {start.isPending ? 'Starting…' : 'Start a pilot case'}
          </Button>
        }
      />

      {(start.error ?? transition.error ?? instances.error) && (
        <Callout tone="danger" title="That didn’t work">
          {(start.error ?? transition.error ?? instances.error)?.message}
        </Callout>
      )}

      {cases.length === 0 ? (
        <div className="rounded-lg border border-border-subtle bg-surface-card px-5 py-10 text-center font-sans text-sm text-muted">
          No pilot cases yet. Start one to see the engine raise a task list.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {cases.slice(0, 8).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelected(c.subject_stream_id)}
                className={
                  c.id === current?.id
                    ? 'rounded-full border border-border-brand bg-brand-subtle px-3 py-1 font-mono text-2xs text-strong'
                    : 'rounded-full border border-border-subtle bg-surface-card px-3 py-1 font-mono text-2xs text-muted transition-colors hover:text-body'
                }
              >
                {c.subject_stream_id.slice(0, 8)} · {c.current_state}
              </button>
            ))}
          </div>

          {current && (
            <>
              <div className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-sans text-sm font-semibold text-strong">
                      Case {current.subject_stream_id.slice(0, 8)} — {current.current_state}
                    </div>
                    <div className="font-sans text-2xs text-muted">
                      Started {formatInstant(current.created_at)}
                      {current.started_by_name ? ` by ${current.started_by_name}` : ''} ·{' '}
                      <Link
                        to="/admin/workflow/instances/$instanceId"
                        params={{ instanceId: current.id }}
                        className="text-brand underline-offset-2 hover:underline"
                      >
                        case history
                      </Link>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      startIcon={<Play size={14} />}
                      disabled={current.current_state !== 'new' || transition.isPending}
                      onClick={() => void fire('begin')}
                    >
                      Begin
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      startIcon={<ShieldCheck size={14} />}
                      disabled={current.current_state !== 'in_progress' || transition.isPending}
                      onClick={() => void fire('verify')}
                    >
                      Open the gate
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      startIcon={<CalendarClock size={14} />}
                      disabled={current.current_state !== 'in_progress' || transition.isPending}
                      onClick={() => void fire('reschedule')}
                    >
                      Move the start date
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                      Refresh
                    </Button>
                  </div>
                </div>
                <p className="font-sans text-2xs text-muted">
                  Each action fires a workflow transition. Its effects run through the outbox and
                  the worker, so the tasks appear a moment later rather than instantly.
                </p>
              </div>

              <CaseProgress
                streamType={PILOT_CASE_STREAM_TYPE}
                streamId={current.subject_stream_id}
                title="Case progress"
                subtitle="Counts, gates and bottlenecks, all computed in SQL — the same component the HR case dashboards will embed."
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
