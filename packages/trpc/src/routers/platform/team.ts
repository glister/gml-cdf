import { TRPCError } from '@trpc/server';
import { sql } from 'kysely';
import { activeOn, appendEvent, endEffective, newUuidV7 } from '@repo/db';
import { hasRole, type EventPayload } from '@repo/domain';
import { roleProcedure, router, type TRPCContext } from '../../trpc.js';
import {
  addTeamMemberInput,
  archiveTeamInput,
  correctTeamMembershipInput,
  createTeamInput,
  endTeamMembershipInput,
  getTeamInput,
  listTeamsInput,
  updateTeamInput,
} from '../../schemas.js';
import { decodeCursor, encodeCursor, keysetBoundary, timestampSortKey } from '../../lib/keyset.js';
import {
  isCheckViolation,
  isExclusionViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from '../../lib/pg-errors.js';
// Lookups and teams are two halves of one service with one maintenance role set
// (§5.1), so the builder is defined once beside the primary router rather than
// duplicated here where the two could silently drift apart.
import { refDataAdminProcedure } from './lookup.js';

/**
 * Teams — the core platform's one Tier 3 configuration entity (core plan 05
 * §5.1, PL-005d/005e, PL-007a, ADR-0016).
 *
 * This router is the exemplar plans 14 and the HR set copy, so it demonstrates
 * the Tier 3 shape rather than the shortest path to CRUD: relationships (manager,
 * deputy, members), a derived column computed in SQL (member count), an
 * effective-dated child through the shared `endEffective` write path, and a
 * `kind='admin'` journal event in the same transaction as every state change.
 *
 * **Reads are org-visible to role-holders** (§12.2 Q6, resolved 2026-08-03).
 * Membership is not sensitive, the person picker and later HR screens need it,
 * and record-scoping it would be circular: plan 04's `managedPersonIds` resolves
 * a Line Manager's `team` scope *through* these very tables. Externals are
 * excluded (§8) and maintenance stays with Administrator / HR User.
 */

/**
 * Who may read teams and rosters — everyone in §8's table except Employee,
 * External and External Administrator. Note this is wider than the maintenance
 * set but narrower than `protectedProcedure`.
 */
const teamReader = roleProcedure(
  [
    'administrator',
    'hr_user',
    'director',
    'line_manager',
    'finance',
    'it',
    'transport',
    'office_admin',
  ],
  { module: 'platform' },
);

const REF_DATA_ADMIN_ROLES = ['administrator', 'hr_user'] as const;

/**
 * Current members, counted in SQL — a derived column, so the displayed value and
 * any future filter or aggregate read one expression (ADR-0004). Counting rows
 * in JS would only ever count the loaded page.
 */
const CURRENT_MEMBER_COUNT = sql<number>`(
  SELECT count(*) FROM platform.team_membership m
  WHERE m.team_id = t.id
    AND m.valid_from <= current_date
    AND (m.valid_to IS NULL OR m.valid_to > current_date)
)`;

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

function isRefDataAdmin(ctx: TRPCContext): boolean {
  return hasRole(ctx.grants, REF_DATA_ADMIN_ROLES, 'platform', new Date());
}

async function loadTeam(ctx: TRPCContext, teamId: string) {
  const row = await ctx.db
    .selectFrom('platform.team')
    .selectAll()
    .where('id', '=', teamId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Team not found' });
  return row;
}

/** Translate the database's own integrity guards into intelligible errors. */
function mapTeamWriteError(error: unknown): never {
  if (isUniqueViolation(error, 'team_name_live_unique')) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'A team with that name already exists. Archive it first to reuse the name.',
    });
  }
  if (isCheckViolation(error, 'team_deputy_not_manager_check')) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The deputy cannot be the same person as the manager.',
    });
  }
  if (isForeignKeyViolation(error)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That person record does not exist.' });
  }
  throw error;
}

export const teamRouter = router({
  /** Keyset-paginated teams; filter, sort and member count all in SQL. */
  list: teamReader.input(listTeamsInput).query(async ({ ctx, input }) => {
    // Archived teams are maintenance detail: showing them to every reader would
    // put retired configuration in front of people who cannot act on it.
    const includeArchived = input.includeArchived && isRefDataAdmin(ctx);

    const sortKey =
      input.sort === 'updated_at'
        ? timestampSortKey('t.updated_at')
        : sql<string>`coalesce(lower(t.name), '')`;

    let query = ctx.db
      .selectFrom('platform.team as t')
      .innerJoin('platform.person as mgr', 'mgr.id', 't.manager_person_id')
      .leftJoin('platform.person as dep', 'dep.id', 't.deputy_person_id')
      .select([
        't.id',
        't.name',
        't.description',
        't.max_concurrent_leave',
        't.colour',
        't.manager_person_id',
        't.deputy_person_id',
        't.deleted_at',
        't.updated_at',
        // `display_name` is classified `internal` (plan 04), so it is inside
        // every reader role's ceiling — no restricted variant is needed here.
        'mgr.display_name as manager_display_name',
        'dep.display_name as deputy_display_name',
      ])
      .select(CURRENT_MEMBER_COUNT.as('member_count'))
      .select(sortKey.as('sort_key'));

    if (!includeArchived) query = query.where('t.deleted_at', 'is', null);
    if (input.search) query = query.where('t.name', 'ilike', `%${input.search}%`);
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      if (cursor) query = query.where(keysetBoundary(sortKey, 't.id', cursor, input.sortDir));
    }

    const rows = await query
      .orderBy(sortKey, input.sortDir)
      .orderBy('t.id', input.sortDir)
      .limit(input.limit + 1)
      .execute();

    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ key: last.sort_key, id: last.id }) : null;
    return { items: items.map(({ sort_key: _sk, ...rest }) => rest), nextCursor };
  }),

  /**
   * One team plus its roster **as at a date** (PL-007a, AC-D4). This is the
   * point of effective dating: asking for a past date returns the roster as it
   * stood, not today's roster with a date label on it.
   */
  get: teamReader.input(getTeamInput).query(async ({ ctx, input }) => {
    const team = await loadTeam(ctx, input.teamId);
    // Resolved in SQL rather than from a JS `new Date()` so "today" is the
    // database's today — the same clock `current_date` uses in the member-count
    // expression and in plan 04's `managedPersonIds` scoping.
    const asAt =
      input.asAt ??
      (
        await sql<{ today: string }>`SELECT to_char(current_date, 'YYYY-MM-DD') AS today`.execute(
          ctx.db,
        )
      ).rows[0].today;

    const roster = await ctx.db
      .selectFrom('platform.team_membership as m')
      .innerJoin('platform.person as p', 'p.id', 'm.person_id')
      .select([
        'm.id',
        'm.person_id',
        'm.valid_from',
        'm.valid_to',
        'p.display_name',
        'p.relationship_type',
      ])
      .where('m.team_id', '=', input.teamId)
      .where(activeOn('m', asAt))
      .orderBy('p.display_name', 'asc')
      .orderBy('m.id', 'asc')
      .execute();

    // The full history backs the membership editor's end/correct actions, which
    // must be able to reach a row that is not active today.
    const history = await ctx.db
      .selectFrom('platform.team_membership as m')
      .innerJoin('platform.person as p', 'p.id', 'm.person_id')
      .select(['m.id', 'm.person_id', 'm.valid_from', 'm.valid_to', 'p.display_name'])
      .where('m.team_id', '=', input.teamId)
      .orderBy('m.valid_from', 'desc')
      .orderBy('m.id', 'desc')
      .execute();

    return { team, asAt, roster, history };
  }),

  create: refDataAdminProcedure.input(createTeamInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    const id = newUuidV7();

    try {
      await ctx.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('platform.team')
          .values({
            id,
            name: input.name,
            description: input.description ?? null,
            manager_person_id: input.managerPersonId,
            deputy_person_id: input.deputyPersonId ?? null,
            max_concurrent_leave: input.maxConcurrentLeave ?? null,
            colour: input.colour ?? null,
            created_by: actor,
            updated_by: actor,
          })
          .execute();

        await appendEvent(trx, {
          kind: 'admin',
          streamType: 'platform.team',
          streamId: id,
          eventType: 'platform.team.created',
          payload: {
            name: input.name,
            managerPersonId: input.managerPersonId,
            deputyPersonId: input.deputyPersonId ?? null,
            maxConcurrentLeave: input.maxConcurrentLeave ?? null,
          },
          actorPersonId: actor,
          correlationId: ctx.correlationId,
        });
      });
    } catch (error) {
      mapTeamWriteError(error);
    }

    return { id };
  }),

  /**
   * Edit team attributes.
   *
   * Manager, deputy and capacity are current-state columns rather than
   * effective-dated rows (§4.1.2), which makes **this event their only history**
   * — hence the full delta set rather than a bare "team updated".
   */
  update: refDataAdminProcedure.input(updateTeamInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    const before = await loadTeam(ctx, input.teamId);

    const next = {
      name: input.name ?? before.name,
      description: input.description === undefined ? before.description : input.description,
      manager_person_id: input.managerPersonId ?? before.manager_person_id,
      deputy_person_id:
        input.deputyPersonId === undefined ? before.deputy_person_id : input.deputyPersonId,
      max_concurrent_leave:
        input.maxConcurrentLeave === undefined
          ? before.max_concurrent_leave
          : input.maxConcurrentLeave,
      colour: input.colour === undefined ? before.colour : input.colour,
    };

    const changes: EventPayload<'platform.team.updated'> = {};
    if (next.name !== before.name) changes.name = { from: before.name, to: next.name };
    if (next.description !== before.description) {
      changes.description = { from: before.description, to: next.description };
    }
    if (next.manager_person_id !== before.manager_person_id) {
      changes.managerPersonId = { from: before.manager_person_id, to: next.manager_person_id };
    }
    if (next.deputy_person_id !== before.deputy_person_id) {
      changes.deputyPersonId = { from: before.deputy_person_id, to: next.deputy_person_id };
    }
    if (next.max_concurrent_leave !== before.max_concurrent_leave) {
      changes.maxConcurrentLeave = {
        from: before.max_concurrent_leave,
        to: next.max_concurrent_leave,
      };
    }
    if (next.colour !== before.colour) changes.colour = { from: before.colour, to: next.colour };
    if (Object.keys(changes).length === 0) return { id: input.teamId, changed: false };

    try {
      await ctx.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('platform.team')
          .set({ ...next, updated_by: actor })
          .where('id', '=', input.teamId)
          .execute();

        await appendEvent(trx, {
          kind: 'admin',
          streamType: 'platform.team',
          streamId: input.teamId,
          eventType: 'platform.team.updated',
          payload: changes,
          actorPersonId: actor,
          correlationId: ctx.correlationId,
        });
      });
    } catch (error) {
      mapTeamWriteError(error);
    }

    return { id: input.teamId, changed: true };
  }),

  /**
   * Archive a team: soft-delete it **and** end-date its open memberships in the
   * same transaction, so no membership is left dangling open against a team that
   * no longer exists (§4.3).
   *
   * A membership that has not started yet is closed to the smallest legal window
   * (`valid_from + 1 day`) rather than erased — memberships are never deleted,
   * and the archived team is filtered out of every consumer query anyway.
   */
  archive: refDataAdminProcedure.input(archiveTeamInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    const before = await loadTeam(ctx, input.teamId);

    const endedMembershipIds = await ctx.db.transaction().execute(async (trx) => {
      const ended = await trx
        .updateTable('platform.team_membership')
        .set({
          valid_to: sql<string>`greatest(current_date, valid_from + 1)`,
          updated_by: actor,
        })
        .where('team_id', '=', input.teamId)
        .where('valid_to', 'is', null)
        .returning('id')
        .execute();

      await trx
        .updateTable('platform.team')
        .set({ deleted_at: new Date(), updated_by: actor })
        .where('id', '=', input.teamId)
        .execute();

      await appendEvent(trx, {
        kind: 'admin',
        streamType: 'platform.team',
        streamId: input.teamId,
        eventType: 'platform.team.archived',
        payload: { name: before.name, endedMembershipIds: ended.map((r) => r.id) },
        actorPersonId: actor,
        correlationId: ctx.correlationId,
      });

      return ended.map((r) => r.id);
    });

    return { id: input.teamId, endedMembershipIds };
  }),

  /**
   * Add a member from a business date.
   *
   * Overlap is rejected by the `team_membership_no_overlap` EXCLUDE constraint,
   * not by a pre-flight SELECT — a check-then-insert would race, and the
   * invariant belongs in the database (ADR-0011). Adjacent ranges are fine:
   * half-open `[a,b)` then `[b,c)` do not overlap, so a member can leave and
   * rejoin on the same day.
   */
  addMember: refDataAdminProcedure.input(addTeamMemberInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    await loadTeam(ctx, input.teamId);
    const membershipId = newUuidV7();

    try {
      await ctx.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('platform.team_membership')
          .values({
            id: membershipId,
            team_id: input.teamId,
            person_id: input.personId,
            valid_from: input.validFrom,
            created_by: actor,
            updated_by: actor,
          })
          .execute();

        await appendEvent(trx, {
          kind: 'admin',
          streamType: 'platform.team',
          streamId: input.teamId,
          eventType: 'platform.team.membership.added',
          payload: {
            membershipId,
            personId: input.personId,
            validFrom: input.validFrom,
          },
          actorPersonId: actor,
          correlationId: ctx.correlationId,
        });
      });
    } catch (error) {
      if (isExclusionViolation(error, 'team_membership_no_overlap')) {
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            'That person already has a membership of this team covering those dates. End the existing membership first.',
        });
      }
      if (isForeignKeyViolation(error)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'That person record does not exist.' });
      }
      throw error;
    }

    return { membershipId };
  }),

  /** End a membership through the shared effective-dating write path (ADR-0022). */
  endMembership: refDataAdminProcedure
    .input(endTeamMembershipInput)
    .mutation(async ({ ctx, input }) => {
      const actor = requireActor(ctx);
      const membership = await ctx.db
        .selectFrom('platform.team_membership')
        .select(['id', 'team_id'])
        .where('id', '=', input.membershipId)
        .executeTakeFirst();
      if (!membership) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Membership not found' });
      }

      try {
        await ctx.db.transaction().execute(async (trx) => {
          const { personId } = await endEffective(trx, {
            table: 'platform.team_membership',
            id: input.membershipId,
            validTo: input.validTo,
            actorPersonId: actor,
          });

          await appendEvent(trx, {
            kind: 'admin',
            streamType: 'platform.team',
            streamId: membership.team_id,
            eventType: 'platform.team.membership.ended',
            payload: { membershipId: input.membershipId, personId, validTo: input.validTo },
            actorPersonId: actor,
            correlationId: ctx.correlationId,
          });
        });
      } catch (error) {
        // `endEffective` refuses to re-end a closed row: re-ending would move a
        // boundary other records have already been read against.
        if (error instanceof Error && /already ended|must be after/.test(error.message)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
        }
        throw error;
      }

      return { membershipId: input.membershipId };
    }),

  /**
   * Correct a membership's dates — the typo path, deliberately distinct from
   * ending (§4.2). It moves a boundary that other records may already have been
   * read against, so it is journalled as its own event rather than hidden inside
   * an "ended".
   */
  correctMembership: refDataAdminProcedure
    .input(correctTeamMembershipInput)
    .mutation(async ({ ctx, input }) => {
      const actor = requireActor(ctx);
      const before = await ctx.db
        .selectFrom('platform.team_membership')
        .select(['id', 'team_id', 'person_id', 'valid_from', 'valid_to'])
        .where('id', '=', input.membershipId)
        .executeTakeFirst();
      if (!before) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Membership not found' });
      }

      const nextFrom = input.validFrom ?? before.valid_from;
      const nextTo = input.validTo === undefined ? before.valid_to : input.validTo;

      const changes: EventPayload<'platform.team.membership.corrected'> = {
        membershipId: before.id,
        personId: before.person_id,
      };
      if (nextFrom !== before.valid_from) {
        changes.validFrom = { from: before.valid_from, to: nextFrom };
      }
      if (nextTo !== before.valid_to) changes.validTo = { from: before.valid_to, to: nextTo };
      if (!changes.validFrom && !changes.validTo) {
        return { membershipId: before.id, changed: false };
      }

      try {
        await ctx.db.transaction().execute(async (trx) => {
          await trx
            .updateTable('platform.team_membership')
            .set({ valid_from: nextFrom, valid_to: nextTo, updated_by: actor })
            .where('id', '=', input.membershipId)
            .execute();

          await appendEvent(trx, {
            kind: 'admin',
            streamType: 'platform.team',
            streamId: before.team_id,
            eventType: 'platform.team.membership.corrected',
            payload: changes,
            actorPersonId: actor,
            correlationId: ctx.correlationId,
          });
        });
      } catch (error) {
        if (isExclusionViolation(error, 'team_membership_no_overlap')) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Those dates would overlap another membership of this team for that person.',
          });
        }
        if (isCheckViolation(error, 'team_membership_dates_check')) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'The end date must be after the start date.',
          });
        }
        throw error;
      }

      return { membershipId: before.id, changed: true };
    }),
});
