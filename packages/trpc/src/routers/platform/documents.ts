import { TRPCError } from '@trpc/server';
import { sql } from 'kysely';
import { appendEvent } from '@repo/db';
import { hasRole, isDocumentHash, MergeContractError, type RoleKey } from '@repo/domain';
import { protectedProcedure, roleProcedure, router, type TRPCContext } from '../../trpc.js';
import {
  cancelDocumentInput,
  completeDocumentInput,
  documentDetailSchema,
  evidencePackSchema,
  generateDocumentsInput,
  issueDocumentsInput,
  listDocumentsInput,
  listDocumentsOutput,
  signDocumentInput,
  updateDocumentDraftInput,
} from '../../schemas.js';
import { decodeCursor, encodeCursor, keysetBoundary, timestampSortKey } from '../../lib/keyset.js';
import { scopeFor, scopePersons } from '../../lib/scope.js';
import {
  cancelDocument,
  completeDocument,
  documentVisibility,
  generateDocuments,
  isLockedSql,
  issueDocuments,
  loadDocumentConfig,
  recordDocumentView,
  retryFiling,
  signDocument,
  visibleCategoryCodes,
  DocumentForbiddenError,
  DocumentNotFoundError,
  DocumentStateError,
  DOCUMENT_STREAM_TYPE,
} from '../../lib/documents.js';
import { ROLE_KEYS } from '../../lib/constants.js';

/**
 * The document engine's tRPC surface (core plan 11 §5.1, PL-009…012).
 *
 * **Every read applies three filters, and all three are SQL** (ADR-0004,
 * ADR-0015): the caller's record scope (`scopePersons` — self, team, allocated,
 * all), the category visibility their roles confer, and whatever facets the
 * request asked for. None of it happens after the page is fetched, because a
 * keyset page filtered in JavaScript is both a security hole and a broken
 * paginator.
 *
 * **The subject always sees their own documents**, whatever a category's role
 * list says (§8). Not a convenience: a document nobody can open is not a
 * document, and the subject has to be able to sign theirs.
 *
 * Binary content does not travel through tRPC. `GET /documents/:id/content` and
 * `/evidence.pdf` are Hono routes in `apps/api` using these same helpers — tRPC
 * is a JSON transport and base64-ing a 20 MB PDF through it would be a choice
 * nobody would defend.
 */

/** Generate, edit, issue, cancel, export evidence. */
const documentAdmin = roleProcedure(['administrator', 'hr_user'], { module: 'platform' });
/** Retry a failed filing — a configuration-adjacent recovery action. */
const filingAdmin = roleProcedure(['administrator'], { module: 'platform' });

function requireActor(ctx: TRPCContext): string {
  if (!ctx.actorPersonId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The acting user is not linked to a person record',
    });
  }
  return ctx.actorPersonId;
}

/** The caller's active platform roles — what category visibility resolves on. */
function viewerRoles(ctx: TRPCContext, now: Date): RoleKey[] {
  return ROLE_KEYS.filter((role) => hasRole(ctx.grants, [role], 'platform', now));
}

function toTRPCError(error: unknown): unknown {
  if (error instanceof DocumentNotFoundError) {
    return new TRPCError({ code: 'NOT_FOUND', message: error.message });
  }
  if (error instanceof DocumentForbiddenError) {
    return new TRPCError({ code: 'FORBIDDEN', message: error.message });
  }
  if (error instanceof DocumentStateError || error instanceof MergeContractError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  return error;
}

const SORT_COLUMNS = {
  created_at: 'd.created_at',
  issued_at: 'd.issued_at',
  title: 'd.title',
  status: 'd.status',
} as const;

/**
 * Everything a read needs to know about the caller: their record scope, and the
 * category codes their roles allow.
 *
 * Resolved once per request rather than per row, and returned as data the query
 * turns into predicates — so the same answer governs the list, the single read
 * and the content stream, and they cannot disagree about who may see what.
 */
export async function documentAccess(ctx: TRPCContext, now: Date) {
  const actor = requireActor(ctx);
  const config = await ctx.db.transaction().execute((trx) => loadDocumentConfig(trx, now));
  const categories = await ctx.db
    .selectFrom('platform.lookup')
    .select('code')
    .where('list_type', '=', 'document_category')
    .where('deleted_at', 'is', null)
    .execute();

  return {
    actor,
    config,
    scope: scopeFor(ctx.grants, 'platform', now),
    allowedCategoryCodes: visibleCategoryCodes(
      config,
      viewerRoles(ctx, now),
      categories.map((c) => c.code),
    ),
  };
}

export const documentsRouter = router({
  /**
   * A subject's documents, keyset-paged.
   *
   * `isLocked` is computed in SQL over the whole ordered group — the fact that
   * makes ordered issue real rather than advisory. Computing it from the loaded
   * page would report every document on page two unlocked.
   */
  listForSubject: protectedProcedure
    .input(listDocumentsInput)
    .output(listDocumentsOutput)
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const access = await documentAccess(ctx, now);
      const direction = input.sortDir;
      const sortColumn = SORT_COLUMNS[input.sort];
      const sortKey =
        input.sort === 'created_at' || input.sort === 'issued_at'
          ? timestampSortKey(sortColumn)
          : sql<string>`coalesce(${sql.ref(sortColumn)}, '')`;

      let query = ctx.db
        .selectFrom('platform.document as d')
        .innerJoin('platform.lookup as c', 'c.id', 'd.category_id')
        .leftJoin('platform.template as t', 't.id', 'd.template_id')
        .select([
          'd.id',
          'd.title',
          'd.issue_mode',
          'd.status',
          'd.filing_state',
          'd.subject_person_id',
          'd.issue_group_id',
          'd.sequence_no',
          'd.content_hash',
          'd.issued_at',
          'd.viewed_at',
          'd.signed_at',
          'd.completed_at',
          'd.completed_by',
          'd.created_at',
          'c.code as category_code',
          'c.label as category_label',
          't.template_key as template_key',
          't.version as template_version',
        ])
        .select(isLockedSql('d').as('is_locked'))
        .where('d.deleted_at', 'is', null)
        // Record scope, applied inside the query (ADR-0015).
        .where(scopePersons('d.subject_person_id', access.actor, access.scope))
        // Category visibility, or their own document (PL-012, §8).
        .where(
          documentVisibility(
            'd.subject_person_id',
            'c.code',
            access.actor,
            access.allowedCategoryCodes,
          ),
        );

      // Omitted subject means "mine" — the self case without the client having
      // to name itself, which is also the shape the mobile app wants.
      query = query.where('d.subject_person_id', '=', input.subjectPersonId ?? access.actor);

      if (input.status) query = query.where('d.status', 'in', input.status);
      if (input.filingState) query = query.where('d.filing_state', 'in', input.filingState);
      if (input.categoryId) query = query.where('d.category_id', '=', input.categoryId);
      if (input.search) query = query.where(sql`d.title`, 'ilike', `%${input.search}%`);
      if (input.outstandingOnly) {
        // The same definition of outstanding the reminder check uses
        // (`isOutstanding` in `@repo/domain`) — one meaning of done, expressed
        // in two languages rather than two meanings.
        query = query
          .where('d.completed_at', 'is', null)
          .where('d.status', 'in', ['issued', 'viewed']);
      }

      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      if (cursor) query = query.where(keysetBoundary(sortKey, 'd.id', cursor, direction));

      const rows = await query
        .orderBy(sortKey, direction)
        .orderBy('d.id', direction)
        .limit(input.limit + 1)
        .execute();

      const page = rows.slice(0, input.limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > input.limit && last
          ? encodeCursor({ key: sortKeyValue(last, input.sort), id: last.id })
          : null;

      return { items: page.map(toSummary), nextCursor };
    }),

  /** One document's metadata and status, record-scoped. */
  get: protectedProcedure
    .input(documentDetailSchema.pick({ id: true }))
    .output(documentDetailSchema)
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const access = await documentAccess(ctx, now);

      const row = await ctx.db
        .selectFrom('platform.document as d')
        .innerJoin('platform.lookup as c', 'c.id', 'd.category_id')
        .leftJoin('platform.template as t', 't.id', 'd.template_id')
        .selectAll('d')
        .select([
          'c.code as category_code',
          'c.label as category_label',
          't.template_key as template_key',
          't.version as template_version',
        ])
        .select(isLockedSql('d').as('is_locked'))
        .where('d.id', '=', input.id)
        .where('d.deleted_at', 'is', null)
        .where(scopePersons('d.subject_person_id', access.actor, access.scope))
        .where(
          documentVisibility(
            'd.subject_person_id',
            'c.code',
            access.actor,
            access.allowedCategoryCodes,
          ),
        )
        .executeTakeFirst();

      // NOT_FOUND, not FORBIDDEN: telling an unauthorised caller that a document
      // exists is itself a disclosure (the plan 04 rule).
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such document' });

      return {
        ...toSummary(row),
        bodyHtml: row.body_html,
        contentHash: row.content_hash,
        captureSchemaKey: row.capture_schema_key,
        captureData: (row.capture_data ?? null) as Record<string, unknown> | null,
        textResponse: row.text_response,
        spWebUrl: row.sp_web_url,
        filingAttempts: row.filing_attempts,
        filingError: row.filing_error,
        cancelReason: row.cancel_reason,
        requireScrollAck: access.config.sign.requireScrollAck,
      };
    }),

  /** Create drafts from published templates, pre-filled (ON-012 driver). */
  generate: documentAdmin.input(generateDocumentsInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    const now = new Date();
    try {
      const created = await ctx.db.transaction().execute((trx) =>
        generateDocuments(trx, {
          subjectPersonId: input.subjectPersonId,
          items: input.items,
          streamRef: input.streamRef,
          actorPersonId: actor,
          correlationId: ctx.correlationId,
          now,
        }),
      );
      return { ids: created.map((d) => d.id) };
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /** Free edit of a draft before issue (ON-013 driver). */
  updateDraft: documentAdmin.input(updateDocumentDraftInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    try {
      await ctx.db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('platform.document')
          .select(['id', 'status'])
          .where('id', '=', input.id)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw new DocumentNotFoundError(input.id);
        if (row.status !== 'draft') {
          throw new DocumentStateError(
            'only a draft can be edited — an issued document may already have been read',
          );
        }
        await trx
          .updateTable('platform.document')
          .set({
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.bodyHtml !== undefined ? { body_html: input.bodyHtml } : {}),
            updated_by: actor,
          })
          .where('id', '=', input.id)
          .execute();
      });
      return { ok: true };
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /** Issue drafts — phase one of the two-phase design (§4.6). */
  issue: documentAdmin.input(issueDocumentsInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    const now = new Date();
    try {
      const issued = await ctx.db.transaction().execute((trx) =>
        issueDocuments(trx, {
          documentIds: input.documentIds,
          issueMode: input.issueMode,
          ordered: input.ordered,
          actorPersonId: actor,
          correlationId: ctx.correlationId,
          now,
        }),
      );
      return { ids: issued.map((d) => d.id), issueGroupId: issued[0]?.issue_group_id ?? null };
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /** The first-view transition, called by the viewer screen (ON-016). */
  recordView: protectedProcedure
    .input(documentDetailSchema.pick({ id: true }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireActor(ctx);
      const now = new Date();
      try {
        const doc = await ctx.db.transaction().execute(async (trx) => {
          const row = await trx
            .selectFrom('platform.document')
            .select(['subject_person_id'])
            .where('id', '=', input.id)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
          if (!row) throw new DocumentNotFoundError(input.id);
          if (row.subject_person_id !== actor) {
            // Only the subject's view is the ON-016 status fact. HR reading a
            // document is a read, not a milestone — recording it as one would
            // mark documents viewed before the person ever opened them.
            throw new DocumentForbiddenError('only the subject’s own view is recorded');
          }
          return recordDocumentView(trx, {
            documentId: input.id,
            actorPersonId: actor,
            correlationId: ctx.correlationId,
            now,
          });
        });
        return { status: doc.status };
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  /** Capture a UK SES signature: evidence, status and events in one tx (§4.7). */
  sign: protectedProcedure.input(signDocumentInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    const now = new Date();
    try {
      return await ctx.db.transaction().execute(async (trx) => {
        const config = await loadDocumentConfig(trx, now);
        const { document, signatureEvidenceId } = await signDocument(
          trx,
          {
            documentId: input.documentId,
            method: input.method,
            typedName: input.typedName,
            expectedHash: input.expectedHash,
            ackScrolled: input.ackScrolled,
            captureData: input.captureData ?? undefined,
            // The request's own facts, taken server-side. A client-supplied IP
            // or user-agent would be evidence of what the client claimed rather
            // than of what happened — and `signDocument` refuses outright when
            // the address is unknown rather than recording a placeholder.
            ip: ctx.requestIp ?? '',
            userAgent: ctx.userAgent ?? 'unknown',
            signatoryPersonId: actor,
            correlationId: ctx.correlationId,
            now,
          },
          config,
        );
        return { status: document.status, signatureEvidenceId };
      });
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /** The five non-signature completion actions (PL-009 controlled responses). */
  complete: protectedProcedure.input(completeDocumentInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    const now = new Date();
    try {
      const doc = await ctx.db.transaction().execute((trx) =>
        completeDocument(trx, {
          documentId: input.documentId,
          action: input.action,
          captureData: input.captureData ?? undefined,
          textResponse: input.textResponse ?? null,
          ackScrolled: input.ackScrolled,
          actorPersonId: actor,
          correlationId: ctx.correlationId,
          now,
        }),
      );
      return { status: doc.status, completedAt: doc.completed_at };
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /** Withdraw an unsigned document. Superseded, never deleted (§7). */
  cancel: documentAdmin.input(cancelDocumentInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    const now = new Date();
    try {
      await ctx.db.transaction().execute((trx) =>
        cancelDocument(trx, {
          documentId: input.documentId,
          reason: input.reason,
          actorPersonId: actor,
          correlationId: ctx.correlationId,
          now,
        }),
      );
      return { ok: true };
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /**
   * The evidence pack (§4.1, PL-011; ON-020 driver).
   *
   * The recomputation is what makes this evidence rather than a report. The
   * export reads the bytes as they stand **now**, hashes them, and reports
   * whether that matches both `document.content_hash` and the evidence row's
   * `document_hash`. A pack that simply echoed the stored hash would prove only
   * that two columns agree with each other.
   *
   * When the bytes live in SharePoint and cannot be reached from this process,
   * `hashMatches` is false with a `note` saying why — never silently true. An
   * unverifiable claim reported as verified is worse than an honest gap.
   */
  exportEvidence: documentAdmin
    .input(documentDetailSchema.pick({ id: true }))
    .output(evidencePackSchema)
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const actor = requireActor(ctx);

      const doc = await ctx.db
        .selectFrom('platform.document as d')
        .innerJoin('platform.lookup as c', 'c.id', 'd.category_id')
        .leftJoin('platform.template as t', 't.id', 'd.template_id')
        .selectAll('d')
        .select([
          'c.code as category_code',
          't.template_key as template_key',
          't.version as template_version',
        ])
        .where('d.id', '=', input.id)
        .where('d.deleted_at', 'is', null)
        .executeTakeFirst();
      if (!doc) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such document' });

      const evidence = await ctx.db
        .selectFrom('platform.signature_evidence')
        .selectAll()
        .where('document_id', '=', input.id)
        .orderBy('signed_at', 'desc')
        .executeTakeFirst();

      const events = await ctx.db
        .selectFrom('platform.domain_event')
        .select(['event_type', 'occurred_at', 'actor_person_id'])
        .where('stream_type', '=', DOCUMENT_STREAM_TYPE)
        .where('stream_id', '=', input.id)
        .orderBy('occurred_at', 'asc')
        .orderBy('id', 'asc')
        .execute();

      const verification = await verifyStoredBytes(ctx, doc, evidence?.document_hash ?? null);

      await ctx.db.transaction().execute((trx) =>
        appendEvent(trx, {
          streamType: DOCUMENT_STREAM_TYPE,
          streamId: input.id,
          eventType: 'platform.document.evidence_exported',
          // Security, not domain: exporting an evidence pack is an access event
          // an auditor asks about (ADR-0015).
          kind: 'security',
          payload: {
            signatureEvidenceId: evidence?.id ?? null,
            hashMatches: verification.hashMatches,
          },
          actorPersonId: actor,
          correlationId: ctx.correlationId,
        }),
      );
      void now;

      return {
        document: {
          id: doc.id,
          title: doc.title,
          category: doc.category_code,
          templateKey: doc.template_key,
          templateVersion: doc.template_version,
          contentHash: doc.content_hash,
          sharepoint: {
            siteId: doc.sp_site_id,
            driveId: doc.sp_drive_id,
            itemId: doc.sp_item_id,
            webUrl: doc.sp_web_url,
          },
        },
        issue: {
          issuedBy: doc.issued_by,
          issuedAt: doc.issued_at ? new Date(doc.issued_at).toISOString() : null,
          issueMode: doc.issue_mode,
        },
        signature: evidence
          ? {
              signatoryPersonId: evidence.signatory_person_id,
              method: evidence.method,
              typedName: evidence.typed_name,
              signedAt: new Date(evidence.signed_at).toISOString(),
              ip: String(evidence.ip),
              userAgent: evidence.user_agent,
              ackScrolled: evidence.ack_scrolled,
              documentHash: evidence.document_hash,
            }
          : null,
        events: events.map((e) => ({
          eventType: e.event_type,
          occurredAt: new Date(e.occurred_at).toISOString(),
          actorPersonId: e.actor_person_id,
        })),
        verification,
      };
    }),

  /** Re-enqueue a failed filing (§5.1, admin recovery). */
  retryFiling: filingAdmin
    .input(documentDetailSchema.pick({ id: true }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireActor(ctx);
      try {
        await ctx.db.transaction().execute((trx) =>
          retryFiling(trx, {
            documentId: input.id,
            actorPersonId: actor,
            correlationId: ctx.correlationId,
          }),
        );
        return { ok: true };
      } catch (error) {
        throw toTRPCError(error);
      }
    }),
});

/**
 * Recompute the hash over the bytes as they stand now (AC-D2).
 *
 * Only the staged bytes are reachable from this process — SharePoint content is
 * the worker's to fetch (ADR-0017). When a document has been filed and its
 * staging cleared, the pack says so in `note` rather than claiming a match it
 * did not perform.
 */
async function verifyStoredBytes(
  ctx: TRPCContext,
  doc: { id: string; content_hash: string | null; pending_content: Buffer | null },
  evidenceHash: string | null,
): Promise<{ hashRecomputedAtExport: boolean; hashMatches: boolean; note: string | null }> {
  if (!doc.content_hash) {
    return {
      hashRecomputedAtExport: false,
      hashMatches: false,
      note: 'this document has not been rendered yet, so there are no bytes to verify',
    };
  }

  const staged = await ctx.db
    .selectFrom('platform.document')
    .select('pending_content')
    .where('id', '=', doc.id)
    .executeTakeFirst();

  if (!staged?.pending_content) {
    return {
      hashRecomputedAtExport: false,
      hashMatches: false,
      note: 'the document is filed to SharePoint; its bytes are not reachable from this process, so the hash was not recomputed here',
    };
  }

  const { computeDocumentHash } = await import('../../lib/document-hash.js');
  const recomputed = computeDocumentHash(new Uint8Array(staged.pending_content));
  const matches =
    isDocumentHash(recomputed) &&
    recomputed === doc.content_hash &&
    (evidenceHash === null || recomputed === evidenceHash);

  return {
    hashRecomputedAtExport: true,
    hashMatches: matches,
    note: matches ? null : 'the stored bytes do not hash to the recorded document hash',
  };
}

interface SummaryRow {
  id: string;
  title: string;
  issue_mode: string;
  status: string;
  filing_state: string;
  subject_person_id: string;
  issue_group_id: string | null;
  sequence_no: number | null;
  content_hash: string | null;
  issued_at: Date | string | null;
  viewed_at: Date | string | null;
  signed_at: Date | string | null;
  completed_at: Date | string | null;
  completed_by: string | null;
  created_at: Date | string;
  category_code: string;
  category_label: string;
  template_key: string | null;
  template_version: number | null;
  is_locked: boolean | null;
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toSummary(row: SummaryRow) {
  return {
    id: row.id,
    title: row.title,
    categoryCode: row.category_code,
    categoryLabel: row.category_label,
    issueMode: row.issue_mode as never,
    status: row.status as never,
    filingState: row.filing_state as never,
    subjectPersonId: row.subject_person_id,
    templateKey: row.template_key,
    templateVersion: row.template_version,
    issueGroupId: row.issue_group_id,
    sequenceNo: row.sequence_no,
    isLocked: Boolean(row.is_locked),
    // "Preparing document…" is a real state the viewer shows, and this is what
    // it keys on: the render step has not set a hash yet (§4.6).
    isRendered: row.content_hash !== null,
    issuedAt: iso(row.issued_at),
    viewedAt: iso(row.viewed_at),
    signedAt: iso(row.signed_at),
    completedAt: iso(row.completed_at),
    completedBy: row.completed_by,
    createdAt: iso(row.created_at)!,
  };
}

function sortKeyValue(row: SummaryRow, sort: keyof typeof SORT_COLUMNS): string {
  switch (sort) {
    case 'created_at':
      return new Date(row.created_at).toISOString().replace('Z', '').padEnd(26, '0');
    case 'issued_at':
      return row.issued_at
        ? new Date(row.issued_at).toISOString().replace('Z', '').padEnd(26, '0')
        : '';
    case 'title':
      return row.title;
    case 'status':
      return row.status;
  }
}
