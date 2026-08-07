import { TRPCError } from '@trpc/server';
import { sql } from 'kysely';
import { appendEvent, newUuidV7 } from '@repo/db';
import {
  captureSchemaRegistry,
  isFieldRequired,
  mergeContextRegistry,
  MergeContractError,
  renderMerge,
  type MergeData,
} from '@repo/domain';
import { roleProcedure, router } from '../../trpc.js';
import { z } from 'zod';
import {
  captureSchemaCatalogueOutput,
  createTemplateInput,
  listTemplatesInput,
  listTemplatesOutput,
  mergeContextCatalogueOutput,
  previewTemplateInput,
  previewTemplateOutput,
  templateDetailSchema,
  templateKeyRefInput,
  templateRefInput,
} from '../../schemas.js';
import { decodeCursor, encodeCursor, keysetBoundary, timestampSortKey } from '../../lib/keyset.js';
import {
  assertCaptureSchema,
  deriveTemplateFields,
  DocumentNotFoundError,
  DocumentStateError,
  TEMPLATE_STREAM_TYPE,
} from '../../lib/documents.js';

/**
 * The template library's tRPC surface (core plan 11 §5.1, PL-009).
 *
 * **A template row is a version, and publishing freezes it** (§4.1). There is no
 * `edit a published template` procedure and there will not be one: `create` with
 * an existing `templateKey` mints the next version, and the database refuses the
 * alternative anyway (`template_guard`). That is what makes AC-D3 true — a
 * document issued last year still re-renders the exact version it pinned.
 *
 * Authoring is Administrator-only; reading is HR too. Composed once here per the
 * set overview's 2026-08-03 reconciliation, rather than repeating a role list at
 * each procedure. `adminProcedure` is deliberately **not** used: it guards Better
 * Auth framework operations, and §5.1's "adminProcedure (Administrator)" means
 * `roleProcedure(['administrator'], { module: 'platform' })` (the 2026-07-28
 * reconciliation row).
 */

/** Authoring: create, edit a draft, publish, archive. */
const templateAdmin = roleProcedure(['administrator'], { module: 'platform' });
/** Reading and previewing: HR needs both to generate documents. */
const templateReader = roleProcedure(['administrator', 'hr_user'], { module: 'platform' });

function toTRPCError(error: unknown): unknown {
  if (error instanceof DocumentNotFoundError) {
    return new TRPCError({ code: 'NOT_FOUND', message: error.message });
  }
  if (error instanceof MergeContractError || error instanceof DocumentStateError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  return error;
}

/**
 * "Is this the current template for its key?" — computed in SQL, because it is
 * the facet the manager list filters on and a JavaScript answer would only be
 * correct for the rows on the loaded page (ADR-0004).
 */
const isCurrentSql = sql<boolean>`(
  t.status = 'published' AND t.version = (
    SELECT max(v.version) FROM platform.template v
    WHERE v.template_key = t.template_key AND v.status = 'published' AND v.deleted_at IS NULL
  )
)`;

const SORT_COLUMNS = {
  name: 't.name',
  category: 'c.label',
  updated_at: 't.updated_at',
} as const;

/**
 * Invent a plausible sample value per declared field, so preview works before
 * anyone has a real person in mind (§5.1).
 *
 * The values are obviously fake on purpose — `[first_name]`, not "Jane". A
 * preview populated with realistic-looking names is one screenshot away from
 * being mistaken for a real letter about a real person.
 */
function sampleFor(context: string, field: string): string {
  return `[${context}.${field}]`;
}

export const templatesRouter = router({
  /**
   * The template manager's keyset page. Every facet is SQL, including
   * `isCurrent` and the search — the list, the filters and the counts read one
   * expression (ADR-0004).
   */
  list: templateReader
    .input(listTemplatesInput)
    .output(listTemplatesOutput)
    .query(async ({ ctx, input }) => {
      const direction = input.sortDir;
      const sortColumn = SORT_COLUMNS[input.sort];
      const sortKey =
        input.sort === 'updated_at'
          ? timestampSortKey(sortColumn)
          : sql<string>`coalesce(${sql.ref(sortColumn)}, '')`;

      let query = ctx.db
        .selectFrom('platform.template as t')
        .innerJoin('platform.lookup as c', 'c.id', 't.category_id')
        .select([
          't.id',
          't.template_key',
          't.version',
          't.name',
          't.category_id',
          't.default_issue_mode',
          't.status',
          't.published_at',
          't.updated_at',
          'c.code as category_code',
          'c.label as category_label',
        ])
        .select(isCurrentSql.as('is_current'))
        .where('t.deleted_at', 'is', null);

      if (input.status) query = query.where('t.status', 'in', input.status);
      if (input.categoryId) query = query.where('t.category_id', '=', input.categoryId);
      if (input.search) {
        const term = `%${input.search}%`;
        query = query.where((eb) =>
          eb.or([eb(sql`t.name`, 'ilike', term), eb(sql`t.template_key`, 'ilike', term)]),
        );
      }
      if (!input.allVersions) {
        // The default list is one row per family: the current published version,
        // or the latest row when a family has never been published.
        query = query.where(
          sql<boolean>`t.version = (
            SELECT max(v.version) FROM platform.template v
            WHERE v.template_key = t.template_key AND v.deleted_at IS NULL
              AND (v.status = 'published' OR NOT EXISTS (
                SELECT 1 FROM platform.template p
                WHERE p.template_key = t.template_key AND p.status = 'published' AND p.deleted_at IS NULL
              ))
          )`,
        );
      }

      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      if (cursor) query = query.where(keysetBoundary(sortKey, 't.id', cursor, direction));

      const rows = await query
        .orderBy(sortKey, direction)
        .orderBy('t.id', direction)
        .limit(input.limit + 1)
        .execute();

      const page = rows.slice(0, input.limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > input.limit && last
          ? encodeCursor({
              key:
                input.sort === 'updated_at'
                  ? new Date(last.updated_at).toISOString().replace('Z', '').padEnd(26, '0')
                  : String(last[input.sort === 'name' ? 'name' : 'category_label'] ?? ''),
              id: last.id,
            })
          : null;

      return {
        items: page.map((r) => ({
          id: r.id,
          templateKey: r.template_key,
          version: r.version,
          name: r.name,
          categoryId: r.category_id,
          categoryCode: r.category_code,
          categoryLabel: r.category_label,
          defaultIssueMode: r.default_issue_mode,
          status: r.status,
          publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
          updatedAt: new Date(r.updated_at).toISOString(),
          isCurrent: Boolean(r.is_current),
        })),
        nextCursor,
      };
    }),

  /** One version, with its body and declared fields. */
  get: templateReader
    .input(templateRefInput)
    .output(templateDetailSchema)
    .query(async ({ ctx, input }) => {
      const row = await ctx.db
        .selectFrom('platform.template as t')
        .innerJoin('platform.lookup as c', 'c.id', 't.category_id')
        .selectAll('t')
        .select(['c.code as category_code', 'c.label as category_label'])
        .select(isCurrentSql.as('is_current'))
        .where('t.id', '=', input.id)
        .where('t.deleted_at', 'is', null)
        .executeTakeFirst();

      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such template' });
      return {
        id: row.id,
        templateKey: row.template_key,
        version: row.version,
        name: row.name,
        categoryId: row.category_id,
        categoryCode: row.category_code,
        categoryLabel: row.category_label,
        defaultIssueMode: row.default_issue_mode,
        status: row.status,
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
        archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
        updatedAt: new Date(row.updated_at).toISOString(),
        isCurrent: Boolean(row.is_current),
        bodyHtml: row.body_html,
        mergeFields: (row.merge_fields ?? []) as never,
        mergeContexts: row.merge_contexts,
        captureSchemaKey: row.capture_schema_key,
      };
    }),

  /** Every version for a family, newest first — the version-history drawer. */
  listVersions: templateReader
    .input(templateKeyRefInput)
    .output(listTemplatesOutput.shape.items)
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .selectFrom('platform.template as t')
        .innerJoin('platform.lookup as c', 'c.id', 't.category_id')
        .select([
          't.id',
          't.template_key',
          't.version',
          't.name',
          't.category_id',
          't.default_issue_mode',
          't.status',
          't.published_at',
          't.updated_at',
          'c.code as category_code',
          'c.label as category_label',
        ])
        .select(isCurrentSql.as('is_current'))
        .where('t.template_key', '=', input.templateKey)
        .where('t.deleted_at', 'is', null)
        .orderBy('t.version', 'desc')
        .execute();

      return rows.map((r) => ({
        id: r.id,
        templateKey: r.template_key,
        version: r.version,
        name: r.name,
        categoryId: r.category_id,
        categoryCode: r.category_code,
        categoryLabel: r.category_label,
        defaultIssueMode: r.default_issue_mode,
        status: r.status,
        publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
        updatedAt: new Date(r.updated_at).toISOString(),
        isCurrent: Boolean(r.is_current),
      }));
    }),

  /**
   * A new draft: a new family, or the next version of an existing one.
   *
   * The version number is `max + 1` computed inside the transaction, with the
   * `(template_key, version)` unique constraint as the real guarantee — two
   * administrators creating v3 at the same moment produce v3 and v4, not two
   * v3s and a lost body.
   */
  create: templateAdmin
    .input(createTemplateInput)
    .output(templateDetailSchema.pick({ id: true, templateKey: true, version: true }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireActor(ctx.actorPersonId);
      try {
        return await ctx.db.transaction().execute(async (trx) => {
          const fields = deriveTemplateFields(input.bodyHtml, input.mergeContexts);
          assertCaptureSchema(input.captureSchemaKey);

          const previous = await trx
            .selectFrom('platform.template')
            .select(sql<number>`coalesce(max(version), 0)`.as('max_version'))
            .where('template_key', '=', input.templateKey)
            .executeTakeFirst();

          const id = newUuidV7();
          const version = Number(previous?.max_version ?? 0) + 1;

          await trx
            .insertInto('platform.template')
            .values({
              id,
              template_key: input.templateKey,
              version,
              name: input.name,
              category_id: input.categoryId,
              body_html: input.bodyHtml,
              merge_fields: JSON.stringify(fields) as never,
              merge_contexts: input.mergeContexts,
              capture_schema_key: input.captureSchemaKey ?? null,
              default_issue_mode: input.defaultIssueMode,
              status: 'draft',
              created_by: actor,
              updated_by: actor,
            })
            .execute();

          // No journal event here on purpose: a draft is not yet a fact about
          // the system's behaviour. `published` is (§4.2) — that is the moment
          // the template can reach a person.
          return { id, templateKey: input.templateKey, version };
        });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  /** Edit a draft. The guard trigger backs this for anything else (§4.1). */
  update: templateAdmin
    .input(createTemplateInput.partial().omit({ templateKey: true }).extend({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireActor(ctx.actorPersonId);
      try {
        await ctx.db.transaction().execute(async (trx) => {
          const row = await trx
            .selectFrom('platform.template')
            .selectAll()
            .where('id', '=', input.id)
            .where('deleted_at', 'is', null)
            .forUpdate()
            .executeTakeFirst();
          if (!row) throw new DocumentNotFoundError(input.id);
          if (row.status !== 'draft') {
            throw new DocumentStateError(
              'a published version is immutable — create a new version instead of editing this one',
            );
          }

          const bodyHtml = input.bodyHtml ?? row.body_html;
          const contexts = input.mergeContexts ?? row.merge_contexts;
          // Re-derived on every save, not only at publish: an author fixing
          // their own typo beats the first recipient finding a blank.
          const fields = deriveTemplateFields(bodyHtml, contexts);
          assertCaptureSchema(input.captureSchemaKey);

          await trx
            .updateTable('platform.template')
            .set({
              name: input.name ?? row.name,
              category_id: input.categoryId ?? row.category_id,
              body_html: bodyHtml,
              merge_contexts: contexts,
              merge_fields: JSON.stringify(fields) as never,
              capture_schema_key:
                input.captureSchemaKey === undefined
                  ? row.capture_schema_key
                  : (input.captureSchemaKey ?? null),
              default_issue_mode: input.defaultIssueMode ?? row.default_issue_mode,
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

  /**
   * Publish a draft: validate its merge contract, freeze it, journal
   * `kind='admin'`.
   *
   * The re-validation is not redundant with `update`'s. A context can be
   * *deregistered* between a draft being saved and published — a module removed,
   * a field renamed — and publishing a template whose tokens no longer resolve
   * would produce blank letters nobody could explain.
   */
  publish: templateAdmin.input(templateRefInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx.actorPersonId);
    const now = new Date();
    try {
      await ctx.db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('platform.template as t')
          .innerJoin('platform.lookup as c', 'c.id', 't.category_id')
          .selectAll('t')
          .select('c.code as category_code')
          .where('t.id', '=', input.id)
          .where('t.deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw new DocumentNotFoundError(input.id);
        if (row.status !== 'draft') {
          throw new DocumentStateError(`this version is already ${row.status}`);
        }

        const fields = deriveTemplateFields(row.body_html, row.merge_contexts);
        assertCaptureSchema(row.capture_schema_key);

        await trx
          .updateTable('platform.template')
          .set({
            status: 'published',
            published_at: now,
            merge_fields: JSON.stringify(fields) as never,
            updated_by: actor,
          })
          .where('id', '=', input.id)
          .execute();

        await appendEvent(trx, {
          streamType: TEMPLATE_STREAM_TYPE,
          streamId: input.id,
          eventType: 'platform.template.published',
          // Admin, not domain: publishing changes what the system will say to
          // people without any business fact having occurred — the same class
          // as a configuration change (§4.2).
          kind: 'admin',
          payload: {
            templateKey: row.template_key,
            version: row.version,
            categoryCode: row.category_code,
            defaultIssueMode: row.default_issue_mode,
            mergeFields: fields.map((f) => f.path),
          },
          actorPersonId: actor,
          correlationId: ctx.correlationId,
        });
      });
      return { ok: true };
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /** Retire a published version. Documents that pinned it are unaffected. */
  archive: templateAdmin.input(templateRefInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx.actorPersonId);
    const now = new Date();
    try {
      await ctx.db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('platform.template')
          .selectAll()
          .where('id', '=', input.id)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw new DocumentNotFoundError(input.id);
        if (row.status !== 'published') {
          throw new DocumentStateError(`only a published version can be archived`);
        }

        await trx
          .updateTable('platform.template')
          .set({ status: 'archived', archived_at: now, updated_by: actor })
          .where('id', '=', input.id)
          .execute();

        await appendEvent(trx, {
          streamType: TEMPLATE_STREAM_TYPE,
          streamId: input.id,
          eventType: 'platform.template.archived',
          kind: 'admin',
          payload: { templateKey: row.template_key, version: row.version },
          actorPersonId: actor,
          correlationId: ctx.correlationId,
        });
      });
      return { ok: true };
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /**
   * Render a body with sample data. Nothing is persisted, and no PDF is produced.
   *
   * **HTML, not PDF, and that is a deliberate narrowing of §5.1** (see the
   * Change log). R4 asks that what was previewed equals what was signed; the
   * honest way to guarantee that is for the *issued* document's viewer to stream
   * the rendered artefact, which it does. A second PDF render here would put a
   * synchronous Gotenberg call inside a request for a picture nobody signs.
   */
  preview: templateReader
    .input(previewTemplateInput)
    .output(previewTemplateOutput)
    .query(({ input }) => {
      try {
        const fields = deriveTemplateFields(input.bodyHtml, input.mergeContexts);
        const data: MergeData =
          (input.sampleData as MergeData | undefined) ??
          fields.reduce<MergeData>((bag, f) => {
            bag[f.context] ??= {};
            bag[f.context]![f.field] = sampleFor(f.context, f.field);
            return bag;
          }, {});
        const { html, blanks } = renderMerge(input.bodyHtml, data);
        return { html, mergeFields: fields, blanks: [...blanks] };
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  /** The merge-field palette the editor offers (§9.4). */
  mergeContexts: templateReader.output(mergeContextCatalogueOutput).query(() =>
    [...mergeContextRegistry.values()].map((def) => ({
      name: def.name,
      description: def.description,
      fields: def.fields.map((field) => ({
        path: `${def.name}.${field}`,
        field,
        required: isFieldRequired(def.name, field),
      })),
    })),
  ),

  /** The registered response sets a template may ask for (§4.3). */
  captureSchemas: templateReader.output(captureSchemaCatalogueOutput).query(() =>
    [...captureSchemaRegistry.values()].map((def) => ({
      key: def.key,
      description: def.description,
      questions: def.questions.map((q) => ({
        name: q.name,
        label: q.label,
        kind: q.kind,
        options: q.options ? [...q.options] : undefined,
        required: q.required,
      })),
    })),
  ),
});

function requireActor(actorPersonId: string | null): string {
  if (!actorPersonId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The acting user is not linked to a person record',
    });
  }
  return actorPersonId;
}
