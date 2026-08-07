import { createHash } from 'node:crypto';
import { formatDocumentHash } from '@repo/domain';

/**
 * The document digest (core plan 11 §9.2, PL-011).
 *
 * **Why this is not in `@repo/domain`.** §9.2 placed a SHA-256 helper there;
 * that package bans `node:*` imports outright (ADR-0009, lint-enforced), and on
 * the plan's own §7 separation it does not belong there anyway — a digest is
 * taken over *bytes*, and the only places holding bytes are the worker's render
 * step and the evidence export. The **format** — canonical form and exact
 * comparison — stays in `@repo/domain/documents/hash.ts`, which is what makes
 * the guard predicates testable without a crypto implementation.
 *
 * One function, and one rule: **the hash is always taken over the rendered PDF
 * bytes, never over the HTML that produced them.** Two renders of the same HTML
 * can differ (a font substitution, an embedded timestamp), and the artefact a
 * person signs and the artefact stored in SharePoint are the PDF. Hashing the
 * source would produce a value that verifies nothing about the file anyone
 * actually holds (R4).
 */

/** The canonical `sha256:<hex>` hash of a rendered document's bytes. */
export function computeDocumentHash(bytes: Uint8Array): string {
  return formatDocumentHash(createHash('sha256').update(bytes).digest('hex'));
}
