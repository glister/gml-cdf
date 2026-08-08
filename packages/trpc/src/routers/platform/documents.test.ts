import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, newUuidV7 } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import {
  documentsCategoryVisibility,
  documentsFilingPathPattern,
  documentsSharePointDriveId,
  documentsSharePointSiteId,
  documentsSignRequireScrollAck,
  setConfig,
} from '@repo/config';
import type { EffectHandlerContext } from '@repo/workflow';
import { appRouter } from '../../router.js';
import type { ContextGrant, TRPCContext } from '../../trpc.js';
import { ROLE_KEYS, type RoleKey } from '../../lib/constants.js';
import { computeDocumentHash } from '../../lib/document-hash.js';
import { setDocumentPortsForTests, type DocumentStore } from '../../lib/document-ports.js';
import { loadDocumentConfig, DOCUMENT_EFFECTS } from '../../lib/documents.js';
import { requireEffect } from '@repo/workflow';
// Side-effect import: registers the `document.*` effect handlers. The barrel
// (`src/index.ts`) does this for every real consumer; a test importing the
// router directly has to say so itself.
import '../../lib/document-effects.js';
// Likewise the notification kinds, reminder kind and subject context (§9.5):
// issuing a document sends one, so the registry has to be populated here too.
import '../../lib/document-notify.js';

/**
 * The document engine against real Postgres (core plan 11 §10).
 *
 * What is proven here and nowhere else:
 *
 *  - **Keyset paging with the sequence lock computed in SQL** (ADR-0004). The
 *    lock is a fact about *other rows*; a JavaScript answer would report every
 *    document on page two unlocked, and that failure only appears with more rows
 *    than a page holds.
 *  - **The sign transaction is atomic** (§10, AC-D2). Evidence row, status and
 *    journal event all commit together — and a refused attempt writes *none* of
 *    the three, which is the half that matters evidentially.
 *  - **Filing resumes from staged bytes** (AC-D4) and a redelivered message
 *    files once, both of which rest on database constraints rather than on the
 *    handler being careful.
 *  - **Category RBAC** (AC-D5), including the rule that the subject always sees
 *    their own document whatever a category's role list says.
 *  - **Version pinning** (AC-D3): a republished template does not change what an
 *    issued document reports.
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
  setDocumentPortsForTests({ renderer: null, store: null });
});

let admin: string;
let subject: string;
let manager: string;
let outsider: string;
let policyCategory: string;
let contractCategory: string;

beforeEach(async () => {
  await truncateAll(db);
  await reseedRoles();
  admin = await insertPerson('Admin');
  subject = await insertPerson('Subject Person');
  manager = await insertPerson('Line Manager');
  outsider = await insertPerson('Outsider');
  await grant(admin, 'administrator');
  await grant(subject, 'employee');
  await grant(manager, 'line_manager');
  await grant(outsider, 'employee');
  policyCategory = await insertCategory('policy', 'Policy');
  contractCategory = await insertCategory('contract', 'Contract');

  // A renderer that produces deterministic bytes, and a store that records
  // uploads. The real ones are HTTP; these are what make the filing state
  // machine testable at all.
  setDocumentPortsForTests({ renderer: fakeRenderer, store: fakeStore });
  uploads.length = 0;
  storeConfigured = true;
  uploadFails = 0;

  // The SharePoint target. Its default is deliberately empty — that is the
  // "CDF IT has not provisioned the site yet" state (§12.2 Q4), and filing
  // stays pending in it, so a test of the filed path has to set it.
  await db.transaction().execute(async (trx) => {
    await setConfig(trx, {
      def: documentsSharePointSiteId,
      value: 'site-1',
      actorPersonId: admin,
      correlationId: newUuidV7(),
    });
    await setConfig(trx, {
      def: documentsSharePointDriveId,
      value: 'drive-1',
      actorPersonId: admin,
      correlationId: newUuidV7(),
    });
  });
});

// --- Harness -----------------------------------------------------------------

const fakeRenderer = async ({ html }: { html: string; title: string }) =>
  new TextEncoder().encode(`%PDF-1.4\n${html}`);

const uploads: { path: string; bytes: number }[] = [];
let storeConfigured = true;
let uploadFails = 0;

const fakeStore: DocumentStore = {
  isConfigured: () => storeConfigured,
  upload: async (input) => {
    if (uploadFails > 0) {
      uploadFails -= 1;
      throw new Error('Graph is having a moment');
    }
    uploads.push({ path: input.path, bytes: input.bytes.byteLength });
    return { itemId: `item-${uploads.length}`, webUrl: `https://sp/${uploads.length}` };
  },
  download: () => {
    throw new Error('not used');
  },
};

async function reseedRoles(): Promise<void> {
  const existing = await db.selectFrom('platform.role').select('id').executeTakeFirst();
  if (existing) return;
  await db
    .insertInto('platform.role')
    .values(
      ROLE_KEYS.map((key, i) => ({
        id: `019f509e-9e0${i.toString(16)}-7000-8000-00000000000${i.toString(16)}`,
        key,
        name: key,
      })),
    )
    .execute();
}

async function insertPerson(displayName: string): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.person')
    .values({ id, relationship_type: 'employee', display_name: displayName })
    .execute();
  return id;
}

async function insertCategory(code: string, label: string): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.lookup')
    .values({
      id,
      list_type: 'document_category',
      code,
      label,
      created_by: admin,
      updated_by: admin,
    })
    .execute();
  return id;
}

async function grant(personId: string, key: RoleKey): Promise<void> {
  const role = await db
    .selectFrom('platform.role')
    .select('id')
    .where('key', '=', key)
    .executeTakeFirstOrThrow();
  await db
    .insertInto('platform.role_grant')
    .values({
      id: newUuidV7(),
      person_id: personId,
      role_id: role.id,
      module: 'platform',
      created_by: personId,
    })
    .execute();
}

async function grantsFor(personId: string): Promise<ContextGrant[]> {
  const rows = await db
    .selectFrom('platform.role_grant as g')
    .innerJoin('platform.role as r', 'r.id', 'g.role_id')
    .select(['r.key as roleKey', 'g.module', 'g.valid_from', 'g.valid_until', 'g.revoked_at'])
    .where('g.person_id', '=', personId)
    .where('g.revoked_at', 'is', null)
    .execute();
  return rows.map((r) => ({
    roleKey: r.roleKey as RoleKey,
    module: r.module,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    revokedAt: r.revoked_at,
  }));
}

async function ctxFor(
  personId: string,
  overrides: Partial<TRPCContext> = {},
): Promise<TRPCContext> {
  return {
    db,
    user: { id: 'u', name: 'T', email: 't@cdf.test', role: 'agent' },
    session: { id: 's', userId: 'u' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    email: { sendOtp: async () => {}, sendInvitation: async () => {} },
    sms: { send: async () => {} },
    rateLimit: { check: () => true },
    correlationId: newUuidV7(),
    actorPersonId: personId,
    grants: await grantsFor(personId),
    requestIp: '203.0.113.7',
    userAgent: 'vitest/1.0',
    ...overrides,
  };
}

async function caller(personId: string) {
  return appRouter.createCaller(await ctxFor(personId));
}

/** Create and publish a template; returns its id. */
async function publishedTemplate(
  opts: {
    key?: string;
    body?: string;
    categoryId?: string;
    issueMode?:
      | 'read_only'
      | 'read_and_sign'
      | 'no_action'
      | 'receipt_only'
      | 'read_and_understood'
      | 'qa_response'
      | 'text_response'
      | 'file_upload';
    captureSchemaKey?: string | null;
  } = {},
): Promise<string> {
  const c = await caller(admin);
  const created = await c.platform.templates.create({
    templateKey: opts.key ?? 'welcome_letter',
    name: 'Welcome letter',
    categoryId: opts.categoryId ?? policyCategory,
    bodyHtml: opts.body ?? '<p>Dear {{person.full_name}},</p><p>Welcome.</p>',
    mergeContexts: ['person'],
    defaultIssueMode: opts.issueMode ?? 'read_and_sign',
    captureSchemaKey: opts.captureSchemaKey ?? undefined,
  });
  await c.platform.templates.publish({ id: created.id });
  return created.id;
}

const personBag = {
  person: { full_name: 'Subject Person', first_name: 'Subject', last_name: 'Person', email: null },
};

/** Generate one draft against `subject`. */
async function generateFor(templateId: string, subjectPersonId = subject): Promise<string> {
  const c = await caller(admin);
  const { ids } = await c.platform.documents.generate({
    subjectPersonId,
    items: [{ templateId, mergeData: personBag }],
  });
  return ids[0]!;
}

/**
 * A logger stub. `EffectHandlerContext['logger']` is the full Winston surface and
 * these handlers use four methods of it; the cast is confined to this test.
 */
const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as EffectHandlerContext['logger'];

/** Run the render-and-file effect exactly as the worker would. */
async function runFiling(documentId: string, correlationId = newUuidV7()): Promise<void> {
  const handler = requireEffect(DOCUMENT_EFFECTS.renderAndFile);
  const ctx: EffectHandlerContext = { db, logger: noopLogger };
  await handler(
    {
      effect: DOCUMENT_EFFECTS.renderAndFile,
      params: { documentId },
      correlationId,
      source: { kind: 'event', eventId: newUuidV7() },
    } as never,
    ctx,
  );
}

async function docRow(id: string) {
  return db
    .selectFrom('platform.document')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

// --- Templates ---------------------------------------------------------------

describe('templates — versioning and the publication freeze (PL-009, AC-D3)', () => {
  it('mints the next version for an existing key rather than editing the published one', async () => {
    const c = await caller(admin);
    await publishedTemplate();
    const v2 = await c.platform.templates.create({
      templateKey: 'welcome_letter',
      name: 'Welcome letter (revised)',
      categoryId: policyCategory,
      bodyHtml: '<p>Hello {{person.first_name}}.</p>',
      mergeContexts: ['person'],
    });
    expect(v2.version).toBe(2);
  });

  it('refuses a token whose field the context does not have', async () => {
    const c = await caller(admin);
    await expect(
      c.platform.templates.create({
        templateKey: 'bad_template',
        name: 'Bad',
        categoryId: policyCategory,
        bodyHtml: '<p>{{person.salary}}</p>',
        mergeContexts: ['person'],
      }),
    ).rejects.toThrow(/no field of 'person'/);
  });

  it('AC-D3 — an issued document keeps reporting the version it was generated from', async () => {
    const v1 = await publishedTemplate();
    const docId = await generateFor(v1);
    const c = await caller(admin);
    await c.platform.documents.issue({ documentIds: [docId] });

    // The family moves on: a second version, published.
    const v2 = await c.platform.templates.create({
      templateKey: 'welcome_letter',
      name: 'Welcome letter v2',
      categoryId: policyCategory,
      bodyHtml: '<p>Completely different.</p>',
      mergeContexts: [],
    });
    await c.platform.templates.publish({ id: v2.id });

    const doc = await c.platform.documents.get({ id: docId });
    expect(doc.templateVersion).toBe(1);
    expect(doc.bodyHtml).toContain('Welcome.');
    expect(doc.bodyHtml).not.toContain('Completely different');
  });

  it('journals publish as kind=admin, not domain', async () => {
    const id = await publishedTemplate();
    const event = await db
      .selectFrom('platform.domain_event')
      .select(['kind', 'event_type'])
      .where('stream_id', '=', id)
      .where('event_type', '=', 'platform.template.published')
      .executeTakeFirstOrThrow();
    // Publishing changes what the system will say to people without a business
    // fact having occurred — the same class as a configuration change (§4.2).
    expect(event.kind).toBe('admin');
  });
});

// --- Keyset paging + the sequence lock ---------------------------------------

describe('listForSubject — keyset paging over real Postgres (ADR-0004)', () => {
  const TOTAL = 47;

  beforeEach(async () => {
    const templateId = await publishedTemplate({ issueMode: 'receipt_only' });
    const c = await caller(admin);
    for (let i = 0; i < TOTAL; i += 1) {
      await c.platform.documents.generate({
        subjectPersonId: subject,
        items: [
          { templateId, title: `Document ${String(i).padStart(3, '0')}`, mergeData: personBag },
        ],
      });
    }
  });

  it('pages the whole set in global order, with no duplicates and no gaps', async () => {
    const c = await caller(admin);
    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;
    let pages = 0;

    do {
      const page = await c.platform.documents.listForSubject({
        subjectPersonId: subject,
        limit: 7,
        cursor,
        sort: 'title',
        sortDir: 'asc',
      });
      seen.push(...page.items.map((d) => d.title));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor);

    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
    expect(seen).toEqual([...seen].sort());
  });

  it('applies every facet in SQL, so a filtered page is still a full page', async () => {
    const c = await caller(admin);
    const page = await c.platform.documents.listForSubject({
      subjectPersonId: subject,
      limit: 5,
      search: 'Document 01',
    });
    // 010–019: ten matches, so a five-row page has a cursor. Filtering after the
    // fetch would have produced a short page and a broken boundary.
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).not.toBeNull();
    expect(page.items.every((d) => d.title.startsWith('Document 01'))).toBe(true);
  });
});

describe('the ordered-sequence lock is computed in SQL over the whole group (AC-D6)', () => {
  it('locks the second document until the first completes, across page boundaries', async () => {
    const templateId = await publishedTemplate({ issueMode: 'receipt_only' });
    const c = await caller(admin);

    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) ids.push(await generateFor(templateId));
    await c.platform.documents.issue({ documentIds: ids, ordered: true });

    // Page size 3: documents 4..12 are on later pages, where a JavaScript lock
    // computed from the loaded rows would see no preceding document at all and
    // report them unlocked.
    const locks: boolean[] = [];
    let cursor: string | null | undefined = undefined;
    do {
      const page = await c.platform.documents.listForSubject({
        subjectPersonId: subject,
        limit: 3,
        cursor,
        sort: 'created_at',
        sortDir: 'asc',
      });
      locks.push(...page.items.map((d) => d.isLocked));
      cursor = page.nextCursor;
    } while (cursor);

    expect(locks[0]).toBe(false);
    expect(locks.slice(1).every(Boolean)).toBe(true);
  });

  it('unlocks the next document the moment the first completes, with no further action', async () => {
    const templateId = await publishedTemplate({ issueMode: 'receipt_only' });
    const first = await generateFor(templateId);
    const second = await generateFor(templateId);
    const admins = await caller(admin);
    await admins.platform.documents.issue({ documentIds: [first, second], ordered: true });

    const subjectCaller = await caller(subject);
    await expect(
      subjectCaller.platform.documents.complete({ documentId: second, action: 'receipt' }),
    ).rejects.toThrow(/earlier document/);

    await subjectCaller.platform.documents.complete({ documentId: first, action: 'receipt' });

    // No unlock call, no second write anywhere: the lock is a query.
    await subjectCaller.platform.documents.complete({ documentId: second, action: 'receipt' });
    expect((await docRow(second)).status).toBe('completed');
  });
});

// --- The sign transaction ----------------------------------------------------

describe('sign — atomicity and hash binding (§10, AC-D1/AC-D2)', () => {
  async function issuedAndRendered(): Promise<{ id: string; hash: string }> {
    const templateId = await publishedTemplate();
    const id = await generateFor(templateId);
    const c = await caller(admin);
    await c.platform.documents.issue({ documentIds: [id] });
    await runFiling(id);
    const row = await docRow(id);
    return { id, hash: row.content_hash! };
  }

  it('writes the evidence row, the status and the journal event together', async () => {
    const { id, hash } = await issuedAndRendered();
    const c = await caller(subject);
    const result = await c.platform.documents.sign({
      documentId: id,
      typedName: 'Subject Person',
      expectedHash: hash,
      ackScrolled: true,
    });

    const evidence = await db
      .selectFrom('platform.signature_evidence')
      .selectAll()
      .where('document_id', '=', id)
      .executeTakeFirstOrThrow();
    const row = await docRow(id);
    const events = await db
      .selectFrom('platform.domain_event')
      .select('event_type')
      .where('stream_id', '=', id)
      .execute();

    expect(result.signatureEvidenceId).toBe(evidence.id);
    expect(row.status).toBe('signed');
    // PL-009: the required action, the completion status, the date AND the user.
    expect(row.completed_at).not.toBeNull();
    expect(row.completed_by).toBe(subject);
    expect(events.map((e) => e.event_type)).toContain('platform.document.signed');
    expect(events.map((e) => e.event_type)).toContain('platform.document.completed');

    // AC-D1 — the evidence pack's contents, from the request rather than the input.
    expect(evidence).toMatchObject({
      signatory_person_id: subject,
      method: 'typed_name',
      typed_name: 'Subject Person',
      document_hash: hash,
      ack_scrolled: true,
    });
    expect(String(evidence.ip)).toBe('203.0.113.7');
    expect(evidence.user_agent).toBe('vitest/1.0');
  });

  it('AC-D2 — a stale expectedHash is rejected and records NO evidence row', async () => {
    const { id } = await issuedAndRendered();
    const c = await caller(subject);
    await expect(
      c.platform.documents.sign({
        documentId: id,
        typedName: 'Subject Person',
        expectedHash: `sha256:${'b'.repeat(64)}`,
        ackScrolled: true,
      }),
    ).rejects.toThrow(/re-rendered|reload/i);

    const evidence = await db
      .selectFrom('platform.signature_evidence')
      .select('id')
      .where('document_id', '=', id)
      .execute();
    // The half that matters evidentially: a refused attempt leaves nothing.
    expect(evidence).toHaveLength(0);
    expect((await docRow(id)).status).toBe('issued');
  });

  it('refuses to sign before the render has produced a hash', async () => {
    const templateId = await publishedTemplate();
    const id = await generateFor(templateId);
    await (await caller(admin)).platform.documents.issue({ documentIds: [id] });

    const c = await caller(subject);
    await expect(
      c.platform.documents.sign({
        documentId: id,
        typedName: 'Subject Person',
        expectedHash: `sha256:${'a'.repeat(64)}`,
        ackScrolled: true,
      }),
    ).rejects.toThrow(/still being prepared/);
  });

  it('refuses an unscrolled signature, and honours the configuration switch', async () => {
    const { id, hash } = await issuedAndRendered();
    const c = await caller(subject);
    await expect(
      c.platform.documents.sign({
        documentId: id,
        typedName: 'Subject Person',
        expectedHash: hash,
        ackScrolled: false,
      }),
    ).rejects.toThrow(/read to the end/i);

    // The control is configuration (§6), so turning it off must actually work —
    // with no release, which is the point of it being a config key at all.
    await db.transaction().execute((trx) =>
      setConfig(trx, {
        def: documentsSignRequireScrollAck,
        value: false,
        actorPersonId: admin,
        correlationId: newUuidV7(),
      }),
    );

    const result = await c.platform.documents.sign({
      documentId: id,
      typedName: 'Subject Person',
      expectedHash: hash,
      ackScrolled: false,
    });
    expect(result.status).toBe('signed');
  });

  it('refuses a signature from anyone but the subject', async () => {
    const { id, hash } = await issuedAndRendered();
    const c = await caller(admin);
    await expect(
      c.platform.documents.sign({
        documentId: id,
        typedName: 'Admin',
        expectedHash: hash,
        ackScrolled: true,
      }),
    ).rejects.toThrow(/only the subject/);
  });
});

// --- Controlled response actions (AC-D7) -------------------------------------

describe('controlled response actions (PL-009, AC-D7)', () => {
  it('completes a receipt_only document on the receipt action, and records who and when', async () => {
    const templateId = await publishedTemplate({ issueMode: 'receipt_only' });
    const id = await generateFor(templateId);
    await (await caller(admin)).platform.documents.issue({ documentIds: [id] });

    const c = await caller(subject);
    await c.platform.documents.complete({ documentId: id, action: 'receipt' });

    const row = await docRow(id);
    expect(row.status).toBe('completed');
    expect(row.completed_by).toBe(subject);
    expect(row.completed_at).not.toBeNull();
  });

  it('refuses to complete a qa_response document with the receipt action', async () => {
    // Without this, the response schema is enforced only for clients that choose
    // to send one.
    const templateId = await publishedTemplate({
      issueMode: 'qa_response',
      captureSchemaKey: 'induction_qa',
    });
    const id = await generateFor(templateId);
    await (await caller(admin)).platform.documents.issue({ documentIds: [id] });

    const c = await caller(subject);
    await expect(
      c.platform.documents.complete({ documentId: id, action: 'receipt' }),
    ).rejects.toThrow(/not completed by a 'receipt' action/);
  });

  it('completes a qa_response document only on answers that validate, and stores them', async () => {
    const templateId = await publishedTemplate({
      issueMode: 'qa_response',
      captureSchemaKey: 'induction_qa',
    });
    const id = await generateFor(templateId);
    await (await caller(admin)).platform.documents.issue({ documentIds: [id] });
    const c = await caller(subject);

    await expect(
      c.platform.documents.complete({
        documentId: id,
        action: 'qa',
        captureData: { preferred_name: 'Sub', read_handbook: false, ppe_size: 'l' },
      }),
    ).rejects.toThrow(/missing or invalid/);

    await c.platform.documents.complete({
      documentId: id,
      action: 'qa',
      captureData: { preferred_name: 'Sub', read_handbook: true, ppe_size: 'l' },
    });

    const row = await docRow(id);
    expect(row.status).toBe('completed');
    expect(row.capture_data).toEqual({
      preferred_name: 'Sub',
      read_handbook: true,
      ppe_size: 'l',
    });
  });

  it('completes a no_action document at issue — it is not left outstanding for ever', async () => {
    const templateId = await publishedTemplate({ issueMode: 'no_action' });
    const id = await generateFor(templateId);
    await (await caller(admin)).platform.documents.issue({ documentIds: [id] });
    const row = await docRow(id);
    expect(row.completed_at).not.toBeNull();
  });

  it('completes a read_only document on the subject’s first view', async () => {
    const templateId = await publishedTemplate({ issueMode: 'read_only' });
    const id = await generateFor(templateId);
    await (await caller(admin)).platform.documents.issue({ documentIds: [id] });

    const c = await caller(subject);
    await c.platform.documents.recordView({ id });
    expect((await docRow(id)).status).toBe('completed');
  });
});

// --- Filing (AC-D4) ----------------------------------------------------------

describe('filing — the asynchronous half (PL-010, AC-D4)', () => {
  it('renders, hashes, uploads and journals filed', async () => {
    const templateId = await publishedTemplate();
    const id = await generateFor(templateId);
    await (await caller(admin)).platform.documents.issue({ documentIds: [id] });
    await runFiling(id);

    const row = await docRow(id);
    expect(row.filing_state).toBe('filed');
    expect(row.sp_item_id).toBe('item-1');
    expect(row.pending_content).toBeNull(); // staging cleared once filed
    expect(row.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(uploads[0]?.path).toBe(`people/${subject}/policy/${id}.pdf`);

    const events = await db
      .selectFrom('platform.domain_event')
      .select('event_type')
      .where('stream_id', '=', id)
      .execute();
    expect(events.map((e) => e.event_type)).toContain('platform.document.filed');
  });

  it('AC-D4 — with the store unavailable, the document is still rendered, viewable and signable', async () => {
    storeConfigured = false;
    const templateId = await publishedTemplate();
    const id = await generateFor(templateId);
    await (await caller(admin)).platform.documents.issue({ documentIds: [id] });
    await runFiling(id);

    const staged = await docRow(id);
    expect(staged.filing_state).toBe('pending');
    expect(staged.content_hash).not.toBeNull();
    expect(staged.pending_content).not.toBeNull();

    const signed = await (
      await caller(subject)
    ).platform.documents.sign({
      documentId: id,
      typedName: 'Subject Person',
      expectedHash: staged.content_hash!,
      ackScrolled: true,
    });
    expect(signed.status).toBe('signed');

    // The store comes back; filing completes with the SAME hash.
    storeConfigured = true;
    await runFiling(id);
    const filed = await docRow(id);
    expect(filed.filing_state).toBe('filed');
    expect(filed.content_hash).toBe(staged.content_hash);
  });

  it('resumes from staged bytes after an upload failure, without re-rendering', async () => {
    const templateId = await publishedTemplate();
    const id = await generateFor(templateId);
    await (await caller(admin)).platform.documents.issue({ documentIds: [id] });

    uploadFails = 1;
    await expect(runFiling(id)).rejects.toThrow(/moment/);
    const afterFailure = await docRow(id);
    expect(afterFailure.filing_attempts).toBe(1);
    expect(afterFailure.pending_content).not.toBeNull();

    await runFiling(id);
    const filed = await docRow(id);
    expect(filed.filing_state).toBe('filed');
    // A second render could have produced different bytes; the hash proves it
    // did not happen.
    expect(filed.content_hash).toBe(afterFailure.content_hash);
  });

  it('a redelivered message files once and journals once', async () => {
    const templateId = await publishedTemplate();
    const id = await generateFor(templateId);
    await (await caller(admin)).platform.documents.issue({ documentIds: [id] });

    await runFiling(id);
    await runFiling(id);

    expect(uploads).toHaveLength(1);
    const filedEvents = await db
      .selectFrom('platform.domain_event')
      .select('id')
      .where('stream_id', '=', id)
      .where('event_type', '=', 'platform.document.filed')
      .execute();
    expect(filedEvents).toHaveLength(1);
  });

  it('marks the document failed and journals once retries are exhausted', async () => {
    const templateId = await publishedTemplate();
    const id = await generateFor(templateId);
    await (await caller(admin)).platform.documents.issue({ documentIds: [id] });

    const config = await db.transaction().execute((trx) => loadDocumentConfig(trx, new Date()));
    uploadFails = config.filing.maxAttempts;
    for (let i = 0; i < config.filing.maxAttempts - 1; i += 1) {
      await expect(runFiling(id)).rejects.toThrow();
    }
    // The final attempt returns rather than throwing: it is a decision to stop,
    // and throwing would dead-letter it instead of surfacing it to an admin.
    await runFiling(id);

    const row = await docRow(id);
    expect(row.filing_state).toBe('failed');
    expect(row.filing_attempts).toBe(config.filing.maxAttempts);

    const events = await db
      .selectFrom('platform.domain_event')
      .select('event_type')
      .where('stream_id', '=', id)
      .where('event_type', '=', 'platform.document.filing_failed')
      .execute();
    expect(events).toHaveLength(1);

    // And an administrator can start it again from zero.
    await (await caller(admin)).platform.documents.retryFiling({ id });
    const retried = await docRow(id);
    expect(retried.filing_state).toBe('pending');
    expect(retried.filing_attempts).toBe(0);
  });

  it('a configured path pattern change affects the next filing, with no release', async () => {
    await db.transaction().execute((trx) =>
      setConfig(trx, {
        def: documentsFilingPathPattern,
        value: 'archive/{category_code}/',
        actorPersonId: admin,
        correlationId: newUuidV7(),
      }),
    );

    const templateId = await publishedTemplate();
    const id = await generateFor(templateId);
    await (await caller(admin)).platform.documents.issue({ documentIds: [id] });
    await runFiling(id);

    expect(uploads[0]?.path).toBe(`archive/policy/${id}.pdf`);
  });
});

// --- Evidence export ---------------------------------------------------------

describe('exportEvidence (PL-011, AC-D1/AC-D2)', () => {
  it('returns the full pack, recomputes the hash, and journals the export', async () => {
    storeConfigured = false; // keep the bytes staged so they can be re-hashed here
    const templateId = await publishedTemplate();
    const id = await generateFor(templateId);
    const admins = await caller(admin);
    await admins.platform.documents.issue({ documentIds: [id] });
    await runFiling(id);
    const hash = (await docRow(id)).content_hash!;
    await (
      await caller(subject)
    ).platform.documents.sign({
      documentId: id,
      typedName: 'Subject Person',
      expectedHash: hash,
      ackScrolled: true,
    });

    const pack = await admins.platform.documents.exportEvidence({ id });

    expect(pack.document.templateKey).toBe('welcome_letter');
    expect(pack.document.templateVersion).toBe(1);
    expect(pack.signature).toMatchObject({ signatoryPersonId: subject, method: 'typed_name' });
    expect(pack.events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining([
        'platform.document.generated',
        'platform.document.issued',
        'platform.document.signed',
      ]),
    );
    expect(pack.verification).toMatchObject({ hashRecomputedAtExport: true, hashMatches: true });

    const exported = await db
      .selectFrom('platform.domain_event')
      .select(['kind'])
      .where('stream_id', '=', id)
      .where('event_type', '=', 'platform.document.evidence_exported')
      .executeTakeFirstOrThrow();
    expect(exported.kind).toBe('security');
  });

  it('reports hashMatches false when the stored bytes have been tampered with', async () => {
    storeConfigured = false;
    const templateId = await publishedTemplate();
    const id = await generateFor(templateId);
    const admins = await caller(admin);
    await admins.platform.documents.issue({ documentIds: [id] });
    await runFiling(id);

    // Rewrite the staged bytes behind the engine's back. `content_hash` is
    // write-once, so it still says what the render produced — which is exactly
    // the discrepancy the export exists to surface.
    await db
      .updateTable('platform.document')
      .set({ pending_content: Buffer.from('%PDF-1.4\ntampered') })
      .where('id', '=', id)
      .execute();

    const pack = await admins.platform.documents.exportEvidence({ id });
    expect(pack.verification.hashMatches).toBe(false);
    expect(pack.verification.note).toMatch(/do not hash/);
  });

  it('never claims a match it did not perform', async () => {
    // Filed to SharePoint and the staging cleared: the bytes are unreachable
    // from this process, so the pack says so rather than echoing a stored value.
    const templateId = await publishedTemplate();
    const id = await generateFor(templateId);
    const admins = await caller(admin);
    await admins.platform.documents.issue({ documentIds: [id] });
    await runFiling(id);

    const pack = await admins.platform.documents.exportEvidence({ id });
    expect(pack.verification.hashRecomputedAtExport).toBe(false);
    expect(pack.verification.hashMatches).toBe(false);
    expect(pack.verification.note).toMatch(/not reachable/);
  });
});

// --- RBAC (AC-D5) ------------------------------------------------------------

describe('category visibility and record scope (PL-012, AC-D5)', () => {
  beforeEach(async () => {
    // `contract` is restricted to Administrator and HR; `policy` is not listed,
    // so it falls back to the default — which is also Administrator and HR.
    await db.transaction().execute((trx) =>
      setConfig(trx, {
        def: documentsCategoryVisibility,
        value: { contract: ['administrator', 'hr_user'] },
        actorPersonId: admin,
        correlationId: newUuidV7(),
      }),
    );
  });

  it('the subject always sees their own document, whatever the category says', async () => {
    const templateId = await publishedTemplate({ categoryId: contractCategory });
    const id = await generateFor(templateId);
    await (await caller(admin)).platform.documents.issue({ documentIds: [id] });

    // A document nobody can open is not a document — the subject has to be able
    // to sign theirs (§8).
    const doc = await (await caller(subject)).platform.documents.get({ id });
    expect(doc.id).toBe(id);
  });

  it('denies another person’s document to an employee, as NOT_FOUND', async () => {
    const templateId = await publishedTemplate();
    const id = await generateFor(templateId);
    const c = await caller(outsider);
    // NOT_FOUND, not FORBIDDEN: confirming it exists is itself the disclosure.
    await expect(c.platform.documents.get({ id })).rejects.toThrow(/No such document/);
  });

  it('denies a restricted-category document to a Line Manager and permits it to an Administrator', async () => {
    const templateId = await publishedTemplate({ categoryId: contractCategory });
    const id = await generateFor(templateId);
    await (await caller(admin)).platform.documents.issue({ documentIds: [id] });

    await expect((await caller(manager)).platform.documents.get({ id })).rejects.toThrow(
      /No such document/,
    );
    await expect((await caller(admin)).platform.documents.get({ id })).resolves.toMatchObject({
      id,
    });
  });

  it('denies every template procedure to an employee', async () => {
    const c = await caller(subject);
    await expect(c.platform.templates.list({})).rejects.toThrow();
    await expect(
      c.platform.templates.create({
        templateKey: 'nope',
        name: 'Nope',
        categoryId: policyCategory,
        bodyHtml: '<p>x</p>',
      }),
    ).rejects.toThrow();
  });
});

// --- Hashing -----------------------------------------------------------------

describe('computeDocumentHash', () => {
  it('hashes the bytes, in canonical form', () => {
    const hash = computeDocumentHash(new TextEncoder().encode('hello'));
    expect(hash).toBe('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});
