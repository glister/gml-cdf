import { TRPCError } from '@trpc/server';
import { sql } from 'kysely';
import { appendEvent, newUuidV7 } from '@repo/db';
import { hasRole, type EventPayload } from '@repo/domain';
import { protectedProcedure, roleProcedure, router, type TRPCContext } from '../../trpc.js';
import {
  createLookupValueInput,
  listLookupValuesInput,
  lookupOptionsInput,
  removeLookupValueInput,
  setLookupActiveInput,
  updateLookupValueInput,
} from '../../schemas.js';
import { decodeCursor, encodeCursor, keysetBoundary, timestampSortKey } from '../../lib/keyset.js';
import { isUniqueViolation } from '@repo/db';

/**
 * Tier 1 reference data (core plan 05 §5.1, PL-005/005b/006/007, ADR-0016).
 *
 * Two audiences, two authorisation levels:
 *
 *  - **`options`** populates dropdowns for every authenticated user. Reference
 *    data is what things are *called*; withholding the labels a form needs would
 *    serve nobody. Retired values are hidden here and only here — that is the
 *    whole mechanism behind PL-007's "deactivate, don't delete".
 *  - **everything else** is maintenance, restricted to Administrator or HR User
 *    (SoW §10, PL-005). Every write journals a `kind='admin'` event in the same
 *    transaction as its state change (ADR-0010/0016), which is what lets a value
 *    be added without a release and still be fully audited (AC-D1, AC-D7).
 */

/**
 * Reference-data maintenance: Administrator ∪ HR User, in the platform module
 * (core plan 05 §12.2 Q5, resolved 2026-08-03 — plan 04 exports the generic
 * `roleProcedure`; there is no separate `refDataAdminProcedure` to import, so
 * the builder is composed here where its role list is visible).
 */
export const refDataAdminProcedure = roleProcedure(['administrator', 'hr_user'], {
  module: 'platform',
});

/** The roles allowed to see retired values and the maintenance table. */
const REF_DATA_ADMIN_ROLES = ['administrator', 'hr_user'] as const;

/**
 * `sort_order` rendered fixed-width so the keyset boundary compares in numeric
 * order (`'2' > '10'` lexically; `'000002' < '000010'` is what we need). The
 * input schema caps `sortOrder` at 9999, well inside six digits.
 */
const SORT_ORDER_KEY = sql<string>`lpad(coalesce(l.sort_order, 0)::text, 6, '0')`;

/** The acting person's id — guaranteed non-null by `roleProcedure`. */
function requireActor(ctx: TRPCContext): string {
  if (!ctx.actorPersonId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The acting user is not linked to a person record',
    });
  }
  return ctx.actorPersonId;
}

/** Load a live value or 404. Soft-deleted rows are invisible to every path. */
async function loadValue(ctx: TRPCContext, id: string) {
  const row = await ctx.db
    .selectFrom('platform.lookup')
    .selectAll()
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Lookup value not found' });
  return row;
}

export const lookupRouter = router({
  /**
   * Dropdown population. Active values of one list in display order.
   *
   * Cached client-side by TanStack Query (`staleTime` 5 min in `LookupSelect`);
   * there is no server cache, because at CDF's scale a seven-row list is cheaper
   * to read than to invalidate correctly (§5.1).
   */
  options: protectedProcedure.input(lookupOptionsInput).query(async ({ ctx, input }) => {
    // Retired values are admin-only: a picker offering one would undo the point
    // of deactivating it (PL-007). Checked here rather than by splitting the
    // procedure, so the same call site serves both audiences.
    if (
      input.includeInactive &&
      !hasRole(ctx.grants, REF_DATA_ADMIN_ROLES, 'platform', new Date())
    ) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Retired values are visible to reference-data administrators only',
      });
    }

    let query = ctx.db
      .selectFrom('platform.lookup')
      .select(['id', 'code', 'label', 'description', 'sort_order', 'active'])
      .where('list_type', '=', input.listType)
      .where('deleted_at', 'is', null);
    if (!input.includeInactive) query = query.where('active', '=', true);

    return query.orderBy('sort_order', 'asc').orderBy('label', 'asc').execute();
  }),

  /**
   * Per-list totals for the reference-data overview screen (§5.3).
   *
   * Added during build (§5.1 deviation, 2026-08-03): the overview needs a count
   * per list, and the alternative — seven `adminList` queries counted in the
   * browser — is the client-side aggregation ADR-0004 forbids, over paginated
   * data that would give the wrong answer anyway. One grouped query instead.
   */
  listTypes: refDataAdminProcedure.query(async ({ ctx }) => {
    return ctx.db
      .selectFrom('platform.lookup')
      .select([
        'list_type',
        (eb) => eb.fn.countAll<number>().as('total'),
        () => sql<number>`count(*) FILTER (WHERE active)`.as('active'),
      ])
      .where('deleted_at', 'is', null)
      .groupBy('list_type')
      .execute();
  }),

  /**
   * The maintenance table: keyset-paginated, every facet applied in SQL
   * (ADR-0004 hard rule — the client holds one page, so filtering or sorting it
   * client-side would silently operate on a fraction of the set).
   */
  adminList: refDataAdminProcedure.input(listLookupValuesInput).query(async ({ ctx, input }) => {
    const sortKey =
      input.sort === 'label'
        ? sql<string>`coalesce(lower(l.label), '')`
        : input.sort === 'updated_at'
          ? timestampSortKey('l.updated_at')
          : SORT_ORDER_KEY;

    let query = ctx.db
      .selectFrom('platform.lookup as l')
      .select([
        'l.id',
        'l.list_type',
        'l.code',
        'l.label',
        'l.description',
        'l.sort_order',
        'l.active',
        'l.updated_at',
      ])
      .select(sortKey.as('sort_key'))
      .where('l.deleted_at', 'is', null);

    if (input.listType) query = query.where('l.list_type', '=', input.listType);
    if (input.active !== undefined) query = query.where('l.active', '=', input.active);
    if (input.search) {
      const term = `%${input.search}%`;
      query = query.where((eb) =>
        eb.or([eb('l.label', 'ilike', term), eb('l.code', 'ilike', term)]),
      );
    }
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      if (cursor) query = query.where(keysetBoundary(sortKey, 'l.id', cursor, input.sortDir));
    }

    const rows = await query
      .orderBy(sortKey, input.sortDir)
      .orderBy('l.id', input.sortDir)
      .limit(input.limit + 1)
      .execute();

    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ key: last.sort_key, id: last.id }) : null;
    return { items: items.map(({ sort_key: _sk, ...rest }) => rest), nextCursor };
  }),

  /**
   * Add a value — the AC-D1 path: data entry, no code change, no release, and
   * immediately selectable in every consuming dropdown.
   *
   * `sortOrder` defaults to the end of its list rather than 0, so a new value
   * appears where an administrator expects it instead of jumping to the top.
   */
  create: refDataAdminProcedure.input(createLookupValueInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    const id = newUuidV7();

    try {
      await ctx.db.transaction().execute(async (trx) => {
        const sortOrder =
          input.sortOrder ??
          (
            await trx
              .selectFrom('platform.lookup')
              .select(sql<number>`coalesce(max(sort_order), -1) + 1`.as('next'))
              .where('list_type', '=', input.listType)
              .executeTakeFirstOrThrow()
          ).next;

        await trx
          .insertInto('platform.lookup')
          .values({
            id,
            list_type: input.listType,
            code: input.code,
            label: input.label,
            description: input.description ?? null,
            sort_order: sortOrder,
            created_by: actor,
            updated_by: actor,
          })
          .execute();

        await appendEvent(trx, {
          kind: 'admin',
          streamType: 'platform.lookup',
          streamId: id,
          eventType: 'platform.lookup.value.created',
          payload: {
            listType: input.listType,
            code: input.code,
            label: input.label,
            sortOrder,
          },
          actorPersonId: actor,
          correlationId: ctx.correlationId,
        });
      });
    } catch (error) {
      // Uniqueness spans soft-deleted rows on purpose: a deleted code must not
      // come back meaning something else (§4.1.1).
      if (isUniqueViolation(error, 'lookup_list_type_code_unique')) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `'${input.code}' already exists in this list. Codes are permanent — reactivate the existing value rather than recreating it.`,
        });
      }
      throw error;
    }

    return { id };
  }),

  /**
   * Edit display attributes. `code` cannot be changed — the input schema is
   * strict, so supplying one is a validation error rather than a silent no-op.
   */
  update: refDataAdminProcedure.input(updateLookupValueInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    const before = await loadValue(ctx, input.id);

    const nextLabel = input.label ?? before.label;
    const nextDescription =
      input.description === undefined ? before.description : input.description;
    const nextSortOrder = input.sortOrder ?? before.sort_order;

    // Deltas drive both the update and the event, so the journal cannot claim a
    // change the row did not make.
    const changes: EventPayload<'platform.lookup.value.updated'> = {
      listType: before.list_type,
      code: before.code,
    };
    if (nextLabel !== before.label) changes.label = { from: before.label, to: nextLabel };
    if (nextDescription !== before.description) {
      changes.description = { from: before.description, to: nextDescription };
    }
    if (nextSortOrder !== before.sort_order) {
      changes.sortOrder = { from: before.sort_order, to: nextSortOrder };
    }
    if (!changes.label && !changes.description && !changes.sortOrder) {
      // Nothing changed: no write, no event. An empty admin event would be noise
      // in the audit view (plan 13) and in the reporting feed.
      return { id: input.id, changed: false };
    }

    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('platform.lookup')
        .set({
          label: nextLabel,
          description: nextDescription,
          sort_order: nextSortOrder,
          updated_by: actor,
        })
        .where('id', '=', input.id)
        .execute();

      await appendEvent(trx, {
        kind: 'admin',
        streamType: 'platform.lookup',
        streamId: input.id,
        eventType: 'platform.lookup.value.updated',
        payload: changes,
        actorPersonId: actor,
        correlationId: ctx.correlationId,
      });
    });

    return { id: input.id, changed: true };
  }),

  /**
   * Retire or restore a value (§4.3). Deactivating hides it from `options`
   * while every historical record referencing it still joins for its label —
   * that pairing IS PL-007 for Tier 1.
   */
  setActive: refDataAdminProcedure.input(setLookupActiveInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    const before = await loadValue(ctx, input.id);
    if (before.active === input.active) return { id: input.id, changed: false };

    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('platform.lookup')
        .set({ active: input.active, updated_by: actor })
        .where('id', '=', input.id)
        .execute();

      await appendEvent(trx, {
        kind: 'admin',
        streamType: 'platform.lookup',
        streamId: input.id,
        eventType: input.active
          ? 'platform.lookup.value.reactivated'
          : 'platform.lookup.value.deactivated',
        payload: { listType: before.list_type, code: before.code },
        actorPersonId: actor,
        correlationId: ctx.correlationId,
      });
    });

    return { id: input.id, changed: true };
  }),

  /**
   * Soft-delete a value created in error.
   *
   * This is the mistake path, not the retirement path — `setActive(false)` is
   * how a value that has been used goes away. Nothing here can prove non-use
   * (the consuming tables arrive with later plans), so `confirmNeverUsed` makes
   * the caller assert it and the journal records who asserted it.
   */
  remove: refDataAdminProcedure.input(removeLookupValueInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    const before = await loadValue(ctx, input.id);

    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('platform.lookup')
        .set({ deleted_at: new Date(), updated_by: actor })
        .where('id', '=', input.id)
        .execute();

      await appendEvent(trx, {
        kind: 'admin',
        streamType: 'platform.lookup',
        streamId: input.id,
        eventType: 'platform.lookup.value.deleted',
        payload: { listType: before.list_type, code: before.code },
        actorPersonId: actor,
        correlationId: ctx.correlationId,
      });
    });

    return { id: input.id };
  }),
});
