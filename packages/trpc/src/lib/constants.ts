/**
 * Constant tuples that back the Zod enums in `../schemas.ts`. Keeping them as
 * `as const` tuples lets us derive both the Zod enum and the TS literal-union
 * type from one source. `@repo/db`'s `.kysely-codegenrc.json` INLINES the same
 * literals for CHECK columns rather than importing from here (avoids a cycle).
 */

/**
 * The role and module vocabulary now lives in `@repo/domain` (`authz/roles.ts`)
 * and is re-exported here so every call site — `roleProcedure`, `schemas.ts`,
 * the web nav — is unchanged. It moved down because `@repo/config` types each
 * key's `editableBy` against `RoleKey` and the workflow runtime resolves `by`
 * policies to role keys, and `@repo/domain` is the only package below all three
 * (core 07 §5.2 write-back, 2026-08-05).
 */
export { MODULE_KEYS, ROLE_KEYS, type ModuleKey, type RoleKey } from '@repo/domain';

/** Better Auth admin-plugin roles. */
export const USER_ROLES = ['admin', 'agent'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Sort directions for keyset-paginated lists. */
export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

// --- Identity & person model (core plan 03) — mirror the CHECK constraints ---

/** A person's relationship with CDF (CORE-01). RBAC externals key on `<> 'employee'`. */
export const RELATIONSHIP_TYPES = [
  'employee',
  'agency',
  'subcontractor',
  'self_employed',
  'external_org_employee',
  'candidate',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/** The CORE-01 profile-status lifecycle. */
export const PROFILE_STATUSES = [
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
] as const;
export type ProfileStatusValue = (typeof PROFILE_STATUSES)[number];

/** Identity/access state governing sign-in and merge bookkeeping. */
export const PERSON_STATUSES = ['active', 'inactive', 'superseded'] as const;
export type PersonStatusValue = (typeof PERSON_STATUSES)[number];

/** Safeguarding flag types (never-lose on merge, PL-040). */
export const PERSON_FLAG_TYPES = ['do_not_rehire', 'safeguarding', 'safety', 'other'] as const;
export type PersonFlagTypeValue = (typeof PERSON_FLAG_TYPES)[number];

/** Sort columns for the person list. */
export const PERSON_SORTS = ['created_at', 'family_name', 'access_valid_until'] as const;
export type PersonSort = (typeof PERSON_SORTS)[number];

// --- Authorisation (core plan 04, ADR-0015) ---------------------------------
//
// `ROLE_KEYS` / `MODULE_KEYS` are re-exported at the top of this file from
// `@repo/domain`; the rest of the vocabulary stays here.

/**
 * Field sensitivity classes (PL-003, ADR-0015), ordered least → most sensitive.
 * `schemaUpTo` keeps every field at or below a given class, so the order here is
 * load-bearing, not decorative.
 */
export const FIELD_CLASSES = ['public', 'internal', 'sensitive', 'special-category'] as const;
export type FieldClass = (typeof FIELD_CLASSES)[number];

/** The lifecycle states of a grant, derived from its timestamps (§4.3). */
export const GRANT_STATES = ['pending', 'active', 'expired', 'revoked'] as const;
export type GrantState = (typeof GRANT_STATES)[number];

/** The record-visibility ladder a viewer holds for a module (ADR-0015). */
export const PERSON_SCOPES = ['all', 'team', 'allocated', 'self'] as const;
export type PersonScope = (typeof PERSON_SCOPES)[number];

/**
 * Authorisation config items (core plan 04 §6), shipped as constants with their
 * config keys **reserved** — reserved, not registered: neither has a consumer
 * that reads it from the store yet.
 *
 * **Renamed 2026-08-05** when plan 06 landed. They were reserved as `authz.*`,
 * but plan 06 fixes the qualified name as `<module>.<area>.<key>` where the
 * module is a Postgres schema (`platform` or `hr`) — `authz` is neither, and
 * `defineConfigKey` validates the grammar at load, so an `authz.*` key could not
 * be registered at all. Whichever change makes these editable registers them
 * under the names below and replaces the reads here.
 *
 * Neither is a business threshold that changes behaviour silently: the TTL only
 * pre-fills a form field, and the reason requirement is already enforced by the
 * Zod schema (`revokeGrantInput.reason` is `min(1)`).
 */
export const AUTHZ_CONFIG_DEFAULTS = {
  /** Pre-filled `validUntil` when granting to an external-role holder (PL-042/043). */
  'platform.authz.external.default_grant_ttl_days': 90,
  /** Whether revoking demands a reason. Enforced by the input schema today. */
  'platform.authz.grants.revoke_requires_reason': true,
} as const;

// --- Reference-data service (core plan 05, ADR-0016) ------------------------

/**
 * The seven Phase 1 Tier 1 lists (PL-005b). Mirrors the `platform.lookup`
 * CHECK constraint and the inlined literals in `.kysely-codegenrc.json`.
 *
 * CHECK-constrained deliberately: adding a *value* to a list is data entry with
 * no release (AC-D1), but adding a *list type* assigns a new list to a tier —
 * a design decision (ADR-0016), so it costs a one-line migration. An open-ended
 * `list_type` is the first step towards the generic key-value store PL-005c
 * exists to prohibit.
 */
export const LOOKUP_LIST_TYPES = [
  'department',
  'job_role',
  'document_category',
  'sickness_type',
  'ppe_type',
  'leaver_reason',
  'equipment_type',
] as const;
export type LookupListType = (typeof LOOKUP_LIST_TYPES)[number];

/** Sort columns for the lookup admin table. */
export const LOOKUP_SORTS = ['sort_order', 'label', 'updated_at'] as const;
export type LookupSort = (typeof LOOKUP_SORTS)[number];

/** Sort columns for the teams list. */
export const TEAM_SORTS = ['name', 'updated_at'] as const;
export type TeamSort = (typeof TEAM_SORTS)[number];

// --- Configuration store (core plan 06, ADR-0016) ---------------------------

/**
 * Sort columns for the config browser. Deliberately short: the browser lists the
 * **registry** (a few dozen keys), merged with whatever entries exist, so its
 * ordering is over key names and last-changed times, not over a large table.
 */
export const CONFIG_SORTS = ['key', 'updated_at'] as const;
export type ConfigSort = (typeof CONFIG_SORTS)[number];

// --- Workflow runtime & scheduled actions (core plan 07, ADR-0013) ----------

/**
 * Sort columns for the instance list. `updated_at` is the useful default for an
 * operator ("what moved recently?"); `created_at` answers "what has been open
 * longest?".
 */
export const WORKFLOW_INSTANCE_SORTS = ['created_at', 'updated_at'] as const;
export type WorkflowInstanceSort = (typeof WORKFLOW_INSTANCE_SORTS)[number];

/**
 * `platform.scheduled_action.status`. Mirrors the CHECK constraint and the
 * inlined literals in `.kysely-codegenrc.json`.
 */
export const SCHEDULED_ACTION_STATUSES = ['pending', 'enqueued', 'executed', 'cancelled'] as const;
export type ScheduledActionStatus = (typeof SCHEDULED_ACTION_STATUSES)[number];

/** Who created a timer. Mirrors `platform.scheduled_action.source`. */
export const SCHEDULED_ACTION_SOURCES = ['workflow', 'manual', 'system'] as const;
export type ScheduledActionSource = (typeof SCHEDULED_ACTION_SOURCES)[number];

/** Sort columns for the timers table. Due date is what an operator scans by. */
export const SCHEDULED_ACTION_SORTS = ['due_at', 'created_at'] as const;
export type ScheduledActionSort = (typeof SCHEDULED_ACTION_SORTS)[number];

// --- Task & checklist engine (core plan 08, PL-013…015) ---------------------

/**
 * `platform.task.status`. Mirrors the CHECK constraint and the inlined literals
 * in `.kysely-codegenrc.json`. `blocked → open` is automatic (dependency
 * satisfaction); `done` and `cancelled` are terminal (§4.3).
 */
export const TASK_STATUSES = ['blocked', 'open', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** `platform.task.due_mode` — absolute, anchor-relative, or no due date. */
export const TASK_DUE_MODES = ['none', 'absolute', 'anchor_relative'] as const;
export type TaskDueMode = (typeof TASK_DUE_MODES)[number];

/** `platform.task.source` — raised by a workflow effect, or created by hand. */
export const TASK_SOURCES = ['workflow', 'manual'] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

/** `platform.task_dependency.depends_on_kind`. */
export const TASK_DEPENDENCY_KINDS = ['task', 'gate'] as const;
export type TaskDependencyKind = (typeof TASK_DEPENDENCY_KINDS)[number];

/**
 * Sort columns for my-tasks. `due` is the working order (what is next, nulls
 * last); `raised` answers "what landed on me recently?".
 */
export const TASK_SORTS = ['due', 'raised'] as const;
export type TaskSort = (typeof TASK_SORTS)[number];
