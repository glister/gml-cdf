import { z } from 'zod';
import { db as _unusedDb } from '@repo/db';
import { registerEffect, type EffectEnvelope, type EffectHandler } from '@repo/workflow';
import {
  loadDocumentConfig,
  markEvidenceFiled,
  markFiled,
  markResponseFiled,
  recordFilingFailure,
  stageRender,
  DOCUMENT_EFFECTS,
} from './documents.js';
import { computeDocumentHash } from './document-hash.js';
import {
  hasDocumentStore,
  requireDocumentRenderer,
  requireDocumentStore,
} from './document-ports.js';

void _unusedDb;

/**
 * The document engine's effect handlers (core plan 11 §4.6/§4.7, ADR-0013).
 *
 * Issue journals `platform.document.issued` with an `effects` array; the outbox
 * relay fans it onto the `effects` queue after the transaction commits; the
 * worker dispatches here. The consequence therefore arrives **after** the fact
 * that caused it and can never be split from it by a broker outage (the
 * 2026-08-07 payload-carried-effects rule).
 *
 * ## Render and file are one handler with two resumable halves
 *
 * `document.render_and_file` renders, hashes, stages, then uploads. On a Graph
 * failure the staged bytes and their hash survive, so redelivery resumes at the
 * upload rather than re-rendering — which matters for more than efficiency: a
 * second render could produce different bytes, and `content_hash` is write-once
 * at the database level precisely so that cannot silently rebind a signature.
 *
 * ## Idempotency
 *
 * Delivery is at-least-once, so each handler runs more than once by design:
 *
 *  - `stageRender` matches on the existing hash, so a re-render of identical
 *    bytes is a no-op and a re-render of *different* bytes updates nothing;
 *  - `markFiled` updates only a row not already `filed`, so no second `filed`
 *    event is journalled;
 *  - the SharePoint upload targets a **path** and replaces, so a redelivery
 *    overwrites rather than leaving a duplicate personnel file behind.
 *
 * ## Failure handling is deliberately two-tier
 *
 * A transient failure increments `filing_attempts` and **throws**, so the queue
 * redelivers with its own backoff. At `platform.documents.filing.max_attempts`
 * the document becomes `failed`, journals `filing_failed`, and the handler
 * **returns** — throwing there would retry a document we have decided to stop
 * retrying, and would dead-letter the message rather than surfacing it on the
 * admin screen where somebody can act on it.
 */

const documentParams = z.object({ documentId: z.uuid() });
const responseParams = z.object({
  documentId: z.uuid(),
  /** The uploaded response, staged by the Hono route. */
  contentType: z.string().min(1).max(200),
  fileName: z.string().min(1).max(300),
});

/** `people/{person_id}/{category_code}/` → a full drive path for this document. */
function filingPath(
  pattern: string,
  values: { person_id: string; category_code: string; document_id: string },
  fileName: string,
): string {
  const folder = pattern.replace(
    /\{([a-z_]+)\}/g,
    (raw, key: string) => (values as Record<string, string>)[key] ?? raw,
  );
  return `${folder.replace(/\/+$/, '')}/${fileName}`;
}

/**
 * A file name that is safe in SharePoint and says nothing about a person.
 *
 * The document id, not the title: a library item's name is visible to anyone
 * with site access, outside this application's RBAC, and "Disciplinary outcome —
 * J Smith.pdf" in a folder listing discloses the thing the category restriction
 * exists to protect (ADR-0019).
 */
function safeFileName(documentId: string, suffix = ''): string {
  return `${documentId}${suffix}.pdf`;
}

const renderAndFile: EffectHandler = async (envelope: EffectEnvelope, ctx) => {
  const { documentId } = documentParams.parse(envelope.params ?? {});
  const now = new Date();

  const doc = await ctx.db
    .selectFrom('platform.document as d')
    .innerJoin('platform.lookup as c', 'c.id', 'd.category_id')
    .select([
      'd.id',
      'd.title',
      'd.body_html',
      'd.status',
      'd.filing_state',
      'd.content_hash',
      'd.pending_content',
      'd.subject_person_id',
      'd.filing_attempts',
      'c.code as category_code',
    ])
    .where('d.id', '=', documentId)
    .where('d.deleted_at', 'is', null)
    .executeTakeFirst();

  if (!doc) {
    // Nothing to retry into existence. Returning dead-letters nothing and logs
    // the fact; throwing would burn ten redeliveries on a document somebody
    // erased.
    ctx.logger.warn('document.render_and_file: no such document', { documentId });
    return;
  }
  if (doc.filing_state === 'filed') return;
  if (doc.status === 'cancelled') {
    ctx.logger.info('document.render_and_file: document withdrawn before filing', { documentId });
    return;
  }

  const config = await ctx.db.transaction().execute((trx) => loadDocumentConfig(trx, now));

  // --- Phase one: render, hash, stage ---------------------------------------
  //
  // Skipped entirely when a previous delivery already staged bytes — the reason
  // the two halves are separable.
  let bytes: Uint8Array | null = doc.pending_content ? new Uint8Array(doc.pending_content) : null;
  let contentHash = doc.content_hash;

  if (!bytes || !contentHash) {
    const render = requireDocumentRenderer();
    bytes = await render({ html: doc.body_html ?? '', title: doc.id });
    contentHash = computeDocumentHash(bytes);
    await ctx.db
      .transaction()
      .execute((trx) => stageRender(trx, { documentId, bytes: bytes!, contentHash: contentHash! }));
    ctx.logger.info('document rendered and staged', { documentId, contentHash });
  }

  // --- Phase two: upload ----------------------------------------------------
  //
  // Not configured is a *state*, not a failure (§12.2 Q4, R1). The document is
  // rendered, viewable and signable from the staged bytes; filing stays pending
  // until CDF IT supply the site, and no attempt is counted against it.
  if (!hasDocumentStore() || !requireDocumentStore().isConfigured()) {
    ctx.logger.info('document filing deferred: SharePoint is not configured yet', { documentId });
    return;
  }
  if (config.sharePoint.siteId === '' || config.sharePoint.driveId === '') {
    ctx.logger.info('document filing deferred: no site/drive configured', { documentId });
    return;
  }

  const store = requireDocumentStore();
  try {
    const uploaded = await store.upload({
      siteId: config.sharePoint.siteId,
      driveId: config.sharePoint.driveId,
      path: filingPath(
        config.filing.pathPattern,
        {
          person_id: doc.subject_person_id,
          category_code: doc.category_code,
          document_id: doc.id,
        },
        safeFileName(doc.id),
      ),
      bytes,
      contentType: 'application/pdf',
    });

    if (store.setMetadata) {
      // Best-effort: a library with no matching custom columns rejects this, and
      // that must not fail the filing — the bytes are stored and the
      // authoritative back-reference is the one in Postgres (PL-010).
      await store
        .setMetadata({
          siteId: config.sharePoint.siteId,
          driveId: config.sharePoint.driveId,
          itemId: uploaded.itemId,
          fields: {
            CdfDocumentId: doc.id,
            CdfCategory: doc.category_code,
            CdfSubjectPersonId: doc.subject_person_id,
          },
        })
        .catch((error: unknown) => {
          ctx.logger.warn('document metadata write failed; filing stands', {
            documentId,
            error: String(error),
          });
        });
    }

    await ctx.db.transaction().execute((trx) =>
      markFiled(trx, {
        documentId,
        siteId: config.sharePoint.siteId,
        driveId: config.sharePoint.driveId,
        itemId: uploaded.itemId,
        webUrl: uploaded.webUrl,
        contentHash: contentHash!,
        attempts: doc.filing_attempts + 1,
        correlationId: envelope.correlationId,
        now: new Date(),
      }),
    );
  } catch (error) {
    const outcome = await ctx.db.transaction().execute((trx) =>
      recordFilingFailure(trx, {
        documentId,
        error: String(error),
        maxAttempts: config.filing.maxAttempts,
        correlationId: envelope.correlationId,
      }),
    );

    if (outcome.terminal) {
      // Decided to stop. Returning puts it on the admin diagnostics screen;
      // throwing would dead-letter it, which looks like an outage rather than
      // the configuration problem it usually is.
      ctx.logger.error('document filing failed permanently', {
        documentId,
        attempts: outcome.attempts,
      });
      return;
    }
    throw error;
  }
};

/**
 * Build and file the evidence certificate alongside the signed document (§4.7).
 *
 * A separate effect from the document's own filing because the two happen at
 * different moments — filing follows issue, the certificate follows signature —
 * and a signature must never wait on a document's filing having finished.
 */
const fileEvidence: EffectHandler = async (envelope, ctx) => {
  const { documentId } = documentParams.parse(envelope.params ?? {});
  const now = new Date();

  const doc = await ctx.db
    .selectFrom('platform.document as d')
    .innerJoin('platform.lookup as c', 'c.id', 'd.category_id')
    .select([
      'd.id',
      'd.title',
      'd.content_hash',
      'd.subject_person_id',
      'd.evidence_sp_item_id',
      'd.issued_at',
      'c.code as category_code',
    ])
    .where('d.id', '=', documentId)
    .executeTakeFirst();

  if (!doc) return;
  if (doc.evidence_sp_item_id) return; // Already filed; redelivery is a no-op.

  const evidence = await ctx.db
    .selectFrom('platform.signature_evidence')
    .selectAll()
    .where('document_id', '=', documentId)
    .orderBy('signed_at', 'desc')
    .executeTakeFirst();
  if (!evidence) return;

  const config = await ctx.db.transaction().execute((trx) => loadDocumentConfig(trx, now));
  if (
    !hasDocumentStore() ||
    !requireDocumentStore().isConfigured() ||
    config.sharePoint.siteId === '' ||
    config.sharePoint.driveId === ''
  ) {
    ctx.logger.info('evidence filing deferred: SharePoint is not configured yet', { documentId });
    return;
  }

  const render = requireDocumentRenderer();
  const bytes = await render({ html: evidenceCertificateHtml(doc, evidence), title: doc.id });

  const store = requireDocumentStore();
  const uploaded = await store.upload({
    siteId: config.sharePoint.siteId,
    driveId: config.sharePoint.driveId,
    path: filingPath(
      config.filing.pathPattern,
      {
        person_id: doc.subject_person_id,
        category_code: doc.category_code,
        document_id: doc.id,
      },
      safeFileName(doc.id, '-evidence'),
    ),
    bytes,
    contentType: 'application/pdf',
  });

  await ctx.db
    .transaction()
    .execute((trx) => markEvidenceFiled(trx, { documentId, itemId: uploaded.itemId }));
};

/**
 * The certificate's HTML.
 *
 * Surrogate ids and the hash — no names, no document content (ADR-0019). It is a
 * statement that *this* signatory signed *these* bytes at *that* moment from
 * *that* address, which is the whole of what a UK SES evidence pack claims. A
 * reader who needs to know who the signatory is looks the id up in a system that
 * checks whether they are allowed to.
 */
function evidenceCertificateHtml(
  doc: { id: string; category_code: string; content_hash: string | null },
  evidence: {
    signatory_person_id: string;
    method: string;
    typed_name: string | null;
    signed_at: Date | string;
    ip: unknown;
    user_agent: string;
    ack_scrolled: boolean;
    document_hash: string;
  },
): string {
  const rows: [string, string][] = [
    ['Document id', doc.id],
    ['Category', doc.category_code],
    ['Document hash (SHA-256)', evidence.document_hash],
    ['Signatory (person id)', evidence.signatory_person_id],
    ['Method', evidence.method === 'typed_name' ? 'Typed name' : 'Signature pad'],
    ['Name as entered', evidence.typed_name ?? '—'],
    ['Signed at (UTC)', new Date(evidence.signed_at).toISOString()],
    ['IP address', String(evidence.ip)],
    ['Device / user agent', evidence.user_agent],
    ['Read to end acknowledged', evidence.ack_scrolled ? 'Yes' : 'No'],
  ];

  const escape = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; margin: 32px; color: #111; }
  h1 { font-size: 16pt; margin-bottom: 4px; }
  p.lead { color: #555; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin-top: 20px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { width: 240px; font-weight: 600; color: #333; }
  td { font-family: 'Courier New', monospace; word-break: break-all; }
</style></head><body>
<h1>Electronic signature evidence</h1>
<p class="lead">UK Simple Electronic Signature (SES). This certificate records the
signature applied to the document identified below, and the exact bytes it was
applied to.</p>
<table>${rows
    .map(([label, value]) => `<tr><th>${escape(label)}</th><td>${escape(value)}</td></tr>`)
    .join('')}</table>
</body></html>`;
}

/** File a subject's uploaded response (`file_upload` mode). */
const fileResponse: EffectHandler = async (envelope, ctx) => {
  const params = responseParams.parse(envelope.params ?? {});
  const now = new Date();

  const doc = await ctx.db
    .selectFrom('platform.document as d')
    .innerJoin('platform.lookup as c', 'c.id', 'd.category_id')
    .select([
      'd.id',
      'd.subject_person_id',
      'd.response_sp_item_id',
      'd.pending_content',
      'c.code as category_code',
    ])
    .where('d.id', '=', params.documentId)
    .executeTakeFirst();
  if (!doc || doc.response_sp_item_id) return;

  const config = await ctx.db.transaction().execute((trx) => loadDocumentConfig(trx, now));
  if (
    !hasDocumentStore() ||
    !requireDocumentStore().isConfigured() ||
    config.sharePoint.siteId === ''
  ) {
    ctx.logger.info('response filing deferred: SharePoint is not configured yet', {
      documentId: params.documentId,
    });
    return;
  }

  const staged = await ctx.db
    .selectFrom('platform.document')
    .select('pending_content')
    .where('id', '=', params.documentId)
    .executeTakeFirst();
  if (!staged?.pending_content) return;

  const uploaded = await requireDocumentStore().upload({
    siteId: config.sharePoint.siteId,
    driveId: config.sharePoint.driveId,
    path: filingPath(
      config.filing.pathPattern,
      {
        person_id: doc.subject_person_id,
        category_code: doc.category_code,
        document_id: doc.id,
      },
      params.fileName,
    ),
    bytes: new Uint8Array(staged.pending_content),
    contentType: params.contentType,
  });

  await ctx.db
    .transaction()
    .execute((trx) =>
      markResponseFiled(trx, { documentId: params.documentId, itemId: uploaded.itemId }),
    );
};

registerEffect(DOCUMENT_EFFECTS.renderAndFile, renderAndFile);
registerEffect(DOCUMENT_EFFECTS.fileEvidence, fileEvidence);
registerEffect(DOCUMENT_EFFECTS.fileResponse, fileResponse);
