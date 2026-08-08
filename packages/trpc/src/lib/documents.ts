import { sql, type Expression, type RawBuilder, type SqlBool, type Transaction } from 'kysely';
import { appendEvent, newUuidV7, type DB, type DocumentRecord } from '@repo/db';
import {
  deriveMergeFields,
  evaluateCompleteGuards,
  evaluateSignGuards,
  isSequenceLocked,
  mergeTemplate,
  requireCaptureSchema,
  stampOnComplete,
  stampOnFirstView,
  stampOnIssue,
  stampOnSign,
  validateCaptureData,
  type CompletionAction,
  type DocumentGuardResult,
  type IssueMode,
  type RoleKey,
} from '@repo/domain';
import { requestNotification, scheduleReminder, cancelReminders } from './notify.js';
import {
  notificationsDefaultReminderCadence,
  qualifiedName,
  documentsCategoryVisibility,
  documentsCategoryVisibilityDefault,
  documentsFilingMaxAttempts,
  documentsFilingPathPattern,
  documentsResponseUploadAllowedTypes,
  documentsResponseUploadMaxBytes,
  documentsSharePointDriveId,
  documentsSharePointSiteId,
  documentsSignRequireScrollAck,
  getConfig,
} from '@repo/config';

/**
 * The document engine's transactional core (core plan 11 §4.6/§4.7) — the single
 * write path for `platform.template`, `platform.document` and
 * `platform.signature_evidence` (ADR-0022).
 *
 * Every function takes a `Transaction<DB>` rather than the root instance, and
 * that is structural rather than conventional (ADR-0010). A signature and the
 * evidence recording it are **one fact**: an evidence row committed without the
 * status change is a signature nobody can find, and a status change committed
 * without the evidence row is a signature that cannot be proven. Passing the
 * root instance is a type error.
 *
 * ## Two callers, one set of rules
 *
 * The `platform.documents.*` procedures and the worker's `document.*` effect
 * handlers both come through here. The worker in particular never writes
 * `filing_state` itself — `markFiled` and `markFilingFailed` are the only paths,
 * so "what does filed mean?" has one answer and the journal event cannot be
 * forgotten on one of them.
 *
 * ## Where decisions live
 *
 * Guards are evaluated in `@repo/domain` (`evaluateSignGuards`,
 * `evaluateCompleteGuards`, `isSequenceLocked`); this layer resolves
 * configuration as-at, reads and writes rows, and journals. The one thing it
 * does **not** delegate is the sequence-lock *count*: that is a fact about other
 * rows, so it is computed in SQL over the whole group and handed to the pure
 * predicate (§4.3, ADR-0004).
 */

// --- Errors ------------------------------------------------------------------

/** No such document/template, or none the caller may see (→ NOT_FOUND). */
export class DocumentNotFoundError extends Error {
  constructor(readonly id: string) {
    super('No such document');
    this.name = 'DocumentNotFoundError';
  }
}

/** The actor may not take this action on this document (→ FORBIDDEN). */
export class DocumentForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentForbiddenError';
  }
}

/** A guard refused, or the request does not describe a legal action. */
export class DocumentStateError extends Error {
  constructor(
    message: string,
    readonly failure?: string,
  ) {
    super(message);
    this.name = 'DocumentStateError';
  }
}

function requireOk(result: DocumentGuardResult): void {
  if (!result.ok) throw new DocumentStateError(result.message, result.failure);
}

// --- Constants ---------------------------------------------------------------

/** The stream a document's own events hang on (ADR-0021). */
export const DOCUMENT_STREAM_TYPE = 'platform.document';
/** The stream a template's events hang on. */
export const TEMPLATE_STREAM_TYPE = 'platform.template';

/** Effect names, exported so a conformance test can assert registration. */
export const DOCUMENT_EFFECTS = {
  renderAndFile: 'document.render_and_file',
  fileEvidence: 'document.file_evidence',
  fileResponse: 'document.file_response',
} as const;

/** The reminder kind that chases an outstanding document (§9.5). */
export const DOCUMENT_REMINDER_KIND = 'document.outstanding';

// --- Configuration -----------------------------------------------------------

export interface DocumentEngineConfig {
  sharePoint: { siteId: string; driveId: string };
  filing: { pathPattern: string; maxAttempts: number };
  sign: { requireScrollAck: boolean };
  visibility: { byCategory: Record<string, readonly string[]>; fallback: readonly string[] };
  responseUpload: { maxBytes: number; allowedTypes: readonly string[] };
}

/**
 * Every decision point this engine reads, resolved **as-at `at` inside the
 * caller's transaction**, so a filing path and the document it produced are
 * consistent and re-reading the journal with the same instant reproduces it
 * (ADR-0016).
 */
export async function loadDocumentConfig(
  trx: Transaction<DB>,
  at: Date,
): Promise<DocumentEngineConfig> {
  const [
    siteId,
    driveId,
    pathPattern,
    maxAttempts,
    requireScrollAck,
    byCategory,
    fallback,
    maxBytes,
    allowedTypes,
  ] = await Promise.all([
    getConfig(trx, documentsSharePointSiteId, { at }),
    getConfig(trx, documentsSharePointDriveId, { at }),
    getConfig(trx, documentsFilingPathPattern, { at }),
    getConfig(trx, documentsFilingMaxAttempts, { at }),
    getConfig(trx, documentsSignRequireScrollAck, { at }),
    getConfig(trx, documentsCategoryVisibility, { at }),
    getConfig(trx, documentsCategoryVisibilityDefault, { at }),
    getConfig(trx, documentsResponseUploadMaxBytes, { at }),
    getConfig(trx, documentsResponseUploadAllowedTypes, { at }),
  ]);

  return {
    sharePoint: { siteId, driveId },
    filing: { pathPattern, maxAttempts },
    sign: { requireScrollAck },
    visibility: { byCategory, fallback },
    responseUpload: { maxBytes, allowedTypes },
  };
}

/** Whether SharePoint filing is configured at all (§12.2 Q4, R1). */
export function isFilingConfigured(config: DocumentEngineConfig): boolean {
  return config.sharePoint.siteId !== '' && config.sharePoint.driveId !== '';
}

// --- Category visibility (PL-012) --------------------------------------------

/**
 * The category codes a viewer may see, given their roles.
 *
 * Deny-by-default: a category with no explicit entry falls back to the
 * configured default (Administrator and HR), so adding a lookup value never
 * silently exposes it. Returns `null` for "every category", which the caller
 * turns into no predicate at all rather than an `IN` list of everything.
 */
export function visibleCategoryCodes(
  config: DocumentEngineConfig,
  viewerRoles: readonly RoleKey[],
  allCategoryCodes: readonly string[],
): string[] | null {
  const roles = new Set<string>(viewerRoles);
  const allowed = allCategoryCodes.filter((code) => {
    const list = config.visibility.byCategory[code] ?? config.visibility.fallback;
    return list.some((role) => roles.has(role));
  });
  return allowed.length === allCategoryCodes.length ? null : allowed;
}

/**
 * The document-visibility predicate: a category the viewer's roles allow, **or**
 * their own document.
 *
 * The subject clause is not a convenience. A document nobody can open is not a
 * document, and the subject has to be able to sign theirs regardless of which
 * roles a category is restricted to (§8). The one case that would want the
 * opposite — HR-only attachments the subject must not see — is Q7, still open.
 */
export function documentVisibility(
  subjectColumn: string,
  categoryCodeColumn: string,
  viewerPersonId: string,
  allowedCategoryCodes: string[] | null,
): Expression<SqlBool> {
  if (allowedCategoryCodes === null) return sql<SqlBool>`true`;
  if (allowedCategoryCodes.length === 0) {
    return sql<SqlBool>`${sql.ref(subjectColumn)} = ${viewerPersonId}`;
  }
  return sql<SqlBool>`(
    ${sql.ref(subjectColumn)} = ${viewerPersonId}
    OR ${sql.ref(categoryCodeColumn)} = ANY(${sql.val(allowedCategoryCodes)}::text[])
  )`;
}

// --- The sequence lock, in SQL (§4.3) ----------------------------------------

/**
 * How many documents earlier in this one's ordered group are still outstanding.
 *
 * A correlated subquery, so the answer is over the **whole group** rather than
 * over whatever the current keyset page happens to contain. Computing this in
 * JavaScript from a fetched page is the exact mistake the data-tables rule
 * exists to prevent: page two of a document list would report every document
 * unlocked.
 *
 * `completed_at IS NULL` is the definition of outstanding, matching
 * `isOutstanding` in `@repo/domain` — one definition of done, in two languages.
 */
export function precedingIncompleteSql(alias: string): RawBuilder<number> {
  return sql<number>`(
    SELECT count(*)::int FROM platform.document prior
    WHERE prior.issue_group_id = ${sql.ref(`${alias}.issue_group_id`)}
      AND prior.sequence_no < ${sql.ref(`${alias}.sequence_no`)}
      AND prior.completed_at IS NULL
      AND prior.status <> 'cancelled'
      AND prior.deleted_at IS NULL
  )`;
}

/** The `is_locked` column every document read selects (§5.1). */
export function isLockedSql(alias: string): RawBuilder<boolean> {
  return sql<boolean>`(
    ${sql.ref(`${alias}.issue_group_id`)} IS NOT NULL
    AND ${precedingIncompleteSql(alias)} > 0
  )`;
}

// --- Reads -------------------------------------------------------------------

interface DocumentRow extends DocumentRecord {
  category_code: string;
  preceding_incomplete: number;
  template_key: string | null;
  template_version: number | null;
}

/** Load a document with the joined facts every guard and every write needs. */
export async function loadDocument(
  trx: Transaction<DB>,
  documentId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<DocumentRow> {
  let query = trx
    .selectFrom('platform.document as d')
    .innerJoin('platform.lookup as c', 'c.id', 'd.category_id')
    .leftJoin('platform.template as t', 't.id', 'd.template_id')
    .selectAll('d')
    .select([
      'c.code as category_code',
      't.template_key as template_key',
      't.version as template_version',
    ])
    .select(precedingIncompleteSql('d').as('preceding_incomplete'))
    .where('d.id', '=', documentId)
    .where('d.deleted_at', 'is', null);

  // The row lock is what makes "first completion wins" true under concurrency —
  // two tabs pressing sign at the same instant produce one evidence row, not two
  // (the same discipline core plan 09 applies to a decision).
  //
  // `OF d` is required, not stylistic: the template join is an outer one, and
  // Postgres refuses `FOR UPDATE` over the nullable side of it. Locking only the
  // document is also what we actually want — a template must not be blocked by
  // somebody signing a document that pinned it.
  if (opts.forUpdate) query = query.forUpdate('d');

  const row = await query.executeTakeFirst();
  if (!row) throw new DocumentNotFoundError(documentId);
  return row as unknown as DocumentRow;
}

function sequenceInput(row: DocumentRow) {
  return {
    inGroup: row.issue_group_id !== null,
    precedingIncomplete: Number(row.preceding_incomplete ?? 0),
  };
}

// --- Generate (§5.1, ON-012 driver) ------------------------------------------

export interface GenerateItem {
  templateId: string;
  title?: string;
  mergeData: unknown;
}

export interface GenerateDocumentsArgs {
  subjectPersonId: string;
  items: readonly GenerateItem[];
  streamRef?: { streamType: string; streamId: string } | null;
  actorPersonId: string;
  correlationId: string;
  now: Date;
}

/**
 * Create draft documents from published template versions.
 *
 * The merge bag is validated and **the parsed result** is what lands in
 * `merge_data` — snapshot-on-use (ADR-0012) of what the schemas accepted, not of
 * what the caller passed. `capture_schema_key` is copied from the template at
 * this moment rather than read through the template later, because a document
 * must keep asking the questions it was generated with even if the template
 * family moves on.
 */
export async function generateDocuments(
  trx: Transaction<DB>,
  args: GenerateDocumentsArgs,
): Promise<DocumentRecord[]> {
  const created: DocumentRecord[] = [];

  for (const item of args.items) {
    const template = await trx
      .selectFrom('platform.template as t')
      .innerJoin('platform.lookup as c', 'c.id', 't.category_id')
      .selectAll('t')
      .select('c.code as category_code')
      .where('t.id', '=', item.templateId)
      .where('t.deleted_at', 'is', null)
      .executeTakeFirst();

    if (!template) throw new DocumentNotFoundError(item.templateId);
    if (template.status !== 'published') {
      // A draft template has not been validated against its contexts and an
      // archived one was deliberately retired. Neither is a thing to issue.
      throw new DocumentStateError(
        `template '${template.template_key}' v${template.version} is ${template.status}, so nothing can be generated from it`,
      );
    }

    // The platform supplies its own contexts (§4.5). `person` is the one it
    // owns, so the caller never assembles profile data and posts it back — which
    // is both a round trip nobody needs and the shape ADR-0019 exists to
    // discourage. A consuming module's context (`employee`, later) is supplied
    // by that module, which is why the caller's bag wins where both have a value.
    const bag = await withPlatformContexts(
      trx,
      template.merge_contexts,
      args.subjectPersonId,
      item.mergeData,
    );

    const { html, mergeData } = mergeTemplate(template.body_html, template.merge_contexts, bag);

    const id = newUuidV7();
    const row = await trx
      .insertInto('platform.document')
      .values({
        id,
        title: item.title ?? template.name,
        category_id: template.category_id,
        template_id: template.id,
        issue_mode: template.default_issue_mode,
        status: 'draft',
        subject_person_id: args.subjectPersonId,
        subject_stream_type: args.streamRef?.streamType ?? null,
        subject_stream_id: args.streamRef?.streamId ?? null,
        merge_data: JSON.stringify(mergeData) as never,
        body_html: html,
        // Copied, not referenced: the questions a document asks are fixed when
        // it is generated, whatever the template does afterwards.
        capture_schema_key: template.capture_schema_key,
        created_by: args.actorPersonId,
        updated_by: args.actorPersonId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await appendEvent(trx, {
      streamType: DOCUMENT_STREAM_TYPE,
      streamId: id,
      eventType: 'platform.document.generated',
      payload: {
        templateId: template.id,
        templateKey: template.template_key,
        templateVersion: template.version,
        categoryCode: template.category_code,
        subjectPersonId: args.subjectPersonId,
        issueMode: template.default_issue_mode,
      },
      actorPersonId: args.actorPersonId,
      correlationId: args.correlationId,
    });

    created.push(row);
  }

  return created;
}

/**
 * Fill in the contexts the platform itself owns, leaving the rest to the caller.
 *
 * Only `person` today — read from `platform.person` at generation time and
 * snapshotted onto the document, so a later name change does not rewrite a
 * letter somebody already signed (ADR-0012).
 *
 * A caller-supplied value for the same context wins. That matters for the HR
 * plans: when the employee plan registers an `employee` context it supplies it
 * itself, and a module that has a better answer for `person` than the base
 * record should be able to say so.
 */
async function withPlatformContexts(
  trx: Transaction<DB>,
  declaredContexts: readonly string[],
  subjectPersonId: string,
  supplied: unknown,
): Promise<Record<string, unknown>> {
  const bag = { ...((supplied as Record<string, unknown> | null | undefined) ?? {}) };
  if (!declaredContexts.includes('person') || bag.person !== undefined) return bag;

  const person = await trx
    .selectFrom('platform.person')
    .select(['display_name', 'given_name', 'family_name', 'contact_email'])
    .where('id', '=', subjectPersonId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();

  if (!person) throw new DocumentNotFoundError(subjectPersonId);

  // Exactly the four fields `personMergeContext` declares. Adding a fifth here
  // without adding it there fails validation, which is the point of the context
  // being strict.
  bag.person = {
    full_name: person.display_name,
    first_name: person.given_name,
    last_name: person.family_name,
    email: person.contact_email,
  };
  return bag;
}

// --- Issue (§4.6) ------------------------------------------------------------

export interface IssueDocumentsArgs {
  documentIds: readonly string[];
  issueMode?: IssueMode;
  ordered: boolean;
  actorPersonId: string;
  correlationId: string;
  now: Date;
}

/**
 * Issue drafts — phase one of the two-phase design (§4.6).
 *
 * The transaction sets `issued`, marks filing `pending`, journals, and **enqueues
 * the render effect via the event payload**. Nothing talks to Gotenberg or Graph
 * here: a render inside a request would put a third party's latency inside a
 * database transaction, and a failed one would roll back an issue that had
 * already been decided.
 *
 * `ordered: true` makes the supplied array the sequence. The ids' order is the
 * contract — an ordered issue whose order came from a `Set` iteration or a
 * database default would lock people out of documents in an arbitrary sequence.
 */
export async function issueDocuments(
  trx: Transaction<DB>,
  args: IssueDocumentsArgs,
): Promise<DocumentRecord[]> {
  const groupId = args.ordered ? newUuidV7() : null;
  const issued: DocumentRecord[] = [];

  for (const [index, documentId] of args.documentIds.entries()) {
    const doc = await loadDocument(trx, documentId, { forUpdate: true });
    if (doc.status !== 'draft') {
      throw new DocumentStateError(
        `document ${documentId} is '${doc.status}' and can no longer be issued`,
      );
    }

    const mode = args.issueMode ?? doc.issue_mode;
    const stamp = stampOnIssue(mode, args.now);

    const row = await trx
      .updateTable('platform.document')
      .set({
        status: stamp.status,
        issue_mode: mode,
        filing_state: 'pending',
        issued_at: args.now,
        issued_by: args.actorPersonId,
        issue_group_id: groupId,
        sequence_no: groupId ? index + 1 : null,
        completed_at: stamp.completedAt,
        completed_by: stamp.completes ? args.actorPersonId : null,
        updated_by: args.actorPersonId,
      })
      .where('id', '=', documentId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await appendEvent(trx, {
      streamType: DOCUMENT_STREAM_TYPE,
      streamId: documentId,
      eventType: 'platform.document.issued',
      payload: {
        categoryCode: doc.category_code,
        subjectPersonId: doc.subject_person_id,
        issueMode: mode,
        issueGroupId: groupId,
        sequenceNo: groupId ? index + 1 : null,
        // The outbox record. The relay fans this onto the `effects` queue after
        // the caller's transaction commits, so the render can never be split
        // from the issue that asked for it (the 2026-08-07 fan-out rule).
        effects: [{ name: DOCUMENT_EFFECTS.renderAndFile, params: { documentId } }],
      },
      actorPersonId: args.actorPersonId,
      correlationId: args.correlationId,
    });

    // Tell the subject, and start chasing them (§9.5, ON AC-6 driver). Both in
    // this transaction: a document issued without its notification is one
    // nobody knows about, and the notification service exists so that cannot
    // happen by omission (ADR-0022).
    //
    // Skipped for `no_action` — it is already complete, so there is nothing to
    // ask for and nothing to chase.
    if (!stamp.completes) {
      await requestNotification(trx, {
        kind: 'document.issued',
        recipient: { kind: 'contextual', ref: 'subject_person' },
        payload: {
          title: doc.title,
          category: doc.category_code,
          requiredAction: REQUIRED_ACTION_TEXT[mode],
          actionUrl: `/documents/${documentId}`,
        },
        subject: { streamType: DOCUMENT_STREAM_TYPE, streamId: documentId },
        // One notification per issue, whatever the queue does with the effect.
        dedupeKey: `document.issued:${documentId}`,
        requestedBy: args.actorPersonId,
        correlationId: args.correlationId,
        now: args.now,
      });

      await scheduleReminder(trx, {
        reminderKind: DOCUMENT_REMINDER_KIND,
        source: { streamType: DOCUMENT_STREAM_TYPE, streamId: documentId },
        recipient: { kind: 'contextual', ref: 'subject_person' },
        anchor: { mode: 'from_now' },
        cadenceRef: DOCUMENT_REMINDER_CADENCE_REF,
        timeZone: DOCUMENT_REMINDER_TIME_ZONE,
        actorPersonId: args.actorPersonId,
        correlationId: args.correlationId,
        now: args.now,
      });
    }

    // `no_action` is complete the moment it is issued. Journalled separately so
    // a consumer waiting on "they are finished with it" subscribes to one event
    // type across all eight modes.
    if (stamp.completes) {
      await appendCompleted(trx, {
        documentId,
        subjectPersonId: doc.subject_person_id,
        issueMode: mode,
        issueGroupId: groupId,
        sequenceNo: groupId ? index + 1 : null,
        hasCaptureData: false,
        actorPersonId: args.actorPersonId,
        correlationId: args.correlationId,
      });
    }

    issued.push(row);
  }

  return issued;
}

async function appendCompleted(
  trx: Transaction<DB>,
  args: {
    documentId: string;
    subjectPersonId: string;
    issueMode: IssueMode;
    issueGroupId: string | null;
    sequenceNo: number | null;
    hasCaptureData: boolean;
    effects?: { name: string; params?: Record<string, string> }[];
    actorPersonId: string | null;
    correlationId: string;
  },
): Promise<void> {
  await appendEvent(trx, {
    streamType: DOCUMENT_STREAM_TYPE,
    streamId: args.documentId,
    eventType: 'platform.document.completed',
    payload: {
      subjectPersonId: args.subjectPersonId,
      issueMode: args.issueMode,
      issueGroupId: args.issueGroupId,
      sequenceNo: args.sequenceNo,
      hasCaptureData: args.hasCaptureData,
      ...(args.effects?.length ? { effects: args.effects } : {}),
    },
    actorPersonId: args.actorPersonId,
    correlationId: args.correlationId,
  });
}

/** What the subject is being asked to do, in the words the notification uses. */
const REQUIRED_ACTION_TEXT: Record<IssueMode, string> = {
  read_only: 'Read this document.',
  read_and_sign: 'Read this document and sign it.',
  no_action: 'For your information. Nothing to do.',
  receipt_only: 'Confirm you have received it.',
  read_and_understood: 'Read it, then confirm you have understood it.',
  qa_response: 'Read it and answer the questions.',
  text_response: 'Read it and write a response.',
  file_upload: 'Read it and upload the file it asks for.',
};

/** How a completion reads on the issuer's notification. */
const OUTCOME_TEXT: Record<IssueMode, string> = {
  read_only: 'read',
  read_and_sign: 'signed',
  no_action: 'issued',
  receipt_only: 'acknowledged as received',
  read_and_understood: 'read and understood',
  qa_response: 'answered',
  text_response: 'responded to',
  file_upload: 'answered with an upload',
};

/**
 * The cadence a document chase runs on, and the zone its wall clock is read in.
 *
 * Plan 10's own default cadence key rather than one of this plan's: "chase daily
 * until it is done" is not a document-specific decision, and a second key would
 * mean an administrator who changed the cadence had to find both.
 */
export const DOCUMENT_REMINDER_CADENCE_REF = `config:${qualifiedName(notificationsDefaultReminderCadence)}`;
/** Europe/London — the same wall clock plans 08 and 09 chase on. */
export const DOCUMENT_REMINDER_TIME_ZONE = 'Europe/London';

/**
 * Tell whoever issues documents that this one is done (ON-024 driver), and stop
 * chasing the subject.
 *
 * Addressed to the **HR role**, not to the person who issued it. Someone who has
 * left HR should not still be told about documents they issued last year, and a
 * role is what makes that true with no reconfiguration (PL-021).
 */
async function notifyCompletion(
  trx: Transaction<DB>,
  args: {
    documentId: string;
    title: string;
    categoryCode: string;
    issueMode: IssueMode;
    actorPersonId: string | null;
    correlationId: string;
    now: Date;
  },
): Promise<void> {
  const hrRole = await trx
    .selectFrom('platform.role')
    .select('id')
    .where('key', '=', 'hr_user')
    .executeTakeFirst();

  if (hrRole) {
    await requestNotification(trx, {
      kind: 'document.completed',
      recipient: { kind: 'role', roleId: hrRole.id },
      payload: {
        title: args.title,
        category: args.categoryCode,
        outcome: OUTCOME_TEXT[args.issueMode],
        actionUrl: `/documents/${args.documentId}`,
      },
      subject: { streamType: DOCUMENT_STREAM_TYPE, streamId: args.documentId },
      dedupeKey: `document.completed:${args.documentId}`,
      requestedBy: args.actorPersonId,
      correlationId: args.correlationId,
      now: args.now,
    });
  }

  // Eager cancellation is an optimisation, not a correctness requirement — the
  // reminder handler re-runs `isSatisfied` before every send, so a path that
  // forgot this costs one redundant chase and can never chase after completion
  // (core plan 10's own note on the contract).
  await cancelReminders(trx, {
    source: { streamType: DOCUMENT_STREAM_TYPE, streamId: args.documentId },
    reason: 'document completed',
    actorPersonId: args.actorPersonId,
    correlationId: args.correlationId,
  });
}

// --- View (ON-016) -----------------------------------------------------------

/**
 * Record the subject's first view.
 *
 * Idempotent by construction: a document past `issued` returns unchanged, so the
 * viewer screen can call this on every open without the status walking forward
 * or `viewed_at` drifting to the most recent read.
 */
export async function recordDocumentView(
  trx: Transaction<DB>,
  args: { documentId: string; actorPersonId: string; correlationId: string; now: Date },
): Promise<DocumentRecord> {
  const doc = await loadDocument(trx, args.documentId, { forUpdate: true });

  // The sequence guard applies to viewing too (§4.3): a locked document is not
  // merely un-signable, it is un-openable, or the ordering would be advisory.
  if (isSequenceLocked(sequenceInput(doc))) {
    throw new DocumentStateError(
      'an earlier document in this group is still outstanding',
      'sequence_locked',
    );
  }

  const stamp = stampOnFirstView(doc.issue_mode, doc.status, args.now);
  if (doc.status !== 'issued') return doc;

  const row = await trx
    .updateTable('platform.document')
    .set({
      status: stamp.status,
      viewed_at: args.now,
      completed_at: stamp.completedAt,
      completed_by: stamp.completes ? args.actorPersonId : null,
      updated_by: args.actorPersonId,
    })
    .where('id', '=', args.documentId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendEvent(trx, {
    streamType: DOCUMENT_STREAM_TYPE,
    streamId: args.documentId,
    eventType: 'platform.document.viewed',
    payload: { subjectPersonId: doc.subject_person_id },
    actorPersonId: args.actorPersonId,
    correlationId: args.correlationId,
  });

  if (stamp.completes) {
    await appendCompleted(trx, {
      documentId: args.documentId,
      subjectPersonId: doc.subject_person_id,
      issueMode: doc.issue_mode,
      issueGroupId: doc.issue_group_id,
      sequenceNo: doc.sequence_no,
      hasCaptureData: false,
      actorPersonId: args.actorPersonId,
      correlationId: args.correlationId,
    });
    await notifyCompletion(trx, {
      documentId: args.documentId,
      title: doc.title,
      categoryCode: doc.category_code,
      issueMode: doc.issue_mode,
      actorPersonId: args.actorPersonId,
      correlationId: args.correlationId,
      now: args.now,
    });
  }

  return row;
}

// --- Sign (§4.7, PL-011) -----------------------------------------------------

export interface SignDocumentArgs {
  documentId: string;
  method: 'typed_name' | 'signature_pad';
  typedName: string;
  signatureImage?: Uint8Array | null;
  expectedHash: string;
  ackScrolled: boolean;
  captureData?: unknown;
  ip: string;
  userAgent: string;
  signatoryPersonId: string;
  correlationId: string;
  now: Date;
}

/**
 * Capture a UK SES signature: evidence row, status, events and effects, in one
 * transaction (§4.7).
 *
 * The order is deliberate. Guards first, so nothing is written for a refused
 * attempt (AC-D2 requires that a hash mismatch leaves **no** evidence row).
 * Then the evidence row, then the status — if either half failed the whole
 * transaction rolls back, which is the property the atomicity test asserts by
 * forcing a failure between them.
 */
export async function signDocument(
  trx: Transaction<DB>,
  args: SignDocumentArgs,
  config: DocumentEngineConfig,
): Promise<{ document: DocumentRecord; signatureEvidenceId: string }> {
  const doc = await loadDocument(trx, args.documentId, { forUpdate: true });

  if (doc.subject_person_id !== args.signatoryPersonId) {
    // Checked here as well as at the procedure boundary (ADR-0015, defence in
    // depth): a future caller that forgets the guard still cannot sign for
    // somebody else.
    throw new DocumentForbiddenError('only the subject of a document may sign it');
  }

  // Evidence with an invented origin is worse than evidence with none: the
  // column is NOT NULL because a UK SES pack states where a signature came from,
  // so a caller that cannot say is refused rather than defaulted (PL-011, R2).
  if (!args.ip) {
    throw new DocumentStateError(
      'the request address could not be determined, and a signature is not recorded without one',
    );
  }

  requireOk(
    evaluateSignGuards({
      status: doc.status,
      issueMode: doc.issue_mode,
      contentHash: doc.content_hash,
      expectedHash: args.expectedHash,
      ackScrolled: args.ackScrolled,
      requireScrollAck: config.sign.requireScrollAck,
      sequence: sequenceInput(doc),
    }),
  );

  const captured = resolveCapture(doc, args.captureData, null);

  const evidenceId = newUuidV7();
  await trx
    .insertInto('platform.signature_evidence')
    .values({
      id: evidenceId,
      document_id: args.documentId,
      signatory_person_id: args.signatoryPersonId,
      method: args.method,
      typed_name: args.method === 'typed_name' ? args.typedName : null,
      signature_image: args.method === 'signature_pad' ? Buffer.from(args.signatureImage!) : null,
      // The document's own hash, not the caller's `expectedHash` — they are
      // equal by the guard above, and taking it from the row means a future
      // change to the guard cannot make the evidence cite a client-supplied
      // value.
      document_hash: doc.content_hash!,
      ip: args.ip,
      user_agent: args.userAgent.slice(0, 1000),
      ack_scrolled: args.ackScrolled,
      signed_at: args.now,
      created_by: args.signatoryPersonId,
    })
    .execute();

  const stamp = stampOnSign(args.now);
  const row = await trx
    .updateTable('platform.document')
    .set({
      status: stamp.status,
      signed_at: args.now,
      completed_at: stamp.completedAt,
      completed_by: args.signatoryPersonId,
      capture_data: captured ? (JSON.stringify(captured) as never) : null,
      updated_by: args.signatoryPersonId,
    })
    .where('id', '=', args.documentId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendEvent(trx, {
    streamType: DOCUMENT_STREAM_TYPE,
    streamId: args.documentId,
    eventType: 'platform.document.signed',
    payload: {
      signatureEvidenceId: evidenceId,
      signatoryPersonId: args.signatoryPersonId,
      method: args.method,
      documentHash: doc.content_hash!,
      ackScrolled: args.ackScrolled,
      // Build and file the evidence certificate alongside the document.
      effects: [{ name: DOCUMENT_EFFECTS.fileEvidence, params: { documentId: args.documentId } }],
    },
    actorPersonId: args.signatoryPersonId,
    correlationId: args.correlationId,
  });

  await appendCompleted(trx, {
    documentId: args.documentId,
    subjectPersonId: doc.subject_person_id,
    issueMode: doc.issue_mode,
    issueGroupId: doc.issue_group_id,
    sequenceNo: doc.sequence_no,
    hasCaptureData: captured !== null,
    actorPersonId: args.signatoryPersonId,
    correlationId: args.correlationId,
  });

  await notifyCompletion(trx, {
    documentId: args.documentId,
    title: doc.title,
    categoryCode: doc.category_code,
    issueMode: doc.issue_mode,
    actorPersonId: args.signatoryPersonId,
    correlationId: args.correlationId,
    now: args.now,
  });

  return { document: row, signatureEvidenceId: evidenceId };
}

/**
 * Validate response data against the document's own capture schema.
 *
 * `undefined` means "the document asks for nothing"; a rejection throws. The
 * schema key comes from the **document**, copied at generation, so a template
 * republished with different questions cannot retroactively change what an
 * already-issued document validates against.
 */
function resolveCapture(
  doc: DocumentRecord,
  captureData: unknown,
  textResponse: string | null,
): Record<string, unknown> | null {
  if (!doc.capture_schema_key) {
    if (captureData !== undefined && captureData !== null) {
      throw new DocumentStateError('this document does not ask for a response');
    }
    return null;
  }
  if (captureData === undefined || captureData === null) {
    if (textResponse !== null) return null;
    throw new DocumentStateError('answer the questions before submitting', 'capture_missing');
  }
  const parsed = validateCaptureData(doc.capture_schema_key, captureData);
  if (!parsed) {
    throw new DocumentStateError('some answers are missing or invalid', 'capture_invalid');
  }
  return parsed;
}

// --- Complete (PL-009 controlled responses) ----------------------------------

export interface CompleteDocumentArgs {
  documentId: string;
  action: CompletionAction;
  captureData?: unknown;
  textResponse?: string | null;
  ackScrolled: boolean;
  /**
   * Consequences to fan onto the `effects` queue with the completion — filing an
   * uploaded response is the only Phase 1 case. Carried on the completion event
   * rather than enqueued separately, so the upload cannot be filed for a
   * completion that rolled back (§4.6).
   */
  effects?: { name: string; params?: Record<string, string> }[];
  actorPersonId: string;
  correlationId: string;
  now: Date;
}

/**
 * Complete a document by any of the five non-signature actions.
 *
 * The action must match what the document's mode is completed by
 * (`evaluateCompleteGuards`), which is what stops a `qa_response` document being
 * satisfied by the receipt endpoint — otherwise the response schema would be
 * enforced only for callers that chose to send one.
 *
 * `file_upload` completes here too, but its bytes arrive over the Hono multipart
 * route (§5.1): the upload sets `response_sp_item_id` and then calls this with
 * `action: 'upload'`, so there is still exactly one path that stamps a
 * completion.
 */
export async function completeDocument(
  trx: Transaction<DB>,
  args: CompleteDocumentArgs,
): Promise<DocumentRecord> {
  const doc = await loadDocument(trx, args.documentId, { forUpdate: true });

  if (doc.subject_person_id !== args.actorPersonId) {
    throw new DocumentForbiddenError('only the subject of a document may complete it');
  }

  const text = args.textResponse?.trim() || null;
  const isQa = doc.issue_mode === 'qa_response';

  requireOk(
    evaluateCompleteGuards({
      status: doc.status,
      issueMode: doc.issue_mode,
      action: args.action,
      ackScrolled: args.ackScrolled,
      sequence: sequenceInput(doc),
      captureValid: isQa ? captureValidity(doc, args.captureData) : undefined,
      textSupplied: text !== null,
    }),
  );

  const captured = isQa ? resolveCapture(doc, args.captureData, text) : null;
  const stamp = stampOnComplete(args.now);

  const row = await trx
    .updateTable('platform.document')
    .set({
      status: stamp.status,
      completed_at: stamp.completedAt,
      completed_by: args.actorPersonId,
      capture_data: captured ? (JSON.stringify(captured) as never) : null,
      text_response: text,
      updated_by: args.actorPersonId,
    })
    .where('id', '=', args.documentId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendCompleted(trx, {
    documentId: args.documentId,
    subjectPersonId: doc.subject_person_id,
    issueMode: doc.issue_mode,
    issueGroupId: doc.issue_group_id,
    sequenceNo: doc.sequence_no,
    hasCaptureData: captured !== null || text !== null,
    effects: args.effects,
    actorPersonId: args.actorPersonId,
    correlationId: args.correlationId,
  });

  await notifyCompletion(trx, {
    documentId: args.documentId,
    title: doc.title,
    categoryCode: doc.category_code,
    issueMode: doc.issue_mode,
    actorPersonId: args.actorPersonId,
    correlationId: args.correlationId,
    now: args.now,
  });

  return row;
}

/** `null` = nothing submitted, `false` = submitted and rejected (§4.3). */
function captureValidity(doc: DocumentRecord, captureData: unknown): boolean | null {
  if (captureData === undefined || captureData === null) return null;
  if (!doc.capture_schema_key) return false;
  return validateCaptureData(doc.capture_schema_key, captureData) !== null;
}

// --- Cancel ------------------------------------------------------------------

/**
 * Withdraw an unsigned document. Superseded, never deleted (§7): the row keeps
 * its content, its hash and its journal, and a reissue is a **new** document.
 */
export async function cancelDocument(
  trx: Transaction<DB>,
  args: {
    documentId: string;
    reason: string;
    actorPersonId: string;
    correlationId: string;
    now: Date;
  },
): Promise<DocumentRecord> {
  const doc = await loadDocument(trx, args.documentId, { forUpdate: true });

  if (doc.status === 'signed' || doc.status === 'completed') {
    throw new DocumentStateError(
      'a completed document cannot be withdrawn — the fact that it was completed is not undoable',
    );
  }
  if (doc.status === 'cancelled') return doc;

  const fromStatus = doc.status;
  const row = await trx
    .updateTable('platform.document')
    .set({
      status: 'cancelled',
      cancelled_at: args.now,
      cancel_reason: args.reason,
      updated_by: args.actorPersonId,
    })
    .where('id', '=', args.documentId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendEvent(trx, {
    streamType: DOCUMENT_STREAM_TYPE,
    streamId: args.documentId,
    eventType: 'platform.document.cancelled',
    payload: {
      subjectPersonId: doc.subject_person_id,
      reason: args.reason,
      fromStatus: fromStatus as 'draft' | 'issued' | 'viewed',
    },
    actorPersonId: args.actorPersonId,
    correlationId: args.correlationId,
  });

  return row;
}

// --- Filing (§4.6) — the worker's only write path ----------------------------

/**
 * Stage the rendered bytes and their hash.
 *
 * Split from `markFiled` because the render succeeding and the upload succeeding
 * are different facts, and the whole point of staging is that the second can
 * fail repeatedly without repeating the first. `content_hash` is write-once at
 * the database level, so a redelivered render that produced different bytes
 * raises rather than quietly rebinding every signature (§4.1).
 */
export async function stageRender(
  trx: Transaction<DB>,
  args: { documentId: string; bytes: Uint8Array; contentHash: string },
): Promise<void> {
  await trx
    .updateTable('platform.document')
    .set({ pending_content: Buffer.from(args.bytes), content_hash: args.contentHash })
    .where('id', '=', args.documentId)
    // Idempotent: a redelivery whose hash matches re-stages the same bytes; one
    // whose hash differs is caught by the trigger, which is the honest outcome.
    .where((eb) =>
      eb.or([eb('content_hash', 'is', null), eb('content_hash', '=', args.contentHash)]),
    )
    .execute();
}

/** Filing succeeded: back-references, the stamp, and the staged bytes cleared. */
export async function markFiled(
  trx: Transaction<DB>,
  args: {
    documentId: string;
    siteId: string;
    driveId: string;
    itemId: string;
    webUrl: string;
    contentHash: string;
    attempts: number;
    correlationId: string;
    now: Date;
  },
): Promise<void> {
  const updated = await trx
    .updateTable('platform.document')
    .set({
      filing_state: 'filed',
      filed_at: args.now,
      sp_site_id: args.siteId,
      sp_drive_id: args.driveId,
      sp_item_id: args.itemId,
      sp_web_url: args.webUrl,
      filing_error: null,
      // SharePoint is the byte store of record; the staging column has done its
      // job (§4.1). Clearing it also narrows plan 16's erasure surface.
      pending_content: null,
    })
    .where('id', '=', args.documentId)
    // The idempotency guard: a redelivered message finds the row already filed
    // and updates nothing, so no second `filed` event is journalled.
    .where('filing_state', '!=', 'filed')
    .executeTakeFirst();

  if (Number(updated.numUpdatedRows ?? 0) === 0) return;

  await appendEvent(trx, {
    streamType: DOCUMENT_STREAM_TYPE,
    streamId: args.documentId,
    eventType: 'platform.document.filed',
    payload: {
      spItemId: args.itemId,
      contentHash: args.contentHash,
      attempts: args.attempts,
    },
    actorPersonId: null,
    correlationId: args.correlationId,
  });
}

/**
 * Record a filing attempt that failed.
 *
 * Below `maxAttempts` the row stays `pending` with its count and error, and the
 * handler throws so the effect queue redelivers. At the limit it becomes
 * `failed` and journals — which is what puts it on the admin diagnostics screen
 * and raises the notification. The counter lives on the row rather than relying
 * on the broker's delivery count because an administrator asking "how many
 * times has this tried?" should not have to read a queue.
 */
export async function recordFilingFailure(
  trx: Transaction<DB>,
  args: {
    documentId: string;
    error: string;
    maxAttempts: number;
    correlationId: string;
  },
): Promise<{ terminal: boolean; attempts: number }> {
  const row = await trx
    .updateTable('platform.document')
    .set((eb) => ({
      filing_attempts: eb('filing_attempts', '+', 1),
      filing_error: args.error.slice(0, 500),
    }))
    .where('id', '=', args.documentId)
    .where('filing_state', 'in', ['pending', 'failed'])
    .returning(['filing_attempts'])
    .executeTakeFirst();

  if (!row) return { terminal: false, attempts: 0 };
  const attempts = Number(row.filing_attempts);
  if (attempts < args.maxAttempts) return { terminal: false, attempts };

  await trx
    .updateTable('platform.document')
    .set({ filing_state: 'failed' })
    .where('id', '=', args.documentId)
    .where('filing_state', '=', 'pending')
    .execute();

  await appendEvent(trx, {
    streamType: DOCUMENT_STREAM_TYPE,
    streamId: args.documentId,
    eventType: 'platform.document.filing_failed',
    payload: { attempts, error: args.error.slice(0, 500) },
    actorPersonId: null,
    correlationId: args.correlationId,
  });

  // Tell an administrator (§9.5). A `failed` row on a diagnostics screen nobody
  // is looking at is the same as no row at all — this is what turns the terminal
  // state into something somebody acts on.
  const adminRole = await trx
    .selectFrom('platform.role')
    .select('id')
    .where('key', '=', 'administrator')
    .executeTakeFirst();

  if (adminRole) {
    const doc = await trx
      .selectFrom('platform.document')
      .select('title')
      .where('id', '=', args.documentId)
      .executeTakeFirst();

    await requestNotification(trx, {
      kind: 'document.filing_failed',
      recipient: { kind: 'role', roleId: adminRole.id },
      payload: {
        title: doc?.title ?? 'A document',
        attempts,
        reason: args.error.slice(0, 300),
        actionUrl: `/documents/${args.documentId}`,
      },
      subject: { streamType: DOCUMENT_STREAM_TYPE, streamId: args.documentId },
      // Once per document per failure run. A retry resets `filing_attempts`, so
      // a genuinely new failure after an admin retry gets its own alert.
      dedupeKey: `document.filing_failed:${args.documentId}:${attempts}`,
      requestedBy: null,
      correlationId: args.correlationId,
      now: new Date(),
    });
  }

  return { terminal: true, attempts };
}

/**
 * Re-enqueue a failed filing (§5.1, admin action).
 *
 * Resets the counter, because an administrator retrying after fixing the
 * SharePoint configuration is starting again rather than continuing — leaving
 * the count would give the retry one attempt before giving up.
 */
export async function retryFiling(
  trx: Transaction<DB>,
  args: { documentId: string; actorPersonId: string; correlationId: string },
): Promise<void> {
  const doc = await loadDocument(trx, args.documentId, { forUpdate: true });
  if (doc.filing_state !== 'failed') {
    throw new DocumentStateError(
      `document ${args.documentId} is not in a failed filing state (it is '${doc.filing_state}')`,
    );
  }

  await trx
    .updateTable('platform.document')
    .set({ filing_state: 'pending', filing_attempts: 0, filing_error: null })
    .where('id', '=', args.documentId)
    .execute();

  // Re-enqueued through the journal, exactly as the original issue was — the
  // relay is the only thing that puts work on the queue (§4.6).
  await appendEvent(trx, {
    streamType: DOCUMENT_STREAM_TYPE,
    streamId: args.documentId,
    eventType: 'platform.document.issued',
    payload: {
      categoryCode: doc.category_code,
      subjectPersonId: doc.subject_person_id,
      issueMode: doc.issue_mode,
      issueGroupId: doc.issue_group_id,
      sequenceNo: doc.sequence_no,
      effects: [{ name: DOCUMENT_EFFECTS.renderAndFile, params: { documentId: args.documentId } }],
    },
    actorPersonId: args.actorPersonId,
    correlationId: args.correlationId,
  });
}

/** Record the filed evidence certificate. Idempotent on redelivery. */
export async function markEvidenceFiled(
  trx: Transaction<DB>,
  args: { documentId: string; itemId: string },
): Promise<void> {
  await trx
    .updateTable('platform.document')
    .set({ evidence_sp_item_id: args.itemId })
    .where('id', '=', args.documentId)
    .where('evidence_sp_item_id', 'is', null)
    .execute();
}

/** Record the filed response upload (`file_upload` mode). */
export async function markResponseFiled(
  trx: Transaction<DB>,
  args: { documentId: string; itemId: string },
): Promise<void> {
  await trx
    .updateTable('platform.document')
    .set({ response_sp_item_id: args.itemId })
    .where('id', '=', args.documentId)
    .execute();
}

// --- Templates ---------------------------------------------------------------

/**
 * Re-derive a draft template's declared fields from its body, validated against
 * the registered contexts (§4.5).
 *
 * Called on every draft save, not only at publish. Catching an unsatisfiable
 * token at save is the difference between an author fixing their own typo and
 * the first person to be sent the letter finding a blank where their name
 * should be.
 */
export function deriveTemplateFields(bodyHtml: string, mergeContexts: readonly string[]) {
  return deriveMergeFields(bodyHtml, mergeContexts);
}

/** The registered response set a template names, or `null`. Throws if unknown. */
export function assertCaptureSchema(key: string | null | undefined): string | null {
  if (!key) return null;
  requireCaptureSchema(key);
  return key;
}
