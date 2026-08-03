import * as React from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import { Archive, CalendarClock, ChevronLeft, Pencil, UserMinus, UserPlus } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Button } from '~/components/ui/button';
import { Callout } from '~/components/feedback/Callout';
import { Modal } from '~/components/feedback/Modal';
import { Field } from '~/components/forms/Field';
import { Input } from '~/components/forms/Input';
import { Select } from '~/components/forms/Select';
import { Textarea } from '~/components/forms/Textarea';
import { StatusPill } from '~/components/data-display/StatusPill';
import { PersonCell } from '~/components/data-display/PersonCell';
import { cn } from '~/lib/utils';
import { formatDay, todayIso } from '~/lib/reference-data';
import { RELATIONSHIP_LABELS, type RelationshipType } from '~/lib/people';
import { z } from 'zod';

export const Route = createFileRoute('/_authenticated/admin/teams/$teamId')({
  component: TeamDetail,
});

type MembershipRow = { id: string; person_id: string; valid_from: string; valid_to: string | null };

/** Form-shaped mirrors of the team mutations' inputs (see `teams/index.tsx`). */
const editTeamFormSchema = z.object({
  name: z.string().trim().min(1, 'Give the team a name').max(200),
  description: z.string().trim().max(1000),
  managerPersonId: z.string().uuid('Choose a manager'),
  deputyPersonId: z.string(),
  maxConcurrentLeave: z.string(),
  colour: z.string(),
});

const addMemberFormSchema = z.object({
  personId: z.string().uuid('Choose a person'),
  validFrom: z.string().min(1, 'Choose the date they join'),
});

const endMembershipFormSchema = z.object({
  validTo: z.string().min(1, 'Choose the date the membership ends'),
});

const correctMembershipFormSchema = z.object({
  validFrom: z.string().min(1, 'A membership must have a start date'),
  // Empty means open-ended, which is a legitimate correction.
  validTo: z.string(),
});

function TeamDetail() {
  const { teamId } = Route.useParams();
  const navigate = useNavigate();
  const utils = trpcReact.useUtils();

  /**
   * The as-at date drives the roster. Effective dating only earns its keep if
   * you can actually ask the question, so the date picker is a first-class
   * control here rather than a debugging aid (AC-D4).
   */
  const [asAt, setAsAt] = React.useState('');
  const [editOpen, setEditOpen] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  const [ending, setEnding] = React.useState<MembershipRow | null>(null);
  const [correcting, setCorrecting] = React.useState<MembershipRow | null>(null);
  const [archiveOpen, setArchiveOpen] = React.useState(false);

  const query = trpcReact.platform.team.get.useQuery({
    teamId,
    asAt: asAt || undefined,
  });
  const people = trpcReact.platform.identity.listPersons.useQuery({ limit: 100 });

  const refresh = async () => {
    await Promise.all([
      utils.platform.team.get.invalidate(),
      utils.platform.team.list.invalidate(),
    ]);
  };

  const updateMutation = trpcReact.platform.team.update.useMutation({
    onSuccess: async () => {
      setEditOpen(false);
      await refresh();
    },
  });
  const addMemberMutation = trpcReact.platform.team.addMember.useMutation({
    onSuccess: async () => {
      setAddOpen(false);
      await refresh();
    },
  });
  const endMutation = trpcReact.platform.team.endMembership.useMutation({
    onSuccess: async () => {
      setEnding(null);
      await refresh();
    },
  });
  const correctMutation = trpcReact.platform.team.correctMembership.useMutation({
    onSuccess: async () => {
      setCorrecting(null);
      await refresh();
    },
  });
  const archiveMutation = trpcReact.platform.team.archive.useMutation({
    onSuccess: async () => {
      await utils.platform.team.list.invalidate();
      await navigate({ to: '/admin/teams' });
    },
  });

  const team = query.data?.team;
  const roster = query.data?.roster ?? [];
  const history = query.data?.history ?? [];
  const displayName = (personId: string) =>
    history.find((h) => h.person_id === personId)?.display_name ?? 'Unknown';

  const editForm = useForm({
    defaultValues: {
      name: '',
      description: '',
      managerPersonId: '',
      deputyPersonId: '',
      maxConcurrentLeave: '',
      colour: '',
    },
    validators: { onChange: editTeamFormSchema },
    onSubmit: async ({ value }) => {
      await updateMutation.mutateAsync({
        teamId,
        name: value.name,
        description: value.description || null,
        managerPersonId: value.managerPersonId,
        deputyPersonId: value.deputyPersonId || null,
        maxConcurrentLeave: value.maxConcurrentLeave ? Number(value.maxConcurrentLeave) : null,
        colour: value.colour || null,
      });
    },
  });

  const addForm = useForm({
    defaultValues: { personId: '', validFrom: todayIso() },
    validators: { onChange: addMemberFormSchema },
    onSubmit: async ({ value }) => {
      await addMemberMutation.mutateAsync({
        teamId,
        personId: value.personId,
        validFrom: value.validFrom,
      });
    },
  });

  const endForm = useForm({
    defaultValues: { validTo: todayIso() },
    validators: { onChange: endMembershipFormSchema },
    onSubmit: async ({ value }) => {
      if (!ending) return;
      await endMutation.mutateAsync({ membershipId: ending.id, validTo: value.validTo });
    },
  });

  const correctForm = useForm({
    defaultValues: { validFrom: '', validTo: '' },
    validators: { onChange: correctMembershipFormSchema },
    onSubmit: async ({ value }) => {
      if (!correcting) return;
      await correctMutation.mutateAsync({
        membershipId: correcting.id,
        validFrom: value.validFrom || undefined,
        validTo: value.validTo === '' ? null : value.validTo,
      });
    },
  });

  const openEdit = () => {
    updateMutation.reset();
    setEditOpen(true);
  };

  /**
   * Load the team into the edit form once the dialog is open. The form instance
   * is created at component level but its fields only mount with the modal, and
   * a reset issued before they mount is discarded when they read their defaults.
   */
  React.useEffect(() => {
    if (!editOpen || !team) return;
    editForm.reset({
      name: team.name,
      description: team.description ?? '',
      managerPersonId: team.manager_person_id,
      deputyPersonId: team.deputy_person_id ?? '',
      maxConcurrentLeave:
        team.max_concurrent_leave == null ? '' : String(team.max_concurrent_leave),
      colour: team.colour ?? '',
    });
    // Deliberately keyed on the dialog opening, not on `team`: the query returns
    // a fresh object on every refetch, and depending on it would clobber the
    // form while someone is typing in it.
  }, [editOpen]);

  /** Same reason as above — load the membership once its dialog is open. */
  React.useEffect(() => {
    if (!correcting) return;
    correctForm.reset({
      validFrom: correcting.valid_from,
      validTo: correcting.valid_to ?? '',
    });
  }, [correcting, correctForm]);

  if (query.error) {
    return (
      <div className="mx-auto max-w-[900px]">
        <Callout tone="danger" title="Couldn’t load this team">
          {query.error.message}
        </Callout>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <PageHeader
        title={team?.name ?? 'Team'}
        description={team?.description ?? undefined}
        meta={
          <Link
            to="/admin/teams"
            className="inline-flex items-center gap-1 font-sans text-sm text-muted transition-colors hover:text-body"
          >
            <ChevronLeft size={15} /> All teams
          </Link>
        }
        primaryAction={
          <>
            <Button variant="secondary" startIcon={<Pencil size={17} />} onClick={openEdit}>
              Edit
            </Button>
            <Button
              variant="ghost"
              startIcon={<Archive size={17} />}
              onClick={() => setArchiveOpen(true)}
            >
              Archive
            </Button>
          </>
        }
      />

      {/* Attributes */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Attribute
          label="Manager"
          value={team ? displayNameOf(team.manager_person_id, people) : '—'}
        />
        <Attribute
          label="Deputy"
          value={team?.deputy_person_id ? displayNameOf(team.deputy_person_id, people) : 'None'}
        />
        <Attribute
          label="Max off at once"
          value={
            team?.max_concurrent_leave == null ? 'No limit' : String(team.max_concurrent_leave)
          }
          hint="Advisory — warns the approver, never blocks."
        />
        <Attribute label="Members today" value={String(roster.length)} />
      </div>

      {/* Roster */}
      <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
          <div>
            <h2 className="font-sans text-sm font-bold tracking-tight text-strong">
              Roster{query.data?.asAt ? ` as at ${formatDay(query.data.asAt)}` : ''}
            </h2>
            <p className="mt-0.5 font-sans text-xs text-muted">
              Membership is dated, so this answers who was in the team on any date — not just today.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 font-sans text-sm text-muted">
              <CalendarClock size={16} />
              <span className="sr-only sm:not-sr-only">As at</span>
              <input
                type="date"
                value={asAt}
                onChange={(e) => setAsAt(e.target.value)}
                aria-label="Show the roster as at this date"
                className="h-9 rounded-md border border-border-default bg-surface-card px-2.5 font-sans text-sm text-body outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              />
            </label>
            {asAt && (
              <Button variant="ghost" size="sm" onClick={() => setAsAt('')}>
                Today
              </Button>
            )}
            <Button
              size="sm"
              startIcon={<UserPlus size={16} />}
              onClick={() => {
                addForm.reset();
                addMemberMutation.reset();
                setAddOpen(true);
              }}
            >
              Add a member
            </Button>
          </div>
        </div>

        {query.isLoading ? (
          <p className="px-4 py-10 text-center font-sans text-sm text-muted">Loading roster…</p>
        ) : roster.length === 0 ? (
          <p className="px-4 py-10 text-center font-sans text-sm text-muted">
            Nobody was in this team on that date.
          </p>
        ) : (
          <ul>
            {roster.map((member) => (
              <li
                key={member.id}
                className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-3 last:border-0"
              >
                <div className="min-w-[220px] flex-1">
                  <PersonCell
                    name={member.display_name}
                    secondary={RELATIONSHIP_LABELS[member.relationship_type as RelationshipType]}
                  />
                </div>
                <span className="font-mono text-sm text-muted">
                  {formatDay(member.valid_from)} → {formatDay(member.valid_to, 'current')}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    startIcon={<Pencil size={15} />}
                    onClick={() => {
                      correctMutation.reset();
                      setCorrecting(member);
                    }}
                  >
                    Correct dates
                  </Button>
                  {member.valid_to === null && (
                    <Button
                      variant="ghost"
                      size="sm"
                      startIcon={<UserMinus size={15} />}
                      onClick={() => {
                        endForm.reset();
                        endMutation.reset();
                        setEnding(member);
                      }}
                    >
                      End
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Full membership history — the editor must reach rows that are not
          active today, which the as-at roster by definition excludes. */}
      {history.length > roster.length && (
        <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface-card">
          <div className="border-b border-border-subtle px-4 py-3">
            <h2 className="font-sans text-sm font-bold tracking-tight text-strong">
              Membership history
            </h2>
            <p className="mt-0.5 font-sans text-xs text-muted">
              Every spell, including ended ones. Memberships are ended or corrected — never deleted.
            </p>
          </div>
          <ul>
            {history.map((row) => {
              const current = row.valid_to === null;
              return (
                <li
                  key={row.id}
                  className={cn(
                    'flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-2.5 last:border-0',
                    !current && 'text-muted',
                  )}
                >
                  <span className="min-w-[200px] flex-1 font-sans text-sm text-body">
                    {row.display_name}
                  </span>
                  <span className="font-mono text-sm text-muted">
                    {formatDay(row.valid_from)} → {formatDay(row.valid_to, 'current')}
                  </span>
                  <StatusPill tone={current ? 'success' : 'neutral'}>
                    {current ? 'Current' : 'Ended'}
                  </StatusPill>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Edit team */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit team"
        description="Changes to the manager, deputy and capacity are recorded in the audit trail."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <editForm.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button
                  onClick={() => void editForm.handleSubmit()}
                  disabled={!canSubmit || isSubmitting}
                >
                  {isSubmitting ? 'Saving…' : 'Save changes'}
                </Button>
              )}
            </editForm.Subscribe>
          </div>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void editForm.handleSubmit();
          }}
        >
          {updateMutation.error && (
            <Callout tone="danger" title="Couldn’t save the team">
              {updateMutation.error.message}
            </Callout>
          )}

          <editForm.Field name="name">
            {(field) => (
              <Field label="Team name" htmlFor={field.name} required>
                <Input
                  id={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </editForm.Field>

          <editForm.Field name="description">
            {(field) => (
              <Field label="Description" htmlFor={field.name}>
                <Textarea
                  id={field.name}
                  rows={2}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </editForm.Field>

          <editForm.Field name="managerPersonId">
            {(field) => (
              <Field label="Manager" htmlFor={field.name} required>
                <Select
                  id={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                >
                  {(people.data?.items ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.display_name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </editForm.Field>

          <editForm.Field name="deputyPersonId">
            {(field) => (
              <Field
                label="Deputy"
                htmlFor={field.name}
                hint="Must be someone other than the manager."
              >
                <Select
                  id={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                >
                  <option value="">No deputy</option>
                  {(people.data?.items ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.display_name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </editForm.Field>

          <div className="flex flex-wrap gap-4">
            <editForm.Field name="maxConcurrentLeave">
              {(field) => (
                <Field
                  label="Max off at once"
                  htmlFor={field.name}
                  hint="Advisory — warns the approver, never blocks a booking."
                >
                  <Input
                    id={field.name}
                    type="number"
                    min={1}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="No limit"
                    className="w-32 font-mono"
                  />
                </Field>
              )}
            </editForm.Field>

            <editForm.Field name="colour">
              {(field) => (
                <Field label="Calendar colour" htmlFor={field.name}>
                  <input
                    id={field.name}
                    type="color"
                    value={field.state.value || '#1e7e34'}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    className="h-10 w-16 cursor-pointer rounded-md border-[1.5px] border-border-default bg-surface-card p-1"
                  />
                </Field>
              )}
            </editForm.Field>
          </div>
        </form>
      </Modal>

      {/* Add member */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add a member"
        description="From the date they join. Someone can leave and rejoin — each spell is recorded separately."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <addForm.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button
                  onClick={() => void addForm.handleSubmit()}
                  disabled={!canSubmit || isSubmitting}
                >
                  {isSubmitting ? 'Adding…' : 'Add member'}
                </Button>
              )}
            </addForm.Subscribe>
          </div>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void addForm.handleSubmit();
          }}
        >
          {addMemberMutation.error && (
            <Callout tone="danger" title="Couldn’t add that member">
              {addMemberMutation.error.message}
            </Callout>
          )}

          <addForm.Field name="personId">
            {(field) => (
              <Field label="Person" htmlFor={field.name} required>
                <Select
                  id={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                >
                  <option value="">Choose a person</option>
                  {(people.data?.items ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.display_name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </addForm.Field>

          <addForm.Field name="validFrom">
            {(field) => (
              <Field label="Member from" htmlFor={field.name} required>
                <Input
                  id={field.name}
                  type="date"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  className="w-48"
                />
              </Field>
            )}
          </addForm.Field>
        </form>
      </Modal>

      {/* End membership */}
      <Modal
        open={ending !== null}
        onClose={() => setEnding(null)}
        title="End this membership"
        description="They stop being a member ON this date, so someone else can start the same day with no overlap."
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEnding(null)}>
              Cancel
            </Button>
            <endForm.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button
                  onClick={() => void endForm.handleSubmit()}
                  disabled={!canSubmit || isSubmitting}
                >
                  {isSubmitting ? 'Ending…' : 'End membership'}
                </Button>
              )}
            </endForm.Subscribe>
          </div>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void endForm.handleSubmit();
          }}
        >
          {endMutation.error && (
            <Callout tone="danger" title="Couldn’t end the membership">
              {endMutation.error.message}
            </Callout>
          )}
          {ending && (
            <p className="font-sans text-sm text-body">
              <span className="font-semibold text-strong">{displayName(ending.person_id)}</span>, a
              member since {formatDay(ending.valid_from)}.
            </p>
          )}
          <endForm.Field name="validTo">
            {(field) => (
              <Field label="Last day in the team is the day before" htmlFor={field.name} required>
                <Input
                  id={field.name}
                  type="date"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  className="w-48"
                />
              </Field>
            )}
          </endForm.Field>
        </form>
      </Modal>

      {/* Correct membership dates */}
      <Modal
        open={correcting !== null}
        onClose={() => setCorrecting(null)}
        title="Correct the dates"
        description="For fixing a mistake. This is recorded separately from ending a membership, because it moves a boundary other records may already have been read against."
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCorrecting(null)}>
              Cancel
            </Button>
            <correctForm.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button
                  onClick={() => void correctForm.handleSubmit()}
                  disabled={!canSubmit || isSubmitting}
                >
                  {isSubmitting ? 'Saving…' : 'Save dates'}
                </Button>
              )}
            </correctForm.Subscribe>
          </div>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void correctForm.handleSubmit();
          }}
        >
          {correctMutation.error && (
            <Callout tone="danger" title="Couldn’t correct the dates">
              {correctMutation.error.message}
            </Callout>
          )}
          <correctForm.Field name="validFrom">
            {(field) => (
              <Field label="Member from" htmlFor={field.name}>
                <Input
                  id={field.name}
                  type="date"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  className="w-48"
                />
              </Field>
            )}
          </correctForm.Field>
          <correctForm.Field name="validTo">
            {(field) => (
              <Field
                label="Until"
                htmlFor={field.name}
                hint="Leave empty for an open-ended member."
              >
                <Input
                  id={field.name}
                  type="date"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  className="w-48"
                />
              </Field>
            )}
          </correctForm.Field>
        </form>
      </Modal>

      {/* Archive */}
      <Modal
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        title="Archive this team?"
        description="Open memberships are end-dated at the same time, and the name becomes free to reuse. Nothing is deleted."
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setArchiveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={archiveMutation.isPending}
              onClick={() => archiveMutation.mutate({ teamId })}
            >
              {archiveMutation.isPending ? 'Archiving…' : 'Archive team'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          {archiveMutation.error && (
            <Callout tone="danger" title="Couldn’t archive the team">
              {archiveMutation.error.message}
            </Callout>
          )}
          <p className="font-sans text-sm text-body">
            Its manager and deputy stop being able to see the team’s records — archiving a team
            withdraws the access it conferred.
          </p>
        </div>
      </Modal>
    </div>
  );
}

function Attribute({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-surface-card p-4">
      <span className="font-sans text-2xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </span>
      <span className="font-sans text-md font-semibold text-strong">{value}</span>
      {hint && <span className="font-sans text-xs text-muted">{hint}</span>}
    </div>
  );
}

/** Resolve a person id to a display name from the already-loaded picker pool. */
function displayNameOf(
  personId: string,
  people: { data?: { items: { id: string; display_name: string }[] } },
): string {
  return people.data?.items.find((p) => p.id === personId)?.display_name ?? '—';
}
