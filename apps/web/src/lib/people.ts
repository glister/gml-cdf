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

/** Why the matcher considers two persons a strong duplicate (mirrors
    `@repo/domain` `DuplicateMatchReason`). */
export type DuplicateMatchReason = 'name_dob' | 'agency_ref';

export const MATCH_REASON_LABELS: Record<DuplicateMatchReason, string> = {
  name_dob: 'Name & date of birth',
  agency_ref: 'Agency worker reference',
};

/** Safeguarding-flag types (mirrors `PERSON_FLAG_TYPES` in @repo/trpc). */
export type PersonFlagType = 'do_not_rehire' | 'safeguarding' | 'safety' | 'other';

export const FLAG_TYPE_LABELS: Record<PersonFlagType, string> = {
  do_not_rehire: 'Do not rehire',
  safeguarding: 'Safeguarding',
  safety: 'Safety',
  other: 'Other',
};

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

/** A `<input type="date">` value → an ISO datetime at end of that UTC day, the
    shape the access-window procedures expect (`z.iso.datetime()`). */
export function dateToEndOfDayIso(date: string): string {
  return new Date(`${date}T23:59:59.999Z`).toISOString();
}

/** An ISO datetime → a `<input type="date">` value (UTC calendar day). */
export function isoToDateInput(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** Format an ISO date/timestamp as a short UK date, or an em dash when absent. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  // Format in UTC: a date-only value like '1990-05-01' parses to UTC midnight, so
  // formatting in a behind-UTC local zone would shift it back a day. Access
  // windows are stored as end-of-day UTC, so UTC keeps the intended calendar day.
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
