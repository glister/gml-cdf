/**
 * The document-hash **format** (core plan 11 §9.2, PL-011) — what
 * `sha256:<hex>` means, and what it means for two of them to match.
 *
 * ## Why the digest itself is not here
 *
 * §9.2 placed a SHA-256 helper in this package. It cannot live here: computing a
 * digest needs `node:crypto`, and `@repo/domain` bans `node:*` imports outright
 * (ADR-0009, lint-enforced). Nor should it — the digest is taken over *bytes*,
 * and the only two places that hold bytes are the worker (which renders the PDF)
 * and the evidence export (which re-reads them). `computeDocumentHash` therefore
 * lives in `@repo/trpc/lib/document-hash.ts`, beside both callers.
 *
 * What *is* a domain concept, and what stays here, is the contract:
 *
 *  - the canonical string form, so the column, the evidence row and the client's
 *    `expectedHash` are all written the same way;
 *  - that comparison is **exact** — no case folding, no prefix tolerance, no
 *    "starts with". A hash comparison that normalises is a hash comparison that
 *    can be argued with, and this one has to survive being argued with in front
 *    of an employment tribunal (R2).
 *
 * The database backs both halves: `content_hash` and `document_hash` carry a
 * `~ '^sha256:[0-9a-f]{64}$'` CHECK, so a malformed value cannot be stored even
 * if some future caller skips these helpers.
 */

/** The canonical form: the algorithm, a colon, and 64 lowercase hex digits. */
export const DOCUMENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** The prefix. Named so a second algorithm would be a visible change, not a typo. */
export const DOCUMENT_HASH_ALGORITHM = 'sha256';

/** Thrown when a value is not a well-formed document hash. */
export class DocumentHashError extends Error {
  constructor(readonly value: string) {
    super(
      `'${value}' is not a document hash: expected ${DOCUMENT_HASH_ALGORITHM}:<64 lowercase hex digits>`,
    );
    this.name = 'DocumentHashError';
  }
}

/** Whether a value is in canonical form. */
export function isDocumentHash(value: unknown): value is string {
  return typeof value === 'string' && DOCUMENT_HASH_PATTERN.test(value);
}

/**
 * Build the canonical form from a raw hex digest.
 *
 * Uppercase hex is lowercased — a digest is the same number either way, and
 * accepting one casing at the door is what lets comparison downstream stay
 * exact. Anything else throws: silently coercing a wrong-length string would
 * produce a hash-shaped value that matches nothing, which is the worst possible
 * failure mode for this particular field.
 */
export function formatDocumentHash(hex: string): string {
  const normalised = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalised)) throw new DocumentHashError(hex);
  return `${DOCUMENT_HASH_ALGORITHM}:${normalised}`;
}

/** The raw hex digest from a canonical hash. */
export function documentHashHex(value: string): string {
  if (!isDocumentHash(value)) throw new DocumentHashError(value);
  return value.slice(DOCUMENT_HASH_ALGORITHM.length + 1);
}

/**
 * Whether two hashes are the same — exactly, and only if both are well-formed.
 *
 * Two malformed values that happen to be equal as strings are **not** a match.
 * Without that rule, `hashesMatch(null as never, null as never)` and
 * `hashesMatch('', '')` both return true, and every guard built on this function
 * passes for a document that was never rendered.
 */
export function hashesMatch(a: unknown, b: unknown): boolean {
  return isDocumentHash(a) && isDocumentHash(b) && a === b;
}
