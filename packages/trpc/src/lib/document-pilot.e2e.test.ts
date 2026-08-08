import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, newUuidV7 } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import { documentsSharePointDriveId, documentsSharePointSiteId, setConfig } from '@repo/config';
import { requireEffect, type EffectHandlerContext } from '@repo/workflow';
import { appRouter } from '../router.js';
import type { ContextGrant, TRPCContext } from '../trpc.js';
import { ROLE_KEYS, type RoleKey } from './constants.js';
import { setDocumentPortsForTests, type DocumentStore } from './document-ports.js';
import { DOCUMENT_EFFECTS, DOCUMENT_REMINDER_KIND } from './documents.js';
import './document-effects.js';
import './document-notify.js';

/**
 * The pilot slice (core plan 11 §9.5) — **the whole capability, with no HR
 * module in existence.**
 *
 * A "Welcome letter" merged from `platform.person` fields, issued read-and-sign,
 * signed, its evidence exported and verified, filed to SharePoint. Every
 * requirement of §1's pilot bullet, walked in one test, against real Postgres.
 *
 * The point of a pilot slice is not coverage — the other suites have that. It is
 * that the capability is demonstrably *whole* before anything depends on it: the
 * merge contract, the two-phase issue, the render, the hash binding, the SES
 * evidence, the notification, the chase and the filing all work **together**, so
 * the HR onboarding plan can build on it rather than discovering the seams.
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
let categoryId: string;
const uploads: { path: string; bytes: Uint8Array }[] = [];

const store: DocumentStore = {
  isConfigured: () => true,
  upload: async (input) => {
    uploads.push({ path: input.path, bytes: input.bytes });
    return { itemId: `sp-${uploads.length}`, webUrl: `https://sharepoint/${uploads.length}` };
  },
  download: () => {
    throw new Error('not used');
  },
};

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as EffectHandlerContext['logger'];

beforeEach(async () => {
  await truncateAll(db);
  await seedRoles();
  admin = await person('Alex Administrator');
  subject = await person('Jordan Miles', 'jordan@cdf.test', 'Jordan', 'Miles');
  await grant(admin, 'administrator');
  await grant(admin, 'hr_user');
  await grant(subject, 'employee');
  categoryId = await category();

  uploads.length = 0;
  setDocumentPortsForTests({
    // A renderer that is honest about being fake but produces real PDF magic
    // bytes, so the hash is over something a PDF reader would accept.
    renderer: async ({ html }) => new TextEncoder().encode(`%PDF-1.4\n${html}\n%%EOF`),
    store,
  });

  await db.transaction().execute(async (trx) => {
    await setConfig(trx, {
      def: documentsSharePointSiteId,
      value: 'cdf-site',
      actorPersonId: admin,
      correlationId: newUuidV7(),
    });
    await setConfig(trx, {
      def: documentsSharePointDriveId,
      value: 'personnel-files',
      actorPersonId: admin,
      correlationId: newUuidV7(),
    });
  });
});

async function seedRoles(): Promise<void> {
  if (await db.selectFrom('platform.role').select('id').executeTakeFirst()) return;
  await db
    .insertInto('platform.role')
    .values(
      ROLE_KEYS.map((key, i) => ({
        id: `019f509e-9e1${i.toString(16)}-7000-8000-00000000000${i.toString(16)}`,
        key,
        name: key,
      })),
    )
    .execute();
}

async function person(
  displayName: string,
  email?: string,
  given?: string,
  family?: string,
): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.person')
    .values({
      id,
      relationship_type: 'employee',
      display_name: displayName,
      contact_email: email ?? null,
      given_name: given ?? null,
      family_name: family ?? null,
    })
    .execute();
  return id;
}

async function category(): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.lookup')
    .values({
      id,
      list_type: 'document_category',
      code: 'other',
      label: 'Other',
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

async function caller(personId: string) {
  const ctx: TRPCContext = {
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
    requestIp: '198.51.100.42',
    userAgent: 'Mozilla/5.0 (pilot)',
  };
  return appRouter.createCaller(ctx);
}

async function runEffect(name: string, params: Record<string, unknown>): Promise<void> {
  await requireEffect(name)(
    {
      effect: name,
      params,
      correlationId: newUuidV7(),
      source: { kind: 'event', eventId: newUuidV7() },
    } as never,
    { db, logger: noopLogger },
  );
}

describe('the pilot slice — a welcome letter, end to end, with no HR module', () => {
  it('goes template → generate → issue → render → sign → evidence → filed', async () => {
    const hr = await caller(admin);

    // --- 1. A published template drawing on the person context ---------------
    const template = await hr.platform.templates.create({
      templateKey: 'welcome_letter',
      name: 'Welcome letter',
      categoryId,
      bodyHtml:
        '<h2>Welcome</h2><p>Dear {{person.first_name}} {{person.last_name}},</p>' +
        '<p>We are glad to have you. Please confirm you have read this.</p>',
      mergeContexts: ['person'],
      defaultIssueMode: 'read_and_sign',
    });
    await hr.platform.templates.publish({ id: template.id });

    // --- 2. Generate — pre-filled from platform.person, not from the caller --
    const { ids } = await hr.platform.documents.generate({
      subjectPersonId: subject,
      items: [{ templateId: template.id, mergeData: {} }],
    });
    const documentId = ids[0]!;

    const draft = await hr.platform.documents.get({ id: documentId });
    expect(draft.status).toBe('draft');
    // ON-012: the letter knows who it is for, and the caller supplied nothing.
    expect(draft.bodyHtml).toContain('Dear Jordan Miles,');
    expect(draft.isRendered).toBe(false);

    // --- 3. Issue -----------------------------------------------------------
    await hr.platform.documents.issue({ documentIds: [documentId] });

    // The subject is told, and a chase is scheduled — both in the issue's own
    // transaction (§9.5).
    const notification = await db
      .selectFrom('platform.notification')
      .select(['kind', 'recipient_kind', 'recipient_contextual', 'title', 'body'])
      .where('subject_stream_id', '=', documentId)
      .where('kind', '=', 'document.issued')
      .executeTakeFirstOrThrow();
    expect(notification.recipient_kind).toBe('contextual');
    expect(notification.recipient_contextual).toBe('subject_person');
    // SA-023: the message names the document and the ask, and nothing from it.
    expect(notification.body).toContain('Welcome letter');
    expect(notification.body).not.toContain('Jordan');

    const chase = await db
      .selectFrom('platform.scheduled_action')
      .select(['action_type', 'payload'])
      .where('subject_stream_id', '=', documentId)
      .executeTakeFirstOrThrow();
    expect(chase.action_type).toBe('notification.reminder');
    expect((chase.payload as { reminderKind: string }).reminderKind).toBe(DOCUMENT_REMINDER_KIND);

    // --- 4. The worker renders, hashes and files -----------------------------
    await runEffect(DOCUMENT_EFFECTS.renderAndFile, { documentId });

    const rendered = await hr.platform.documents.get({ id: documentId });
    expect(rendered.isRendered).toBe(true);
    expect(rendered.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rendered.filingState).toBe('filed');
    expect(uploads[0]?.path).toBe(`people/${subject}/other/${documentId}.pdf`);
    // The bytes that were filed are the bytes that were hashed.
    expect(new TextDecoder().decode(uploads[0]!.bytes)).toContain('Dear Jordan Miles,');

    // --- 5. Sign -------------------------------------------------------------
    const signed = await (
      await caller(subject)
    ).platform.documents.sign({
      documentId,
      typedName: 'Jordan Miles',
      expectedHash: rendered.contentHash!,
      ackScrolled: true,
    });
    expect(signed.status).toBe('signed');

    // The chase stops, and whoever issues documents is told (ON-024).
    const cancelled = await db
      .selectFrom('platform.scheduled_action')
      .select('status')
      .where('subject_stream_id', '=', documentId)
      .executeTakeFirstOrThrow();
    expect(cancelled.status).toBe('cancelled');

    const completedNotice = await db
      .selectFrom('platform.notification')
      .select(['recipient_kind', 'body'])
      .where('subject_stream_id', '=', documentId)
      .where('kind', '=', 'document.completed')
      .executeTakeFirstOrThrow();
    // A role, not the person who issued it (PL-021).
    expect(completedNotice.recipient_kind).toBe('role');
    expect(completedNotice.body).toContain('signed');
    expect(completedNotice.body).not.toContain('Jordan');

    // --- 6. Export the evidence, and verify it -------------------------------
    const pack = await hr.platform.documents.exportEvidence({ id: documentId });

    expect(pack.document.templateKey).toBe('welcome_letter');
    expect(pack.document.templateVersion).toBe(1);
    expect(pack.document.sharepoint.itemId).toBe('sp-1');
    // AC-D1 — the whole SES evidence set, taken from the request.
    expect(pack.signature).toMatchObject({
      signatoryPersonId: subject,
      method: 'typed_name',
      typedName: 'Jordan Miles',
      ip: '198.51.100.42',
      userAgent: 'Mozilla/5.0 (pilot)',
      ackScrolled: true,
      documentHash: rendered.contentHash,
    });
    // The trail, in order.
    expect(pack.events.map((e) => e.eventType)).toEqual([
      'platform.document.generated',
      'platform.document.issued',
      'platform.document.filed',
      'platform.document.signed',
      'platform.document.completed',
    ]);
    // The export is itself an access event (§4.2).
    const exported = await db
      .selectFrom('platform.domain_event')
      .select('kind')
      .where('stream_id', '=', documentId)
      .where('event_type', '=', 'platform.document.evidence_exported')
      .executeTakeFirstOrThrow();
    expect(exported.kind).toBe('security');
  });

  it('signs during a Graph outage, and files the same bytes when it returns (AC-D4)', async () => {
    const hr = await caller(admin);
    const template = await hr.platform.templates.create({
      templateKey: 'outage_letter',
      name: 'Outage letter',
      categoryId,
      bodyHtml: '<p>Dear {{person.full_name}}.</p>',
      mergeContexts: ['person'],
      defaultIssueMode: 'read_and_sign',
    });
    await hr.platform.templates.publish({ id: template.id });
    const { ids } = await hr.platform.documents.generate({
      subjectPersonId: subject,
      items: [{ templateId: template.id, mergeData: {} }],
    });
    const documentId = ids[0]!;
    await hr.platform.documents.issue({ documentIds: [documentId] });

    // Graph is down. The render still happens; only the upload is deferred.
    setDocumentPortsForTests({ store: { ...store, isConfigured: () => false } });
    await runEffect(DOCUMENT_EFFECTS.renderAndFile, { documentId });

    const staged = await hr.platform.documents.get({ id: documentId });
    expect(staged.filingState).toBe('pending');
    expect(staged.isRendered).toBe(true);

    // …and the subject can still sign, which is the whole point of staging.
    await (
      await caller(subject)
    ).platform.documents.sign({
      documentId,
      typedName: 'Jordan Miles',
      expectedHash: staged.contentHash!,
      ackScrolled: true,
    });

    // Graph returns. Same hash before and after — no re-render happened.
    setDocumentPortsForTests({ store });
    await runEffect(DOCUMENT_EFFECTS.renderAndFile, { documentId });

    const filed = await hr.platform.documents.get({ id: documentId });
    expect(filed.filingState).toBe('filed');
    expect(filed.contentHash).toBe(staged.contentHash);
    expect(filed.status).toBe('signed');
  });
});
