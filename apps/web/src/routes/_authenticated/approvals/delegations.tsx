import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import { ArrowLeft, Plus } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { Modal } from '~/components/feedback/Modal';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/forms/Field';
import { Input } from '~/components/forms/Input';
import { Textarea } from '~/components/forms/Textarea';
import { StatusPill } from '~/components/data-display/StatusPill';
import { Switch } from '~/components/forms/Switch';
import { formatDay } from '~/lib/approvals';

export const Route = createFileRoute('/_authenticated/approvals/delegations')({
  component: Delegations,
});

/**
 * Delegation settings (core plan 09 §5.3, HL-035 driver).
 *
 * A delegation hands your approval authority to someone else for a period. Two
 * properties of the model shape this screen:
 *
 *  - **It is not a reassignment.** Nothing moves; the delegate becomes eligible
 *    alongside you, and either of you can decide. So the list shows both
 *    directions — authority you have given away, and authority you are currently
 *    carrying — because someone covering for a colleague needs to see it as much
 *    as the person who arranged it.
 *  - **Revoking is not deleting.** The window stays on the row, so a decision
 *    already made under a delegation stays explainable afterwards. The list
 *    reflects that: a revoked delegation is shown as ended, not removed.
 */
function Delegations() {
  const [includeInactive, setIncludeInactive] = React.useState(false);
  const [creating, setCreating] = React.useState(false);

  const query = trpcReact.platform.approvals.delegations.list.useQuery({ includeInactive });
  const revoke = trpcReact.platform.approvals.delegations.revoke.useMutation();

  const refetch = React.useCallback(async () => {
    await query.refetch();
  }, [query]);

  const rows = query.data ?? [];

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-4">
      <Link
        to="/approvals"
        className="inline-flex w-fit items-center gap-1.5 font-sans text-sm text-muted transition-colors hover:text-body"
      >
        <ArrowLeft size={15} />
        All approvals
      </Link>

      <PageHeader
        title="Delegations"
        description="Cover for an absence by letting someone else decide your approvals for a period. They are added alongside you rather than replacing you, and either of you can decide."
        primaryAction={
          <Button startIcon={<Plus size={15} />} onClick={() => setCreating(true)}>
            Delegate my approvals
          </Button>
        }
      />

      {query.error && (
        <Callout tone="danger" title="Couldn’t load delegations">
          {query.error.message}
        </Callout>
      )}

      {revoke.error && (
        <Callout tone="danger" title="Couldn’t end that delegation">
          {revoke.error.message}
        </Callout>
      )}

      <div className="flex items-center justify-end">
        <div className="flex h-9 items-center rounded-md border border-border-default bg-surface-card px-3">
          <Switch
            label="Show ended ones"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface-card">
        {query.isLoading ? (
          <p className="px-4 py-10 text-center font-sans text-sm text-muted">
            Loading delegations…
          </p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-10 text-center font-sans text-sm text-muted">
            {includeInactive
              ? 'No delegations, past or present.'
              : 'Nothing delegated at the moment.'}
          </p>
        ) : (
          <ul className="list-none divide-y divide-border-subtle p-0">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="font-sans text-sm font-semibold text-strong">
                    {row.delegatorName ?? 'Someone'} → {row.delegateName ?? 'someone'}
                  </p>
                  <p className="mt-0.5 font-sans text-2xs text-muted">
                    {formatDay(row.validFrom)} to {formatDay(row.validTo)}
                    {row.subjectType ? ` · ${row.subjectType} only` : ' · all approvals'}
                    {row.revokedAt ? ` · ended ${formatDay(row.revokedAt)}` : ''}
                  </p>
                  {row.reason && (
                    <p className="mt-1 font-sans text-2xs italic text-muted">“{row.reason}”</p>
                  )}
                </div>
                <StatusPill tone={row.active ? 'success' : 'neutral'}>
                  {row.active ? 'Active' : row.revokedAt ? 'Ended early' : 'Lapsed'}
                </StatusPill>
                {row.active && (
                  <Button
                    variant="ghost"
                    disabled={revoke.isPending}
                    onClick={async () => {
                      await revoke.mutateAsync({ delegationId: row.id });
                      await refetch();
                    }}
                  >
                    End now
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {creating && (
        <CreateDelegationDialog
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refetch();
          }}
        />
      )}
    </div>
  );
}

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function CreateDelegationDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const create = trpcReact.platform.approvals.delegations.create.useMutation();

  const form = useForm({
    defaultValues: {
      delegatePersonId: '',
      subjectType: '',
      validFrom: isoDay(0),
      validTo: isoDay(7),
      reason: '',
    },
    onSubmit: async ({ value }) => {
      await create.mutateAsync({
        delegatePersonId: value.delegatePersonId.trim(),
        // Dates are days in the form and instants on the wire: a delegation
        // runs from the start of its first day to the start of the day after
        // its last, which is what the half-open window in the engine expects.
        validFrom: new Date(`${value.validFrom}T00:00:00.000Z`).toISOString(),
        validTo: new Date(`${value.validTo}T00:00:00.000Z`).toISOString(),
        ...(value.subjectType.trim() ? { subjectType: value.subjectType.trim() } : {}),
        ...(value.reason.trim() ? { reason: value.reason.trim() } : {}),
      });
      await onCreated();
    },
  });

  return (
    <Modal open onClose={onClose} title="Delegate my approvals">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void form.handleSubmit();
        }}
        className="flex flex-col gap-4"
      >
        {create.error && (
          <Callout tone="danger" title="Couldn’t create the delegation">
            {create.error.message}
          </Callout>
        )}

        <form.Field
          name="delegatePersonId"
          validators={{
            onChange: ({ value }) =>
              value.trim().length === 0 ? 'Choose who is covering for you.' : undefined,
          }}
        >
          {(field) => (
            <Field
              label="Person covering"
              htmlFor={field.name}
              required
              hint="Their person id. Anyone can cover for you — the delegation is what gives them the authority."
              error={field.state.meta.errors.join(', ') || undefined}
            >
              <Input
                id={field.name}
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="0192f3a4-…"
              />
            </Field>
          )}
        </form.Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <form.Field name="validFrom">
            {(field) => (
              <Field label="From" htmlFor={field.name} required>
                <Input
                  id={field.name}
                  name={field.name}
                  type="date"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Field
            name="validTo"
            validators={{
              onChangeListenTo: ['validFrom'],
              onChange: ({ value, fieldApi }) =>
                value <= fieldApi.form.getFieldValue('validFrom')
                  ? 'The delegation must end after it starts.'
                  : undefined,
            }}
          >
            {(field) => (
              <Field
                label="Until"
                htmlFor={field.name}
                required
                error={field.state.meta.errors.join(', ') || undefined}
              >
                <Input
                  id={field.name}
                  name={field.name}
                  type="date"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </form.Field>
        </div>

        <form.Field name="subjectType">
          {(field) => (
            <Field
              label="Only this kind of approval"
              htmlFor={field.name}
              hint="Leave blank to cover all of them. A stream name, e.g. hr.leave_booking."
            >
              <Input
                id={field.name}
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="All approvals"
              />
            </Field>
          )}
        </form.Field>

        <form.Field name="reason">
          {(field) => (
            <Field label="Reason" htmlFor={field.name} hint="Optional. Shown on the delegation.">
              <Textarea
                id={field.name}
                name={field.name}
                rows={2}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="Annual leave, on site, …"
              />
            </Field>
          )}
        </form.Field>

        <form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit || isSubmitting}>
                Delegate
              </Button>
            </div>
          )}
        </form.Subscribe>
      </form>
    </Modal>
  );
}
