import type { ApprovalStatusValue } from '@repo/trpc/schemas';
import type { StatusTone } from '~/components/data-display/StatusPill';

/**
 * Presentation helpers for the approval screens (core plan 09 §5.3).
 *
 * Formatting only. Nothing here decides anything: whether a viewer may act, why
 * a request is in their inbox, and how long it has been waiting are all computed
 * in SQL and arrive on the row (§4.5, ADR-0004). A helper in this file that
 * started answering one of those questions would be a second implementation of
 * the authorisation model, which is exactly how the two would come to disagree.
 */

/**
 * Status → state-taxonomy tone (design system `tokens/states.css`).
 *
 * `cancelled` is **neutral, not danger**: a withdrawn request is inert rather
 * than bad, and the taxonomy is explicit that "cancelled" reads neutral. Only a
 * decision against the requester — `rejected` — earns the danger red.
 */
export function approvalTone(status: ApprovalStatusValue): StatusTone {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'approved':
      return 'success';
    case 'rejected':
      return 'danger';
    case 'cancelled':
      return 'neutral';
  }
}

/**
 * Plain English for each status.
 *
 * "Declined" rather than "Rejected", and "Withdrawn" rather than "Cancelled" —
 * the brand voice is direct but not blunt, and these words are read by the
 * person whose request it was.
 */
export const APPROVAL_STATUS_LABEL: Record<ApprovalStatusValue, string> = {
  pending: 'Waiting',
  approved: 'Approved',
  rejected: 'Declined',
  cancelled: 'Withdrawn',
};

/**
 * `hr.leave_booking` → `Leave booking`.
 *
 * Subject types are journal stream names (ADR-0021) and the engine is generic,
 * so it has no vocabulary of its own to translate them with. Humanising the
 * entity segment is honest about that; a lookup table here would go stale the
 * first time an HR plan added a subject type without updating it.
 */
export function shortSubjectType(subjectType: string): string {
  const entity = subjectType.includes('.')
    ? subjectType.slice(subjectType.indexOf('.') + 1)
    : subjectType;
  const words = entity.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `2026-08-06T09:15:00Z` → `6 Aug 2026, 09:15`. */
export function formatInstant(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `2026-08-06T09:15:00Z` → `6 Aug 2026`. */
export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Why the viewer cannot decide, in words for the person reading it.
 *
 * `not_eligible` is the interesting one: the honest explanation is that the
 * policy no longer resolves to them, which is a thing that can change under
 * them without anyone editing the request (§4.5). Saying so beats a disabled
 * button with no explanation.
 */
export const CANNOT_DECIDE_REASON: Record<
  NonNullable<'not_eligible' | 'already_decided' | 'cancelled' | 'is_requester'>,
  string
> = {
  not_eligible:
    'You are not currently one of this request’s approvers. Who may approve is a policy over roles, so this can change if a role’s membership changes.',
  already_decided: 'This request has already been decided.',
  cancelled: 'This request was withdrawn before anyone decided it.',
  is_requester: 'You raised this request, so you cannot decide it yourself.',
};
