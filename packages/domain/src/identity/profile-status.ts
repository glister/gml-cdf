/**
 * Profile-status transition guard (core plan 03 §4.4, CORE-01). Pure: the
 * legal-edge graph of the profile-status machine. `setProfileStatus` consults
 * this before every transition; the previous position always survives as a
 * journal event (CORE-01), so this function only answers "is this edge legal?".
 *
 * It does NOT encode the activation guard (readiness / authorisation on the
 * `→ active` edges) — that is orchestration in the procedure (ON-050, plan 17),
 * not a property of the graph.
 */

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

/**
 * The legal transitions, exactly per the §4.4 graph. No self-loops: a no-op
 * transition (`from === to`) is not legal.
 */
const TRANSITIONS: Record<ProfileStatus, readonly ProfileStatus[]> = {
  draft_shell: ['information_requested'],
  information_requested: ['information_submitted'],
  information_submitted: ['pending_review'],
  pending_review: ['incomplete_rejected', 'approved_not_active'],
  incomplete_rejected: ['information_requested'],
  approved_not_active: ['active'],
  active: ['active_with_restrictions', 'inactive', 'leaver'],
  active_with_restrictions: ['active', 'inactive', 'leaver'],
  inactive: ['reactivated'],
  leaver: ['reactivated'],
  reactivated: ['active'],
};

/** Is `from → to` a legal profile-status transition (§4.4)? */
export function canTransition(from: ProfileStatus, to: ProfileStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The legal target statuses from `from` (for UI affordances; server still guards). */
export function allowedTransitions(from: ProfileStatus): readonly ProfileStatus[] {
  return TRANSITIONS[from];
}
