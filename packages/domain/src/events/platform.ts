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
