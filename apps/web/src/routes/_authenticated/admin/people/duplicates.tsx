import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/trpc';
import { z } from 'zod';
import { ChevronLeft, ChevronRight, GitMerge, ShieldCheck } from 'lucide-react';
import { trpcReact } from '../../../../trpc.js';
import { PageHeader } from '../../../../components/nav/PageHeader.js';
import { DuplicateSignalCard } from '../../../../components/admin/DuplicateSignalCard.js';
import { IdentityMergeView } from '../../../../components/admin/IdentityMergeView.js';
import { Modal } from '../../../../components/feedback/Modal.js';
import { Callout } from '../../../../components/feedback/Callout.js';
import { Field } from '../../../../components/forms/Field.js';
import { Textarea } from '../../../../components/forms/Textarea.js';
import { Button } from '../../../../components/ui/button.js';
import { cn } from '../../../../lib/utils.js';
import { MATCH_REASON_LABELS, type DuplicateMatchReason } from '../../../../lib/people.js';

export const Route = createFileRoute('/_authenticated/admin/people/duplicates')({
  component: Duplicates,
});

type Candidate =
  inferRouterOutputs<AppRouter>['platform']['identity']['listDuplicateCandidates']['items'][number];

const mergeReasonSchema = z.object({ reason: z.string().trim().min(1, 'A reason is required') });

function MergeDialog({
  pair,
  onClose,
  onMerged,
}: {
  pair: Candidate;
  onClose: () => void;
  onMerged: () => void;
}) {
  const [survivorId, setSurvivorId] = React.useState(pair.personA.id);
  const [error, setError] = React.useState<string | null>(null);
  const merge = trpcReact.platform.identity.merge.useMutation();

  const form = useForm({
    defaultValues: { reason: '' },
    validators: { onChange: mergeReasonSchema },
    onSubmit: async ({ value }) => {
      setError(null);
      const supersededPersonId = survivorId === pair.personA.id ? pair.personB.id : pair.personA.id;
      try {
        await merge.mutateAsync({
          survivingPersonId: survivorId,
          supersededPersonId,
          reason: value.reason.trim(),
        });
        onMerged();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not merge the records.');
      }
    },
  });

  const party = (p: Candidate['personA']) => ({ id: p.id, name: p.displayName });
  const fields = [
    { label: 'Display name', a: pair.personA.displayName, b: pair.personB.displayName },
    { label: 'Given name', a: pair.personA.givenName, b: pair.personB.givenName },
    { label: 'Family name', a: pair.personA.familyName, b: pair.personB.familyName },
  ];

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      closeOnOverlay={false}
      title="Merge duplicate records"
      description="Choose which record survives. The other is merged into it — its sign-ins move across and its flags are unioned onto the survivor."
      footer={
        <>
          <Button variant="neutral" onClick={onClose}>
            Cancel
          </Button>
          <form.Subscribe
            selector={(s) => ({ canSubmit: s.canSubmit, isSubmitting: s.isSubmitting })}
          >
            {({ canSubmit, isSubmitting }) => (
              <Button
                startIcon={<GitMerge size={16} />}
                disabled={!canSubmit || isSubmitting}
                onClick={() => void form.handleSubmit()}
              >
                {isSubmitting ? 'Merging…' : 'Merge records'}
              </Button>
            )}
          </form.Subscribe>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <IdentityMergeView
          a={party(pair.personA)}
          b={party(pair.personB)}
          fields={fields}
          survivorId={survivorId}
          onSurvivorChange={setSurvivorId}
        />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="reason">
            {(field) => {
              const invalid = field.state.meta.isTouched && field.state.meta.errors.length > 0;
              return (
                <Field
                  label="Reason for merge"
                  htmlFor="merge-reason"
                  required
                  error={invalid ? field.state.meta.errors[0]?.message : undefined}
                >
                  <Textarea
                    id="merge-reason"
                    invalid={invalid}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                    placeholder="Why are these the same person?"
                  />
                </Field>
              );
            }}
          </form.Field>
        </form>

        <p className="inline-flex items-center gap-1.5 text-xs text-muted">
          <ShieldCheck size={14} /> This merge is{' '}
          <b className="font-semibold text-body">reversible</b> and fully audited.
        </p>

        {error && (
          <Callout tone="danger" title="Merge failed">
            {error}
          </Callout>
        )}
      </div>
    </Modal>
  );
}

function Duplicates() {
  const utils = trpcReact.useUtils();
  const [cursorStack, setCursorStack] = React.useState<string[]>([]);
  const cursor = cursorStack[cursorStack.length - 1];
  const [reviewing, setReviewing] = React.useState<Candidate | null>(null);

  const query = trpcReact.platform.identity.listDuplicateCandidates.useQuery({ limit: 25, cursor });
  const dismiss = trpcReact.platform.identity.dismissDuplicate.useMutation();

  const items = query.data?.items ?? [];
  const hasNext = Boolean(query.data?.nextCursor);
  const hasPrev = cursorStack.length > 0;

  const refresh = async () => {
    await Promise.all([
      utils.platform.identity.listDuplicateCandidates.invalidate(),
      utils.platform.identity.listPersons.invalidate(),
    ]);
  };

  const onDismiss = async (pair: Candidate) => {
    await dismiss.mutateAsync({ personIdA: pair.personA.id, personIdB: pair.personB.id });
    await utils.platform.identity.listDuplicateCandidates.invalidate();
  };

  const attrsOf = (p: Candidate['personA']) => ({
    'Given name': p.givenName ?? '—',
    'Family name': p.familyName ?? '—',
  });
  const eq = (x: string | null, y: string | null) =>
    Boolean(x && y && x.toLowerCase() === y.toLowerCase());

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-5">
      <PageHeader
        title="Possible duplicates"
        description="Advisory pairs the system spotted from matching identity details. Nothing is merged automatically — review each and merge, or dismiss it as a distinct person."
      />

      {query.isLoading ? (
        <p className="py-10 text-center text-sm text-muted">Loading possible duplicates…</p>
      ) : query.error ? (
        <Callout tone="danger" title="Couldn’t load duplicates">
          Try again in a moment.
        </Callout>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-border-subtle bg-surface-card py-14 text-center shadow-sm">
          <ShieldCheck size={28} className="text-state-success" />
          <p className="text-base font-semibold text-strong">No possible duplicates</p>
          <p className="max-w-[360px] text-sm text-muted">
            Every identity record looks distinct. New matches will appear here as records are added
            or edited.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {items.map((pair) => {
            const matches: string[] = [];
            if (eq(pair.personA.givenName, pair.personB.givenName)) matches.push('Given name');
            if (eq(pair.personA.familyName, pair.personB.familyName)) matches.push('Family name');
            const reasonLabels = (pair.reasons as DuplicateMatchReason[])
              .map((r) => MATCH_REASON_LABELS[r])
              .join(', ');
            return (
              <DuplicateSignalCard
                key={`${pair.personA.id}:${pair.personB.id}`}
                matchLabel={
                  reasonLabels ? `Possible duplicate · ${reasonLabels}` : 'Possible duplicate'
                }
                left={{ name: pair.personA.displayName, attrs: attrsOf(pair.personA) }}
                right={{ name: pair.personB.displayName, attrs: attrsOf(pair.personB) }}
                matches={matches}
                onReview={() => setReviewing(pair)}
                onDismiss={() => void onDismiss(pair)}
              />
            );
          })}
        </div>
      )}

      {(hasPrev || hasNext) && (
        <div className="flex items-center justify-end gap-1.5">
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
      )}

      {reviewing && (
        <MergeDialog
          pair={reviewing}
          onClose={() => setReviewing(null)}
          onMerged={async () => {
            setReviewing(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}
