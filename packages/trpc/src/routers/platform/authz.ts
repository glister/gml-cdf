import { TRPCError } from '@trpc/server';
import { sql, type SqlBool } from 'kysely';
import { appendEvent, grantRole, newUuidV7, revokeGrant } from '@repo/db';
import { grantState } from '@repo/domain';
import { protectedProcedure, roleProcedure, router, type TRPCContext } from '../../trpc.js';
import {
  addAllocationInput,
  endAllocationInput,
  grantRoleInput,
  listAllocationsInput,
  listGrantsInput,
  revokeGrantInput,
} from '../../schemas.js';
import { decodeCursor, encodeCursor, keysetBoundary, timestampSortKey } from '../../lib/keyset.js';

/**
 * Authorisation administration (core plan 04 §5.1, PL-002/PL-004, CORE-05).
 *
 * This router administers the machinery that guards every other router, so it
 * guards itself with that same machinery: `roleProcedure(['administrator'],
 * { module: 'platform' })` — no hardcoded superuser, no `adminProcedure`.
 *
 * Every mutation journals its fact in the SAME transaction as the state change
 * (ADR-0010), with PII-minimal payloads: ids, role keys and module keys only.
 */

/** Administration of roles and grants — Administrator, in the platform module. */
const authzAdmin = roleProcedure(['administrator'], { module: 'platform' });
/** Allocation administration is shared with HR (CORE-05 intake is an HR flow). */
const allocationAdmin = roleProcedure(['administrator', 'hr_user'], { module: 'platform' });

/**
 * The grant lifecycle state, derived in SQL. Mirrors `grantState()` in
 * `@repo/domain` **exactly**, including precedence (revoked → expired → pending
 * → active), so the displayed value, the `state` filter and any aggregate all
 * read the same expression (ADR-0004). Changing one without the other is a bug.
 */
const GRANT_STATE_SQL = sql<string>`CASE
  WHEN g.revoked_at IS NOT NULL THEN 'revoked'
  WHEN g.valid_until IS NOT NULL AND g.valid_until <= now() THEN 'expired'
  WHEN g.valid_from > now() THEN 'pending'
  ELSE 'active'
END`;

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

export const authzRouter = router({
  // --- Roles --------------------------------------------------------------

  /**
   * The role set with live grant counts per module. The counts are computed in
   * SQL (a lateral aggregate), never by counting rows in JS.
   */
  roles: router({
    list: authzAdmin.query(async ({ ctx }) => {
      const rows = await ctx.db
        .selectFrom('platform.role as r')
        .select([
          'r.id',
          'r.key',
          'r.name',
          'r.description',
          'r.is_system',
          (eb) =>
            eb
              .selectFrom('platform.role_grant as g')
              .select((e) => e.fn.countAll<number>().as('c'))
              .whereRef('g.role_id', '=', 'r.id')
              .where('g.revoked_at', 'is', null)
              .where('g.deleted_at', 'is', null)
              .where(sql<SqlBool>`g.valid_from <= now()`)
              .where(sql<SqlBool>`(g.valid_until IS NULL OR g.valid_until > now())`)
              .as('activeGrantCount'),
        ])
        .where('r.deleted_at', 'is', null)
        .orderBy('r.id')
        .execute();
      return rows;
    }),

    /**
     * Per-module breakdown of who holds what — the §5.3 "roles" view. One
     * grouped query, not a per-role fan-out.
     */
    byModule: authzAdmin.query(async ({ ctx }) => {
      return ctx.db
        .selectFrom('platform.role_grant as g')
        .innerJoin('platform.role as r', 'r.id', 'g.role_id')
        .select([
          'g.module',
          'r.key as roleKey',
          'r.name as roleName',
          (eb) => eb.fn.countAll<number>().as('holders'),
        ])
        .where('g.revoked_at', 'is', null)
        .where('g.deleted_at', 'is', null)
        .where(sql<SqlBool>`g.valid_from <= now()`)
        .where(sql<SqlBool>`(g.valid_until IS NULL OR g.valid_until > now())`)
        .groupBy(['g.module', 'r.key', 'r.name'])
        .orderBy('g.module')
        .orderBy('r.key')
        .execute();
    }),
  }),

  // --- Grants -------------------------------------------------------------

  grants: router({
    /** Keyset-paginated grant list; every facet applied in SQL (ADR-0004). */
    list: authzAdmin.input(listGrantsInput).query(async ({ ctx, input }) => {
      const sortKey = timestampSortKey('g.created_at');

      let query = ctx.db
        .selectFrom('platform.role_grant as g')
        .innerJoin('platform.role as r', 'r.id', 'g.role_id')
        .innerJoin('platform.person as p', 'p.id', 'g.person_id')
        .select([
          'g.id',
          'g.person_id as personId',
          'p.display_name as personDisplayName',
          'r.key as roleKey',
          'r.name as roleName',
          'g.module',
          'g.valid_from as validFrom',
          'g.valid_until as validUntil',
          'g.revoked_at as revokedAt',
          'g.revoke_reason as revokeReason',
          'g.created_at as createdAt',
        ])
        .select(GRANT_STATE_SQL.as('state'))
        .select(sortKey.as('sort_key'))
        .where('g.deleted_at', 'is', null);

      if (input.personId) query = query.where('g.person_id', '=', input.personId);
      if (input.roleKey) query = query.where('r.key', '=', input.roleKey);
      if (input.module) query = query.where('g.module', '=', input.module);
      // The derived state is filtered by the same expression that displays it.
      if (input.state) query = query.where(GRANT_STATE_SQL, '=', input.state);
      if (input.search) {
        const term = `%${input.search}%`;
        query = query.where((eb) =>
          eb.or([eb('p.display_name', 'ilike', term), eb('p.contact_email', 'ilike', term)]),
        );
      }
      if (input.cursor) {
        const cursor = decodeCursor(input.cursor);
        if (cursor) query = query.where(keysetBoundary(sortKey, 'g.id', cursor, input.sortDir));
      }

      const rows = await query
        .orderBy(sortKey, input.sortDir)
        .orderBy('g.id', input.sortDir)
        .limit(input.limit + 1)
        .execute();

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items.at(-1);
      const nextCursor = hasMore && last ? encodeCursor({ key: last.sort_key, id: last.id }) : null;
      return { items: items.map(({ sort_key: _sk, ...rest }) => rest), nextCursor };
    }),

    /**
     * Grant a role in a module. Nothing grants implicitly anywhere else in the
     * platform (§4.1) — this is the only path that inserts a `role_grant` row
     * from a user action.
     */
    grant: authzAdmin.input(grantRoleInput).mutation(async ({ ctx, input }) => {
      const actor = requireActor(ctx);

      const role = await ctx.db
        .selectFrom('platform.role')
        .select(['id', 'key'])
        .where('key', '=', input.roleKey)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!role) throw new TRPCError({ code: 'NOT_FOUND', message: 'Role not found' });

      const person = await ctx.db
        .selectFrom('platform.person')
        .select('id')
        .where('id', '=', input.personId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!person) throw new TRPCError({ code: 'NOT_FOUND', message: 'Person not found' });

      const validFrom = input.validFrom ? new Date(input.validFrom) : new Date();
      const validUntil = input.validUntil ? new Date(input.validUntil) : null;
      if (validUntil && validUntil <= validFrom) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'validUntil must be after validFrom',
        });
      }

      // Friendly error ahead of the partial unique index (one live grant per
      // person/role/module). The index remains the real guarantee under races.
      const live = await ctx.db
        .selectFrom('platform.role_grant')
        .select('id')
        .where('person_id', '=', input.personId)
        .where('role_id', '=', role.id)
        .where('module', '=', input.module)
        .where('revoked_at', 'is', null)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (live) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `That person already holds '${input.roleKey}' in '${input.module}'`,
        });
      }

      // The shared write path (ADR-0022) — `platform.identity.unmerge` restores
      // merge-revoked grants through the same function.
      const grantId = newUuidV7();
      await ctx.db.transaction().execute((trx) =>
        grantRole(trx, {
          grantId,
          personId: input.personId,
          roleId: role.id,
          roleKey: input.roleKey,
          module: input.module,
          validFrom,
          validUntil,
          actorPersonId: actor,
          correlationId: ctx.correlationId,
        }),
      );
      return { grantId };
    }),

    /** Revoke a grant through the shared write path (ADR-0022). */
    revoke: authzAdmin.input(revokeGrantInput).mutation(async ({ ctx, input }) => {
      const actor = requireActor(ctx);
      const revoked = await ctx.db.transaction().execute((trx) =>
        revokeGrant(trx, {
          grantId: input.grantId,
          actorPersonId: actor,
          reason: input.reason,
          correlationId: ctx.correlationId,
        }),
      );
      if (!revoked) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Grant not found, or already revoked',
        });
      }
      return revoked;
    }),

    /**
     * The caller's own grants — feeds UX-only navigation gating. Deliberately
     * `protectedProcedure`: everyone may see what they hold, and this response
     * is never the access control (ADR-0003).
     */
    mine: protectedProcedure.query(({ ctx }) => {
      const at = new Date();
      return ctx.grants.map((g) => ({
        roleKey: g.roleKey,
        module: g.module,
        validFrom: g.validFrom,
        validUntil: g.validUntil,
        state: grantState(g, at),
      }));
    }),
  }),

  // --- Allocations (CORE-05) ---------------------------------------------

  allocations: router({
    list: allocationAdmin.input(listAllocationsInput).query(async ({ ctx, input }) => {
      const sortKey = timestampSortKey('a.created_at');

      let query = ctx.db
        .selectFrom('platform.person_allocation as a')
        .innerJoin('platform.person as admin', 'admin.id', 'a.admin_person_id')
        .innerJoin('platform.person as subject', 'subject.id', 'a.person_id')
        .select([
          'a.id',
          'a.admin_person_id as adminPersonId',
          'admin.display_name as adminDisplayName',
          'a.person_id as personId',
          'subject.display_name as personDisplayName',
          'a.valid_from as validFrom',
          'a.valid_until as validUntil',
          'a.ended_at as endedAt',
          'a.end_reason as endReason',
          'a.created_at as createdAt',
        ])
        .select(sortKey.as('sort_key'))
        .where('a.deleted_at', 'is', null);

      if (input.adminPersonId) query = query.where('a.admin_person_id', '=', input.adminPersonId);
      if (input.personId) query = query.where('a.person_id', '=', input.personId);
      if (input.liveOnly) {
        query = query
          .where('a.ended_at', 'is', null)
          .where(sql<SqlBool>`a.valid_from <= now()`)
          .where(sql<SqlBool>`(a.valid_until IS NULL OR a.valid_until > now())`);
      }
      if (input.cursor) {
        const cursor = decodeCursor(input.cursor);
        if (cursor) query = query.where(keysetBoundary(sortKey, 'a.id', cursor, input.sortDir));
      }

      const rows = await query
        .orderBy(sortKey, input.sortDir)
        .orderBy('a.id', input.sortDir)
        .limit(input.limit + 1)
        .execute();

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items.at(-1);
      const nextCursor = hasMore && last ? encodeCursor({ key: last.sort_key, id: last.id }) : null;
      return { items: items.map(({ sort_key: _sk, ...rest }) => rest), nextCursor };
    }),

    /** Allocate a person to a restricted external administrator (CORE-05). */
    add: allocationAdmin.input(addAllocationInput).mutation(async ({ ctx, input }) => {
      const actor = requireActor(ctx);
      if (input.adminPersonId === input.personId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A person cannot be allocated to themselves',
        });
      }

      const people = await ctx.db
        .selectFrom('platform.person')
        .select('id')
        .where('id', 'in', [input.adminPersonId, input.personId])
        .where('deleted_at', 'is', null)
        .execute();
      if (people.length !== 2) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Person not found' });
      }

      // The allocation only means anything alongside the role; without it the
      // row would grant nothing and quietly imply access that does not exist.
      const isExternalAdmin = await ctx.db
        .selectFrom('platform.role_grant as g')
        .innerJoin('platform.role as r', 'r.id', 'g.role_id')
        .select('g.id')
        .where('g.person_id', '=', input.adminPersonId)
        .where('r.key', '=', 'external_administrator')
        .where('g.revoked_at', 'is', null)
        .where('g.deleted_at', 'is', null)
        .executeTakeFirst();
      if (!isExternalAdmin) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'That person does not hold the external_administrator role — grant it before allocating people',
        });
      }

      const validFrom = input.validFrom ? new Date(input.validFrom) : new Date();
      const validUntil = input.validUntil ? new Date(input.validUntil) : null;
      if (validUntil && validUntil <= validFrom) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'validUntil must be after validFrom' });
      }

      const live = await ctx.db
        .selectFrom('platform.person_allocation')
        .select('id')
        .where('admin_person_id', '=', input.adminPersonId)
        .where('person_id', '=', input.personId)
        .where('ended_at', 'is', null)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (live) {
        throw new TRPCError({ code: 'CONFLICT', message: 'That allocation is already live' });
      }

      const allocationId = newUuidV7();
      await ctx.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('platform.person_allocation')
          .values({
            id: allocationId,
            admin_person_id: input.adminPersonId,
            person_id: input.personId,
            valid_from: validFrom,
            valid_until: validUntil,
            created_by: actor,
            updated_by: actor,
          })
          .execute();
        await appendEvent(trx, {
          kind: 'security',
          streamType: 'platform.person_allocation',
          streamId: allocationId,
          eventType: 'platform.person.allocation_added',
          payload: {
            adminPersonId: input.adminPersonId,
            personId: input.personId,
            validUntil: validUntil ? validUntil.toISOString() : null,
          },
          actorPersonId: actor,
          correlationId: ctx.correlationId,
        });
      });
      return { allocationId };
    }),

    /** End an allocation: visibility closes immediately, the row survives. */
    end: allocationAdmin.input(endAllocationInput).mutation(async ({ ctx, input }) => {
      const actor = requireActor(ctx);
      const allocation = await ctx.db
        .selectFrom('platform.person_allocation')
        .select(['id', 'admin_person_id', 'person_id', 'ended_at'])
        .where('id', '=', input.allocationId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!allocation) throw new TRPCError({ code: 'NOT_FOUND', message: 'Allocation not found' });
      if (allocation.ended_at) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Allocation already ended' });
      }

      await ctx.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('platform.person_allocation')
          .set({
            ended_at: new Date(),
            ended_by: actor,
            end_reason: input.reason,
            updated_by: actor,
          })
          .where('id', '=', input.allocationId)
          .execute();
        await appendEvent(trx, {
          kind: 'security',
          streamType: 'platform.person_allocation',
          streamId: input.allocationId,
          eventType: 'platform.person.allocation_ended',
          payload: {
            adminPersonId: allocation.admin_person_id,
            personId: allocation.person_id,
            endReason: input.reason,
          },
          actorPersonId: actor,
          correlationId: ctx.correlationId,
        });
      });
      return { allocationId: input.allocationId };
    }),
  }),
});
