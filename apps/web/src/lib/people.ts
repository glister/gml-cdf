import type { StatusTone } from '~/components/data-display/StatusPill';

/* Presentation maps for the three CORE-01 identity dimensions — relationship,
   profile status, and identity/access status. Labels + StatusPill tones live
   here so the list, detail and duplicate screens read the same way. Keyed by the
   literal unions the tRPC contract returns (kept in step with
   packages/trpc/src/lib/constants.ts). */

export type RelationshipType =
  'employee' | 'agency' | 'subcontractor' | 'self_employed' | 'external_org_employee' | 'candidate';

export type ProfileStatus =
  | 'draft_shell'
  | 'information_requested'
  | 'information_submitted'
  | 'pending_review'
  | 'incomplete_rejected'
  | 'approved_not_active'
  | 'active'
  | 'active_with_restrictions'
  | 'inactive'
  | 'leaver'
  | 'reactivated';

export type PersonStatus = 'active' | 'inactive' | 'superseded';

export const RELATIONSHIP_LABELS: Record<RelationshipType, string> = {
  employee: 'Employee',
  agency: 'Agency',
  subcontractor: 'Subcontractor',
  self_employed: 'Self-employed',
  external_org_employee: 'External org',
  candidate: 'Candidate',
};

export const PROFILE_STATUS_LABELS: Record<ProfileStatus, string> = {
  draft_shell: 'Draft',
  information_requested: 'Info requested',
  information_submitted: 'Info submitted',
  pending_review: 'Pending review',
  incomplete_rejected: 'Rejected',
  approved_not_active: 'Approved',
  active: 'Active',
  active_with_restrictions: 'Active — restricted',
  inactive: 'Inactive',
  leaver: 'Leaver',
  reactivated: 'Reactivated',
};

export const PROFILE_STATUS_TONES: Record<ProfileStatus, StatusTone> = {
  draft_shell: 'neutral',
  information_requested: 'pending',
  information_submitted: 'info',
  pending_review: 'pending',
  incomplete_rejected: 'danger',
  approved_not_active: 'info',
  active: 'success',
  active_with_restrictions: 'success',
  inactive: 'neutral',
  leaver: 'pending',
  reactivated: 'info',
};

export const PERSON_STATUS_LABELS: Record<PersonStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  superseded: 'Superseded',
};

export const PERSON_STATUS_TONES: Record<PersonStatus, StatusTone> = {
  active: 'success',
  inactive: 'neutral',
  superseded: 'neutral',
};

/** Format an ISO date/timestamp as a short UK date, or an em dash when absent. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
