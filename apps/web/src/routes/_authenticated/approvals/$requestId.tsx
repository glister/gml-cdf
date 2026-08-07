import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import type { WarningAck } from '@repo/trpc/schemas';
import { ArrowLeft, Check, UserCheck, X } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { Modal } from '~/components/feedback/Modal';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/forms/Field';
import { Textarea } from '~/components/forms/Textarea';
import { StatusPill } from '~/components/data-display/StatusPill';
import { DescriptionList } from '~/components/data-display/DescriptionList';
import { SoftWarningPanel } from '~/components/approvals/SoftWarningPanel';
import { ApprovalTrail } from '~/components/approvals/ApprovalTrail';
import {
  approvalTone,
  APPROVAL_STATUS_LABEL,
  CANNOT_DECIDE_REASON,
  formatInstant,
  shortSubjectType,
} from '~/lib/approvals';

export const Route = createFileRoute('/_authenticated/approvals/$requestId')({
  component: ApprovalDecision,
});

/**
 * The decision screen (core plan 09 §5.3, PL-016/PL-017).
 *
 * Three things about this screen are requirements rather than choices:
 *
 *  - **Approve is never disabled by a warning.** The soft-warning panel collects
 *    acknowledgements and returns no validity (PL-017, HL-038, and the design
 *    system's own note on `SoftWarningBlock`). What ticking does is get recorded
 *    on the decision — "the approver saw this and proceeded anyway" is the audit
 *    fact worth having, and it is not the same as consent being required.
 *  - **Declining requires a reason** (PL-016). The button stays disabled until
 *    the field has something in it, the shared Zod schema refuses it at the API,
 *    and a CHECK constraint refuses it at the database. Three layers because
 *    AC-D2 asks for it to be impossible "via the UI, the API and direct SQL".
 *  - **Whether you may decide is re-read from the server every time**, so this
 *    screen can honestly grey its buttons out for someone who was notified
 *    yesterday and has since left the role — and say why (§4.5).
 */
function ApprovalDecision() {
  const { requestId } = Route.useParams();
  const [acknowledged, setAcknowledged] = React.useState<WarningAck[]>([]);
  const [declining, setDeclining] = React.useState(false);
  const [conflict, setConflict] = React.useState<string | null>(null);

  const query = trpcReact.platform.approvals.byId.useQuery({ requestId });
  const decide = trpcReact.platform.approvals.decide.useMutation();
  const cancel = trpcReact.platform.approvals.cancel.useMutation();

  const refetch = React.useCallback(async () => {
    await query.refetch();
  }, [query]);

  /**
   * The loser of an any-one-approves race, and the person whose eligibility
   * changed under them, both land here. Neither has done anything wrong, so the
   * screen refreshes to show what actually happened rather than presenting an
   * error and leaving stale buttons on screen.
   */
  const handleDecisionError = React.useCallback(
    async (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Something went wrong.';
      setConflict(message);
      await refetch();
    },
    [refetch],
  );

  if (query.error) {
    return (
      <div className="mx-auto flex max-w-[900px] flex-col gap-4">
        <BackLink />
        <Callout tone="danger" title="Couldn’t open this request">
          {query.error.message}
        </Callout>
      </div>
    );
  }

  const detail = query.data;
  if (!detail) {
    return (
      <div className="mx-auto max-w-[900px] px-1 py-10 text-center font-sans text-sm text-muted">
        Loading request…
      </div>
    );
  }

  const { request, warnings, decision } = detail;
  const pending = request.status === 'pending';
  const busy = decide.isPending || cancel.isPending;

  const contextEntries = Object.entries(request.context);

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-4">
      <BackLink />

      <PageHeader
        title={shortSubjectType(request.subjectType)}
        description={`Raised by ${request.requestedByName ?? 'the system'} · ${formatInstant(request.submittedAt)}`}
        primaryAction={
          <StatusPill tone={approvalTone(request.status)}>
            {APPROVAL_STATUS_LABEL[request.status]}
          </StatusPill>
        }
      />

      {conflict && (
        <Callout tone="warning" title="This request moved while you were looking at it">
          {conflict}
        </Callout>
      )}

      {detail.viewerDelegationId && pending && (
        <Callout tone="info" title="You are covering for someone" icon={<UserCheck size={16} />}>
          You can decide this because an approver delegated their authority to you. Your decision is
          recorded as made via that delegation.
        </Callout>
      )}

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex flex-col gap-4">
          {/* The request's own facts. Ids, dates and amounts only — the engine
              stores nothing else, by rule (§4.2, ADR-0019). */}
          <section className="rounded-lg border border-border-subtle bg-surface-card p-5">
            <h2 className="mb-3 font-sans text-sm font-semibold text-strong">Request</h2>
            <DescriptionList
              items={[
                { term: 'Type', value: shortSubjectType(request.subjectType) },
                { term: 'Raised', value: formatInstant(request.submittedAt) },
                ...(request.decidedAt
                  ? [{ term: 'Decided', value: formatInstant(request.decidedAt) }]
                  : []),
                ...contextEntries.map(([key, value]) => ({
                  term: key.replaceAll('_', ' '),
                  value: String(value ?? '—'),
                  mono: typeof value === 'number',
                })),
              ]}
            />
          </section>

          {warnings.length > 0 && (
            <SoftWarningPanel
              warnings={warnings}
              acknowledged={acknowledged}
              // Read-only once decided: there is nothing left to acknowledge,
              // and the decision already recorded what was ticked at the time.
              onAcknowledgeChange={
                detail.viewerCanDecide ? (next) => setAcknowledged(next) : undefined
              }
            />
          )}

          {pending && detail.viewerCanDecide && (
            <div className="flex flex-wrap items-center gap-2.5">
              <Button
                startIcon={<Check size={15} />}
                disabled={busy}
                onClick={async () => {
                  try {
                    await decide.mutateAsync({
                      requestId,
                      decision: 'approved',
                      acknowledgedWarnings: acknowledged,
                    });
                    await refetch();
                  } catch (error) {
                    await handleDecisionError(error);
                  }
                }}
              >
                Approve
              </Button>
              <Button
                variant="secondary"
                startIcon={<X size={15} />}
                disabled={busy}
                onClick={() => setDeclining(true)}
              >
                Decline
              </Button>
              {warnings.length > 0 && acknowledged.length < warnings.length && (
                // The wording matters: the advisories do not gate the button,
                // and telling someone they "must acknowledge" when they need
                // not would make the panel read as a blocker.
                <span className="font-sans text-2xs text-muted">
                  You can approve without ticking the advisories — ticking records that you saw
                  them.
                </span>
              )}
            </div>
          )}

          {pending && !detail.viewerCanDecide && detail.viewerCannotDecideReason && (
            <Callout tone="info" title="You cannot decide this request">
              {CANNOT_DECIDE_REASON[detail.viewerCannotDecideReason]}
            </Callout>
          )}

          {pending && request.requestedBy !== null && (
            <div>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={async () => {
                  await cancel.mutateAsync({ requestId });
                  await refetch();
                }}
              >
                Withdraw this request
              </Button>
            </div>
          )}
        </div>

        <aside className="flex flex-col gap-4">
          <section className="rounded-lg border border-border-subtle bg-surface-card p-5">
            <ApprovalTrail assignees={detail.assignees} decision={decision} />
          </section>
        </aside>
      </div>

      {declining && (
        <DeclineDialog
          busy={busy}
          onClose={() => setDeclining(false)}
          onSubmit={async (reason) => {
            try {
              await decide.mutateAsync({
                requestId,
                decision: 'rejected',
                reason,
                acknowledgedWarnings: acknowledged,
              });
              setDeclining(false);
              await refetch();
            } catch (error) {
              setDeclining(false);
              await handleDecisionError(error);
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * The decline dialog. The reason is mandatory (PL-016) and the Confirm button
 * stays disabled until there is one — the design system's `DecisionPanel` note
 * calls this "the single enforced gate", in contrast to the advisories, which
 * enforce nothing.
 */
function DeclineDialog({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const form = useForm({
    defaultValues: { reason: '' },
    onSubmit: async ({ value }) => {
      await onSubmit(value.reason.trim());
    },
  });

  return (
    <Modal open onClose={onClose} title="Decline this request">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void form.handleSubmit();
        }}
        className="flex flex-col gap-4"
      >
        <form.Field
          name="reason"
          validators={{
            onChange: ({ value }) =>
              value.trim().length === 0 ? 'A reason is required when declining.' : undefined,
          }}
        >
          {(field) => (
            <Field
              label="Reason"
              htmlFor={field.name}
              required
              hint="The requester is told why, so write it for them."
              error={field.state.meta.errors.join(', ') || undefined}
            >
              <Textarea
                id={field.name}
                name={field.name}
                rows={4}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="Why is this being declined?"
              />
            </Field>
          )}
        </form.Field>

        <form.Subscribe selector={(s) => [s.values.reason, s.isSubmitting] as const}>
          {([reason, isSubmitting]) => (
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="danger"
                disabled={busy || isSubmitting || reason.trim().length === 0}
              >
                Confirm decline
              </Button>
            </div>
          )}
        </form.Subscribe>
      </form>
    </Modal>
  );
}

function BackLink() {
  return (
    <Link
      to="/approvals"
      className="inline-flex w-fit items-center gap-1.5 font-sans text-sm text-muted transition-colors hover:text-body"
    >
      <ArrowLeft size={15} />
      All approvals
    </Link>
  );
}
