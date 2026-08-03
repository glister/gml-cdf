import { TRPCError } from '@trpc/server';
import { setUserRole } from '@repo/identity';
import { adminProcedure, router } from '../trpc.js';
import { updateUserRoleInput } from '../schemas.js';

/**
 * Better Auth **framework** operations on the `user` table — nothing else
 * (core plan 04 Q1, resolved 2026-07-28). `adminProcedure` guards these and
 * only these; a product surface guarded with it is a review-blocking violation,
 * because it resurrects a second, parallel authorisation system.
 *
 * There is deliberately no user *directory* read here. The person directory is
 * `platform.identity.listPersons`, which applies all three authorisation
 * granularities — role, record scope and field classification. A second, weaker
 * read of the same population is precisely what Q1 exists to prevent.
 *
 * The write itself goes through `@repo/identity`, the sole owner of the Better
 * Auth tables (ADR-0014) — this router no longer needs the boundary exemption
 * it carried while it held a direct `user` read.
 */
export const usersRouter = router({
  /** Admin-only: change a user's Better Auth role. */
  updateRole: adminProcedure.input(updateUserRoleInput).mutation(async ({ ctx, input }) => {
    const updated = await setUserRole(ctx.db, input.id, input.role);

    if (!updated) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
    }

    ctx.logger.info('user.role.updated', { id: input.id, role: input.role });
    return updated;
  }),
});
