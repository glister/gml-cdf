/**
 * The personal data this engine holds, declared for core plan 16's erasure and
 * retention process (core plan 11 §9.5, NFR-003, ADR-0019).
 *
 * **Plan 16 is not built.** There is no registry to call yet, so this is a
 * declaration rather than a registration — a typed constant plan 16 imports when
 * it builds its inventory, instead of a comment in a plan document that somebody
 * has to remember to act on. When that registry lands, this becomes its
 * argument; nothing here has to be rediscovered by reading the schema.
 *
 * ## Why this list is longer than it looks
 *
 * The obvious answer is "documents are in SharePoint, so erasure is a Graph
 * delete". It is wrong in five places, and each of them is a column somebody
 * would have had to notice:
 *
 *  - **`merge_data`** is a snapshot of the person's own details, frozen at
 *    generation and kept for ever so "what was merged" stays reconstructable
 *    (ADR-0012). It is the reason `personMergeContext` declares four fields
 *    rather than the seven `platform.person` could offer.
 *  - **`body_html`** is the merged letter. It contains whatever the template
 *    put in it, which is the person's name at minimum.
 *  - **`pending_content`** is the rendered PDF. Transient — cleared on filing —
 *    but a document that never files keeps it indefinitely, which is exactly the
 *    case an erasure sweep must not miss.
 *  - **`capture_data` / `text_response`** are the subject's own answers.
 *  - **`signature_evidence`** is append-only *and* holds an IP address, a
 *    user-agent and a typed name. It cannot be deleted through the application
 *    at all — only the `cdf_erasure` role passes the guard — which is precisely
 *    why plan 16 needs to know it exists rather than discovering it when a
 *    deletion fails.
 *
 * The **journal** is deliberately absent: document event payloads are
 * PII-minimal by construction (ADR-0019, §4.2), so there is nothing in them to
 * erase. That is the property the strict payload schemas exist to guarantee, and
 * stating it here is how a later reader knows it was considered rather than
 * forgotten.
 */

/** How a column is dealt with when a person is erased. */
export type ErasureTreatment =
  /** Overwrite with a redaction marker; the row survives. */
  | 'redact'
  /** Set to NULL; the column is optional and its absence is meaningful. */
  | 'null'
  /** Delete the external object (a SharePoint item) through its adapter. */
  | 'delete_external'
  /** Retain — with the lawful basis that permits it. */
  | 'retain';

export interface ErasureSurfaceEntry {
  readonly table: string;
  readonly column: string;
  /** What is in it, in plain English. */
  readonly holds: string;
  readonly treatment: ErasureTreatment;
  /** Why this treatment and not another. */
  readonly note: string;
}

export const DOCUMENT_ERASURE_SURFACE: readonly ErasureSurfaceEntry[] = Object.freeze([
  {
    table: 'platform.document',
    column: 'merge_data',
    holds: 'the exact data bag merged into the document, snapshotted at generation',
    treatment: 'redact',
    note: 'Kept as a redacted stub rather than nulled: "a document was generated from data that has since been erased" is a different fact from "no data was ever merged", and the second is not true.',
  },
  {
    table: 'platform.document',
    column: 'body_html',
    holds: 'the merged, possibly hand-edited letter',
    treatment: 'redact',
    note: 'The document must remain listable and its lifecycle answerable after erasure; only the content goes.',
  },
  {
    table: 'platform.document',
    column: 'pending_content',
    holds: 'the rendered PDF, staged between render and filing',
    treatment: 'null',
    note: 'Transient by design and cleared on filing — but a document that never files keeps it indefinitely, so the sweep must cover it.',
  },
  {
    table: 'platform.document',
    column: 'capture_data',
    holds: 'the subject’s answers to a registered response set',
    treatment: 'redact',
    note: 'Answers are the subject’s own words; the fact that the document was completed is not erased with them.',
  },
  {
    table: 'platform.document',
    column: 'text_response',
    holds: 'the subject’s free-text response',
    treatment: 'redact',
    note: 'As `capture_data`. Free text is the field most likely to hold something nobody anticipated.',
  },
  {
    table: 'platform.document',
    column: 'title',
    holds: 'a template-authored title, which may name the subject',
    treatment: 'retain',
    note: 'Titles come from Administrator-authored templates, not from user input. Flagged rather than treated so plan 16 can decide with CDF; the engine does not put a name in one.',
  },
  {
    table: 'platform.document',
    column: 'sp_item_id',
    holds: 'the SharePoint item holding the rendered document',
    treatment: 'delete_external',
    note: 'Through `@repo/m365`’s `deleteFile`, which exists for this and for nothing else — cancelling a document supersedes it and leaves the bytes (§7).',
  },
  {
    table: 'platform.document',
    column: 'evidence_sp_item_id',
    holds: 'the filed evidence certificate PDF',
    treatment: 'delete_external',
    note: 'Contains the same evidence as the row below, so the two must be decided together.',
  },
  {
    table: 'platform.document',
    column: 'response_sp_item_id',
    holds: 'a file or photograph the subject uploaded',
    treatment: 'delete_external',
    note: 'Supplied by the subject, so the least defensible thing to keep.',
  },
  {
    table: 'platform.signature_evidence',
    column: 'typed_name, signature_image, ip, user_agent',
    holds: 'the UK SES evidence pack: name as entered, IP address, device',
    treatment: 'retain',
    note: 'A retention decision for CDF, not a technical one: erasing signature evidence destroys the ability to answer a repudiation claim about a contract that may still be in force. The table is append-only and only the `cdf_erasure` role can touch it (ADR-0011/0019), so plan 16 must handle it deliberately — it cannot be swept by accident either way.',
  },
]);
