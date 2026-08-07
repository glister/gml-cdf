import { z } from 'zod';
import { ROLE_KEYS } from '@repo/domain';
import { defineConfigKey } from './registry.js';
import { defineApprovalSubject } from './approval-subjects.js';

/**
 * The registered configuration keys (core plan 06 §6).
 *
 * **Registration is distributed by ownership, and this file is where the
 * `platform.*` keys land.** Only the pilot key is registered by plan 06 itself;
 * every other catalogued key is registered by the plan that owns its behaviour
 * when that plan builds — plan 07 the `platform.workflow.demo.*` keys, plan 10
 * `platform.notifications.*`, plan 09 `platform.approvals.*`, plans 16/17 the
 * retention and readiness namespaces. `hr.*` keys are registered by the HR plan
 * set in its own module file beside this one.
 *
 * What plan 06 fixes for all of them is the **naming convention**: a qualified
 * name is `<module>.<area>.<key>` in snake_case, `namespace` is every segment
 * but the last, `key` is the last, and workflow definitions reference values as
 * `config:<qualified name>` (ADR-0013). The catalogue of names and defaults in
 * §6 of the plan is the contract later plans register against, so a definition
 * authored today against `config:hr.leave.approvers` keeps working when the HR
 * leave plan registers it.
 *
 * Two rules bind every addition here (§4.5/§4.6):
 *
 *  - **Defaults are frozen once shipped.** Behaviour changes by writing a config
 *    entry, never by editing a `defaultValue`.
 *  - **A value may never contain personal data** — no person IDs, no names.
 *    Policies reference roles; membership resolves at use time (PL-021). A key
 *    whose value wants to point at an individual is a design error, not a
 *    configuration.
 */

/**
 * PL-042 — how long a newly created external's access runs before it expires,
 * when the administrator does not pick an explicit date.
 *
 * The **pilot key** for the whole store: registered here, consumed by plan 03's
 * person-creation path (§9.5-T2), editable in the admin UI with no release, and
 * every change journalled. Default 90 days — SoW PL-042 gives no number; 90 was
 * confirmed by CDF on 2026-08-05 (§12.2 Q2) and matches the constant plan 03
 * shipped inline. Administrator-only: an access window is a security control,
 * so it is not on the HR User's bench (§8).
 *
 * The 1–365 bound is deliberate. Zero would mean "expired on creation" and an
 * unbounded value would quietly defeat PL-042's "time-boxed" requirement; a
 * longer engagement is expressed by setting an explicit date on the person, not
 * by widening the org-wide default.
 */
export const externalAccessDefaultDays = defineConfigKey({
  namespace: 'platform.identity',
  key: 'external_access_default_days',
  schema: z.number().int().min(1).max(365),
  defaultValue: 90,
  description:
    'Default number of days an external’s access runs from creation, when no explicit expiry date is given. Applies to agency, subcontractor, self-employed, external-organisation and candidate records; employees never expire.',
  editableBy: ['administrator'],
  registeredBy: '06',
});

// --- Workflow runtime (core plan 07 §6) --------------------------------------
//
// The pilot `platform.demo.request` shape's two decision points. They exist to
// prove the mechanism end to end without HR: an approver policy resolved from
// configuration at execution time, and a timer lead time resolved when the
// timer is created. Real business keys — `hr.leave.approvers`, fit-note
// thresholds, reminder cadences — are registered by their owning plans.
//
// The qualified names are declared once in `@repo/domain`
// (`workflow/demo-config-keys.ts`) so the definition's `config:` references, the
// guard that reads the resolved value, and these registrations cannot drift.

/**
 * Who may approve or reject a demo request — the `by` decision point (WF-2).
 *
 * A **role**, never a person: membership resolves at execution time, so a
 * leaver stops approving the moment their grant ends and no definition changes
 * (PL-021). Changing this in the admin UI changes who may take the next
 * transition, with no release — which is the whole demonstration.
 */
export const workflowDemoApproverRole = defineConfigKey({
  namespace: 'platform.workflow.demo',
  key: 'approver_role',
  schema: z.enum(ROLE_KEYS),
  defaultValue: 'administrator',
  description:
    'Role permitted to approve or reject a demo workflow request. Demonstration key for the workflow runtime — it governs no real business process.',
  editableBy: ['administrator'],
  registeredBy: '07',
});

/**
 * How long a demo request stands before its expiry timer fires (WF-8).
 *
 * Read when the timer is created, so changing it moves the deadline for every
 * request started afterwards while leaving timers already scheduled where they
 * are — the same "a change never rewrites the past" property every real lead
 * time (fit-note chase, probation review) inherits.
 */
export const workflowDemoExpiryHours = defineConfigKey({
  namespace: 'platform.workflow.demo',
  key: 'expiry_hours',
  schema: z.number().int().min(1).max(8760),
  defaultValue: 72,
  description:
    'Hours a demo workflow request stands before it expires itself. Demonstration key for the workflow runtime.',
  editableBy: ['administrator'],
  registeredBy: '07',
});

// --- Task & checklist engine (core plan 08 §6) -------------------------------
//
// Four decision points, and one thing they have in common: every one of them is
// a number or a cadence a business user might reasonably want to change, and a
// hardcoded value would mean a release to change how often people are chased or
// what time of day work is due (PL-029). None of them names a person — the
// engine assigns to roles, and membership resolves at use time (PL-021).

/**
 * How often an incomplete task is chased (PL-020, ON-047/OF-008).
 *
 * Stored as the `cadenceRef` on each pending reminder occurrence and resolved
 * **as-at each firing** by plan 10's reminder handler, so changing it here moves
 * the next chase for every outstanding task with no release and no backfill
 * (AC-D6). ISO-8601 duration, matching the shape plans 09 and 10 use.
 */
export const tasksReminderCadence = defineConfigKey({
  namespace: 'platform.tasks.reminder',
  key: 'cadence',
  schema: z.string().regex(/^P(?!$)(\d+D|\d+W)$/, 'an ISO-8601 day or week duration, e.g. P1D'),
  defaultValue: 'P1D',
  description:
    'How often an incomplete task is chased, as an ISO-8601 duration (P1D = daily, P7D = weekly). Read afresh at every firing, so a change takes effect from the next chase.',
  editableBy: ['administrator', 'hr_user'],
  registeredBy: '08',
});

/**
 * When the chase starts, relative to the due date (PL-020, ON-049).
 *
 * Negative chases **before** the deadline, which is what ON-049 asks for on
 * onboarding tasks; zero starts on the day. Bounded at a fortnight either side:
 * beyond that the reminder is no longer about the deadline.
 */
export const tasksReminderStartOffsetDays = defineConfigKey({
  namespace: 'platform.tasks.reminder',
  key: 'start_offset_days',
  schema: z.number().int().min(-14).max(14),
  defaultValue: 0,
  description:
    'Days relative to a task’s due date at which chasing begins. Negative starts before the deadline (e.g. -2 = two days before), 0 starts on the day.',
  editableBy: ['administrator', 'hr_user'],
  registeredBy: '08',
});

/**
 * What to do about a task with no due date.
 *
 * `from_raise` chases on the cadence from the moment it is raised; `none`
 * leaves it alone. The choice matters because most tasks in a raised lane have
 * no individual deadline — the case does — and chasing all of them daily from
 * day one is how a notification system teaches people to ignore it.
 */
export const tasksReminderNoDueDate = defineConfigKey({
  namespace: 'platform.tasks.reminder',
  key: 'no_due_date',
  schema: z.enum(['from_raise', 'none']),
  defaultValue: 'from_raise',
  description:
    'Whether tasks with no due date are chased at all: from_raise starts the cadence when the task is raised; none leaves them unchased until someone sets a due date.',
  editableBy: ['administrator', 'hr_user'],
  registeredBy: '08',
});

/**
 * The local time an anchor-relative due date lands on (PL-013).
 *
 * "Due on the 11th" is not an instant until you say what time and where, and
 * `start_date − 3d` has to become a `timestamptz`. Split from the zone below so
 * each edits as a plain text field rather than as JSON — the same value the plan
 * catalogued as `17:00 Europe/London`, in the two halves that are separately
 * meaningful.
 */
export const tasksDueTimeOfDay = defineConfigKey({
  namespace: 'platform.tasks.due',
  key: 'time_of_day',
  schema: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a 24-hour local time, HH:MM'),
  defaultValue: '17:00',
  description:
    'Local time of day an anchor-relative due date falls due, as HH:MM. The end of the working day, so a task due “on the 11th” is not overdue at one minute past midnight.',
  editableBy: ['administrator'],
  registeredBy: '08',
});

/** The zone {@link tasksDueTimeOfDay} is interpreted in. */
export const tasksDueTimeZone = defineConfigKey({
  namespace: 'platform.tasks.due',
  key: 'time_zone',
  schema: z.string().regex(/^[A-Za-z]+\/[A-Za-z_+-]+$/, 'an IANA time zone, e.g. Europe/London'),
  defaultValue: 'Europe/London',
  description:
    'IANA time zone the due time-of-day is interpreted in. Changing it moves future resolutions only — due dates already resolved keep the instant they were given.',
  editableBy: ['administrator'],
  registeredBy: '08',
});

// --- Approval engine (core plan 09 §6) ---------------------------------------
//
// Two engine-wide keys live here; everything per-subject-type is a **family**
// registered through `defineApprovalSubject` (see `./approval-subjects.ts`),
// because "who approves an hr.leave_booking" and "who approves a training
// spend" are separate values with separate audit trails, not one setting.
//
// Note what is absent: no approver, threshold or cadence appears anywhere in
// code. That is the whole of PL-016/PL-018 — changing who signs off, or the
// figure above which a sign-off is needed, is a config edit and never a release.

/**
 * How often an undecided approval request is chased (PL-020, HL-054 driver).
 *
 * Stored as the `cadenceRef` on each pending reminder occurrence and resolved
 * **as-at each firing** by plan 10's reminder handler, so changing it moves the
 * next chase for every outstanding request with no release and no backfill —
 * the same contract core plan 08 established for task chases. A subject type
 * that needs its own rhythm overrides it through its own key
 * (`platform.approvals.reminder.cadence.<subjectType>`).
 */
export const approvalsReminderCadence = defineConfigKey({
  namespace: 'platform.approvals.reminder',
  key: 'cadence',
  schema: z.string().regex(/^P(?!$)(\d+D|\d+W)$/, 'an ISO-8601 day or week duration, e.g. P1D'),
  defaultValue: 'P1D',
  description:
    'How often an undecided approval request is chased, as an ISO-8601 duration (P1D = daily, P7D = weekly). Read afresh at every firing, so a change takes effect from the next chase.',
  editableBy: ['administrator', 'hr_user'],
  registeredBy: '09',
});

/**
 * The longest period an approver may hand their authority to someone else
 * (HL-035, §6).
 *
 * A ceiling rather than a fixed term: a delegation is cover for an absence, and
 * an unbounded one is a permanent transfer of authority that never appears in
 * anyone's role grants. 90 days matches the external-access default above —
 * long enough for parental leave or a secondment, short enough that a
 * delegation nobody remembers making expires on its own.
 *
 * Administrator-only, unlike the rest of the approvals namespace: this bounds
 * how far authority can travel, which is a security control rather than an HR
 * policy.
 */
export const approvalsDelegationMaxDurationDays = defineConfigKey({
  namespace: 'platform.approvals.delegation',
  key: 'max_duration_days',
  schema: z.number().int().min(1).max(365),
  defaultValue: 90,
  description:
    'The longest period, in days, that an approver may delegate their approval authority for. A delegation is cover for an absence — renew it rather than setting an open-ended one.',
  editableBy: ['administrator'],
  registeredBy: '09',
});

/**
 * The pilot subject type (§9.8) — the slice that proves PL-016…018 with no HR
 * module in existence.
 *
 * Administrator any-one-approves with an HR override, so the two halves of
 * HL-033 are demonstrable at once: any one administrator can decide, and HR can
 * decide without being notified of every one. The threshold defaults to
 * `amount > 500`, which is what makes AC-D5 demonstrable — edit the number in
 * the admin UI and the next submit routes differently, with no release.
 *
 * It retires with the pilot slice, exactly as plan 07's `platform.demo.request`
 * shape and plan 08's `platform.pilot_case` will.
 */
// --- Notifications & reminders (core plan 10 §6) -----------------------------
//
// Six keys, and what they have in common is that every one of them is a lever a
// business user should be able to pull without a release: how often people are
// chased, which channels are live, how long a message stays in the inbox, and
// which kinds are too chatty for email (PL-029).
//
// Note what is *not* here. Retry backoff and the maximum delivery attempt count
// are operational tuning, not business decisions, and stay as code constants by
// design — a key nobody in the business has an opinion about is a setting to get
// wrong, not a decision point. And no key names a person: a notification
// addresses a role or a policy, and membership resolves at send time (PL-021).

/**
 * How often an outstanding thing is chased when its own capability has not
 * registered a rhythm of its own (PL-020).
 *
 * The platform floor rather than the usual answer: core plan 08's task chases
 * and core plan 09's approval chases each carry their own key, and a reminder
 * occurrence stores whichever `config:` reference its scheduler chose. This is
 * what a reminder kind falls back to when it names none, and it is deliberately
 * the same shape and default (`P1D` — daily until complete) so a reader
 * comparing the three finds no surprise.
 *
 * Read **as-at each firing**, so an administrator lengthening it moves the next
 * chase for everything outstanding, with no release and no backfill (AC-D7).
 */
export const notificationsDefaultReminderCadence = defineConfigKey({
  namespace: 'platform.notifications',
  key: 'default_reminder_cadence',
  schema: z.string().regex(/^P(?!$)(\d+D|\d+W)$/, 'an ISO-8601 day or week duration, e.g. P1D'),
  defaultValue: 'P1D',
  description:
    'How often an outstanding item is chased when its own capability names no cadence, as an ISO-8601 duration (P1D = daily, P7D = weekly). Read afresh at every firing, so a change takes effect from the next chase.',
  editableBy: ['administrator', 'hr_user'],
  registeredBy: '10',
});

/**
 * Is the in-app channel live? (§6, AC-D8.)
 *
 * Ships `true` and would be an odd thing to turn off — the inbox is the channel
 * with no delivery risk at all. It exists as a key for the same reason the
 * others do: the dispatcher reads *every* channel's enablement the same way, so
 * there is one code path and no special case that could drift.
 */
export const notificationsChannelInAppEnabled = defineConfigKey({
  namespace: 'platform.notifications.channel.in_app',
  key: 'enabled',
  schema: z.boolean(),
  defaultValue: true,
  description:
    'Whether in-app notifications are delivered. Turning this off records suppressed deliveries rather than skipping them silently, so the inbox emptying is explainable.',
  editableBy: ['administrator'],
  registeredBy: '10',
});

/**
 * Is the email channel live?
 *
 * The one most likely to be used in anger: a provider outage or a deliverability
 * problem is answered by turning email off for an afternoon, which leaves the
 * in-app inbox working and records `suppressed` rows saying exactly why nobody
 * got an email (AC-D8).
 */
export const notificationsChannelEmailEnabled = defineConfigKey({
  namespace: 'platform.notifications.channel.email',
  key: 'enabled',
  schema: z.boolean(),
  defaultValue: true,
  description:
    'Whether notification emails are sent. Turning this off during a provider outage records suppressed deliveries and leaves the in-app inbox unaffected.',
  editableBy: ['administrator'],
  registeredBy: '10',
});

/**
 * Is the push channel live? **Ships `false`** (ADR-0024).
 *
 * The channel enum, the adapter seam, the per-channel delivery rows and this key
 * all exist from day one, and the push build is the only thing that does not
 * (§5.3). That is the shape of the deferral: turning it on later is a
 * configuration change plus an adapter, not a schema migration — which is what a
 * "designed now, built later" claim has to mean if it is to mean anything.
 *
 * Leaving it registered but false also means the dispatcher's suppression path
 * is exercised by the default configuration on every send, rather than being
 * dead code until someone flips a switch in production.
 */
export const notificationsChannelPushEnabled = defineConfigKey({
  namespace: 'platform.notifications.channel.push',
  key: 'enabled',
  schema: z.boolean(),
  defaultValue: false,
  description:
    'Whether push notifications are sent to the mobile app. Ships off: the channel is designed and wired but the Expo Push adapter and device registration are a later build (ADR-0024). Turning it on before then records suppressed deliveries.',
  editableBy: ['administrator'],
  registeredBy: '10',
});

/**
 * How long a notification stays visible in the in-app inbox (§6, Q2).
 *
 * A visibility horizon, not a deletion policy: past it the message drops out of
 * the inbox and its delivery rows stay exactly where they are. Erasure and
 * retention are plan 16's, and a notification service quietly deleting its own
 * evidence of what it sent would be the wrong half of that job done in the wrong
 * place.
 *
 * 90 days is the working assumption pending CDF's answer on Q2 — bounded at a
 * year because an inbox nobody can ever clear stops being an inbox.
 */
export const notificationsDefaultExpiry = defineConfigKey({
  namespace: 'platform.notifications',
  key: 'default_expiry',
  schema: z.string().regex(/^P(?!$)(\d+D|\d+W)$/, 'an ISO-8601 day or week duration, e.g. P90D'),
  defaultValue: 'P90D',
  description:
    'How long a notification stays visible in the in-app inbox, as an ISO-8601 duration. Past it the message drops out of the inbox; the delivery record is kept regardless — clearing it is retention policy, not inbox policy.',
  editableBy: ['administrator'],
  registeredBy: '10',
});

/**
 * Per-kind channel overrides — the volume relief valve (§12.3, Q4).
 *
 * A notification kind registers the channels it *wants*; this overrides them for
 * a named kind without a release, which is how CDF turns email off for a chatty
 * kind while leaving the inbox entry intact. The value is a map of kind name to
 * channel list, and an empty list is legitimate: it means "record it in the
 * table, tell nobody" — the honest way to mute something without losing the
 * trail that it happened.
 *
 * The value names kinds and channels only. It cannot name a person, which is
 * the rule every key in this store obeys and the reason this one is safe to
 * carry in full in its own audit event.
 */
export const notificationsKindChannelOverrides = defineConfigKey({
  namespace: 'platform.notifications',
  key: 'kind_channel_overrides',
  schema: z.record(
    z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'a registered notification kind'),
    z.array(z.enum(['in_app', 'email', 'push'])),
  ),
  defaultValue: {},
  description:
    'Per-kind channel overrides: a map of notification kind to the channels it should use, overriding the kind’s registered defaults. An empty list mutes a kind on every channel while still recording it.',
  editableBy: ['administrator'],
  registeredBy: '10',
});

export const pilotSignoffSubject = defineApprovalSubject({
  subjectType: 'platform.pilot_signoff',
  policyDefault: {
    mode: 'any-one',
    approvers: [{ kind: 'role', roleKey: 'administrator' }],
    overrideRoles: ['hr_user'],
  },
  thresholdDefault: { field: 'amount', op: 'gt', value: 500 },
  policyDescription:
    'Who may approve a pilot sign-off. Demonstration key for the approval engine — it governs no real business process.',
  thresholdDescription:
    'The amount above which a pilot sign-off needs approval at all. Demonstration key for the approval engine: change it and the next request routes differently, with no release (PL-018).',
  registeredBy: '09',
});

// --- Documents, templates & e-signature (core plan 11 §6) --------------------
//
// Eight decision points, and the shape of the set is the point: where the bytes
// go, how hard we try to put them there, whether a signature needs a scroll, who
// may see which category, and what a response upload may be. None of them is a
// person, and none is a threshold anyone would want to change by release.

/**
 * The SharePoint site holding the document library (PL-010, ADR-0017).
 *
 * Empty until CDF IT provisions the site and grants `Sites.Selected` consent
 * (§12.2 Q4). Filing checks it and stays `pending` while it is empty rather than
 * failing — an unset target is a configuration state, not an error, and the
 * two-phase issue design exists precisely so documents stay usable through it.
 */
export const documentsSharePointSiteId = defineConfigKey({
  namespace: 'platform.documents',
  key: 'sharepoint_site_id',
  schema: z.string().max(300),
  defaultValue: '',
  description:
    'The Microsoft Graph site id of the SharePoint site holding the document library. Empty means filing is not configured yet: documents are still issued, viewed and signed from staged bytes, and filing stays pending.',
  editableBy: ['administrator'],
  registeredBy: '11',
});

/** The drive (document library) within that site. */
export const documentsSharePointDriveId = defineConfigKey({
  namespace: 'platform.documents',
  key: 'sharepoint_drive_id',
  schema: z.string().max(300),
  defaultValue: '',
  description:
    'The Graph drive id of the document library within the configured site. Empty means filing is not configured yet.',
  editableBy: ['administrator'],
  registeredBy: '11',
});

/**
 * Where in the library a filed document lands (PL-010).
 *
 * Placeholders are substituted at filing time; an unknown one is left verbatim
 * rather than blanked, so a typo shows up as a visibly wrong folder name instead
 * of silently collapsing two categories into one directory. The **personnel-file
 * taxonomy** beyond this generic pattern is Q6, decided with CDF HR when the HR
 * onboarding plan lands.
 */
export const documentsFilingPathPattern = defineConfigKey({
  namespace: 'platform.documents',
  key: 'filing_path_pattern',
  schema: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[A-Za-z0-9_\-{}/. ]+$/, 'a drive-relative folder path with {placeholder} segments'),
  defaultValue: 'people/{person_id}/{category_code}/',
  description:
    'Drive-relative folder pattern a filed document is written to. Supported placeholders: {person_id}, {category_code}, {document_id}. Changing it affects the next filing, with no release.',
  editableBy: ['administrator'],
  registeredBy: '11',
});

/**
 * How many times filing is attempted before the document is marked `failed`
 * and an administrator is told (§4.6).
 *
 * Bounded at 20 because the alternative to giving up is a document that retries
 * for ever and never appears on the diagnostics screen — the failure mode this
 * whole `failed` state exists to make visible.
 */
export const documentsFilingMaxAttempts = defineConfigKey({
  namespace: 'platform.documents',
  key: 'filing_max_attempts',
  schema: z.number().int().min(1).max(20),
  defaultValue: 8,
  description:
    'How many times a document’s SharePoint filing is attempted before it is marked failed and an administrator is notified. A failed filing can be retried by hand from the documents screen.',
  editableBy: ['administrator'],
  registeredBy: '11',
});

/**
 * Whether signing requires the signatory to have scrolled to the end (PL-011).
 *
 * On by default, and it is a real evidential control rather than a nicety:
 * `ack_scrolled` is a column on the evidence row, so turning this off changes
 * what the evidence pack can claim. Left configurable because a
 * countersignature on a document someone has already read is a legitimate flow.
 */
export const documentsSignRequireScrollAck = defineConfigKey({
  namespace: 'platform.documents',
  key: 'sign_require_scroll_ack',
  schema: z.boolean(),
  defaultValue: true,
  description:
    'Whether a signatory must scroll to the end of a document before the signature control is accepted. Recorded on the signature evidence row either way, so turning it off changes what the evidence pack can claim.',
  editableBy: ['administrator'],
  registeredBy: '11',
});

/**
 * Which roles may see documents in each category (PL-012).
 *
 * A map of category **code** to role keys — codes, not row ids, because this is
 * a value a human edits and reads (the 2026-08-07 reconciliation row draws that
 * line). A category absent from the map falls back to the default list, so
 * adding a lookup value never accidentally exposes it.
 *
 * **The subject always sees their own documents**, and that is not expressible
 * here on purpose: it is not a role, and a document nobody can sign is not a
 * document. `exclude_subject` — the HR plans' "attachments must not leak to the
 * subject" case — is Q7, still open.
 */
export const documentsCategoryVisibility = defineConfigKey({
  namespace: 'platform.documents',
  key: 'category_visibility',
  schema: z.record(
    z.string().regex(/^[a-z0-9][a-z0-9_]{0,63}$/, 'a document category code'),
    z.array(z.enum(ROLE_KEYS)),
  ),
  defaultValue: {},
  description:
    'Which roles may view documents in each category, by category code. A category not listed falls back to Administrator and HR only — so adding a category never exposes it by accident. The subject always sees their own documents regardless.',
  editableBy: ['administrator'],
  registeredBy: '11',
});

/**
 * The roles a category confers when the map above does not mention it.
 *
 * Deny-by-default, expressed as a value rather than as a constant, so the
 * fallback is visible on the configuration screen instead of being a number
 * somebody has to read the source to discover (§8).
 */
export const documentsCategoryVisibilityDefault = defineConfigKey({
  namespace: 'platform.documents',
  key: 'category_visibility_default',
  schema: z.array(z.enum(ROLE_KEYS)).min(1),
  defaultValue: ['administrator', 'hr_user'],
  description:
    'The roles that may view documents in a category with no explicit entry. Deny-by-default: Administrator and HR only.',
  editableBy: ['administrator'],
  registeredBy: '11',
});

/** The largest response file a subject may upload (`file_upload` mode). */
export const documentsResponseUploadMaxBytes = defineConfigKey({
  namespace: 'platform.documents',
  key: 'response_upload_max_bytes',
  schema: z
    .number()
    .int()
    .min(1024)
    .max(100 * 1024 * 1024),
  defaultValue: 10 * 1024 * 1024,
  description:
    'The maximum size, in bytes, of a file or photograph uploaded in response to a document issued for file upload.',
  editableBy: ['administrator'],
  registeredBy: '11',
});

/**
 * What a response upload may be.
 *
 * An allow-list, never a deny-list. The content type is also **sniffed from the
 * bytes** at upload rather than trusted from the multipart header, because a
 * client controls the header and this list would otherwise be advice.
 */
export const documentsResponseUploadAllowedTypes = defineConfigKey({
  namespace: 'platform.documents',
  key: 'response_upload_allowed_types',
  schema: z.array(z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/, 'a MIME type')).min(1),
  defaultValue: ['application/pdf', 'image/jpeg', 'image/png', 'image/heic'],
  description:
    'The content types a document response upload may be. An allow-list: anything not named is refused. The type is verified against the file’s own bytes, not the type the client declares.',
  editableBy: ['administrator'],
  registeredBy: '11',
});
