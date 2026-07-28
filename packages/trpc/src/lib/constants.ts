/**
 * Constant tuples that back the Zod enums in `../schemas.ts`. Keeping them as
 * `as const` tuples lets us derive both the Zod enum and the TS literal-union
 * type from one source. `@repo/db`'s `.kysely-codegenrc.json` INLINES the same
 * literals for CHECK columns rather than importing from here (avoids a cycle).
 */

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

/**
 * The seeded role set (SoW §10 + `external_administrator`, CORE-05). Mirrors
 * `platform.role.key`, which is deliberately NOT CHECK-constrained — roles are
 * data (PL-002), so adding one in Phase 2 needs no migration. This tuple exists
 * to make `roleProcedure([...])` arguments type-safe; a role key that is in the
 * table but not here simply cannot be named by a builder at compile time.
 */
export const ROLE_KEYS = [
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
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/**
 * The grant-scope keys — which functional area a role applies in. Mirrors the
 * `platform.role_grant.module` CHECK. A code-level constant, not reference data:
 * adding a module is a code change by definition (ADR-0008).
 *
 * Note the asymmetry: `platform` is one coarse scope covering every shared
 * service (identity, reference data, config, documents, calendar, audit,
 * evidence), while the HR module is subdivided into nine areas so the restricted
 * ones (`hr.er`, `hr.wellbeing`) can be granted separately.
 */
export const MODULE_KEYS = [
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
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

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
