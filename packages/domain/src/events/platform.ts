import { z } from 'zod';
import { defineEvent } from './define.js';

/**
 * Event types owned by the `platform` module (core plan 02 §4.2). Payload keys
 * are camelCase, PII-minimal (ADR-0019/0021): surrogate IDs, deltas and
 * decisions — never names, emails or special-category detail. Schemas are
 * strict, so an accidental profile-row spread is rejected at validation.
 *
 * Later plans register their own module's event types the same way (03 identity,
 * 06 config, 11 documents, 16 migration, …) and add them to `eventTypes`.
 */

/**
 * The pilot slice's demo event (§4.2). Emitted by `platform.journal.demoPing`,
 * relayed, and consumed by the `pilot-demo` subscription — the end-to-end smoke
 * probe of the rail. `note` is a short free-text string; nothing PII-bearing.
 */
export const platformDemoPinged = defineEvent(
  'platform.demo.pinged',
  1,
  z.strictObject({ note: z.string().max(200) }),
);

// --- Identity & person model (core plan 03, PL-045, kind='security') ---------
//
// Every identity lifecycle fact is a `kind='security'` event on
// `stream_type='platform.person'`, `stream_id=<person id>`, emitted in the same
// transaction as its state change (ADR-0010). `stream_id` and the actor are
// carried by the envelope, so payloads never repeat them — they hold only the
// *other* party, deltas, codes and the actor's audit rationale. Names, emails
// and DoB never appear (ADR-0019); the enum literals are inlined (never imported
// from `@repo/trpc` — circular) exactly as the CHECK constraints restate them.

const relationshipTypeValues = z.enum([
  'employee',
  'agency',
  'subcontractor',
  'self_employed',
  'external_org_employee',
  'candidate',
]);
const profileStatusValues = z.enum([
  'draft_shell',
  'information_requested',
  'information_submitted',
  'pending_review',
  'incomplete_rejected',
  'approved_not_active',
  'active',
  'active_with_restrictions',
  'inactive',
  'leaver',
  'reactivated',
]);
const flagTypeValues = z.enum(['do_not_rehire', 'safeguarding', 'safety', 'other']);
const duplicateReasonValues = z.enum(['name_dob', 'agency_ref']);
/** Admin-entered audit rationale — the actor's own words, never profile data. */
const reason = z.string().min(1).max(2000);

/** A person row was created — via invitation, first Entra SSO, or admin/migration. */
export const platformPersonCreated = defineEvent(
  'platform.person.created',
  1,
  z.strictObject({
    relationshipType: relationshipTypeValues,
    via: z.enum(['invitation', 'first_sso', 'admin', 'migration']),
  }),
);

/** An invitation was issued/re-issued: a linked login was pre-provisioned (PL-036). */
export const platformPersonInvited = defineEvent(
  'platform.person.invited',
  1,
  z.strictObject({ reinvited: z.boolean() }),
);

/** A Better Auth account was attached to a user of this person (PL-035). */
export const platformPersonCredentialLinked = defineEvent(
  'platform.person.credential_linked',
  1,
  // The subject is hashed — the raw issuer subject is never journalled.
  z.strictObject({ providerId: z.string().max(100), subjectHash: z.string().max(128) }),
);

/** A successful sign-in resolved to this person. */
export const platformPersonSignedIn = defineEvent(
  'platform.person.signed_in',
  1,
  z.strictObject({ providerId: z.string().max(100) }),
);

/** An advisory duplicate signal was raised against another person (PL-037). */
export const platformPersonDuplicateFlagged = defineEvent(
  'platform.person.duplicate_flagged',
  1,
  z.strictObject({
    otherPersonId: z.uuid(),
    reasons: z.array(duplicateReasonValues).min(1),
  }),
);

/** An admin marked a pair "not a duplicate" — excluded from future signals. */
export const platformPersonDuplicateDismissed = defineEvent(
  'platform.person.duplicate_dismissed',
  1,
  z.strictObject({ otherPersonId: z.uuid() }),
);

/** A merge executed; this stream is the surviving person (PL-038). */
export const platformPersonMerged = defineEvent(
  'platform.person.merged',
  1,
  z.strictObject({
    mergeId: z.uuid(),
    supersededPersonId: z.uuid(),
    movedUserIds: z.array(z.string().max(255)),
    copiedFlagIds: z.array(z.uuid()),
  }),
);

/** A merge was reversed (PL-039). */
export const platformPersonMergeReversed = defineEvent(
  'platform.person.merge_reversed',
  1,
  z.strictObject({ mergeId: z.uuid(), supersededPersonId: z.uuid() }),
);

/** A safeguarding flag was raised (PL-040). */
export const platformPersonFlagAdded = defineEvent(
  'platform.person.flag_added',
  1,
  z.strictObject({ flagId: z.uuid(), flagType: flagTypeValues }),
);

/** A safeguarding flag was explicitly closed out (PL-040). */
export const platformPersonFlagEnded = defineEvent(
  'platform.person.flag_ended',
  1,
  z.strictObject({ flagId: z.uuid(), flagType: flagTypeValues }),
);

/** The external access window was set or extended (PL-042). */
export const platformPersonAccessExpirySet = defineEvent(
  'platform.person.access_expiry_set',
  1,
  z.strictObject({ accessValidUntil: z.iso.datetime() }),
);

/** The expiry job disabled sign-in for this person (PL-042); plan 04 revokes grants. */
export const platformPersonAccessExpired = defineEvent(
  'platform.person.access_expired',
  1,
  z.strictObject({}),
);

/** An expired external was reactivated against the same person (PL-042). */
export const platformPersonReengaged = defineEvent(
  'platform.person.reengaged',
  1,
  z.strictObject({ accessValidUntil: z.iso.datetime() }),
);

/** A profile-status transition — the CORE-01 history record. */
export const platformPersonProfileStatusChanged = defineEvent(
  'platform.person.profile_status_changed',
  1,
  z.strictObject({ from: profileStatusValues, to: profileStatusValues, reason }),
);

/** A relationship transition, incl. non-employee→employee conversion (PL-046/047). */
export const platformPersonRelationshipChanged = defineEvent(
  'platform.person.relationship_changed',
  1,
  z.strictObject({
    from: relationshipTypeValues,
    to: relationshipTypeValues,
    via: z.enum(['conversion', 'admin']),
    reason,
  }),
);

/** An authorised user created a person despite candidate matches (PL-047). */
export const platformPersonPrecreationCheckOverridden = defineEvent(
  'platform.person.precreation_check_overridden',
  1,
  z.strictObject({ candidatePersonIds: z.array(z.uuid()).min(1), reason }),
);

// --- Authorisation (core plan 04, PL-002/003, CORE-05, kind='security') ------
//
// Grant/revoke stream on ('platform.role_grant', grant_id) and allocation
// changes on ('platform.person_allocation', allocation_id) — so the stream is
// the thing whose lifecycle is being recorded, and `personId` in the payload
// identifies the *subject* (the envelope's actor is the granter). Payload keys
// are camelCase, matching the rest of the registry; §4.2 of the plan sketched
// them snake_case, which would have been the only snake_case payload in the
// system. Special-category read events carry field NAMES only — never values
// (ADR-0015/0019).

const roleKeyValues = z.enum([
  'administrator',
  'hr_user',
  'line_manager',
  'finance',
  'it',
  'transport',
  'office_admin',
  'director',
  'employee',
  'external',
  'external_administrator',
]);
const moduleKeyValues = z.enum([
  'platform',
  'hr.core',
  'hr.onboarding',
  'hr.holiday_leave',
  'hr.sickness_absence',
  'hr.er',
  'hr.ld',
  'hr.offboarding',
  'hr.wellbeing',
  'hr.reporting',
]);

/** A role was granted to a person in one module (PL-002). */
export const platformRoleGranted = defineEvent(
  'platform.role.granted',
  1,
  z.strictObject({
    personId: z.uuid(),
    roleKey: roleKeyValues,
    module: moduleKeyValues,
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime().nullable(),
  }),
);

/**
 * A grant was revoked — manually, or by plan 03's expiry sweep with
 * `revokeReason='expired'` (PL-002, PL-042). Grants are never un-revoked;
 * re-engagement appends a new grant row and a new `granted` event.
 */
export const platformRoleRevoked = defineEvent(
  'platform.role.revoked',
  1,
  z.strictObject({
    personId: z.uuid(),
    roleKey: roleKeyValues,
    module: moduleKeyValues,
    revokeReason: z.string().min(1).max(500),
  }),
);

/**
 * A procedure returned special-category fields to a reader (ADR-0015; consumed
 * by plan 13's audit view). The stream is the SUBJECT entity, not the reader.
 * `fields` holds column names only — a value here would defeat the purpose.
 */
export const platformDataSpecialCategoryAccessed = defineEvent(
  'platform.data.special_category.accessed',
  1,
  z.strictObject({
    entity: z.string().max(100),
    fields: z.array(z.string().max(100)).min(1),
    readerPersonId: z.uuid(),
    procedure: z.string().max(200),
  }),
);

/** A person was allocated to a restricted external administrator (CORE-05). */
export const platformPersonAllocationAdded = defineEvent(
  'platform.person.allocation_added',
  1,
  z.strictObject({
    adminPersonId: z.uuid(),
    personId: z.uuid(),
    validUntil: z.iso.datetime().nullable(),
  }),
);

/** An allocation was ended — visibility closes, the row survives (CORE-05). */
export const platformPersonAllocationEnded = defineEvent(
  'platform.person.allocation_ended',
  1,
  z.strictObject({
    adminPersonId: z.uuid(),
    personId: z.uuid(),
    endReason: z.string().min(1).max(500),
  }),
);

// --- Reference-data service (core plan 05, ADR-0016, kind='admin') -----------
//
// Reference-data maintenance is administrative configuration of the system, so
// every write journals a `kind='admin'` event in the same transaction as its
// state change (ADR-0010/0016; PL-028/PL-030 pattern). Payloads carry ids,
// codes, labels and deltas only — a team's manager and deputy appear as
// surrogate person IDs, never as names (ADR-0019).
//
// As everywhere in this file, `stream_id` and the actor are carried by the
// envelope and never repeated in the payload. Memberships stream under their
// TEAM (§4.2), so membership payloads name the membership and the person but
// not the team.

const lookupListTypeValues = z.enum([
  'department',
  'job_role',
  'document_category',
  'sickness_type',
  'ppe_type',
  'leaver_reason',
  'equipment_type',
]);

/** An old→new pair for one changed field. */
const delta = <T extends z.ZodTypeAny>(value: T) => z.strictObject({ from: value, to: value });

const lookupLabel = z.string().min(1).max(200);
const lookupDescription = z.string().max(1000).nullable();
const lookupCode = z.string().max(64);

/** A Tier 1 value was added — data entry, no release (PL-005b, AC-D1). */
export const platformLookupValueCreated = defineEvent(
  'platform.lookup.value.created',
  1,
  z.strictObject({
    listType: lookupListTypeValues,
    code: lookupCode,
    label: lookupLabel,
    sortOrder: z.number().int(),
  }),
);

/**
 * A value's display attributes changed. `code` is immutable (§4.1.1), so it
 * appears here to identify the value, never as a delta — an event carrying a
 * code change would mean the immutability guard had been bypassed.
 */
export const platformLookupValueUpdated = defineEvent(
  'platform.lookup.value.updated',
  1,
  z.strictObject({
    listType: lookupListTypeValues,
    code: lookupCode,
    label: delta(lookupLabel).optional(),
    description: delta(lookupDescription).optional(),
    sortOrder: delta(z.number().int()).optional(),
  }),
);

/** A value was retired: hidden from pickers, still resolvable in history (PL-007). */
export const platformLookupValueDeactivated = defineEvent(
  'platform.lookup.value.deactivated',
  1,
  z.strictObject({ listType: lookupListTypeValues, code: lookupCode }),
);

/** A retired value was brought back into use (PL-007). */
export const platformLookupValueReactivated = defineEvent(
  'platform.lookup.value.reactivated',
  1,
  z.strictObject({ listType: lookupListTypeValues, code: lookupCode }),
);

/**
 * A never-referenced value was soft-deleted — the mistake path, not the
 * retirement path. `(list_type, code)` uniqueness includes deleted rows, so the
 * code cannot be silently reused with a different meaning.
 */
export const platformLookupValueDeleted = defineEvent(
  'platform.lookup.value.deleted',
  1,
  z.strictObject({ listType: lookupListTypeValues, code: lookupCode }),
);

const teamName = z.string().min(1).max(200);
const teamDescription = z.string().max(1000).nullable();
const teamColour = z.string().max(7).nullable();
const teamCapacity = z.number().int().nullable();

/** A Tier 3 team was created (PL-005d/e). */
export const platformTeamCreated = defineEvent(
  'platform.team.created',
  1,
  z.strictObject({
    name: teamName,
    managerPersonId: z.uuid(),
    deputyPersonId: z.uuid().nullable(),
    maxConcurrentLeave: teamCapacity,
  }),
);

/**
 * Team attributes changed. Manager, deputy and capacity are current-state
 * columns rather than effective-dated rows (§4.1.2), so this event IS their
 * history — every delta that matters to a later "who was the approver?" question
 * has to be here.
 */
export const platformTeamUpdated = defineEvent(
  'platform.team.updated',
  1,
  z.strictObject({
    name: delta(teamName).optional(),
    description: delta(teamDescription).optional(),
    managerPersonId: delta(z.uuid()).optional(),
    deputyPersonId: delta(z.uuid().nullable()).optional(),
    maxConcurrentLeave: delta(teamCapacity).optional(),
    colour: delta(teamColour).optional(),
  }),
);

/** A team was archived (soft delete); its open memberships end-date with it. */
export const platformTeamArchived = defineEvent(
  'platform.team.archived',
  1,
  z.strictObject({ name: teamName, endedMembershipIds: z.array(z.uuid()) }),
);

/** A person joined a team, effective from a business date (PL-007a). */
export const platformTeamMembershipAdded = defineEvent(
  'platform.team.membership.added',
  1,
  z.strictObject({
    membershipId: z.uuid(),
    personId: z.uuid(),
    validFrom: z.iso.date(),
  }),
);

/** A membership was end-dated. Half-open: the person is out ON `validTo`. */
export const platformTeamMembershipEnded = defineEvent(
  'platform.team.membership.ended',
  1,
  z.strictObject({
    membershipId: z.uuid(),
    personId: z.uuid(),
    validTo: z.iso.date(),
  }),
);

/**
 * A membership's dates were corrected retroactively — the typo path, distinct
 * from ending. Kept separate precisely because it moves a boundary other records
 * may already have been read against, so it must be visibly different in the
 * audit trail.
 */
export const platformTeamMembershipCorrected = defineEvent(
  'platform.team.membership.corrected',
  1,
  z.strictObject({
    membershipId: z.uuid(),
    personId: z.uuid(),
    validFrom: delta(z.iso.date()).optional(),
    validTo: delta(z.iso.date().nullable()).optional(),
  }),
);

// --- Configuration store (core plan 06, PL-029/030, kind='admin') ------------
//
// Changing a decision point is administrative configuration of the system, so
// both events are `kind='admin'` on `stream_type='platform.config_entry'`,
// appended in the same transaction as the supersede (ADR-0010, PL-030). Plan
// 13's audit view renders them as "who changed what, when".
//
// **Values travel in the payload, and that is safe by construction.** ADR-0019
// bans personal data from payloads; §4.5 of the plan bans it from config values
// in the first place — a value may hold thresholds, cadences, role codes and
// dates, never a person. So carrying old and new here makes the audit view
// self-contained without a second read, and the registry's `sensitiveValue`
// flag exists to suppress them should an exception ever be justified.
//
// The name is `platform.config_entry.*`, not `platform.config.*` as the plan's
// §4.2 first sketched: ADR-0021 derives the entity segment from the table, and
// `stream_type` is the `<module>.<entity>` prefix of the event type — a
// `platform.config.changed` on `stream_type='platform.config_entry'` would be
// the one place in the system where those two disagreed (write-back 2026-08-05).

const configNamespace = z.string().max(200);
const configKeyName = z.string().max(100);
/** A config value: any JSON the key's registered Zod schema accepts. */
const configValue = z.json();

/**
 * A key's value was set or superseded. `fromVersion` is null on the first-ever
 * entry for a key, where the predecessor is the frozen code default rather than
 * a row — which is exactly the distinction the audit view needs to render
 * "default → 45" differently from "90 → 45".
 */
export const platformConfigEntryChanged = defineEvent(
  'platform.config_entry.changed',
  1,
  z.strictObject({
    namespace: configNamespace,
    key: configKeyName,
    fromVersion: z.number().int().nullable(),
    toVersion: z.number().int(),
    oldValue: configValue.optional(),
    newValue: configValue.optional(),
    validFrom: z.iso.datetime(),
  }),
);

/**
 * A key was reverted to its registered code default: the open row was closed
 * with no successor. Distinct from `changed` because there is no successor
 * version to point at, and because "reverted to default" is the fact an auditor
 * is looking for — reconstructing it from an absence of rows would not do.
 */
export const platformConfigEntryReset = defineEvent(
  'platform.config_entry.reset',
  1,
  z.strictObject({
    namespace: configNamespace,
    key: configKeyName,
    closedVersion: z.number().int(),
    oldValue: configValue.optional(),
    defaultValue: configValue.optional(),
  }),
);

// --- Workflow runtime & scheduled actions (core plan 07, ADR-0013) -----------
//
// Every state change a workflow makes is journalled in the same transaction as
// the state write (ADR-0010), which is what makes the runtime auditable, the
// module-decoupling rail real, and the reporting feed complete.
//
// **The generic events stream on the instance, not on the subject** — that is a
// correction to the plan's §4.2, made in build. ADR-0021 fixes `stream_type` as
// the event type's `<module>.<entity>` prefix, so a `platform.workflow.*` type
// journalled against `stream_type='hr.leave_booking'` would break the one
// pairing rule the grammar exists to guarantee. Instead:
//
//  - the **generic** types are `platform.workflow_instance.*` on
//    `stream_type='platform.workflow_instance'`, `stream_id=<instance id>`, and
//    carry the subject as payload fields so consumers can still fan out by it;
//  - a definition that wants the fact to land on the subject's own timeline
//    declares `emits` (e.g. `hr.leave_booking.approved`), and the runtime
//    enforces that the declared type's `<module>.<entity>` prefix equals the
//    instance's `subject_stream_type` — so the ADR-0021 pairing holds there too,
//    by construction rather than by convention.
//
// Payloads carry ids, keys and state names only. A definition or effect whose
// params embed subject profile data is a review-blocking defect (ADR-0019), and
// the strict schemas here are the structural half of that rule.

/** A journal stream name, `<module>.<entity>` (ADR-0021). */
const streamTypeName = z.string().max(100);
/** An effect fanned onto the `effects` queue — registry name plus ids-only params. */
const effectRef = z.strictObject({
  name: z.string().min(1).max(100),
  params: z.record(z.string(), z.json()).optional(),
});

/**
 * The payload shape shared by the generic `transitioned` event and by every
 * domain-specific `emits` override (§4.2: "the same payload shape, instead of
 * the generic type"). Exported so a consuming plan registers its override with
 * this schema rather than inventing a divergent one — and so the outbox relay
 * can read `payload.effects` from any of them (§5.4).
 */
export const workflowTransitionedPayload = z.strictObject({
  /**
   * The `platform.workflow_transition` row this event records. Present because
   * the relay derives the effect messages' deterministic `MessageId` and their
   * idempotency root from it (§5.4) — and because it lets a subscriber fetch the
   * guard results and resolved config behind the decision.
   */
  transitionId: z.uuid(),
  /**
   * The instance. Redundant with `stream_id` on the generic event, but not on an
   * `emits` override, where the stream is the subject.
   */
  instanceId: z.uuid(),
  workflowKey: z.string().max(200),
  definitionVersion: z.number().int().min(1),
  subjectStreamType: streamTypeName,
  subjectStreamId: z.uuid(),
  from: z.string().max(100),
  to: z.string().max(100),
  action: z.string().max(100),
  /** Names of the soft guards that warned; details live on the transition row. */
  guardWarnings: z.array(z.string().max(100)),
  /** What the relay fans onto the `effects` queue (§5.4). */
  effects: z.array(effectRef),
  /** True when `to` is terminal — the instance completed with this transition. */
  completed: z.boolean(),
});

/** An instance was created and entered its initial state. */
export const platformWorkflowInstanceStarted = defineEvent(
  'platform.workflow_instance.started',
  1,
  z.strictObject({
    workflowKey: z.string().max(200),
    definitionVersion: z.number().int().min(1),
    subjectStreamType: streamTypeName,
    subjectStreamId: z.uuid(),
    initialState: z.string().max(100),
  }),
);

/**
 * A named transition was taken. The default event for every transition whose
 * definition declares no `emits` override — one event per transition, never two.
 */
export const platformWorkflowInstanceTransitioned = defineEvent(
  'platform.workflow_instance.transitioned',
  1,
  workflowTransitionedPayload,
);

/**
 * A timer was created. Journalled so the activity trail explains *why* something
 * fired later, which a `scheduled_action` row alone cannot (it is mutable
 * operational state — ADR-0012 puts its history here).
 */
export const platformScheduledActionScheduled = defineEvent(
  'platform.scheduled_action.scheduled',
  1,
  z.strictObject({
    actionType: z.string().max(200),
    dueAt: z.iso.datetime(),
    workflowInstanceId: z.uuid().nullable(),
    subjectStreamType: streamTypeName.nullable(),
    subjectStreamId: z.uuid().nullable(),
    source: z.enum(['workflow', 'manual', 'system']),
  }),
);

/**
 * A pending timer's due date was amended. Not in the plan's §4.2 list, but
 * AC-D9 requires both admin timer actions — cancel *and* reschedule — to be
 * journalled, and re-emitting `scheduled` would assert a timer was created when
 * one was moved. `from`/`to` carry the whole change, so the audit view needs no
 * second read.
 */
export const platformScheduledActionRescheduled = defineEvent(
  'platform.scheduled_action.rescheduled',
  1,
  z.strictObject({
    actionType: z.string().max(200),
    fromDueAt: z.iso.datetime(),
    toDueAt: z.iso.datetime(),
    workflowInstanceId: z.uuid().nullable(),
  }),
);

/**
 * A pending timer was cancelled — by an administrator, or automatically when the
 * instance reached a terminal state (the "a human got there before the chaser"
 * case, §5.2 step 6).
 *
 * There is no matching `executed` event by design: the effect a timer fires
 * produces its own business fact, and journalling the mechanics as well would
 * double-count it in the activity trail. `executed_at` on the row records it.
 */
export const platformScheduledActionCancelled = defineEvent(
  'platform.scheduled_action.cancelled',
  1,
  z.strictObject({
    actionType: z.string().max(200),
    reason: z.string().min(1).max(500),
    workflowInstanceId: z.uuid().nullable(),
  }),
);

/**
 * The pilot slice's effect fact (core plan 07 §4.3). `demo.recordOutcome` is the
 * one effect plan 07 ships, and this is the observable thing it does — so the
 * end-to-end test can assert that a message delivered twice produces exactly one
 * business fact (AC-D6), which is the property every effect a later plan
 * registers must also have.
 *
 * Demo-only: it retires with the `platform.demo.request` shape, and no
 * production consumer should ever subscribe to it.
 */
export const platformWorkflowInstanceDemoOutcomeRecorded = defineEvent(
  'platform.workflow_instance.demo_outcome_recorded',
  1,
  z.strictObject({ outcome: z.enum(['approved', 'rejected', 'expired']) }),
);

// --- Task & checklist engine (core plan 08 §4.2, PL-013…015) ----------------
//
// Every task fact is journalled on the **task's own row**
// (`stream_type='platform.task'`, `stream_id=<task id>`), with the case it
// belongs to travelling as `caseStreamType`/`caseStreamId` in the payload —
// exactly the correction plan 07 made for `platform.workflow_instance.*`
// (ADR-0021: `stream_type` is the event type's `<module>.<entity>` prefix, and
// the plan's original "stream = the case" pairing would have been the only place
// in the system where the two disagreed). A case's trail stays one indexed query:
// find the case's task ids, then read their streams.
//
// The single exception is `platform.task.gate.opened`, which is journalled on
// the **case** stream — see its own note.
//
// Payloads carry ids, keys and decisions. **No titles, no descriptions, no
// names** (ADR-0019): a task's title is instruction text authored by a raising
// definition, and the moment one is copied into a payload the journal starts
// accumulating free text nobody classified.

/** The case a task belongs to — the raising module's stream, not this one's. */
const caseStream = {
  caseStreamType: streamTypeName,
  caseStreamId: z.uuid(),
};

/** What a dependency waits on: another task, or a named gate on the case. */
const blockerRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('task'), taskId: z.uuid() }),
  z.strictObject({ kind: z.literal('gate'), gateKey: z.string().min(1).max(100) }),
]);

/**
 * A task was created — by a workflow effect (`tasks.raiseList`) or by hand.
 *
 * `initialStatus` and `blockedBy` are here because "why did this land blocked?"
 * is the first question anyone asks of a stuck case, and answering it from the
 * trail alone means not having to reconstruct the dependency rows as they stood
 * at raise time.
 */
export const platformTaskRaised = defineEvent(
  'platform.task.raised',
  1,
  z.strictObject({
    ...caseStream,
    assigneeRoleId: z.uuid(),
    lane: z.string().max(100).nullable(),
    dueMode: z.enum(['none', 'absolute', 'anchor_relative']),
    dueAt: z.iso.datetime().nullable(),
    anchorName: z.string().max(100).nullable(),
    anchorOffsetDays: z.number().int().nullable(),
    source: z.enum(['workflow', 'manual']),
    sourceRef: z.string().max(200).nullable(),
    workflowInstanceId: z.uuid().nullable(),
    initialStatus: z.enum(['blocked', 'open']),
    /** The unsatisfied edges at raise time; empty when the task started open. */
    blockedBy: z.array(blockerRef),
  }),
);

/**
 * A task's last unsatisfied dependency cleared: `blocked → open`.
 *
 * Emitted once per task per unblocking, in the same transaction as the
 * completion or gate opening that caused it — so "work became actionable" is a
 * fact with a cause, not something inferred by diffing two reads.
 */
export const platformTaskUnblocked = defineEvent(
  'platform.task.unblocked',
  1,
  z.strictObject({
    ...caseStream,
    assigneeRoleId: z.uuid(),
    /** The edge whose satisfaction was the last one outstanding. */
    satisfiedBy: blockerRef,
  }),
);

/** Someone in the assignee role took the task to work on. Metadata, not state. */
export const platformTaskClaimed = defineEvent(
  'platform.task.claimed',
  1,
  z.strictObject({ ...caseStream, assigneeRoleId: z.uuid() }),
);

/** A claim was given up — the task returns to the role's shared pool. */
export const platformTaskReleased = defineEvent(
  'platform.task.released',
  1,
  z.strictObject({ ...caseStream, assigneeRoleId: z.uuid() }),
);

/**
 * A task was completed. `noteProvided` rather than the note itself: completion
 * notes are free text a user typed, and the journal records that one exists and
 * where to find it (ADR-0019).
 *
 * `override` marks an HR/Administrator completion of a task assigned to a role
 * they do not hold — the envelope's `on_behalf_of` says for whom.
 */
export const platformTaskCompleted = defineEvent(
  'platform.task.completed',
  1,
  z.strictObject({
    ...caseStream,
    assigneeRoleId: z.uuid(),
    noteProvided: z.boolean(),
    override: z.boolean(),
    /** Overdue at the moment of completion — the reporting feed's raw material. */
    overdue: z.boolean(),
    /** Tasks this completion unblocked, each with its own `unblocked` event. */
    unblockedTaskIds: z.array(z.uuid()),
  }),
);

/**
 * A task was cancelled. A cancelled prerequisite satisfies its reverse edges
 * (§4.1) — otherwise its dependents would wait for something that will never
 * happen — so this event carries what it unblocked, like completion does.
 */
export const platformTaskCancelled = defineEvent(
  'platform.task.cancelled',
  1,
  z.strictObject({
    ...caseStream,
    assigneeRoleId: z.uuid(),
    /** Short operator rationale. Content rule §8: never special-category detail. */
    reason: z.string().min(1).max(500),
    unblockedTaskIds: z.array(z.uuid()),
  }),
);

/**
 * An anchor moved and the task's due date was re-resolved (PL-013). Only
 * non-terminal anchor-relative tasks whose date actually changed emit this — a
 * recomputation that lands on the same instant is not a fact.
 */
export const platformTaskDueRecomputed = defineEvent(
  'platform.task.due_recomputed',
  1,
  z.strictObject({
    ...caseStream,
    anchorName: z.string().max(100),
    anchorOffsetDays: z.number().int(),
    fromDueAt: z.iso.datetime().nullable(),
    toDueAt: z.iso.datetime(),
  }),
);

/**
 * A named gate opened for a case (§4.1) — the licence check passed, or the gate
 * was bypassed (ON-035).
 *
 * **The one task event journalled on the case's stream rather than on
 * `platform.task`.** A gate is case-scoped and has no row of its own, so there
 * is no task id to hang it on — and a gate can legitimately open before any
 * gated task exists, which is precisely the case `raiseTaskList` must be able to
 * look up later. Putting it on the case makes that lookup a keyed, indexed read
 * (`stream_type`, `stream_id`, `event_type`) instead of a scan over payloads.
 * ADR-0021's rule that `stream_type` is the event type's prefix therefore does
 * not hold for this one type; it is recorded in core plan 08 §4.2 and §12.1
 * rather than left as a silent divergence.
 */
export const platformTaskGateOpened = defineEvent(
  'platform.task.gate.opened',
  1,
  z.strictObject({
    gateKey: z.string().min(1).max(100),
    /** How many blocking edges this opening satisfied. */
    dependenciesSatisfied: z.number().int().min(0),
    /** Tasks that became actionable as a result, each with its own event. */
    unblockedTaskIds: z.array(z.uuid()),
    workflowInstanceId: z.uuid().nullable(),
  }),
);

// --- Approval engine (core plan 09, PL-016…018) ------------------------------
//
// **Streamed on the request row, not on the subject** — the same ADR-0021
// correction plans 06, 07 and 08 each made in build. The ADR fixes `stream_type`
// as the event type's `<module>.<entity>` prefix with the entity taken from the
// table, so `platform.approval_request.approved` belongs on
// `stream_type='platform.approval_request'`. Plan 09 §4.3 originally paired
// `platform.approval.*` with the *subject's* stream; that pairing would have
// been the only place in the system where the two disagreed.
//
// The subject is not lost. It travels as `subjectStreamType`/`subjectStreamId`
// on every payload, so a booking's activity trail (plan 13) and the reporting
// feed (plan 15) still fan out by it — one indexed read for "this booking's
// approvals", and one task's own history becomes readable too, which the
// original pairing could not do.
//
// Payloads carry ids, codes, policy keys and decisions. **Reason text stays on
// the row** (ADR-0019): a rejection reason is free text a human typed, and the
// journal records that one exists and where to find it, never its content.

/** `{ provider, code }` — what a warning was, never what it said (PL-017). */
const acknowledgedWarning = z.strictObject({
  provider: z.string().min(1).max(100),
  code: z.string().min(1).max(100),
});

/** The business record a sign-off is about, in journal stream vocabulary. */
const approvalSubject = {
  subjectStreamType: streamTypeName,
  subjectStreamId: z.uuid(),
};

/** How an approver came to be asked — mirrors `approval_assignee.source`. */
const approvalAssigneeRef = z.strictObject({
  personId: z.uuid(),
  source: z.enum(['policy_role', 'designated', 'delegation']),
  /** Role **key**, not id: a payload read a year later should be legible. */
  roleKey: z.string().max(100).nullable(),
  designatedSource: z.string().max(100).nullable(),
  delegationId: z.uuid().nullable(),
});

/**
 * A sign-off was sought (PL-016).
 *
 * `assignees` is the notification record — who the policy resolved to *at this
 * instant*, and how. It is deliberately not the authorisation set: eligibility
 * is re-resolved live at decide time (§4.5), so this payload answers "who was
 * asked?" and nothing else. `policyVersion` is null when the frozen code default
 * was in force rather than a written config entry.
 */
export const platformApprovalRequestRequested = defineEvent(
  'platform.approval_request.requested',
  1,
  z.strictObject({
    ...approvalSubject,
    policyKey: z.string().min(1).max(200),
    policyVersion: z.number().int().nullable(),
    workflowInstanceId: z.uuid().nullable(),
    workflowAction: z.string().max(100).nullable(),
    /** `null` when a timer-fired transition opened it — nobody to notify. */
    requestedBy: z.uuid().nullable(),
    assignees: z.array(approvalAssigneeRef),
    /** Warnings the *requester* was shown and acknowledged at submit (PL-017). */
    acknowledgedWarnings: z.array(acknowledgedWarning),
  }),
);

/**
 * The decisive approval (PL-016, any-one-approves). There is no second one.
 *
 * The deciding person is the envelope's `actor_person_id`; `delegationId` says
 * whether they were acting on their own authority or carrying someone else's.
 */
export const platformApprovalRequestApproved = defineEvent(
  'platform.approval_request.approved',
  1,
  z.strictObject({
    ...approvalSubject,
    policyKey: z.string().min(1).max(200),
    /** Set when the decider's authority came via a delegation. */
    delegationId: z.uuid().nullable(),
    /** Warnings the *approver* acknowledged — soft, never blocking (PL-017). */
    acknowledgedWarnings: z.array(acknowledgedWarning),
    workflowInstanceId: z.uuid().nullable(),
    /** The runtime action this approval fired, in the same transaction (§5.5). */
    workflowAction: z.string().max(100).nullable(),
  }),
);

/**
 * The decisive rejection. `hasReason` is always true — PL-016 makes the reason
 * mandatory at the schema *and* the CHECK constraint — and the text itself stays
 * on `approval_decision.reason`, out of immutable storage (ADR-0019).
 */
export const platformApprovalRequestRejected = defineEvent(
  'platform.approval_request.rejected',
  1,
  z.strictObject({
    ...approvalSubject,
    policyKey: z.string().min(1).max(200),
    delegationId: z.uuid().nullable(),
    acknowledgedWarnings: z.array(acknowledgedWarning),
    workflowInstanceId: z.uuid().nullable(),
    workflowAction: z.string().max(100).nullable(),
    hasReason: z.literal(true),
  }),
);

/** A pending request was withdrawn before anyone decided it. */
export const platformApprovalRequestCancelled = defineEvent(
  'platform.approval_request.cancelled',
  1,
  z.strictObject({
    ...approvalSubject,
    policyKey: z.string().min(1).max(200),
    /** Who ended it: the requester, an administrator, or the owning workflow. */
    source: z.enum(['requester', 'admin', 'workflow']),
    hasReason: z.boolean(),
  }),
);

/**
 * A sign-off was **not** sought, because the configured threshold did not call
 * for one (PL-018) — the auto-approve path.
 *
 * **Streamed on the subject, and this is the engine's one ADR-0021 exception**
 * (§12.2 Q2, resolved 2026-08-06: no request row is created). The fact is about
 * a request that deliberately does not exist, so there is no
 * `platform.approval_request` row to hang it on, and the subject is the only
 * durable thing it is about. Exactly the shape of plan 08's
 * `platform.task.gate.opened`, and recorded here rather than left silent.
 *
 * It carries the same `policyKey`/`policyVersion` as a real request so that
 * "why was this never approved by anyone?" is answerable from the trail, and so
 * reporting can count authorisations that happened without a human.
 */
export const platformApprovalRequestAutoApproved = defineEvent(
  'platform.approval_request.auto_approved',
  1,
  z.strictObject({
    policyKey: z.string().min(1).max(200),
    policyVersion: z.number().int().nullable(),
    /** The `platform.approvals.threshold.<subjectType>` key that decided it. */
    thresholdKey: z.string().min(1).max(200),
    thresholdVersion: z.number().int().nullable(),
    /** Why no approval was required — `below_threshold` in every current case. */
    reason: z.enum(['below_threshold']),
    requestedBy: z.uuid().nullable(),
    workflowInstanceId: z.uuid().nullable(),
    workflowAction: z.string().max(100).nullable(),
  }),
);

/**
 * An approver handed their authority to someone else for a period (HL-035).
 *
 * `kind='security'` at the call site: a delegation transfers the power to
 * authorise, which is the same class of fact as a role grant (plan 04). Both
 * parties are on the payload because the envelope's actor is whoever *created*
 * it — an administrator arranging cover for an absent approver is neither.
 */
export const platformApprovalDelegationCreated = defineEvent(
  'platform.approval_delegation.created',
  1,
  z.strictObject({
    delegatorPersonId: z.uuid(),
    delegatePersonId: z.uuid(),
    /** `null` = every subject type. */
    subjectType: streamTypeName.nullable(),
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime(),
    hasReason: z.boolean(),
  }),
);

/** A delegation was ended early. The window stays on the row; this stamps it. */
export const platformApprovalDelegationRevoked = defineEvent(
  'platform.approval_delegation.revoked',
  1,
  z.strictObject({
    delegatorPersonId: z.uuid(),
    delegatePersonId: z.uuid(),
    subjectType: streamTypeName.nullable(),
    /** Whether the window had already lapsed — a revocation of nothing is a fact. */
    alreadyExpired: z.boolean(),
  }),
);
