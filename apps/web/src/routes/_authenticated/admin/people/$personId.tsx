import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/trpc';
import { allowedTransitions, type ProfileStatus as DomainProfileStatus } from '@repo/domain';
import { z } from 'zod';
import {
  ArrowLeft,
  BadgeCheck,
  Flag,
  GitMerge,
  Mail,
  Pencil,
  Plus,
  ShieldAlert,
  UserCog,
} from 'lucide-react';
import { trpcReact } from '../../../../trpc.js';
import { PageHeader } from '../../../../components/nav/PageHeader.js';
import { DescriptionList } from '../../../../components/data-display/DescriptionList.js';
import { StatusPill } from '../../../../components/data-display/StatusPill.js';
import { Modal } from '../../../../components/feedback/Modal.js';
import { Callout } from '../../../../components/feedback/Callout.js';
import { Field } from '../../../../components/forms/Field.js';
import { Input } from '../../../../components/forms/Input.js';
import { Select } from '../../../../components/forms/Select.js';
import { Textarea } from '../../../../components/forms/Textarea.js';
import { Button } from '../../../../components/ui/button.js';
import { cn } from '../../../../lib/utils.js';
import {
  dateToEndOfDayIso,
  FLAG_TYPE_LABELS,
  formatDate,
  isoToDateInput,
  PERSON_STATUS_LABELS,
  PERSON_STATUS_TONES,
  PROFILE_STATUS_LABELS,
  PROFILE_STATUS_TONES,
  RELATIONSHIP_LABELS,
  type PersonFlagType,
  type PersonStatus,
  type ProfileStatus,
  type RelationshipType,
} from '../../../../lib/people.js';

export const Route = createFileRoute('/_authenticated/admin/people/$personId')({
  component: PersonDetail,
});

type PersonDetail = inferRouterOutputs<AppRouter>['platform']['identity']['getPerson'];

const FLAG_TYPES: PersonFlagType[] = ['do_not_rehire', 'safeguarding', 'safety', 'other'];

const PROVIDER_LABELS: Record<string, string> = {
  microsoft: 'Microsoft work account',
  'email-otp': 'Email one-time passcode',
  email: 'Email one-time passcode',
  credential: 'Password',
};

const reasonField = z.string().trim().min(1, 'A reason is required');

/* ------------------------------------------------------------------ layout -- */

function SectionCard({
  title,
  icon,
  action,
  children,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border-subtle bg-surface-card p-5 shadow-sm">
      <div className="flex items-center gap-2.5">
        {icon && <span className="inline-flex text-muted">{icon}</span>}
        <h2 className="flex-1 text-base font-bold tracking-tight text-strong">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/* ----------------------------------------------------------------- dialogs -- */

/** A confirm dialog gated on a mandatory audit reason (convert, unmerge, end-flag). */
function ReasonDialog({
  title,
  description,
  confirmLabel,
  destructive,
  placeholder,
  onConfirm,
  onClose,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  destructive?: boolean;
  placeholder?: string;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const form = useForm({
    defaultValues: { reason: '' },
    validators: { onChange: z.object({ reason: reasonField }) },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await onConfirm(value.reason.trim());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      }
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={description}
      closeOnOverlay={false}
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
                variant={destructive ? 'danger' : 'primary'}
                disabled={!canSubmit || isSubmitting}
                onClick={() => void form.handleSubmit()}
              >
                {isSubmitting ? 'Working…' : confirmLabel}
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
        <form.Field name="reason">
          {(field) => {
            const invalid = field.state.meta.isTouched && field.state.meta.errors.length > 0;
            return (
              <Field
                label="Reason"
                htmlFor="reason"
                required
                error={invalid ? field.state.meta.errors[0]?.message : undefined}
              >
                <Textarea
                  id="reason"
                  invalid={invalid}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  placeholder={placeholder}
                />
              </Field>
            );
          }}
        </form.Field>
        {error && (
          <Callout tone="danger" title="Couldn’t complete">
            {error}
          </Callout>
        )}
      </form>
    </Modal>
  );
}

function ChangeStatusDialog({
  current,
  onConfirm,
  onClose,
}: {
  current: ProfileStatus;
  onConfirm: (to: ProfileStatus, reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const targets = allowedTransitions(current as DomainProfileStatus) as ProfileStatus[];
  const [error, setError] = React.useState<string | null>(null);
  const form = useForm({
    defaultValues: { to: (targets[0] ?? '') as string, reason: '' },
    validators: {
      onChange: z.object({ to: z.string().min(1, 'Choose a status'), reason: reasonField }),
    },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await onConfirm(value.to as ProfileStatus, value.reason.trim());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      }
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Change profile status"
      description={`From “${PROFILE_STATUS_LABELS[current]}”. Only legal transitions are offered; the previous status is kept on the audit trail.`}
      closeOnOverlay={false}
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
                disabled={!canSubmit || isSubmitting}
                onClick={() => void form.handleSubmit()}
              >
                {isSubmitting ? 'Changing…' : 'Change status'}
              </Button>
            )}
          </form.Subscribe>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <form.Field name="to">
          {(field) => (
            <Field label="New status" htmlFor="to" required>
              <Select
                id="to"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              >
                {targets.map((t) => (
                  <option key={t} value={t}>
                    {PROFILE_STATUS_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </form.Field>
        <form.Field name="reason">
          {(field) => {
            const invalid = field.state.meta.isTouched && field.state.meta.errors.length > 0;
            return (
              <Field
                label="Reason"
                htmlFor="status-reason"
                required
                error={invalid ? field.state.meta.errors[0]?.message : undefined}
              >
                <Textarea
                  id="status-reason"
                  invalid={invalid}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
              </Field>
            );
          }}
        </form.Field>
        {error && (
          <Callout tone="danger" title="Transition rejected">
            {error}
          </Callout>
        )}
      </div>
    </Modal>
  );
}

function AddFlagDialog({
  onConfirm,
  onClose,
}: {
  onConfirm: (flagType: PersonFlagType, reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const form = useForm({
    defaultValues: { flagType: 'safeguarding' as string, reason: '' },
    validators: { onChange: z.object({ flagType: z.string().min(1), reason: reasonField }) },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await onConfirm(value.flagType as PersonFlagType, value.reason.trim());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      }
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a flag"
      description="Flags travel with the person and always survive a merge."
      closeOnOverlay={false}
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
                disabled={!canSubmit || isSubmitting}
                onClick={() => void form.handleSubmit()}
              >
                {isSubmitting ? 'Adding…' : 'Add flag'}
              </Button>
            )}
          </form.Subscribe>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <form.Field name="flagType">
          {(field) => (
            <Field label="Flag type" htmlFor="flagType" required>
              <Select
                id="flagType"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value as PersonFlagType)}
              >
                {FLAG_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {FLAG_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </form.Field>
        <form.Field name="reason">
          {(field) => {
            const invalid = field.state.meta.isTouched && field.state.meta.errors.length > 0;
            return (
              <Field
                label="Reason"
                htmlFor="flag-reason"
                required
                error={invalid ? field.state.meta.errors[0]?.message : undefined}
              >
                <Textarea
                  id="flag-reason"
                  invalid={invalid}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
              </Field>
            );
          }}
        </form.Field>
        {error && (
          <Callout tone="danger" title="Couldn’t add the flag">
            {error}
          </Callout>
        )}
      </div>
    </Modal>
  );
}

function AccessDialog({
  mode,
  currentUntil,
  onConfirm,
  onClose,
}: {
  mode: 'set' | 'reengage';
  currentUntil: string | Date | null;
  onConfirm: (accessValidUntilIso: string) => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const form = useForm({
    defaultValues: { date: mode === 'set' ? isoToDateInput(currentUntil) : '' },
    validators: { onChange: z.object({ date: z.string().min(1, 'Choose a date') }) },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await onConfirm(dateToEndOfDayIso(value.date));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      }
    },
  });
  const isReengage = mode === 'reengage';
  return (
    <Modal
      open
      onClose={onClose}
      title={isReengage ? 'Re-engage this person' : 'Set access expiry'}
      description={
        isReengage
          ? 'Reactivate the same record and restore sign-in, with a new access expiry.'
          : 'External access ends at the end of the chosen day.'
      }
      closeOnOverlay={false}
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
                disabled={!canSubmit || isSubmitting}
                onClick={() => void form.handleSubmit()}
              >
                {isSubmitting ? 'Saving…' : isReengage ? 'Re-engage' : 'Save expiry'}
              </Button>
            )}
          </form.Subscribe>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <form.Field name="date">
          {(field) => (
            <Field label="Access valid until" htmlFor="access-date" required>
              <Input
                id="access-date"
                type="date"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
              />
            </Field>
          )}
        </form.Field>
        {error && (
          <Callout tone="danger" title="Couldn’t save">
            {error}
          </Callout>
        )}
      </div>
    </Modal>
  );
}

function InviteDialog({
  defaultEmail,
  onConfirm,
  onClose,
}: {
  defaultEmail: string;
  onConfirm: (email: string) => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const form = useForm({
    defaultValues: { email: defaultEmail },
    validators: { onChange: z.object({ email: z.email('Enter a valid email') }) },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await onConfirm(value.email.trim());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      }
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Invite to Connect"
      description="Emails a sign-in link. This is the only way an external gets an account."
      closeOnOverlay={false}
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
                startIcon={<Mail size={16} />}
                disabled={!canSubmit || isSubmitting}
                onClick={() => void form.handleSubmit()}
              >
                {isSubmitting ? 'Sending…' : 'Send invitation'}
              </Button>
            )}
          </form.Subscribe>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <form.Field name="email">
          {(field) => {
            const invalid = field.state.meta.isTouched && field.state.meta.errors.length > 0;
            return (
              <Field
                label="Email"
                htmlFor="invite-email"
                required
                error={invalid ? field.state.meta.errors[0]?.message : undefined}
              >
                <Input
                  id="invite-email"
                  type="email"
                  inputMode="email"
                  invalid={invalid}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
              </Field>
            );
          }}
        </form.Field>
        {error && (
          <Callout tone="danger" title="Couldn’t send the invitation">
            {error}
          </Callout>
        )}
      </div>
    </Modal>
  );
}

function EditDetailsDialog({
  person,
  onConfirm,
  onClose,
}: {
  person: PersonDetail['person'];
  onConfirm: (input: {
    displayName: string;
    givenName: string | null;
    familyName: string | null;
    dateOfBirth: string | null;
    contactEmail: string | null;
    agencyWorkerReference: string | null;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const form = useForm({
    defaultValues: {
      displayName: person.display_name,
      givenName: person.given_name ?? '',
      familyName: person.family_name ?? '',
      dateOfBirth: isoToDateInput(person.date_of_birth),
      contactEmail: person.contact_email ?? '',
      agencyWorkerReference: person.agency_worker_reference ?? '',
    },
    validators: {
      onChange: z.object({
        displayName: z.string().trim().min(1, 'Enter a display name').max(400),
        givenName: z.string().trim().max(200),
        familyName: z.string().trim().max(200),
        dateOfBirth: z.string(),
        contactEmail: z.string().trim().max(320),
        agencyWorkerReference: z.string().trim().max(100),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await onConfirm({
          displayName: value.displayName.trim(),
          givenName: value.givenName.trim() || null,
          familyName: value.familyName.trim() || null,
          dateOfBirth: value.dateOfBirth || null,
          contactEmail: value.contactEmail.trim() || null,
          agencyWorkerReference: value.agencyWorkerReference.trim() || null,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      }
    },
  });
  const text = (
    name: 'displayName' | 'givenName' | 'familyName' | 'contactEmail' | 'agencyWorkerReference',
    label: string,
    required?: boolean,
    type = 'text',
  ) => (
    <form.Field name={name}>
      {(field) => {
        const invalid = field.state.meta.isTouched && field.state.meta.errors.length > 0;
        return (
          <Field
            label={label}
            htmlFor={`edit-${name}`}
            required={required}
            error={invalid ? field.state.meta.errors[0]?.message : undefined}
          >
            <Input
              id={`edit-${name}`}
              type={type}
              invalid={invalid}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
            />
          </Field>
        );
      }}
    </form.Field>
  );
  return (
    <Modal
      open
      onClose={onClose}
      title="Edit details"
      description="Editing identity attributes re-runs the duplicate check."
      closeOnOverlay={false}
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
                disabled={!canSubmit || isSubmitting}
                onClick={() => void form.handleSubmit()}
              >
                {isSubmitting ? 'Saving…' : 'Save changes'}
              </Button>
            )}
          </form.Subscribe>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {text('displayName', 'Display name', true)}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {text('givenName', 'Given name')}
          {text('familyName', 'Family name')}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <form.Field name="dateOfBirth">
            {(field) => (
              <Field label="Date of birth" htmlFor="edit-dob">
                <Input
                  id="edit-dob"
                  type="date"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
              </Field>
            )}
          </form.Field>
          {text('agencyWorkerReference', 'Agency worker reference')}
        </div>
        {text('contactEmail', 'Contact email', false, 'email')}
        {error && (
          <Callout tone="danger" title="Couldn’t save">
            {error}
          </Callout>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------- route -- */

type Dialog =
  | { kind: 'status' }
  | { kind: 'convert' }
  | { kind: 'edit' }
  | { kind: 'invite' }
  | { kind: 'addFlag' }
  | { kind: 'access'; mode: 'set' | 'reengage' }
  | { kind: 'endFlag'; flagId: string; label: string }
  | { kind: 'unmerge'; mergeId: string; name: string };

function PersonDetail() {
  const { personId } = Route.useParams();
  const utils = trpcReact.useUtils();
  const [dialog, setDialog] = React.useState<Dialog | null>(null);

  const query = trpcReact.platform.identity.getPerson.useQuery({ personId });

  const m = {
    setProfileStatus: trpcReact.platform.identity.setProfileStatus.useMutation(),
    convert: trpcReact.platform.identity.convertToEmployee.useMutation(),
    setAccess: trpcReact.platform.identity.setAccessValidUntil.useMutation(),
    reengage: trpcReact.platform.identity.reengage.useMutation(),
    addFlag: trpcReact.platform.identity.addFlag.useMutation(),
    endFlag: trpcReact.platform.identity.endFlag.useMutation(),
    unmerge: trpcReact.platform.identity.unmerge.useMutation(),
    invite: trpcReact.platform.identity.invite.useMutation(),
    update: trpcReact.platform.identity.updatePerson.useMutation(),
  };

  const refresh = async () => {
    await Promise.all([
      utils.platform.identity.getPerson.invalidate({ personId }),
      utils.platform.identity.listPersons.invalidate(),
    ]);
  };
  const close = () => setDialog(null);
  const done = async () => {
    await refresh();
    close();
  };

  if (query.isLoading) {
    return <p className="py-10 text-center text-sm text-muted">Loading record…</p>;
  }
  if (query.error || !query.data) {
    return (
      <div className="mx-auto max-w-[720px]">
        <Callout tone="danger" title="Couldn’t load this record">
          It may have been merged or removed.{' '}
          <Link to="/admin/people" className="font-semibold text-link">
            Back to people
          </Link>
        </Callout>
      </div>
    );
  }

  const { person, flags, credentials, merges } = query.data;
  const relationship = person.relationship_type as RelationshipType;
  const profileStatus = person.profile_status as ProfileStatus;
  const personStatus = person.status as PersonStatus;
  const isEmployee = relationship === 'employee';
  const activeFlags = flags.filter((f) => !f.ended_at);
  const endedFlags = flags.filter((f) => f.ended_at);
  const transitions = allowedTransitions(profileStatus as DomainProfileStatus);

  return (
    <div className="mx-auto flex max-w-[1120px] flex-col gap-5">
      <div>
        <Link
          to="/admin/people"
          className="mb-2 inline-flex items-center gap-1 text-sm font-medium text-muted transition-colors hover:text-body"
        >
          <ArrowLeft size={15} /> People
        </Link>
        <PageHeader
          title={person.display_name}
          meta={
            <span className="inline-flex flex-wrap items-center gap-2.5">
              <span className="text-sm text-muted">{RELATIONSHIP_LABELS[relationship]}</span>
              <StatusPill tone={PROFILE_STATUS_TONES[profileStatus]}>
                {PROFILE_STATUS_LABELS[profileStatus]}
              </StatusPill>
              {personStatus !== 'active' && (
                <StatusPill tone={PERSON_STATUS_TONES[personStatus]}>
                  {PERSON_STATUS_LABELS[personStatus]}
                </StatusPill>
              )}
              <span className="font-mono text-2xs text-disabled">{person.id.slice(0, 8)}</span>
            </span>
          }
          primaryAction={
            <Button
              variant="neutral"
              startIcon={<Pencil size={16} />}
              onClick={() => setDialog({ kind: 'edit' })}
            >
              Edit details
            </Button>
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.6fr_1fr]">
        {/* Main column */}
        <div className="flex flex-col gap-5">
          <SectionCard title="Profile">
            <DescriptionList
              columns={2}
              bordered
              items={[
                { term: 'Relationship', value: RELATIONSHIP_LABELS[relationship] },
                { term: 'Given name', value: person.given_name },
                { term: 'Family name', value: person.family_name },
                { term: 'Date of birth', value: formatDate(person.date_of_birth), mono: true },
                { term: 'Contact email', value: person.contact_email, mono: true },
                {
                  term: 'Agency worker reference',
                  value: person.agency_worker_reference,
                  mono: true,
                },
                {
                  term: 'Access valid until',
                  value: isEmployee ? '— (employee)' : formatDate(person.access_valid_until),
                  mono: true,
                },
                { term: 'Added', value: formatDate(person.created_at), mono: true },
              ]}
            />
          </SectionCard>

          <SectionCard
            title="Safeguarding flags"
            icon={<Flag size={18} />}
            action={
              <Button
                variant="secondary"
                size="sm"
                startIcon={<Plus size={15} />}
                onClick={() => setDialog({ kind: 'addFlag' })}
              >
                Add flag
              </Button>
            }
          >
            {activeFlags.length === 0 && endedFlags.length === 0 ? (
              <p className="text-sm text-muted">No flags on this record.</p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {activeFlags.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-start gap-3 rounded-md border border-state-danger-border bg-state-danger-bg px-3.5 py-3"
                  >
                    <ShieldAlert size={17} className="mt-0.5 shrink-0 text-state-danger" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-state-danger-text">
                        {FLAG_TYPE_LABELS[f.flag_type as PersonFlagType]}
                      </div>
                      <p className="mt-0.5 text-sm text-body">{f.reason}</p>
                      <p className="mt-1 font-mono text-2xs text-muted">
                        Raised {formatDate(f.raised_at)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setDialog({
                          kind: 'endFlag',
                          flagId: f.id,
                          label: FLAG_TYPE_LABELS[f.flag_type as PersonFlagType],
                        })
                      }
                    >
                      End
                    </Button>
                  </div>
                ))}
                {endedFlags.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-start gap-3 rounded-md border border-border-subtle px-3.5 py-3 opacity-70"
                  >
                    <Flag size={17} className="mt-0.5 shrink-0 text-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-body">
                        {FLAG_TYPE_LABELS[f.flag_type as PersonFlagType]}{' '}
                        <span className="font-normal text-muted">
                          · ended {formatDate(f.ended_at)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-sm text-muted">{f.reason}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Merge history" icon={<GitMerge size={18} />}>
            {merges.length === 0 ? (
              <p className="text-sm text-muted">This record has not absorbed any others.</p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {merges.map((mg) => (
                  <div
                    key={mg.mergeId}
                    className="flex items-start gap-3 rounded-md border border-border-subtle px-3.5 py-3"
                  >
                    <GitMerge size={17} className="mt-0.5 shrink-0 text-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-strong">
                        Merged in{' '}
                        <Link
                          to="/admin/people/$personId"
                          params={{ personId: mg.supersededPersonId }}
                          className="text-link hover:underline"
                        >
                          {mg.supersededDisplayName}
                        </Link>
                      </div>
                      <p className="mt-0.5 text-sm text-body">{mg.reason}</p>
                      <p className="mt-1 font-mono text-2xs text-muted">
                        {formatDate(mg.mergedAt)}
                        {mg.reversedAt && ` · reversed ${formatDate(mg.reversedAt)}`}
                      </p>
                    </div>
                    {!mg.reversedAt && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setDialog({
                            kind: 'unmerge',
                            mergeId: mg.mergeId,
                            name: mg.supersededDisplayName,
                          })
                        }
                      >
                        Unmerge
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        {/* Side column */}
        <div className="flex flex-col gap-5">
          <SectionCard title="Lifecycle" icon={<UserCog size={18} />}>
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-muted">Profile status</div>
                  <div className="mt-1">
                    <StatusPill tone={PROFILE_STATUS_TONES[profileStatus]}>
                      {PROFILE_STATUS_LABELS[profileStatus]}
                    </StatusPill>
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={transitions.length === 0}
                  onClick={() => setDialog({ kind: 'status' })}
                >
                  Change
                </Button>
              </div>

              {!isEmployee && (
                <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-4">
                  <div>
                    <div className="text-xs font-semibold text-muted">Relationship</div>
                    <div className="mt-1 text-sm font-medium text-strong">
                      {RELATIONSHIP_LABELS[relationship]}
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    startIcon={<BadgeCheck size={15} />}
                    onClick={() => setDialog({ kind: 'convert' })}
                  >
                    Convert to employee
                  </Button>
                </div>
              )}

              {!isEmployee && (
                <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-4">
                  <div>
                    <div className="text-xs font-semibold text-muted">Access valid until</div>
                    <div className="mt-1 font-mono text-sm text-strong">
                      {formatDate(person.access_valid_until)}
                    </div>
                  </div>
                  {personStatus === 'inactive' ? (
                    <Button
                      size="sm"
                      onClick={() => setDialog({ kind: 'access', mode: 'reengage' })}
                    >
                      Re-engage
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setDialog({ kind: 'access', mode: 'set' })}
                    >
                      {person.access_valid_until ? 'Extend' : 'Set'}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </SectionCard>

          <SectionCard
            title="Sign-in accounts"
            icon={<BadgeCheck size={18} />}
            action={
              <Button
                variant="secondary"
                size="sm"
                startIcon={<Mail size={15} />}
                onClick={() => setDialog({ kind: 'invite' })}
              >
                Invite
              </Button>
            }
          >
            {credentials.length === 0 ? (
              <p className="text-sm text-muted">No sign-in yet. Invite the person to Connect.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {credentials.map((c) => (
                  <div
                    key={c.userId + c.providerId}
                    className={cn(
                      'flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3.5 py-2.5',
                    )}
                  >
                    <span className="text-sm font-medium text-strong">
                      {PROVIDER_LABELS[c.providerId] ?? c.providerId}
                    </span>
                    <span className="font-mono text-2xs text-muted">{formatDate(c.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      </div>

      {/* Dialogs */}
      {dialog?.kind === 'status' && (
        <ChangeStatusDialog
          current={profileStatus}
          onClose={close}
          onConfirm={async (to, reason) => {
            await m.setProfileStatus.mutateAsync({ personId, to, reason });
            await done();
          }}
        />
      )}
      {dialog?.kind === 'convert' && (
        <ReasonDialog
          title="Convert to employee"
          description="Keeps the record, its id and history; clears any access expiry."
          confirmLabel="Convert to employee"
          placeholder="Why is this person becoming an employee?"
          onClose={close}
          onConfirm={async (reason) => {
            await m.convert.mutateAsync({ personId, reason });
            await done();
          }}
        />
      )}
      {dialog?.kind === 'addFlag' && (
        <AddFlagDialog
          onClose={close}
          onConfirm={async (flagType, reason) => {
            await m.addFlag.mutateAsync({ personId, flagType, reason });
            await done();
          }}
        />
      )}
      {dialog?.kind === 'endFlag' && (
        <ReasonDialog
          title={`End “${dialog.label}” flag`}
          description="The flag is retained on the record as ended, with your reason."
          confirmLabel="End flag"
          placeholder="Why is this flag no longer needed?"
          onClose={close}
          onConfirm={async (reason) => {
            await m.endFlag.mutateAsync({ flagId: dialog.flagId, reason });
            await done();
          }}
        />
      )}
      {dialog?.kind === 'access' && (
        <AccessDialog
          mode={dialog.mode}
          currentUntil={person.access_valid_until}
          onClose={close}
          onConfirm={async (iso) => {
            if (dialog.mode === 'reengage') {
              await m.reengage.mutateAsync({ personId, accessValidUntil: iso });
            } else {
              await m.setAccess.mutateAsync({ personId, accessValidUntil: iso });
            }
            await done();
          }}
        />
      )}
      {dialog?.kind === 'unmerge' && (
        <ReasonDialog
          title={`Unmerge ${dialog.name}`}
          description="Reverses the merge: the superseded record is reactivated and its sign-ins restored."
          confirmLabel="Reverse merge"
          destructive
          placeholder="Why is this merge being reversed?"
          onClose={close}
          onConfirm={async (reason) => {
            await m.unmerge.mutateAsync({ mergeId: dialog.mergeId, reason });
            await done();
          }}
        />
      )}
      {dialog?.kind === 'invite' && (
        <InviteDialog
          defaultEmail={person.contact_email ?? ''}
          onClose={close}
          onConfirm={async (email) => {
            await m.invite.mutateAsync({ personId, email });
            await done();
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <EditDetailsDialog
          person={person}
          onClose={close}
          onConfirm={async (input) => {
            await m.update.mutateAsync({ personId, ...input });
            await done();
          }}
        />
      )}
    </div>
  );
}
