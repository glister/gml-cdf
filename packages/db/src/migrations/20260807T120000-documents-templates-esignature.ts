import { Kysely, sql } from 'kysely';
import {
  attachUpdatedAtTrigger,
  makeAppendOnly,
  withStandardColumns,
} from '../migration-helpers.js';

/**
 * Core plan 11 §4.1 (PL-009…012, ADR-0011/0012/0017/0019): the three tables of
 * the document engine — the versioned template library, the generated document
 * with its two orthogonal state machines, and the append-only UK SES evidence
 * pack.
 *
 * ## What the shape asserts
 *
 * **A template row *is* a version, and publishing freezes it.** Rows share a
 * `template_key`; `version` increments per key; "the current template" is the
 * highest published version. The alternative — one row edited in place with a
 * separate history table — cannot answer "what exactly did this person sign?"
 * without replaying the history, and a document that pins a version row answers
 * it with a foreign key (ADR-0012, snapshot/effective class). `template_guard`
 * makes the freeze a database property rather than a procedure's promise: once
 * `status <> 'draft'` the content columns cannot move, and the status itself may
 * only advance `published → archived`. Without that last rule a published
 * version could be walked back to `draft`, edited, and re-published under the
 * same id — which is precisely the rewrite the freeze exists to prevent.
 *
 * **The document has two state machines, and they are deliberately not one.**
 * `status` is the user-facing content lifecycle (`draft → issued → viewed →
 * signed`/`completed`, or `cancelled` — ON-016) and `filing_state` is the
 * asynchronous SharePoint half (`none → pending → filed`/`failed`). Collapsing
 * them would make "signed but not yet filed" unrepresentable, and that state is
 * not an edge case: filing happens on a queue precisely so that a Graph outage
 * never blocks a signature (ADR-0017, §4.6). A single `status` column would have
 * to choose which fact to lose.
 *
 * **`document_guard` freezes content at issue, not at signature.** Free edit
 * (ON-013) applies to drafts; the moment a document is issued, `body_html`,
 * `merge_data`, `template_id`, `issue_mode` and `subject_person_id` are fixed,
 * because from that point a person may be reading it. `content_hash` is the one
 * column that may still be *set* after issue — the worker computes it when it
 * renders — but only NULL → value, never value → different value. That single
 * asymmetry is what ties the evidence row to the exact bytes: a hash that could
 * be rewritten would make every signature deniable.
 *
 * **`pending_content` is render staging, not a byte store.** SharePoint is the
 * store of record (PL-010, ADR-0017). The column exists so that issue → view →
 * sign works while Graph is unavailable, and the worker NULLs it once the upload
 * lands. It is listed in plan 16's erasure inventory for that reason: transient
 * or not, it holds a rendered document about a person.
 *
 * **`signature_evidence` is append-only at the database level** (`makeAppendOnly`
 * — REVOKE plus a trigger that fires for the superuser too). Evidence that the
 * application *could* rewrite is not evidence. `evidence_sp_item_id` lives on the
 * *document* rather than here for exactly this reason: the worker sets it after
 * filing the certificate, and an append-only row has nowhere to put it.
 *
 * ## Two deviations from the plan's §4.1 sketch, both recorded in its change log
 *
 *  - **`category_id uuid` + a composite FK, not `category_code text`.** Core plan
 *    05 §4.4 ratified the consumer convention after this plan was written:
 *    transactional records FK the lookup **row id**, with a generated
 *    `*_kind` column pinning the list, so "a document filed under a PPE type" is
 *    a constraint violation rather than a code-review hope. Codes remain the
 *    stable identifier in *configuration* (category visibility, filing paths) —
 *    they are just not what the row stores.
 *  - **`completed_at`/`completed_by` are paired by CHECK, and `filed` implies
 *    `filed_at`.** PL-009 requires the completion status, date and user to be
 *    recorded in every case; two nullable columns with nothing binding them are
 *    how one of the three goes missing.
 *
 * History class (ADR-0012): `template` is **snapshot/effective** (a row is a
 * version; documents pin one). `document` is **operational state** whose business
 * facts are journal events appended in the same transaction (ADR-0010).
 * `signature_evidence` is **evidence** → append-only.
 */

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // The eight issue modes (PL-009 controlled response actions). Written once and
  // reused by both CHECK constraints so template and document can never drift
  // into accepting different sets.
  const issueModes = sql`('read_only', 'read_and_sign', 'no_action', 'receipt_only',
                          'read_and_understood', 'qa_response', 'text_response', 'file_upload')`;

  // --- platform.template -----------------------------------------------------
  await withStandardColumns(
    db.schema
      .createTable('platform.template')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side (ADR-0011)
      // The stable family key. Versions of "the welcome letter" share it; the id
      // identifies one immutable version of it.
      .addColumn('template_key', 'text', (c) =>
        c.notNull().check(sql`template_key ~ '^[a-z][a-z0-9_]{0,63}$'`),
      )
      .addColumn('version', 'integer', (c) => c.notNull().check(sql`version >= 1`))
      .addColumn('name', 'text', (c) => c.notNull())
      // Composite FK against lookup_id_list_type_unique (core plan 05 §4.4): the
      // generated column is what stops this pointing into another list.
      .addColumn('category_id', 'uuid', (c) => c.notNull())
      .addColumn('category_kind', 'text', (c) =>
        c
          .notNull()
          .generatedAlwaysAs(sql`'document_category'`)
          .stored(),
      )
      // HTML with {{context.field}} merge tokens (§4.5). The format the editor,
      // the pure merge engine and the PDF renderer all share.
      .addColumn('body_html', 'text', (c) => c.notNull())
      // Derived from body_html on save — the validation contract, not free input.
      .addColumn('merge_fields', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
      .addColumn('merge_contexts', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))
      // A registered response-capture schema (ON-026 driver). Required for
      // qa_response; nullable everywhere else.
      .addColumn('capture_schema_key', 'text')
      .addColumn('default_issue_mode', 'text', (c) =>
        c
          .notNull()
          .defaultTo('read_and_sign')
          .check(sql`default_issue_mode IN ${issueModes}`),
      )
      .addColumn('status', 'text', (c) =>
        c
          .notNull()
          .defaultTo('draft')
          .check(sql`status IN ('draft', 'published', 'archived')`),
      )
      .addColumn('published_at', 'timestamptz')
      .addColumn('archived_at', 'timestamptz'),
    { actorStamps: false },
  )
    // NOT NULL, unlike the platform default: a template is authored by an
    // Administrator, never by the system. There is no path that creates one
    // without a person behind it, so the column may as well say so.
    .addColumn('created_by', 'uuid', (c) => c.notNull())
    .addColumn('updated_by', 'uuid', (c) => c.notNull())
    .addUniqueConstraint('template_key_version_uq', ['template_key', 'version'])
    .addForeignKeyConstraint(
      'template_category_fkey',
      ['category_id', 'category_kind'],
      'platform.lookup',
      ['id', 'list_type'],
    )
    .addForeignKeyConstraint('template_created_by_fkey', ['created_by'], 'platform.person', ['id'])
    .addForeignKeyConstraint('template_updated_by_fkey', ['updated_by'], 'platform.person', ['id'])
    // A status stamp that can drift from its status is a status stamp nobody can
    // trust. `published_at` survives archiving — it records when the version was
    // published, not whether it still is.
    .addCheckConstraint(
      'template_published_at_chk',
      sql`(status = 'draft') = (published_at IS NULL)`,
    )
    .addCheckConstraint(
      'template_archived_at_chk',
      sql`(status = 'archived') = (archived_at IS NOT NULL)`,
    )
    // qa_response has answers to validate, so it must say what against (§4.3).
    .addCheckConstraint(
      'template_qa_needs_capture_schema_chk',
      sql`default_issue_mode <> 'qa_response' OR capture_schema_key IS NOT NULL`,
    )
    .execute();

  await sql`
    COMMENT ON TABLE platform.template IS
      'One immutable version of a document template (PL-009). Rows share template_key; version increments per key; publishing freezes the content columns via template_guard. A document pins the exact row it was generated from, so later edits never rewrite what was issued (ADR-0012).'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN platform.template.merge_fields IS
      'Derived from body_html on save, never hand-entered: the declared field contract publish validates against, so a template cannot ship with an unsatisfiable token (§4.5).'
  `.execute(db);

  // "The current template for this key" and the version-history drawer.
  await sql`
    CREATE INDEX template_key_version_idx
      ON platform.template (template_key, version DESC) WHERE deleted_at IS NULL
  `.execute(db);
  // The manager's keyset list, filtered by status/category in SQL (ADR-0004).
  await sql`
    CREATE INDEX template_list_idx
      ON platform.template (created_at, id) WHERE deleted_at IS NULL
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.template');

  // Publication freeze (§4.1). The content columns are named explicitly rather
  // than compared wholesale, because `name`, the status advance and the soft
  // delete must all still work on a published row.
  await sql`
    CREATE FUNCTION platform.template_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      -- Erasure-role bypass (ADR-0019, plan 16). Defensive: no-op until the role
      -- exists (current_user membership, never a session GUC).
      IF to_regrole('cdf_erasure') IS NOT NULL
         AND pg_has_role(current_user, 'cdf_erasure', 'MEMBER') THEN
        RETURN COALESCE(NEW, OLD);
      END IF;

      -- Drafts are freely editable; that is what draft means.
      IF OLD.status = 'draft' THEN
        RETURN NEW;
      END IF;

      IF NEW.template_key       IS DISTINCT FROM OLD.template_key
      OR NEW.version            IS DISTINCT FROM OLD.version
      OR NEW.category_id        IS DISTINCT FROM OLD.category_id
      OR NEW.body_html          IS DISTINCT FROM OLD.body_html
      OR NEW.merge_fields       IS DISTINCT FROM OLD.merge_fields
      OR NEW.merge_contexts     IS DISTINCT FROM OLD.merge_contexts
      OR NEW.capture_schema_key IS DISTINCT FROM OLD.capture_schema_key
      OR NEW.default_issue_mode IS DISTINCT FROM OLD.default_issue_mode
      OR NEW.published_at       IS DISTINCT FROM OLD.published_at THEN
        RAISE EXCEPTION
          'platform.template %: a published version is immutable (PL-009, ADR-0012) — publish a new version instead of editing this one',
          OLD.id;
      END IF;

      -- Status may only advance. Walking back to draft would make the row
      -- editable again under the same id, which is the rewrite the freeze exists
      -- to prevent — and documents already pin this id.
      IF NEW.status <> OLD.status AND NOT (OLD.status = 'published' AND NEW.status = 'archived') THEN
        RAISE EXCEPTION
          'platform.template %: status may only advance published -> archived, not % -> %',
          OLD.id, OLD.status, NEW.status;
      END IF;

      RETURN NEW;
    END;
    $$;
  `.execute(db);
  await sql`
    CREATE TRIGGER template_guard BEFORE UPDATE
      ON platform.template FOR EACH ROW
      EXECUTE FUNCTION platform.template_guard()
  `.execute(db);

  // --- platform.document -----------------------------------------------------
  await withStandardColumns(
    db.schema
      .createTable('platform.document')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side
      .addColumn('title', 'text', (c) => c.notNull())
      .addColumn('category_id', 'uuid', (c) => c.notNull())
      .addColumn('category_kind', 'text', (c) =>
        c
          .notNull()
          .generatedAlwaysAs(sql`'document_category'`)
          .stored(),
      )
      // The exact immutable VERSION row used (PL-009). NULL only for migrated or
      // imported documents, which have no template (DM plan, impl notes §5).
      .addColumn('template_id', 'uuid')
      // The recorded REQUIRED ACTION (PL-009). Copied from the template's default
      // at generation and overridable at issue — the document, not the template,
      // is what a person was asked to do.
      .addColumn('issue_mode', 'text', (c) => c.notNull().check(sql`issue_mode IN ${issueModes}`))
      .addColumn('status', 'text', (c) =>
        c
          .notNull()
          .defaultTo('draft')
          .check(sql`status IN ('draft', 'issued', 'viewed', 'signed', 'completed', 'cancelled')`),
      )
      .addColumn('filing_state', 'text', (c) =>
        c
          .notNull()
          .defaultTo('none')
          .check(sql`filing_state IN ('none', 'pending', 'filed', 'failed')`),
      )
      .addColumn('filing_attempts', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('filing_error', 'text')
      // --- Subject links -------------------------------------------------------
      // The person the document is about, plus a generic stream ref for the
      // consuming module's case record (later 'hr.onboarding_case' etc.).
      .addColumn('subject_person_id', 'uuid', (c) => c.notNull())
      .addColumn('subject_stream_type', 'text')
      .addColumn('subject_stream_id', 'uuid')
      // --- Ordered-sequence issue (ON-023 driver) ------------------------------
      .addColumn('issue_group_id', 'uuid')
      .addColumn('sequence_no', 'integer', (c) => c.check(sql`sequence_no >= 1`))
      // --- Content -------------------------------------------------------------
      // Snapshot-on-use (ADR-0012): the exact data bag merged, kept so "what was
      // pre-filled" and "what was issued" are both reconstructable after a free
      // edit (ON-013 driver).
      .addColumn('merge_data', 'jsonb')
      .addColumn('body_html', 'text')
      // Lowercase `sha256:<hex>` of the rendered PDF bytes, set by the render
      // step. Ties evidence to exact bytes (ADR-0017).
      .addColumn('content_hash', 'text', (c) =>
        c.check(sql`content_hash ~ '^sha256:[0-9a-f]{64}$'`),
      )
      // Transient render staging. SharePoint is the byte store of record; this is
      // NULLed once filing lands (§4.6).
      .addColumn('pending_content', 'bytea')
      // --- Response capture (ON-026 driver; PL-009 Q&A/text responses) ---------
      .addColumn('capture_schema_key', 'text')
      .addColumn('capture_data', 'jsonb')
      .addColumn('text_response', 'text')
      .addColumn('response_sp_item_id', 'text')
      // --- Completion record (PL-009: required action, status, date and user) --
      .addColumn('completed_at', 'timestamptz')
      .addColumn('completed_by', 'uuid')
      // --- SharePoint back-reference (PL-010, ADR-0017) ------------------------
      .addColumn('sp_site_id', 'text')
      .addColumn('sp_drive_id', 'text')
      .addColumn('sp_item_id', 'text')
      .addColumn('sp_web_url', 'text')
      // The filed evidence-certificate PDF. Kept here rather than on the
      // append-only evidence row, so the worker can set it after the fact.
      .addColumn('evidence_sp_item_id', 'text')
      // --- Lifecycle stamps ----------------------------------------------------
      .addColumn('issued_by', 'uuid')
      .addColumn('issued_at', 'timestamptz')
      .addColumn('viewed_at', 'timestamptz') // first subject view (ON-016)
      .addColumn('signed_at', 'timestamptz')
      .addColumn('filed_at', 'timestamptz')
      .addColumn('cancelled_at', 'timestamptz')
      .addColumn('cancel_reason', 'text'),
    { actorStamps: false },
  )
    .addColumn('created_by', 'uuid', (c) => c.notNull())
    .addColumn('updated_by', 'uuid', (c) => c.notNull())
    .addForeignKeyConstraint(
      'document_category_fkey',
      ['category_id', 'category_kind'],
      'platform.lookup',
      ['id', 'list_type'],
    )
    .addForeignKeyConstraint('document_template_fkey', ['template_id'], 'platform.template', ['id'])
    .addForeignKeyConstraint('document_subject_fkey', ['subject_person_id'], 'platform.person', [
      'id',
    ])
    .addForeignKeyConstraint('document_completed_by_fkey', ['completed_by'], 'platform.person', [
      'id',
    ])
    .addForeignKeyConstraint('document_issued_by_fkey', ['issued_by'], 'platform.person', ['id'])
    .addForeignKeyConstraint('document_created_by_fkey', ['created_by'], 'platform.person', ['id'])
    .addForeignKeyConstraint('document_updated_by_fkey', ['updated_by'], 'platform.person', ['id'])
    // A sequence position without a group is meaningless, and a group member
    // without a position cannot be ordered.
    .addCheckConstraint(
      'document_sequence_shape_chk',
      sql`(issue_group_id IS NULL) = (sequence_no IS NULL)`,
    )
    .addCheckConstraint(
      'document_subject_stream_shape_chk',
      sql`(subject_stream_type IS NULL) = (subject_stream_id IS NULL)`,
    )
    // PL-009 asks for the completion status, date AND user. Two independently
    // nullable columns are how the third goes missing.
    .addCheckConstraint(
      'document_completed_shape_chk',
      sql`(completed_at IS NULL) = (completed_by IS NULL)`,
    )
    .addCheckConstraint('document_issued_shape_chk', sql`(issued_at IS NULL) = (issued_by IS NULL)`)
    // Filing that claims to be done says where and when.
    .addCheckConstraint(
      'document_filed_chk',
      sql`filing_state <> 'filed' OR (filed_at IS NOT NULL AND sp_item_id IS NOT NULL)`,
    )
    .addCheckConstraint(
      'document_cancelled_chk',
      sql`(status = 'cancelled') = (cancelled_at IS NOT NULL)`,
    )
    .execute();

  await sql`
    COMMENT ON TABLE platform.document IS
      'A generated document: metadata, status and evidence in Postgres; bytes in SharePoint (PL-010, ADR-0017). Two orthogonal state machines — status is the user-facing content lifecycle (ON-016), filing_state the asynchronous SharePoint half — so "signed but not yet filed" is representable, which is the whole point of filing on a queue.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN platform.document.pending_content IS
      'Transient render staging only: the rendered PDF between the render step and a successful upload, NULLed once filed. SharePoint is the byte store of record. Registered with plan 16''s erasure inventory — transient or not, it holds a rendered document about a person.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN platform.document.content_hash IS
      'sha256:<hex> of the rendered PDF bytes. Settable once (NULL -> value) and never rewritable, enforced by document_guard: a hash that could change would make every signature bound to it deniable.'
  `.execute(db);

  // One position per group, so an ordered issue cannot double-book step 2.
  await sql`
    CREATE UNIQUE INDEX document_group_sequence_uq
      ON platform.document (issue_group_id, sequence_no) WHERE issue_group_id IS NOT NULL
  `.execute(db);
  // The subject's keyset list (ADR-0004).
  await sql`
    CREATE INDEX document_subject_keyset_idx
      ON platform.document (subject_person_id, created_at, id) WHERE deleted_at IS NULL
  `.execute(db);
  // The filing sweep and the admin "what is stuck?" query.
  await sql`
    CREATE INDEX document_filing_idx
      ON platform.document (filing_state) WHERE filing_state IN ('pending', 'failed')
  `.execute(db);
  // "Which documents belong to this case?" — the consuming module's read.
  await sql`
    CREATE INDEX document_stream_idx
      ON platform.document (subject_stream_type, subject_stream_id)
      WHERE subject_stream_type IS NOT NULL
  `.execute(db);
  // Chasing outstanding documents (the reminder rule's satisfaction check).
  await sql`
    CREATE INDEX document_outstanding_idx
      ON platform.document (status) WHERE status IN ('issued', 'viewed') AND deleted_at IS NULL
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.document');

  // Post-issue content freeze (§4.1). Free edit is a draft-only affordance; from
  // `issued` onwards someone may be reading the thing.
  await sql`
    CREATE FUNCTION platform.document_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF to_regrole('cdf_erasure') IS NOT NULL
         AND pg_has_role(current_user, 'cdf_erasure', 'MEMBER') THEN
        RETURN COALESCE(NEW, OLD);
      END IF;

      IF OLD.status = 'draft' THEN
        RETURN NEW;
      END IF;

      IF NEW.body_html         IS DISTINCT FROM OLD.body_html
      OR NEW.merge_data        IS DISTINCT FROM OLD.merge_data
      OR NEW.template_id       IS DISTINCT FROM OLD.template_id
      OR NEW.issue_mode        IS DISTINCT FROM OLD.issue_mode
      OR NEW.subject_person_id IS DISTINCT FROM OLD.subject_person_id
      OR NEW.category_id       IS DISTINCT FROM OLD.category_id THEN
        RAISE EXCEPTION
          'platform.document %: issued content is frozen (ADR-0012) — cancel and reissue rather than editing what someone may already have read',
          OLD.id;
      END IF;

      -- The one asymmetry: the worker sets content_hash after issue when the
      -- render completes. NULL -> value is the render; value -> anything else
      -- would unbind every signature that cited it.
      IF OLD.content_hash IS NOT NULL AND NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN
        RAISE EXCEPTION
          'platform.document %: content_hash is write-once — it is what ties signature evidence to the exact bytes signed (PL-011)',
          OLD.id;
      END IF;

      RETURN NEW;
    END;
    $$;
  `.execute(db);
  await sql`
    CREATE TRIGGER document_guard BEFORE UPDATE
      ON platform.document FOR EACH ROW
      EXECUTE FUNCTION platform.document_guard()
  `.execute(db);

  // --- platform.signature_evidence -------------------------------------------
  //
  // The UK SES evidence pack (PL-011; ON-017…020 drivers). Append-only at the
  // database level: evidence the application could rewrite is not evidence.
  await withStandardColumns(
    db.schema
      .createTable('platform.signature_evidence')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side
      .addColumn('document_id', 'uuid', (c) => c.notNull())
      .addColumn('signatory_person_id', 'uuid', (c) => c.notNull())
      .addColumn('method', 'text', (c) =>
        c.notNull().check(sql`method IN ('typed_name', 'signature_pad')`),
      )
      // Exactly as entered — the evidential value is in it being the signatory's
      // own keystrokes, not a normalised form of them.
      .addColumn('typed_name', 'text')
      // PNG of pad strokes. The mobile app's method (ADR-0023); the column ships
      // now so the schema does not have to move when the app lands.
      .addColumn('signature_image', 'bytea')
      // MUST equal document.content_hash at signing — checked by the procedure
      // and recorded here so the export can re-verify it independently.
      .addColumn('document_hash', 'text', (c) =>
        c.notNull().check(sql`document_hash ~ '^sha256:[0-9a-f]{64}$'`),
      )
      .addColumn('ip', sql`inet`, (c) => c.notNull())
      .addColumn('user_agent', 'text', (c) => c.notNull())
      // The signatory scrolled/acknowledged the full document before signing.
      .addColumn('ack_scrolled', 'boolean', (c) => c.notNull())
      .addColumn('signed_at', 'timestamptz', (c) => c.notNull()),
    { updatedAt: false, softDelete: false, actorStamps: false },
  )
    .addColumn('created_by', 'uuid', (c) => c.notNull())
    .addForeignKeyConstraint(
      'signature_evidence_document_fkey',
      ['document_id'],
      'platform.document',
      ['id'],
    )
    .addForeignKeyConstraint(
      'signature_evidence_signatory_fkey',
      ['signatory_person_id'],
      'platform.person',
      ['id'],
    )
    .addForeignKeyConstraint(
      'signature_evidence_created_by_fkey',
      ['created_by'],
      'platform.person',
      ['id'],
    )
    // A method without its artefact is not evidence of anything.
    .addCheckConstraint(
      'signature_evidence_method_shape_chk',
      sql`(method = 'typed_name' AND typed_name IS NOT NULL AND signature_image IS NULL)
       OR (method = 'signature_pad' AND signature_image IS NOT NULL AND typed_name IS NULL)`,
    )
    .execute();

  await sql`
    COMMENT ON TABLE platform.signature_evidence IS
      'UK Simple Electronic Signature evidence (PL-011): signatory, method, timestamp, IP, user-agent, scroll acknowledgement and the document hash. Append-only at the database level (ADR-0011) — the export recomputes the hash over the stored bytes and asserts it matches this row, which is what makes the pack answer a repudiation claim.'
  `.execute(db);

  await sql`
    CREATE INDEX signature_evidence_document_idx
      ON platform.signature_evidence (document_id)
  `.execute(db);

  await makeAppendOnly(db, 'platform.signature_evidence');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('platform.signature_evidence').ifExists().execute();
  await sql`DROP TRIGGER IF EXISTS document_guard ON platform.document`.execute(db);
  await db.schema.dropTable('platform.document').ifExists().execute();
  await sql`DROP FUNCTION IF EXISTS platform.document_guard()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS template_guard ON platform.template`.execute(db);
  await db.schema.dropTable('platform.template').ifExists().execute();
  await sql`DROP FUNCTION IF EXISTS platform.template_guard()`.execute(db);
}
