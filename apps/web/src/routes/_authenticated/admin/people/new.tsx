import * as React from 'react';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import { useStore } from '@tanstack/react-form';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/trpc';
import { z } from 'zod';
import { ArrowRight, UserPlus } from 'lucide-react';
import { trpcReact } from '../../../../trpc.js';
import { PageHeader } from '../../../../components/nav/PageHeader.js';
import { PersonCell } from '../../../../components/data-display/PersonCell.js';
import { StatusPill } from '../../../../components/data-display/StatusPill.js';
import { Callout } from '../../../../components/feedback/Callout.js';
import { Field } from '../../../../components/forms/Field.js';
import { Input } from '../../../../components/forms/Input.js';
import { Select } from '../../../../components/forms/Select.js';
import { Textarea } from '../../../../components/forms/Textarea.js';
import { Button } from '../../../../components/ui/button.js';
import {
  dateToEndOfDayIso,
  MATCH_REASON_LABELS,
  PROFILE_STATUS_LABELS,
  PROFILE_STATUS_TONES,
  RELATIONSHIP_LABELS,
  type DuplicateMatchReason,
  type ProfileStatus,
  type RelationshipType,
} from '../../../../lib/people.js';

export const Route = createFileRoute('/_authenticated/admin/people/new')({
  component: NewPerson,
});

type CheckMatch = inferRouterOutputs<AppRouter>['platform']['identity']['checkExisting'][number];

/* Local form schema mirroring `createPersonInput` (@repo/trpc). The contract's
   runtime Zod can't be imported client-side — its only entry point pulls the
   server router — so, as in login.tsx, the shape is mirrored here. */
const RELATIONSHIP_TYPES = [
  'employee',
  'agency',
  'subcontractor',
  'self_employed',
  'external_org_employee',
  'candidate',
] as const;

const createPersonFormSchema = z.object({
  relationshipType: z.enum(RELATIONSHIP_TYPES, { message: 'Choose a relationship' }),
  displayName: z.string().trim().min(1, 'Enter a display name').max(400),
  givenName: z.string().trim().max(200),
  familyName: z.string().trim().max(200),
  dateOfBirth: z.string(),
  contactEmail: z.string().trim().max(320),
  agencyWorkerReference: z.string().trim().max(100),
  accessValidUntil: z.string(),
});

const EMPTY = {
  relationshipType: '' as RelationshipType | '',
  displayName: '',
  givenName: '',
  familyName: '',
  dateOfBirth: '',
  contactEmail: '',
  agencyWorkerReference: '',
  accessValidUntil: '',
};

/** A candidate advisory card — the existing profile that matches what's typed. */
function MatchCard({ match }: { match: CheckMatch }) {
  const p = match.person;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-state-pending-border bg-state-pending-bg px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <PersonCell
          name={p.display_name}
          secondary={RELATIONSHIP_LABELS[p.relationship_type as RelationshipType]}
        />
      </div>
      <div className="flex items-center gap-2">
        <StatusPill tone={PROFILE_STATUS_TONES[p.profile_status as ProfileStatus]} size="sm">
          {PROFILE_STATUS_LABELS[p.profile_status as ProfileStatus]}
        </StatusPill>
        {(match.reasons as DuplicateMatchReason[]).map((r) => (
          <span
            key={r}
            className="rounded-full bg-surface-card px-2 py-0.5 text-2xs font-semibold text-state-pending-text"
          >
            {MATCH_REASON_LABELS[r]}
          </span>
        ))}
      </div>
      <Link to="/admin/people/$personId" params={{ personId: p.id }}>
        <Button variant="secondary" size="sm" endIcon={<ArrowRight size={15} />}>
          Use this record
        </Button>
      </Link>
    </div>
  );
}

function NewPerson() {
  const router = useRouter();
  const utils = trpcReact.useUtils();
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [overrideReason, setOverrideReason] = React.useState('');

  const createPerson = trpcReact.platform.identity.createPerson.useMutation();

  const form = useForm({
    defaultValues: EMPTY,
    validators: { onChange: createPersonFormSchema },
    onSubmit: async ({ value }) => {
      setSubmitError(null);
      const isEmployee = value.relationshipType === 'employee';
      const candidateIds = matches.map((m) => m.person.id);
      // Matches present → an override with a journalled reason is mandatory (PL-047).
      if (candidateIds.length > 0 && overrideReason.trim().length === 0) {
        setSubmitError(
          'This looks like an existing person. Link to that record, or give a reason to create anyway.',
        );
        return;
      }
      try {
        const { personId } = await createPerson.mutateAsync({
          relationshipType: value.relationshipType as RelationshipType,
          displayName: value.displayName.trim(),
          givenName: value.givenName.trim() || undefined,
          familyName: value.familyName.trim() || undefined,
          dateOfBirth: value.dateOfBirth || undefined,
          contactEmail: value.contactEmail.trim() || undefined,
          agencyWorkerReference: value.agencyWorkerReference.trim() || undefined,
          accessValidUntil:
            !isEmployee && value.accessValidUntil
              ? dateToEndOfDayIso(value.accessValidUntil)
              : undefined,
          overrideMatches:
            candidateIds.length > 0
              ? { candidatePersonIds: candidateIds, reason: overrideReason.trim() }
              : undefined,
        });
        await utils.platform.identity.listPersons.invalidate();
        await router.navigate({ to: '/admin/people/$personId', params: { personId } });
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Could not create the person.');
      }
    },
  });

  // Reactive pre-creation existing-profile check (PL-047), debounced.
  const values = useStore(form.store, (s) => s.values);
  const [probe, setProbe] = React.useState(EMPTY);
  React.useEffect(() => {
    const t = setTimeout(() => setProbe(values), 350);
    return () => clearTimeout(t);
  }, [values]);

  const hasNameDob = Boolean(probe.givenName && probe.familyName && probe.dateOfBirth);
  const hasRef = Boolean(probe.agencyWorkerReference);
  const checkEnabled = hasNameDob || hasRef;
  const checkQuery = trpcReact.platform.identity.checkExisting.useQuery(
    {
      givenName: probe.givenName.trim() || undefined,
      familyName: probe.familyName.trim() || undefined,
      dateOfBirth: probe.dateOfBirth || undefined,
      contactEmail: probe.contactEmail.trim() || undefined,
      agencyWorkerReference: probe.agencyWorkerReference.trim() || undefined,
    },
    { enabled: checkEnabled, placeholderData: (prev) => prev },
  );
  const matches = checkEnabled ? (checkQuery.data ?? []) : [];

  const inputCls =
    'flex flex-col gap-4 rounded-lg border border-border-subtle bg-surface-card p-5 shadow-sm';

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-5">
      <PageHeader
        title="Add a person"
        description="Create a new identity record. We check for an existing profile before creating one."
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
        className="flex flex-col gap-5"
      >
        {/* Identity */}
        <section className={inputCls}>
          <h2 className="text-base font-bold tracking-tight text-strong">Identity</h2>

          <form.Field name="relationshipType">
            {(field) => {
              const invalid = field.state.meta.isTouched && field.state.meta.errors.length > 0;
              return (
                <Field
                  label="Relationship"
                  htmlFor="relationshipType"
                  required
                  error={invalid ? 'Choose a relationship' : undefined}
                >
                  <Select
                    id="relationshipType"
                    invalid={invalid}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value as RelationshipType)}
                    onBlur={field.handleBlur}
                  >
                    <option value="">Select…</option>
                    {RELATIONSHIP_TYPES.map((rt) => (
                      <option key={rt} value={rt}>
                        {RELATIONSHIP_LABELS[rt]}
                      </option>
                    ))}
                  </Select>
                </Field>
              );
            }}
          </form.Field>

          <form.Field name="displayName">
            {(field) => {
              const invalid = field.state.meta.isTouched && field.state.meta.errors.length > 0;
              return (
                <Field
                  label="Display name"
                  htmlFor="displayName"
                  required
                  hint="How this person appears across the platform"
                  error={invalid ? field.state.meta.errors[0]?.message : undefined}
                >
                  <Input
                    id="displayName"
                    invalid={invalid}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                    placeholder="e.g. Jordan Miles"
                  />
                </Field>
              );
            }}
          </form.Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <form.Field name="givenName">
              {(field) => (
                <Field label="Given name" htmlFor="givenName">
                  <Input
                    id="givenName"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                  />
                </Field>
              )}
            </form.Field>
            <form.Field name="familyName">
              {(field) => (
                <Field label="Family name" htmlFor="familyName">
                  <Input
                    id="familyName"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                  />
                </Field>
              )}
            </form.Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <form.Field name="dateOfBirth">
              {(field) => (
                <Field label="Date of birth" htmlFor="dateOfBirth">
                  <Input
                    id="dateOfBirth"
                    type="date"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                  />
                </Field>
              )}
            </form.Field>
            <form.Field name="agencyWorkerReference">
              {(field) => (
                <Field label="Agency worker reference" htmlFor="agencyWorkerReference">
                  <Input
                    id="agencyWorkerReference"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                  />
                </Field>
              )}
            </form.Field>
          </div>

          <form.Field name="contactEmail">
            {(field) => (
              <Field
                label="Contact email"
                htmlFor="contactEmail"
                hint="Not a sign-in — invite the person separately from their record"
              >
                <Input
                  id="contactEmail"
                  type="email"
                  inputMode="email"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
              </Field>
            )}
          </form.Field>
        </section>

        {/* Access window — externals only (employees never carry an expiry) */}
        <form.Subscribe selector={(s) => s.values.relationshipType}>
          {(rt) =>
            rt && rt !== 'employee' ? (
              <section className={inputCls}>
                <h2 className="text-base font-bold tracking-tight text-strong">Access window</h2>
                <form.Field name="accessValidUntil">
                  {(field) => (
                    <Field
                      label="Access valid until"
                      htmlFor="accessValidUntil"
                      hint="Leave blank for no expiry. External access ends at the end of this day."
                    >
                      <Input
                        id="accessValidUntil"
                        type="date"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                      />
                    </Field>
                  )}
                </form.Field>
              </section>
            ) : null
          }
        </form.Subscribe>

        {/* Existing-profile check (PL-047) */}
        {matches.length > 0 && (
          <section className="flex flex-col gap-3 rounded-lg border border-state-pending-border bg-surface-card p-5 shadow-sm">
            <div>
              <h2 className="text-base font-bold tracking-tight text-strong">
                {matches.length} possible existing profile{matches.length === 1 ? '' : 's'}
              </h2>
              <p className="mt-1 text-sm text-muted">
                Link to the existing record instead of creating a duplicate. To create a new record
                anyway, give a reason — it is recorded on the audit trail.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              {matches.map((m) => (
                <MatchCard key={m.person.id} match={m} />
              ))}
            </div>
            <Field label="Reason to create anyway" htmlFor="overrideReason" required>
              <Textarea
                id="overrideReason"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="Why is this a distinct person from the matches above?"
              />
            </Field>
          </section>
        )}

        {submitError && (
          <Callout tone="danger" title="Couldn’t create the person">
            {submitError}
          </Callout>
        )}

        <div className="flex items-center justify-end gap-2.5">
          <Link to="/admin/people">
            <Button variant="ghost">Cancel</Button>
          </Link>
          <form.Subscribe
            selector={(s) => ({ canSubmit: s.canSubmit, isSubmitting: s.isSubmitting })}
          >
            {({ canSubmit, isSubmitting }) => (
              <Button
                type="submit"
                startIcon={<UserPlus size={17} />}
                disabled={!canSubmit || isSubmitting}
              >
                {isSubmitting
                  ? 'Creating…'
                  : matches.length > 0
                    ? 'Create anyway'
                    : 'Create person'}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </form>
    </div>
  );
}
