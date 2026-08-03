/* Presentation maps for the reference-data service (core plan 05). Labels and
   copy live here so the overview, the value editor and every consuming dropdown
   describe a list the same way. Keyed by the literal union the tRPC contract
   returns (kept in step with packages/trpc/src/lib/constants.ts). */

export type LookupListType =
  | 'department'
  | 'job_role'
  | 'document_category'
  | 'sickness_type'
  | 'ppe_type'
  | 'leaver_reason'
  | 'equipment_type';

export const LOOKUP_LIST_TYPES: LookupListType[] = [
  'department',
  'job_role',
  'document_category',
  'sickness_type',
  'ppe_type',
  'leaver_reason',
  'equipment_type',
];

export const LOOKUP_LIST_LABELS: Record<LookupListType, string> = {
  department: 'Departments',
  job_role: 'Job roles',
  document_category: 'Document categories',
  sickness_type: 'Sickness types',
  ppe_type: 'PPE types',
  leaver_reason: 'Leaver reasons',
  equipment_type: 'Equipment and asset types',
};

/** What each list is *for* — the overview's job is to make the tier visible. */
export const LOOKUP_LIST_DESCRIPTIONS: Record<LookupListType, string> = {
  department: 'Where someone works. Used across the employee record and reporting.',
  job_role: 'What someone does. Used on the employee record and in onboarding.',
  document_category: 'How documents are grouped in the personnel file.',
  sickness_type: 'The categories an absence is recorded against.',
  ppe_type: 'Protective equipment a role type can require.',
  leaver_reason: 'Why someone left. Feeds offboarding and reporting.',
  equipment_type: 'Equipment and assets issued and returned.',
};

/** Formats an ISO timestamp for the maintenance table. */
export function formatTimestamp(value: string | Date | null): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `YYYY-MM-DD` for today, in the **viewer's** calendar — the default
 * `validFrom` on a new membership.
 *
 * Built from local components rather than `toISOString().slice(0, 10)`, which
 * returns the UTC date and so names the wrong day either side of midnight for
 * anyone not on UTC.
 */
export function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Formats a `YYYY-MM-DD` column; open-ended (`null`) reads as "current".
 *
 * Formatted from the string's own parts, never via `new Date(...)`. A membership
 * boundary is a calendar date with no time and no timezone: parsing it as an
 * instant and rendering it in the viewer's zone shifts it by a day for anyone
 * behind UTC, which turns "member from 1 January" into "31 December" and,
 * worse, misreports which side of a half-open boundary a date falls.
 */
export function formatDay(value: string | null, openEnded = '—'): string {
  if (!value) return openEnded;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  return `${day} ${MONTHS[Number(month) - 1]} ${year}`;
}
