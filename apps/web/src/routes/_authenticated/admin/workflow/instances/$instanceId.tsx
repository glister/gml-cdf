import { createFileRoute, Link } from '@tanstack/react-router';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/trpc';
import { ArrowLeft, ArrowRight, ChevronRight, TriangleAlert } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { StatusPill } from '~/components/data-display/StatusPill';
import { DescriptionList } from '~/components/data-display/DescriptionList';
import {
  formatInstant,
  formatParams,
  formatRelative,
  instanceTone,
  parseEffects,
  parseGuardResults,
  parseResolvedConfig,
  timerTone,
  TIMER_STATUS_LABEL,
  isTimerOverdue,
} from '~/lib/workflow';

export const Route = createFileRoute('/_authenticated/admin/workflow/instances/$instanceId')({
  component: WorkflowInstanceDetail,
});

type InstanceDetail = inferRouterOutputs<AppRouter>['platform']['workflow']['get'];
type TransitionRow = InstanceDetail['transitions'][number];

/**
 * One case, and how it got where it is (core plan 07 §5.7, WF-11; PL-026/028).
 *
 * This screen is the argument for the whole design made visible. The instance
 * row holds one thing — the current state — and everything else is reconstructed
 * from the append-only transition log: who moved it, when, under which version
 * of the definition, which guards were consulted and what they said, **what the
 * configuration was at that instant**, and what the move set in motion. None of
 * that is derivable from a status column and a few boolean flags, which is
 * precisely why the runtime does not use any.
 *
 * The soft-guard warnings render as advisories, never errors: they did not block
 * anything, and the design system's two-tier severity reserves red for things
 * that did.
 */
function WorkflowInstanceDetail() {
  const { instanceId } = Route.useParams();
  const query = trpcReact.platform.workflow.get.useQuery({ instanceId });

  if (query.error) {
    return (
      <div className="mx-auto flex max-w-[900px] flex-col gap-4">
        <BackLink />
        <Callout tone="danger" title="Couldn’t open this instance">
          {query.error.message}
        </Callout>
      </div>
    );
  }

  if (!query.data) {
    return (
      <div className="mx-auto flex max-w-[900px] flex-col gap-4">
        <BackLink />
        <p className="font-sans text-sm text-muted">Loading…</p>
      </div>
    );
  }

  const { instance, transitions, timers } = query.data;
  const running = !instance.completed_at;

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-5">
      <BackLink />

      <PageHeader
        title={instance.workflow_key}
        description={
          running
            ? 'This case is still running. Everything below is the record of how it reached its current state.'
            : 'This case has completed. Its history is immutable — the transition log cannot be edited or deleted, by anyone.'
        }
        meta={
          <>
            <StatusPill tone={instanceTone(instance.completed_at)}>
              {instance.current_state}
            </StatusPill>
            <span className="font-mono text-2xs text-muted">
              Definition version {instance.definition_version}
            </span>
          </>
        }
      />

      <section className="rounded-lg border border-border-subtle bg-surface-card p-5">
        <DescriptionList
          items={[
            { term: 'About', value: instance.subject_stream_type, mono: true },
            { term: 'Subject reference', value: instance.subject_stream_id, mono: true },
            {
              term: 'Started',
              value: `${formatInstant(instance.created_at)} by ${instance.started_by_name ?? 'the system'}`,
            },
            {
              term: 'Completed',
              value: instance.completed_at ? formatInstant(instance.completed_at) : 'Still running',
            },
          ]}
        />
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="font-sans text-md font-bold tracking-tight text-strong">History</h2>
          <p className="mt-1 font-sans text-sm leading-normal text-muted">
            Every named transition this case has taken, oldest first. Each entry records the
            configuration values the decision rested on, so it can still be explained after those
            values change.
          </p>
        </div>

        {transitions.length === 0 ? (
          <p className="rounded-lg border border-border-subtle bg-surface-card px-5 py-8 text-center font-sans text-sm text-muted">
            Nothing has happened yet — the case is sitting in its initial state.
          </p>
        ) : (
          <ol className="flex flex-col">
            {transitions.map((transition, i) => (
              <TransitionEntry
                key={transition.id}
                transition={transition}
                last={i === transitions.length - 1}
              />
            ))}
          </ol>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="font-sans text-md font-bold tracking-tight text-strong">Timers</h2>
          <p className="mt-1 font-sans text-sm leading-normal text-muted">
            What happens to this case if nobody acts. Reaching a final state cancels every timer
            still waiting, in the same moment — a finished case never has something still pointed at
            it.
          </p>
        </div>

        {timers.length === 0 ? (
          <p className="rounded-lg border border-border-subtle bg-surface-card px-5 py-8 text-center font-sans text-sm text-muted">
            This case has no timers.
          </p>
        ) : (
          <ul className="divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle bg-surface-card">
            {timers.map((timer) => (
              <li key={timer.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <StatusPill
                  tone={timerTone(timer.status)}
                  overdue={isTimerOverdue(timer.status, timer.due_at)}
                >
                  {TIMER_STATUS_LABEL[timer.status] ?? timer.status}
                </StatusPill>
                <span className="font-mono text-sm text-body">{timer.action_type}</span>
                <span className="ml-auto flex flex-col items-end">
                  <span className="whitespace-nowrap font-mono text-sm text-muted">
                    {formatInstant(timer.due_at)}
                  </span>
                  <span className="font-sans text-2xs text-muted">
                    {timer.status === 'cancelled'
                      ? (timer.cancel_reason ?? 'Cancelled')
                      : timer.status === 'executed'
                        ? `Fired ${formatRelative(timer.executed_at)}`
                        : formatRelative(timer.due_at)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/admin/workflow/instances"
      className="inline-flex w-fit items-center gap-1.5 font-sans text-sm text-muted transition-colors hover:text-body"
    >
      <ArrowLeft size={15} /> All instances
    </Link>
  );
}

/**
 * One transition, as a timeline entry: the move itself, then the evidence behind
 * it. The vertical rule is the design system's activity-feed idiom — a spine of
 * dots, one per event, read top to bottom.
 */
function TransitionEntry({ transition, last }: { transition: TransitionRow; last: boolean }) {
  const guardResults = parseGuardResults(transition.guardResults);
  const warnings = guardResults.filter((g) => g.outcome === 'warn');
  const effects = parseEffects(transition.effects);
  const resolvedConfig = parseResolvedConfig(transition.resolvedConfig);

  return (
    <li className="relative flex gap-4 pb-5 last:pb-0">
      {/* The spine. Hidden on the last entry so the line stops at the final dot. */}
      {!last && (
        <span
          aria-hidden="true"
          className="absolute left-[7px] top-4 h-full w-px bg-border-subtle"
        />
      )}
      <span
        aria-hidden="true"
        className="relative z-10 mt-1.5 size-[15px] shrink-0 rounded-full border-[3px] border-surface-card bg-state-info"
      />

      <div className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold tracking-tight text-strong">
            {transition.action}
          </span>
          <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted">
            {transition.fromState}
            <ArrowRight size={13} className="text-border-strong" />
            {transition.toState}
          </span>
          <span className="ml-auto whitespace-nowrap font-mono text-2xs text-muted">
            {formatInstant(transition.occurredAt)}
          </span>
        </div>

        <p className="mt-1.5 font-sans text-sm text-muted">
          {/* A null actor is the system — a timer or a sweep — and saying so is
              more truthful than leaving the field blank. */}
          {transition.actorName ?? 'The system'}
          {transition.onBehalfOf && ' · acting on behalf of another person'}
        </p>

        {transition.comment && (
          <p className="mt-2.5 border-l-2 border-border-subtle pl-3 font-sans text-sm italic leading-normal text-body">
            {transition.comment}
          </p>
        )}

        {warnings.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {warnings.map((warning) => (
              <Callout
                key={warning.guard}
                tone="warning"
                icon={<TriangleAlert size={15} />}
                title={warning.guard}
              >
                {warning.detail ?? 'Proceeded with a warning.'}
              </Callout>
            ))}
          </div>
        )}

        {(resolvedConfig.length > 0 || effects.length > 0) && (
          <dl className="mt-3 flex flex-col gap-2 border-t border-border-subtle pt-3">
            {resolvedConfig.length > 0 && (
              <div className="flex flex-wrap gap-x-2 gap-y-1">
                <dt className="font-sans text-2xs font-semibold uppercase tracking-wide text-muted">
                  Rules in force
                </dt>
                <dd className="flex flex-wrap gap-1.5">
                  {resolvedConfig.map(([key, value]) => (
                    <span
                      key={key}
                      className="rounded-sm border border-border-subtle bg-gray-100 px-2 py-0.5 font-mono text-2xs text-body"
                    >
                      {key} = {value}
                    </span>
                  ))}
                </dd>
              </div>
            )}
            {effects.length > 0 && (
              <div className="flex flex-wrap gap-x-2 gap-y-1">
                <dt className="font-sans text-2xs font-semibold uppercase tracking-wide text-muted">
                  Set in motion
                </dt>
                <dd className="flex flex-wrap gap-1.5">
                  {effects.map((effect) => (
                    <span
                      key={effect.name}
                      className="inline-flex items-center gap-1 rounded-sm border border-border-subtle bg-gray-100 px-2 py-0.5 font-mono text-2xs text-body"
                    >
                      {effect.name}
                      <ChevronRight size={11} className="text-border-strong" />
                      {formatParams(effect.params)}
                    </span>
                  ))}
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </li>
  );
}
