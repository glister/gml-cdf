/**
 * Advisory duplicate detection (core plan 03 §5.2, PL-037/041). Pure decision
 * logic: given two persons' natural-identity attributes, decide whether they are
 * a strong match and why. This is the SAME rule used by the on-write check, the
 * nightly scan, and the PL-047 pre-creation check — one definition, three call
 * sites.
 *
 * These attributes are decision AIDS only, never an authentication factor or a
 * claim mechanism (PL-041): a `true` here raises an advisory signal to an
 * administrator; it never auto-merges and never attaches a credential.
 */

/** Reason codes for a strong match, mirrored by the §4.2 partial indexes. */
export type DuplicateMatchReason = 'name_dob' | 'agency_ref';

/** The natural-identity attributes a duplicate decision reads. */
export interface PersonIdentityAttributes {
  givenName?: string | null;
  familyName?: string | null;
  /** ISO `YYYY-MM-DD`. */
  dateOfBirth?: string | null;
  agencyWorkerReference?: string | null;
}

export interface DuplicateMatchResult {
  match: boolean;
  reasons: DuplicateMatchReason[];
}

/**
 * Case- and whitespace-fold a value for comparison: Unicode NFKC (so composed
 * and decomposed forms compare equal), trim, lowercase, and collapse internal
 * runs of whitespace to a single space. Returns `null` for absent or
 * whitespace-only input so a missing attribute never matches another missing
 * one. Diacritics are deliberately preserved — folding "é"→"e" would over-match.
 */
export function normaliseIdentityValue(value: string | null | undefined): string | null {
  if (value == null) return null;
  const folded = value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  return folded.length > 0 ? folded : null;
}

/**
 * Decide whether two persons are a strong duplicate match. Strong match is:
 *
 *  - `name_dob`  — same normalised family name AND given name AND date of birth
 *    (all three present on both), or
 *  - `agency_ref` — identical normalised agency worker reference.
 *
 * Either alone is sufficient; both may fire. A person is never compared to
 * itself by this function — callers pair distinct persons.
 */
export function matchDuplicate(
  a: PersonIdentityAttributes,
  b: PersonIdentityAttributes,
): DuplicateMatchResult {
  const reasons: DuplicateMatchReason[] = [];

  const aFamily = normaliseIdentityValue(a.familyName);
  const aGiven = normaliseIdentityValue(a.givenName);
  const aDob = normaliseIdentityValue(a.dateOfBirth);
  const bFamily = normaliseIdentityValue(b.familyName);
  const bGiven = normaliseIdentityValue(b.givenName);
  const bDob = normaliseIdentityValue(b.dateOfBirth);

  if (
    aFamily !== null &&
    aGiven !== null &&
    aDob !== null &&
    aFamily === bFamily &&
    aGiven === bGiven &&
    aDob === bDob
  ) {
    reasons.push('name_dob');
  }

  const aRef = normaliseIdentityValue(a.agencyWorkerReference);
  const bRef = normaliseIdentityValue(b.agencyWorkerReference);
  if (aRef !== null && aRef === bRef) {
    reasons.push('agency_ref');
  }

  return { match: reasons.length > 0, reasons };
}
