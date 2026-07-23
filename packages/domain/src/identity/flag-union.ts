/**
 * Safeguarding-flag union planning for a person merge (core plan 03 §5.2 step 4,
 * PL-040). Pure: decide which of the losing person's active flags must be copied
 * onto the surviving person so that a safeguarding-critical flag is **never lost
 * through a merge**. No I/O — the caller performs the inserts and the journal
 * append.
 */

export type PersonFlagType = 'do_not_rehire' | 'safeguarding' | 'safety' | 'other';

/** An active flag on either side of a merge. */
export interface ActiveFlag {
  id: string;
  flagType: PersonFlagType;
  reason: string;
}

/** One copy to insert on the survivor, tracing back to the flag it came from. */
export interface FlagCopyPlan {
  sourceFlagId: string;
  flagType: PersonFlagType;
  reason: string;
}

/**
 * Plan the survivor-side copies for a merge: copy every active flag on the loser
 * whose `flag_type` is not already present among the survivor's active flags.
 *
 * The check is against the survivor's flag types *as given* (pre-merge), so if
 * the loser carries two distinct flags of a type the survivor lacks, both are
 * copied — never-lose favours over-copying a safeguarding flag over dropping
 * one. Copies are additive; the loser's originals stay in place (its history is
 * never rewritten), and unmerge never removes a copy (PL-040).
 */
export function planFlagUnion(
  survivorFlags: ActiveFlag[],
  loserFlags: ActiveFlag[],
): FlagCopyPlan[] {
  const survivorTypes = new Set(survivorFlags.map((f) => f.flagType));
  return loserFlags
    .filter((f) => !survivorTypes.has(f.flagType))
    .map((f) => ({ sourceFlagId: f.id, flagType: f.flagType, reason: f.reason }));
}
