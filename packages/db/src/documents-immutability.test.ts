import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { db } from './client.js';
import { newUuidV7 } from './ids.js';
import { createMigrator } from './migrator.js';
import { truncateAll } from './test-support.js';

/**
 * Real-Postgres validation of the document engine's immutability guarantees
 * (core plan 11 §4.1/§10, AC-D3). These cannot be proven by a mock-DB test:
 * every rule here is a trigger, and a trigger only exists in Postgres.
 *
 * Three separate guarantees, and they fail differently:
 *
 *  - **A published template version is frozen.** Content columns raise on
 *    UPDATE, and status may only advance `published → archived`. The second half
 *    matters more than it looks: without it, a published row could be walked back
 *    to `draft`, edited, and re-published under the same id — and every document
 *    that pinned that id would silently start reporting different content than
 *    the person signed.
 *  - **Issued document content is frozen**, with one deliberate asymmetry:
 *    `content_hash` may go NULL → value (the worker's render) but never
 *    value → value. A rewritable hash would make every signature citing it
 *    deniable, which is the one thing an SES evidence pack exists to prevent.
 *  - **`signature_evidence` is append-only at the database level.** Phase 1
 *    connects as the superuser owner, which bypasses `REVOKE` — so the guard
 *    trigger is the binding enforcement, and it is what these assert.
 */

async function migrate(): Promise<void> {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
}

beforeAll(migrate);
afterAll(async () => {
  await db.destroy();
});

/** The fixture ids, re-minted per test so nothing leaks between them. */
let personId: string;
let categoryId: string;

beforeEach(async () => {
  await truncateAll(db);

  personId = newUuidV7();
  await db
    .insertInto('platform.person')
    .values({ id: personId, relationship_type: 'employee', display_name: 'Jane Doe' })
    .execute();

  categoryId = newUuidV7();
  await db
    .insertInto('platform.lookup')
    .values({
      id: categoryId,
      list_type: 'document_category',
      code: 'policy',
      label: 'Policy',
      created_by: personId,
      updated_by: personId,
    })
    .execute();
});

async function insertTemplate(status: 'draft' | 'published' = 'draft'): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.template')
    .values({
      id,
      template_key: 'guard_test',
      version: 1,
      name: 'Guard test',
      category_id: categoryId,
      body_html: '<p>Hello {{person.full_name}}</p>',
      status,
      published_at: status === 'published' ? new Date() : null,
      created_by: personId,
      updated_by: personId,
    })
    .execute();
  return id;
}

async function insertDocument(
  status: 'draft' | 'issued' = 'draft',
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.document')
    .values({
      id,
      title: 'Guard test',
      category_id: categoryId,
      issue_mode: 'read_and_sign',
      status,
      subject_person_id: personId,
      body_html: '<p>Hello</p>',
      created_by: personId,
      updated_by: personId,
      ...(status === 'issued' ? { issued_at: new Date(), issued_by: personId } : {}),
      ...overrides,
    })
    .execute();
  return id;
}

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

describe('platform.template — publication freeze (PL-009, ADR-0012)', () => {
  it('permits every edit while the version is a draft', async () => {
    const id = await insertTemplate('draft');
    await db
      .updateTable('platform.template')
      .set({ body_html: '<p>rewritten</p>', name: 'Renamed' })
      .where('id', '=', id)
      .execute();

    const row = await db
      .selectFrom('platform.template')
      .select('body_html')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.body_html).toBe('<p>rewritten</p>');
  });

  it('rejects a content edit once the version is published', async () => {
    const id = await insertTemplate('published');
    await expect(
      db
        .updateTable('platform.template')
        .set({ body_html: '<p>tampered</p>' })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/published version is immutable/);
  });

  it('still permits the name, the archive and the soft delete after publication', async () => {
    const id = await insertTemplate('published');
    await db
      .updateTable('platform.template')
      .set({ name: 'Clearer name', updated_by: personId })
      .where('id', '=', id)
      .execute();
    await db
      .updateTable('platform.template')
      .set({ status: 'archived', archived_at: new Date() })
      .where('id', '=', id)
      .execute();

    const row = await db
      .selectFrom('platform.template')
      .select(['name', 'status'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ name: 'Clearer name', status: 'archived' });
  });

  it('refuses to walk a version backwards through its statuses', async () => {
    // The rule that stops "unpublish, edit, republish" rewriting what documents
    // already pinned. Without it the content freeze above is one UPDATE away
    // from being optional.
    const id = await insertTemplate('published');

    // Unpublishing is refused. It trips the frozen-column check first, because
    // clearing `published_at` is itself a rewrite of the publication record —
    // either way the row cannot become editable again.
    await expect(
      db
        .updateTable('platform.template')
        .set({ status: 'draft', published_at: null })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/immutable/);

    // Un-archiving touches no frozen column, so it reaches the status rule —
    // which is the half a column-freeze alone would not cover.
    await db
      .updateTable('platform.template')
      .set({ status: 'archived', archived_at: new Date() })
      .where('id', '=', id)
      .execute();
    await expect(
      db
        .updateTable('platform.template')
        .set({ status: 'published', archived_at: null })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/may only advance/);
  });
});

describe('platform.document — post-issue content freeze (ADR-0012)', () => {
  it('permits free edit of a draft (ON-013 driver)', async () => {
    const id = await insertDocument('draft');
    await db
      .updateTable('platform.document')
      .set({ body_html: '<p>HR edited this before issuing it</p>' })
      .where('id', '=', id)
      .execute();

    const row = await db
      .selectFrom('platform.document')
      .select('body_html')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.body_html).toContain('HR edited');
  });

  it('rejects a content edit once the document is issued', async () => {
    const id = await insertDocument('issued');
    await expect(
      db
        .updateTable('platform.document')
        .set({ body_html: '<p>changed after someone may have read it</p>' })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/issued content is frozen/);
  });

  it('rejects a change of issue mode or subject once issued', async () => {
    const id = await insertDocument('issued');
    await expect(
      db
        .updateTable('platform.document')
        .set({ issue_mode: 'read_only' })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/issued content is frozen/);
  });

  it('lets the render step set content_hash after issue, exactly once', async () => {
    const id = await insertDocument('issued');

    // NULL -> value: this is the worker finishing its render.
    await db
      .updateTable('platform.document')
      .set({ content_hash: HASH_A, filing_state: 'pending' })
      .where('id', '=', id)
      .execute();

    // value -> different value: the rewrite that would unbind every signature.
    await expect(
      db
        .updateTable('platform.document')
        .set({ content_hash: HASH_B })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/content_hash is write-once/);
  });

  it('still permits the filing back-references and lifecycle stamps after issue', async () => {
    const id = await insertDocument('issued');
    await db
      .updateTable('platform.document')
      .set({
        status: 'viewed',
        viewed_at: new Date(),
        content_hash: HASH_A,
        filing_state: 'filed',
        filed_at: new Date(),
        sp_site_id: 'site',
        sp_drive_id: 'drive',
        sp_item_id: 'item',
        pending_content: null,
      })
      .where('id', '=', id)
      .execute();

    const row = await db
      .selectFrom('platform.document')
      .select(['status', 'filing_state'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'viewed', filing_state: 'filed' });
  });
});

describe('platform.signature_evidence — append-only (PL-011, ADR-0011)', () => {
  async function insertEvidence(): Promise<{ evidenceId: string; documentId: string }> {
    const documentId = await insertDocument('issued', { content_hash: HASH_A });
    const evidenceId = newUuidV7();
    await db
      .insertInto('platform.signature_evidence')
      .values({
        id: evidenceId,
        document_id: documentId,
        signatory_person_id: personId,
        method: 'typed_name',
        typed_name: 'Jane Doe',
        document_hash: HASH_A,
        ip: '203.0.113.7',
        user_agent: 'vitest',
        ack_scrolled: true,
        signed_at: new Date(),
        created_by: personId,
      })
      .execute();
    return { evidenceId, documentId };
  }

  it('rejects UPDATE of a recorded signature', async () => {
    const { evidenceId } = await insertEvidence();
    await expect(
      db
        .updateTable('platform.signature_evidence')
        .set({ typed_name: 'Someone Else' })
        .where('id', '=', evidenceId)
        .execute(),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects DELETE of a recorded signature', async () => {
    const { evidenceId } = await insertEvidence();
    await expect(
      db.deleteFrom('platform.signature_evidence').where('id', '=', evidenceId).execute(),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects TRUNCATE — the statement a row trigger would not see', async () => {
    await insertEvidence();
    await expect(sql`TRUNCATE platform.signature_evidence`.execute(db)).rejects.toThrow(
      /append-only/i,
    );
  });

  it('refuses a typed-name signature with no typed name', async () => {
    const documentId = await insertDocument('issued', { content_hash: HASH_A });
    // A method without its artefact is not evidence of anything (§4.1 CHECK).
    await expect(
      db
        .insertInto('platform.signature_evidence')
        .values({
          id: newUuidV7(),
          document_id: documentId,
          signatory_person_id: personId,
          method: 'typed_name',
          typed_name: null,
          document_hash: HASH_A,
          ip: '203.0.113.7',
          user_agent: 'vitest',
          ack_scrolled: true,
          signed_at: new Date(),
          created_by: personId,
        })
        .execute(),
    ).rejects.toThrow(/signature_evidence_method_shape_chk/);
  });
});

describe('platform.document — shape constraints (PL-009)', () => {
  it('refuses a sequence position without a group', async () => {
    await expect(insertDocument('draft', { sequence_no: 2 })).rejects.toThrow(
      /document_sequence_shape_chk/,
    );
  });

  it('refuses a completion date with no completing user', async () => {
    // PL-009 asks for the required action, completion status, date AND user.
    // Two independently nullable columns are how the third goes missing.
    await expect(insertDocument('draft', { completed_at: new Date() })).rejects.toThrow(
      /document_completed_shape_chk/,
    );
  });

  it('refuses to call filing done with no SharePoint item', async () => {
    await expect(
      insertDocument('issued', { filing_state: 'filed', filed_at: new Date() }),
    ).rejects.toThrow(/document_filed_chk/);
  });

  it('refuses a content hash that is not a lowercase sha256 hex', async () => {
    await expect(insertDocument('draft', { content_hash: 'sha256:NOTAHASH' })).rejects.toThrow(
      /document_content_hash_check/,
    );
  });
});
