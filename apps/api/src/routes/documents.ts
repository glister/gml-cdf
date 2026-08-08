import { Hono, type Context } from 'hono';
import { appendEvent, db } from '@repo/db';
import {
  hasRole,
  type RoleKey,
  completeDocument,
  documentVisibility,
  loadDocumentConfig,
  visibleCategoryCodes,
  DOCUMENT_EFFECTS,
  DOCUMENT_STREAM_TYPE,
  ROLE_KEYS,
  scopeFor,
  scopePersons,
  type ContextGrant,
} from '@repo/trpc';
import { logger } from '../logger.js';

/**
 * The document engine's binary routes (core plan 11 §5.1).
 *
 * **Why these are Hono routes and not tRPC procedures.** tRPC is a JSON
 * transport; base64-ing a 20 MB PDF through it to hand a browser something it
 * could have streamed is a choice nobody would defend. Everything else about
 * them is identical to a procedure: the same session, the same record scope, the
 * same category visibility, resolved through the same helpers the router uses
 * (`documentAccess`'s parts) so the two surfaces cannot disagree about who may
 * see what.
 *
 * Three routes:
 *
 *  - `GET /documents/:id/content` — the document itself, from SharePoint when
 *    filed and from the staged bytes before that. **The same bytes and the same
 *    hash either way** (§4.6), which is what lets signing proceed during a Graph
 *    outage rather than waiting on it.
 *  - `GET /documents/:id/evidence.pdf` — the filed evidence certificate.
 *  - `POST /documents/:id/response-file` — a `file_upload` response, size- and
 *    type-checked against configuration, staged and then filed by an effect.
 *
 * ## The read that is journalled
 *
 * A **non-subject** streaming a restricted-category document appends
 * `platform.document.content_accessed` with `kind='security'` (ADR-0015). Not
 * every read: the subject reading their own contract is not an access event, and
 * journalling it would bury the ones that matter under the ones that do not.
 */

type Variables = {
  personId: string | null;
  grants: ContextGrant[];
};

export const documentRoutes = new Hono<{ Variables: Variables }>();

/** The caller's active platform roles — what category visibility resolves on. */
function viewerRoles(grants: readonly ContextGrant[], now: Date): RoleKey[] {
  return ROLE_KEYS.filter((role) => hasRole(grants, [role], 'platform', now));
}

interface AccessibleDocument {
  id: string;
  title: string;
  status: string;
  category_code: string;
  subject_person_id: string;
  content_hash: string | null;
  pending_content: Buffer | null;
  sp_site_id: string | null;
  sp_drive_id: string | null;
  sp_item_id: string | null;
  evidence_sp_item_id: string | null;
  issue_mode: string;
  capture_schema_key: string | null;
}

/**
 * Load a document the caller is entitled to, applying record scope and category
 * visibility **in SQL** — the same two predicates the tRPC router applies.
 *
 * Returns `null` for both "no such document" and "not yours", and the caller
 * turns both into 404. A 403 would confirm the document exists, which for a
 * restricted category is itself the disclosure (the plan 04 rule).
 */
async function loadAccessible(
  c: Context<{ Variables: Variables }>,
  documentId: string,
): Promise<{ doc: AccessibleDocument; personId: string; isSubject: boolean } | null> {
  const personId = c.get('personId');
  if (!personId) return null;

  const now = new Date();
  const grants = c.get('grants') ?? [];
  const config = await db.transaction().execute((trx) => loadDocumentConfig(trx, now));
  const categories = await db
    .selectFrom('platform.lookup')
    .select('code')
    .where('list_type', '=', 'document_category')
    .where('deleted_at', 'is', null)
    .execute();

  const allowed = visibleCategoryCodes(
    config,
    viewerRoles(grants, now),
    categories.map((r) => r.code),
  );

  const doc = await db
    .selectFrom('platform.document as d')
    .innerJoin('platform.lookup as c', 'c.id', 'd.category_id')
    .select([
      'd.id',
      'd.title',
      'd.status',
      'd.subject_person_id',
      'd.content_hash',
      'd.pending_content',
      'd.sp_site_id',
      'd.sp_drive_id',
      'd.sp_item_id',
      'd.evidence_sp_item_id',
      'd.issue_mode',
      'd.capture_schema_key',
      'c.code as category_code',
    ])
    .where('d.id', '=', documentId)
    .where('d.deleted_at', 'is', null)
    .where(scopePersons('d.subject_person_id', personId, scopeFor(grants, 'platform', now)))
    .where(documentVisibility('d.subject_person_id', 'c.code', personId, allowed))
    .executeTakeFirst();

  if (!doc) return null;
  return {
    doc: doc as unknown as AccessibleDocument,
    personId,
    isSubject: doc.subject_person_id === personId,
  };
}

/**
 * Journal a restricted-category read by somebody other than the subject.
 *
 * Only when the category is actually restricted — i.e. when the viewer's role
 * set does not cover every category. An unrestricted policy would otherwise
 * journal every HR read of every welcome letter, and a security log that records
 * everything records nothing.
 */
async function journalContentAccess(
  c: Context<{ Variables: Variables }>,
  doc: AccessibleDocument,
  personId: string,
): Promise<void> {
  const now = new Date();
  const grants = c.get('grants') ?? [];
  const roles = viewerRoles(grants, now);
  const config = await db.transaction().execute((trx) => loadDocumentConfig(trx, now));
  const restricted = config.visibility.byCategory[doc.category_code] !== undefined;
  if (!restricted) return;

  await db.transaction().execute((trx) =>
    appendEvent(trx, {
      streamType: DOCUMENT_STREAM_TYPE,
      streamId: doc.id,
      eventType: 'platform.document.content_accessed',
      kind: 'security',
      payload: {
        categoryCode: doc.category_code,
        subjectPersonId: doc.subject_person_id,
        viaRole: roles[0] ?? 'unknown',
      },
      actorPersonId: personId,
      correlationId: c.get('requestId' as never) ?? crypto.randomUUID(),
    }),
  );
}

/**
 * Stream a document's bytes.
 *
 * SharePoint when filed, the staged copy before that — the same bytes and the
 * same hash either way (§4.6). Reading from SharePoint needs the worker's Graph
 * client, which this process does not have (ADR-0017), so a filed document whose
 * staging has been cleared returns 409 with an explanation rather than a broken
 * download. That is a real Phase 1 limitation and is recorded as such rather
 * than papered over: see the plan's Change log.
 */
documentRoutes.get('/documents/:id/content', async (c) => {
  const access = await loadAccessible(c, c.req.param('id'));
  if (!access) return c.json({ error: 'not_found' }, 404);
  const { doc, personId, isSubject } = access;

  if (!isSubject) await journalContentAccess(c, doc, personId);

  if (doc.pending_content) {
    return new Response(new Uint8Array(doc.pending_content), {
      headers: {
        'content-type': 'application/pdf',
        // `inline` so the viewer can embed it; the filename is the id, because
        // a download's filename ends up wherever the browser puts it.
        'content-disposition': `inline; filename="${doc.id}.pdf"`,
        // The hash the client must echo back as `expectedHash` when signing —
        // it is bound to these exact bytes (§4.3).
        'x-document-hash': doc.content_hash ?? '',
        'cache-control': 'private, no-store',
      },
    });
  }

  if (!doc.content_hash) {
    // The render has not finished. The viewer shows "Preparing document…" on
    // this, rather than a broken PDF frame.
    return c.json({ error: 'not_rendered' }, 409);
  }

  logger.warn('document content unavailable in the API process', { documentId: doc.id });
  return c.json(
    {
      error: 'filed_remotely',
      detail:
        'this document is filed to SharePoint and its staged copy has been cleared; streaming filed content is not available in this process',
    },
    409,
  );
});

/** Stream the filed evidence certificate (PL-011). */
documentRoutes.get('/documents/:id/evidence.pdf', async (c) => {
  const access = await loadAccessible(c, c.req.param('id'));
  if (!access) return c.json({ error: 'not_found' }, 404);

  const now = new Date();
  const grants = c.get('grants') ?? [];
  // The evidence pack is an HR/Administrator artefact (§5.1), unlike the
  // document itself which its subject must be able to read.
  if (!hasRole(grants, ['administrator', 'hr_user'], 'platform', now)) {
    return c.json({ error: 'not_found' }, 404);
  }
  if (!access.doc.evidence_sp_item_id) return c.json({ error: 'not_filed' }, 409);

  return c.json(
    {
      error: 'filed_remotely',
      detail:
        'the evidence certificate is filed to SharePoint; use platform.documents.exportEvidence for the machine-readable pack',
    },
    409,
  );
});

/**
 * Upload a `file_upload` response (PL-009).
 *
 * Size and type come from configuration (§6), and the type is checked against
 * the file's **own bytes** rather than the multipart header — a client controls
 * the header, so an allow-list that trusted it would be advice rather than a
 * control.
 */
documentRoutes.post('/documents/:id/response-file', async (c) => {
  const access = await loadAccessible(c, c.req.param('id'));
  if (!access) return c.json({ error: 'not_found' }, 404);
  const { doc, personId, isSubject } = access;

  if (!isSubject) return c.json({ error: 'forbidden' }, 403);
  if (doc.issue_mode !== 'file_upload') {
    return c.json({ error: 'wrong_mode', detail: 'this document does not ask for a file' }, 400);
  }

  const now = new Date();
  const config = await db.transaction().execute((trx) => loadDocumentConfig(trx, now));

  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: 'no_file' }, 400);
  if (file.size > config.responseUpload.maxBytes) {
    return c.json({ error: 'too_large', maxBytes: config.responseUpload.maxBytes }, 413);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffContentType(bytes);
  if (!sniffed || !config.responseUpload.allowedTypes.includes(sniffed)) {
    return c.json(
      {
        error: 'unsupported_type',
        detail: `the file's own bytes read as ${sniffed ?? 'an unrecognised type'}`,
        allowed: config.responseUpload.allowedTypes,
      },
      415,
    );
  }

  const extension = sniffed.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
  const fileName = `${doc.id}-response.${extension}`;
  const correlationId = crypto.randomUUID();

  await db.transaction().execute(async (trx) => {
    // Staged on the row, exactly as a render is, so the upload can be retried
    // from the bytes without asking the person to send them again.
    await trx
      .updateTable('platform.document')
      .set({ pending_content: Buffer.from(bytes) })
      .where('id', '=', doc.id)
      .execute();

    // The completion IS the fact, and filing the uploaded response is its
    // consequence — carried on the completion event so the outbox relay fans it
    // only if the completion actually committed (§4.6).
    await completeDocument(trx, {
      documentId: doc.id,
      action: 'upload',
      ackScrolled: true,
      effects: [
        {
          name: DOCUMENT_EFFECTS.fileResponse,
          params: { documentId: doc.id, contentType: sniffed, fileName },
        },
      ],
      actorPersonId: personId,
      correlationId,
      now,
    });
  });

  return c.json({ ok: true });
});

/**
 * Identify a file from its own leading bytes.
 *
 * A deliberately small set — the four types the default allow-list names. It
 * exists because the multipart `content-type` is whatever the client says, and
 * a `application/pdf` header on a `.exe` is one line of code away for anyone who
 * wants it.
 */
export function sniffContentType(bytes: Uint8Array): string | null {
  const startsWith = (...sig: number[]) => sig.every((byte, i) => bytes[i] === byte);

  if (startsWith(0x25, 0x50, 0x44, 0x46)) return 'application/pdf'; // %PDF
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  // HEIC/HEIF: an ISO-BMFF box whose brand sits at offset 8.
  if (bytes.length > 12) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (['heic', 'heix', 'hevc', 'mif1'].includes(brand)) return 'image/heic';
  }
  return null;
}
