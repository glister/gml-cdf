import type { StatusTone } from '~/components/data-display/StatusPill';

/* Presentation maps for the authorisation model (core plan 04). Labels and
   StatusPill tones live here so the grants, roles and allocations screens read
   the same way. Keyed by the literal unions the tRPC contract returns (kept in
   step with packages/trpc/src/lib/constants.ts). */

export type RoleKey =
  | 'administrator'
  | 'hr_user'
  | 'line_manager'
  | 'finance'
  | 'it'
  | 'transport'
  | 'office_admin'
  | 'director'
  | 'employee'
  | 'external'
  | 'external_administrator';

export type ModuleKey =
  | 'platform'
  | 'hr.core'
  | 'hr.onboarding'
  | 'hr.holiday_leave'
  | 'hr.sickness_absence'
  | 'hr.er'
  | 'hr.ld'
  | 'hr.offboarding'
  | 'hr.wellbeing'
  | 'hr.reporting';

export type GrantState = 'pending' | 'active' | 'expired' | 'revoked';

export const ROLE_LABELS: Record<RoleKey, string> = {
  administrator: 'Administrator',
  hr_user: 'HR User',
  line_manager: 'Line Manager',
  finance: 'Finance',
  it: 'IT',
  transport: 'Transport',
  office_admin: 'Admin (operational)',
  director: 'Director',
  employee: 'Employee / Candidate',
  external: 'External / Agency',
  external_administrator: 'External Administrator',
};

export const MODULE_LABELS: Record<ModuleKey, string> = {
  platform: 'Platform (shared services)',
  'hr.core': 'HR — Core',
  'hr.onboarding': 'HR — Onboarding',
  'hr.holiday_leave': 'HR — Holiday & leave',
  'hr.sickness_absence': 'HR — Sickness & absence',
  'hr.er': 'HR — Employee relations',
  'hr.ld': 'HR — Learning & development',
  'hr.offboarding': 'HR — Offboarding',
  'hr.wellbeing': 'HR — Wellbeing, OH & D&A',
  'hr.reporting': 'HR — Reporting',
};

/** Short form for table cells, where the module column is already labelled. */
export const MODULE_SHORT_LABELS: Record<ModuleKey, string> = {
  platform: 'Platform',
  'hr.core': 'Core',
  'hr.onboarding': 'Onboarding',
  'hr.holiday_leave': 'Holiday & leave',
  'hr.sickness_absence': 'Sickness & absence',
  'hr.er': 'Employee relations',
  'hr.ld': 'Learning & dev',
  'hr.offboarding': 'Offboarding',
  'hr.wellbeing': 'Wellbeing & OH',
  'hr.reporting': 'Reporting',
};

export const GRANT_STATE_LABELS: Record<GrantState, string> = {
  pending: 'Not yet active',
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
};

/**
 * Tones per the design system's state taxonomy: a live grant is a success
 * state; a future-dated one is informational (nothing is awaiting anyone, so
 * amber "pending" would overstate it); and expired/revoked stay neutral rather
 * than alarming — the taxonomy is explicit that expired and withdrawn states
 * are neutral, not danger.
 */
export const GRANT_STATE_TONES: Record<GrantState, StatusTone> = {
  pending: 'info',
  active: 'success',
  expired: 'neutral',
  revoked: 'neutral',
};

export const ROLE_OPTIONS = Object.entries(ROLE_LABELS) as [RoleKey, string][];
export const MODULE_OPTIONS = Object.entries(MODULE_LABELS) as [ModuleKey, string][];
export const GRANT_STATE_OPTIONS = Object.entries(GRANT_STATE_LABELS) as [GrantState, string][];

/**
 * Modules the caller holds any live grant in — drives UX-only navigation.
 * **Never** an access decision: the procedures are the boundary (ADR-0003).
 */
export function modulesFromGrants(
  grants: { module: ModuleKey; state: GrantState }[] | undefined,
): Set<ModuleKey> {
  return new Set((grants ?? []).filter((g) => g.state === 'active').map((g) => g.module));
}

/** Does the caller hold any of these roles, live, anywhere? UX-only. */
export function holdsAnyRole(
  grants: { roleKey: RoleKey; state: GrantState }[] | undefined,
  roles: RoleKey[],
): boolean {
  return (grants ?? []).some((g) => g.state === 'active' && roles.includes(g.roleKey));
}
