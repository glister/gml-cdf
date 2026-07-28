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
