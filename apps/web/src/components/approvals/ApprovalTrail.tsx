import * as React from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/trpc';
import { Avatar } from '~/components/data-display/Avatar';
import { cn } from '~/lib/utils';

/* Ported from the CD Fencing Design System (components/approvals/ApprovalTrail),
   translated to Tailwind and wired to the real `byId` payload.

   The system's note describes exactly the model this engine implements: "the
   approver who actually decided is marked with their decision and timestamp, and
   the others read **Not required** (any single approval settles the request)".
   That "Not required" is the any-one-approves semantics made visible, and it is
   why the trail is worth rendering rather than a bare "Approved by X". */

type Detail = inferRouterOutputs<AppRouter>['platform']['approvals']['byId'];
type Assignee = Detail['assignees'][number];
type Decision = NonNullable<Detail['decision']>;

/** How each assignee came to be asked. `policy_person` does not exist (§4.5). */
const SOURCE_LABEL: Record<Assignee['source'], string> = {
  policy_role: 'by role',
  designated: 'designated approver',
  delegation: 'covering',
};

export interface ApprovalTrailProps {
  assignees: readonly Assignee[];
  decision: Decision | null;
  className?: string;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ApprovalTrail({ assignees, decision, className }: ApprovalTrailProps) {
  const settled = decision !== null;

  return (
    <div className={cn('font-sans', className)}>
      <div className="mb-2.5 flex items-baseline gap-2">
        <span className="text-2xs font-bold uppercase tracking-caps text-muted">Approvers</span>
        <span className="text-2xs text-muted">· any one may decide</span>
      </div>

      {assignees.length === 0 && (
        <p className="text-sm text-muted">
          The approver policy resolved to nobody when this was raised. An administrator can fix the
          policy in configuration; the request stays open until someone can act on it.
        </p>
      )}

      <ul className="flex list-none flex-col gap-0.5 p-0">
        {assignees.map((assignee) => {
          const decided = settled && decision.actorPersonId === assignee.personId;
          const notRequired = settled && !decided;
          return (
            <li
              key={assignee.personId}
              className={cn('flex items-start gap-3 px-0.5 py-2', notRequired && 'opacity-60')}
            >
              <Avatar name={assignee.personName ?? 'Unknown'} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-semibold leading-snug text-strong">
                    {assignee.personName ?? 'Unknown person'}
                  </span>
                  <span className="text-2xs text-muted">
                    {assignee.roleName ?? SOURCE_LABEL[assignee.source]}
                  </span>
                </div>
                <div className="mt-px flex items-baseline gap-1.5">
                  <span
                    className={cn(
                      'text-2xs leading-normal',
                      decided
                        ? decision.decision === 'approved'
                          ? 'font-semibold text-state-success-text'
                          : 'font-semibold text-state-danger-text'
                        : 'text-muted',
                    )}
                  >
                    {decided
                      ? decision.decision === 'approved'
                        ? 'Approved'
                        : 'Declined'
                      : notRequired
                        ? 'Not required'
                        : 'Awaiting decision'}
                  </span>
                  {decided && (
                    <span className="font-mono text-2xs text-muted">
                      · {formatWhen(decision.decidedAt)}
                    </span>
                  )}
                  {/* Honest about the outbox rather than asserting a send that
                      has not happened: `notified_at` is stamped by plan 10's
                      dispatch, so until that plan lands it stays blank. */}
                  {!settled && assignee.notifiedAt && (
                    <span className="text-2xs text-muted">· notified</span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {/* The decider may not be on the list at all — an override role acts
          without ever being notified (HL-033), and a delegate stands in for
          someone who is. Showing them separately keeps "who was asked" and
          "who decided" as the two different questions they are. */}
      {settled && !assignees.some((a) => a.personId === decision.actorPersonId) && (
        <div className="mt-2 border-t border-border-subtle pt-2.5">
          <div className="flex items-start gap-3 px-0.5 py-1">
            <Avatar name={decision.actorName ?? 'Unknown'} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-semibold leading-snug text-strong">
                  {decision.actorName ?? 'Unknown person'}
                </span>
                <span className="text-2xs text-muted">
                  {decision.onBehalfOfName
                    ? `covering for ${decision.onBehalfOfName}`
                    : 'was not on the notified list'}
                </span>
              </div>
              <div className="mt-px flex items-baseline gap-1.5">
                <span
                  className={cn(
                    'text-2xs font-semibold leading-normal',
                    decision.decision === 'approved'
                      ? 'text-state-success-text'
                      : 'text-state-danger-text',
                  )}
                >
                  {decision.decision === 'approved' ? 'Approved' : 'Declined'}
                </span>
                <span className="font-mono text-2xs text-muted">
                  · {formatWhen(decision.decidedAt)}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {settled && decision.decision === 'rejected' && decision.reason && (
        <div className="mt-2 rounded-sm bg-state-danger-bg px-2.5 py-1.5 text-2xs leading-normal text-state-danger-text">
          “{decision.reason}”
        </div>
      )}
    </div>
  );
}
