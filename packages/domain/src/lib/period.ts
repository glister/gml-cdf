/**
 * Half-open period arithmetic — the foundational pure helpers effective-dated
 * reads (ADR-0012, plans 05/06) build on. Intervals are half-open `[from, to)`:
 * `from` is inclusive, `to` is exclusive, and `to = null` means open-ended
 * (valid indefinitely). All instants are passed in — this package never reads a
 * clock (ADR-0009, `@repo/domain` purity rule 4).
 */

/**
 * Is `instant` within the half-open period `[from, to)`?
 * `from` inclusive, `to` exclusive; `to = null` is open-ended.
 */
export function isWithinPeriod(instant: Date, from: Date, to: Date | null): boolean {
  const t = instant.getTime();
  if (t < from.getTime()) return false;
  if (to !== null && t >= to.getTime()) return false;
  return true;
}

/**
 * Do the half-open periods `[aFrom, aTo)` and `[bFrom, bTo)` overlap?
 * A `null` end is treated as +infinity (open-ended). Periods that merely touch
 * at a boundary (one's `to` equals the other's `from`) do **not** overlap, which
 * is the point of half-open intervals: adjacent versions never both apply.
 */
export function overlaps(aFrom: Date, aTo: Date | null, bFrom: Date, bTo: Date | null): boolean {
  const aStart = aFrom.getTime();
  const bStart = bFrom.getTime();
  const aEndOpen = aTo === null;
  const bEndOpen = bTo === null;
  // Overlap iff aStart < bEnd && bStart < aEnd (with null ends unbounded).
  const aStartsBeforeBEnds = bEndOpen || aStart < bTo.getTime();
  const bStartsBeforeAEnds = aEndOpen || bStart < aTo.getTime();
  return aStartsBeforeBEnds && bStartsBeforeAEnds;
}
