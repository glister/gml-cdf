import { TRPCError } from '@trpc/server';
import { adminProcedure, protectedProcedure, router } from '../trpc.js';
import { listUsersInput, updateUserRoleInput } from '../schemas.js';
import { decodeCursor, encodeCursor, keysetBoundary, timestampSortKey } from '../lib/keyset.js';

/**
 * Example feature router backed by the real `user` table. Demonstrates the
 * required patterns: SQL-side filtering/search/sort, keyset pagination, and the
 * admin security boundary on the mutation.
 */
export const usersRouter = router({
  /** Keyset-paginated, SQL-filtered user list. */
  list: protectedProcedure.input(listUsersInput).query(async ({ ctx, input }) => {
    // One expression drives both ORDER BY and the cursor boundary.
    const sortKey = timestampSortKey('u.created_at');

    let query = ctx.db
      .selectFrom('user as u')
      .select(['u.id', 'u.name', 'u.email', 'u.role', 'u.banned', 'u.created_at'])
      .select(sortKey.as('sort_key'));

    // Search + facets pushed into SQL — never filtered client-side.
    if (input.search) {
      const term = `%${input.search}%`;
      query = query.where((eb) =>
        eb.or([eb('u.email', 'ilike', term), eb('u.name', 'ilike', term)]),
      );
    }
    if (input.role) {
      query = query.where('u.role', '=', input.role);
    }
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      if (cursor) {
        query = query.where(keysetBoundary(sortKey, 'u.id', cursor, input.sortDir));
      }
    }

    const rows = await query
      .orderBy(sortKey, input.sortDir)
      .orderBy('u.id', input.sortDir)
      .limit(input.limit + 1)
      .execute();

    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ key: last.sort_key, id: last.id }) : null;

    return { items, nextCursor };
  }),

  /** Admin-only: change a user's role. */
  updateRole: adminProcedure.input(updateUserRoleInput).mutation(async ({ ctx, input }) => {
    const updated = await ctx.db
      .updateTable('user')
      .set({ role: input.role, updated_at: new Date() })
      .where('id', '=', input.id)
      .returning(['id', 'role'])
      .executeTakeFirst();

    if (!updated) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
    }

    ctx.logger.info('user.role.updated', { id: input.id, role: input.role });
    return updated;
  }),
});
