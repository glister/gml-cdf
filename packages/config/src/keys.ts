import { z } from 'zod';
import { ROLE_KEYS } from '@repo/domain';
import { defineConfigKey } from './registry.js';

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
