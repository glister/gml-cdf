/**
 * The role and module vocabulary (core plan 04 §4.3, ADR-0015, SoW §10).
 *
 * Pure data: two `as const` tuples and the literal unions derived from them, so
 * one declaration serves both the runtime value and the type. They live here
 * rather than in `@repo/trpc` because more than the API layer needs them — the
 * configuration store types each key's `editableBy` against `RoleKey`, and the
 * workflow runtime resolves `by` policies to role keys — and `@repo/domain` is
 * the only package that sits below all of them (ADR-0009). `@repo/trpc`
 * re-exports both from `lib/constants.ts`, so every existing call site is
 * unchanged.
 *
 * The *functions* in `./grants.ts` remain generic over these vocabularies and do
 * not import them: an engine that decides whether a grant is active has no
 * business knowing the role list, and keeping it generic is what lets the same
 * predicate serve a Phase 2 role added purely as data.
 */

/**
 * The seeded role set (SoW §10 + `external_administrator`, CORE-05). Mirrors
 * `platform.role.key`, which is deliberately NOT CHECK-constrained — roles are
 * data (PL-002), so adding one in Phase 2 needs no migration. This tuple exists
 * to make `roleProcedure([...])` arguments and `editableBy` lists type-safe; a
 * role key that is in the table but not here simply cannot be named in code.
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
