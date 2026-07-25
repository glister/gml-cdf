import { TRPCError } from '@trpc/server';
import { type Expression, type SqlBool, sql } from 'kysely';
import { appendEvent, newUuidV7, type PersonRecord } from '@repo/db';
import {
  type DuplicateMatchReason,
  canTransition,
  matchDuplicate,
  planFlagUnion,
} from '@repo/domain';
import {
  enableSignIn,
  listCredentials,
  personLineage,
  provisionInvitedUser,
  repointUsers,
  restoreUsers,
} from '@repo/identity';
import { adminProcedure, protectedProcedure, router, type TRPCContext } from '../../trpc.js';
import {
  addFlagInput,
  checkExistingInput,
  convertToEmployeeInput,
  createPersonInput,
  dismissDuplicateInput,
  endFlagInput,
  invitePersonInput,
  listDuplicateCandidatesInput,
  listPersonsInput,
  mergePersonsInput,
  personIdInput,
  reengageInput,
  setAccessValidUntilInput,
  setProfileStatusInput,
  unmergeInput,
  updatePersonInput,
} from '../../schemas.js';
import { decodeCursor, encodeCursor, keysetBoundary, timestampSortKey } from '../../lib/keyset.js';

/**
 * Identity & person model tRPC surface (core plan 03 §5.1). The security
 * boundary: every admin operation is an `adminProcedure`. All journal appends go
 * through core plan 02's `appendEvent` in the SAME transaction as their state
 * change (ADR-0010); Better Auth tables are touched only via `@repo/identity`.
 */

/** The person columns returned by list/detail reads. */
const PERSON_COLUMNS = [
  'p.id',
  'p.relationship_type',
  'p.profile_status',
  'p.status',
  'p.display_name',
  'p.given_name',
  'p.family_name',
  'p.contact_email',
  'p.date_of_birth',
  'p.agency_worker_reference',
  'p.access_valid_until',
  'p.created_at',
  'p.updated_at',
] as const;

/** The acting admin's person id — required to stamp actor columns. */
function requireActor(ctx: TRPCContext): string {
  if (!ctx.actorPersonId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The acting user is not linked to a person record',
    });
  }
  return ctx.actorPersonId;
}

async function loadPerson(ctx: TRPCContext, personId: string): Promise<PersonRecord> {
  const person = await ctx.db
    .selectFrom('platform.person')
    .selectAll()
    .where('id', '=', personId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!person) throw new TRPCError({ code: 'NOT_FOUND', message: 'Person not found' });
  return person;
}

/** SQL predicate: two aliased persons are a strong duplicate (mirrors the matcher). */
function duplicatePredicate(a: string, b: string): Expression<SqlBool> {
  return sql<SqlBool>`(
    (${sql.ref(`${a}.family_name`)} IS NOT NULL AND ${sql.ref(`${a}.given_name`)} IS NOT NULL
       AND ${sql.ref(`${a}.date_of_birth`)} IS NOT NULL
       AND lower(${sql.ref(`${a}.family_name`)}) = lower(${sql.ref(`${b}.family_name`)})
       AND lower(${sql.ref(`${a}.given_name`)}) = lower(${sql.ref(`${b}.given_name`)})
       AND ${sql.ref(`${a}.date_of_birth`)} = ${sql.ref(`${b}.date_of_birth`)})
    OR (${sql.ref(`${a}.agency_worker_reference`)} IS NOT NULL
       AND lower(${sql.ref(`${a}.agency_worker_reference`)}) = lower(${sql.ref(`${b}.agency_worker_reference`)}))
  )`;
}

/** Natural-identity attributes used by the matcher. */
function attrs(p: {
  given_name: string | null;
  family_name: string | null;
  date_of_birth: string | null;
  agency_worker_reference: string | null;
}) {
  return {
    givenName: p.given_name,
    familyName: p.family_name,
    dateOfBirth: p.date_of_birth,
    agencyWorkerReference: p.agency_worker_reference,
  };
}

export const identityRouter = router({
  // --- Reads --------------------------------------------------------------

  /** Keyset-paginated person list; every facet applied in SQL (ADR data-tables). */
  listPersons: adminProcedure.input(listPersonsInput).query(async ({ ctx, input }) => {
    const sortKey =
      input.sort === 'family_name'
        ? sql<string>`coalesce(lower(p.family_name), '')`
        : input.sort === 'access_valid_until'
          ? timestampSortKey('p.access_valid_until')
          : timestampSortKey('p.created_at');

    let query = ctx.db
      .selectFrom('platform.person as p')
      .select(PERSON_COLUMNS)
      .select(sortKey.as('sort_key'))
      .where('p.deleted_at', 'is', null);

    if (input.relationshipType)
      query = query.where('p.relationship_type', '=', input.relationshipType);
    if (input.profileStatus) query = query.where('p.profile_status', '=', input.profileStatus);
    if (input.status) query = query.where('p.status', '=', input.status);
    if (input.search) {
      const term = `%${input.search}%`;
      query = query.where((eb) =>
        eb.or([
          eb('p.display_name', 'ilike', term),
          eb('p.contact_email', 'ilike', term),
          eb('p.given_name', 'ilike', term),
          eb('p.family_name', 'ilike', term),
          eb('p.agency_worker_reference', 'ilike', term),
        ]),
      );
    }
    if (input.expiringWithinDays !== undefined) {
      query = query
        .where('p.access_valid_until', 'is not', null)
        .where(
          'p.access_valid_until',
          '<',
          sql<Date>`now() + make_interval(days => ${input.expiringWithinDays})`,
        );
    }
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      if (cursor) query = query.where(keysetBoundary(sortKey, 'p.id', cursor, input.sortDir));
    }

    const rows = await query
      .orderBy(sortKey, input.sortDir)
      .orderBy('p.id', input.sortDir)
      .limit(input.limit + 1)
      .execute();

    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ key: last.sort_key, id: last.id }) : null;
    return { items: items.map(({ sort_key: _sk, ...rest }) => rest), nextCursor };
  }),

  /** Person detail: attributes, flags, linked credentials, and merge lineage. */
  getPerson: adminProcedure.input(personIdInput).query(async ({ ctx, input }) => {
    const person = await loadPerson(ctx, input.personId);
    const flags = await ctx.db
      .selectFrom('platform.person_flag')
      .selectAll()
      .where('person_id', '=', input.personId)
      .orderBy('raised_at', 'desc')
      .execute();
    const credentials = await listCredentials(ctx.db, input.personId);
    const lineage = await personLineage(ctx.db, input.personId);
    return { person, flags, credentials, lineage };
  }),

  /** Own person summary — the only identity read a non-admin can make. */
  me: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.actorPersonId) return null;
    const person = await ctx.db
      .selectFrom('platform.person')
      .select(['id', 'display_name', 'relationship_type', 'profile_status', 'status'])
      .where('id', '=', ctx.actorPersonId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return person ?? null;
  }),

  // --- Duplicate detection & review --------------------------------------

  /** Pre-creation existing-profile check (PL-047): candidate matches for attrs. */
  checkExisting: adminProcedure.input(checkExistingInput).query(async ({ ctx, input }) => {
    // Which match branches the probe can even satisfy is a JS decision — never
    // bind an untyped NULL into SQL (Postgres 42P18). Empty probe → no matches.
    const rows = await ctx.db
      .selectFrom('platform.person as p')
      .select(PERSON_COLUMNS)
      .where('p.deleted_at', 'is', null)
      .where('p.status', '<>', 'superseded')
      .where((eb) => {
        const clauses: Expression<SqlBool>[] = [];
        if (input.familyName && input.givenName && input.dateOfBirth) {
          clauses.push(
            eb.and([
              eb(sql`lower(p.family_name)`, '=', input.familyName.toLowerCase()),
              eb(sql`lower(p.given_name)`, '=', input.givenName.toLowerCase()),
              eb('p.date_of_birth', '=', input.dateOfBirth),
            ]),
          );
        }
        if (input.agencyWorkerReference) {
          clauses.push(
            eb(
              sql`lower(p.agency_worker_reference)`,
              '=',
              input.agencyWorkerReference.toLowerCase(),
            ),
          );
        }
        return clauses.length > 0 ? eb.or(clauses) : eb.val(false);
      })
      .limit(50)
      .execute();

    const probe = {
      givenName: input.givenName,
      familyName: input.familyName,
      dateOfBirth: input.dateOfBirth,
      agencyWorkerReference: input.agencyWorkerReference,
    };
    return rows.map((r) => ({ person: r, reasons: matchDuplicate(probe, attrs(r)).reasons }));
  }),

  /** Advisory duplicate-candidate pairs (live SQL match, dismissed pairs excluded). */
  listDuplicateCandidates: adminProcedure
    .input(listDuplicateCandidatesInput)
    .query(async ({ ctx, input }) => {
      const sortKey = sql<string>`a.id::text`;
      let query = ctx.db
        .selectFrom('platform.person as a')
        .innerJoin('platform.person as b', (join) => join.onRef('a.id', '<', 'b.id'))
        .select([
          'a.id as a_id',
          'a.display_name as a_display_name',
          'a.given_name as a_given_name',
          'a.family_name as a_family_name',
          'a.date_of_birth as a_date_of_birth',
          'a.agency_worker_reference as a_agency_worker_reference',
          'b.id as b_id',
          'b.display_name as b_display_name',
          'b.given_name as b_given_name',
          'b.family_name as b_family_name',
          'b.date_of_birth as b_date_of_birth',
          'b.agency_worker_reference as b_agency_worker_reference',
        ])
        .select(sortKey.as('sort_key'))
        .where('a.deleted_at', 'is', null)
        .where('b.deleted_at', 'is', null)
        .where('a.status', '<>', 'superseded')
        .where('b.status', '<>', 'superseded')
        .where(duplicatePredicate('a', 'b'))
        // Exclude pairs an admin has dismissed (canonical order: min id is the stream).
        .where(
          sql<SqlBool>`NOT EXISTS (
            SELECT 1 FROM platform.domain_event d
            WHERE d.event_type = 'platform.person.duplicate_dismissed'
              AND d.stream_id = a.id AND d.payload->>'otherPersonId' = b.id::text
          )`,
        );

      if (input.cursor) {
        const cursor = decodeCursor(input.cursor);
        if (cursor) query = query.where(keysetBoundary(sortKey, 'b.id', cursor, 'asc'));
      }

      const rows = await query
        .orderBy(sortKey, 'asc')
        .orderBy('b.id', 'asc')
        .limit(input.limit + 1)
        .execute();

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const last = page.at(-1);
      const nextCursor =
        hasMore && last ? encodeCursor({ key: last.sort_key, id: last.b_id }) : null;

      const items = page.map((r) => ({
        personA: {
          id: r.a_id,
          displayName: r.a_display_name,
          givenName: r.a_given_name,
          familyName: r.a_family_name,
        },
        personB: {
          id: r.b_id,
          displayName: r.b_display_name,
          givenName: r.b_given_name,
          familyName: r.b_family_name,
        },
        reasons: matchDuplicate(
          attrs({
            given_name: r.a_given_name,
            family_name: r.a_family_name,
            date_of_birth: r.a_date_of_birth,
            agency_worker_reference: r.a_agency_worker_reference,
          }),
          attrs({
            given_name: r.b_given_name,
            family_name: r.b_family_name,
            date_of_birth: r.b_date_of_birth,
            agency_worker_reference: r.b_agency_worker_reference,
          }),
        ).reasons,
      }));
      return { items, nextCursor };
    }),

  /** Mark a pair "not a duplicate" — excluded from future signals (canonical order). */
  dismissDuplicate: adminProcedure.input(dismissDuplicateInput).mutation(async ({ ctx, input }) => {
    const [min, max] = [input.personIdA, input.personIdB].sort();
    const actor = requireActor(ctx);
    await ctx.db.transaction().execute((trx) =>
      appendEvent(trx, {
        kind: 'security',
        streamType: 'platform.person',
        streamId: min,
        eventType: 'platform.person.duplicate_dismissed',
        payload: { otherPersonId: max },
        actorPersonId: actor,
        correlationId: ctx.correlationId,
      }),
    );
    return { dismissed: true };
  }),

  // --- Mutations: attributes ---------------------------------------------

  /** Create a person after the PL-047 check; proceeding past matches needs an override. */
  createPerson: adminProcedure.input(createPersonInput).mutation(async ({ ctx, input }) => {
    if (input.relationshipType === 'employee' && input.accessValidUntil) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Employees have no access-expiry date' });
    }
    const actor = requireActor(ctx);

    // Re-run the same match against live persons; a match without an override stops.
    const candidates = await ctx.db
      .selectFrom('platform.person as p')
      .select([
        'p.id',
        'p.given_name',
        'p.family_name',
        'p.date_of_birth',
        'p.agency_worker_reference',
      ])
      .where('p.deleted_at', 'is', null)
      .where('p.status', '<>', 'superseded')
      .execute();
    const probe = {
      givenName: input.givenName,
      familyName: input.familyName,
      dateOfBirth: input.dateOfBirth,
      agencyWorkerReference: input.agencyWorkerReference,
    };
    const matched = candidates
      .filter((c) => matchDuplicate(probe, attrs(c)).match)
      .map((c) => c.id);

    if (matched.length > 0 && !input.overrideMatches) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'A possible existing profile matches; link instead, or create with an override',
        cause: { candidatePersonIds: matched },
      });
    }

    const personId = newUuidV7();
    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('platform.person')
        .values({
          id: personId,
          relationship_type: input.relationshipType,
          display_name: input.displayName,
          given_name: input.givenName,
          family_name: input.familyName,
          date_of_birth: input.dateOfBirth,
          contact_email: input.contactEmail?.toLowerCase(),
          agency_worker_reference: input.agencyWorkerReference,
          access_valid_until: input.accessValidUntil ? new Date(input.accessValidUntil) : null,
          created_by: actor,
          updated_by: actor,
        })
        .execute();
      await appendEvent(trx, {
        kind: 'security',
        streamType: 'platform.person',
        streamId: personId,
        eventType: 'platform.person.created',
        payload: { relationshipType: input.relationshipType, via: 'admin' },
        actorPersonId: actor,
        correlationId: ctx.correlationId,
      });
      if (input.overrideMatches) {
        await appendEvent(trx, {
          kind: 'security',
          streamType: 'platform.person',
          streamId: personId,
          eventType: 'platform.person.precreation_check_overridden',
          payload: {
            candidatePersonIds: input.overrideMatches.candidatePersonIds,
            reason: input.overrideMatches.reason,
          },
          actorPersonId: actor,
          correlationId: ctx.correlationId,
        });
      }
    });
    return { personId };
  }),

  /** Edit natural-identity attributes; runs the on-write duplicate check. */
  updatePerson: adminProcedure.input(updatePersonInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    await loadPerson(ctx, input.personId);

    const updated = await ctx.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable('platform.person')
        .set({
          ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
          ...(input.givenName !== undefined ? { given_name: input.givenName } : {}),
          ...(input.familyName !== undefined ? { family_name: input.familyName } : {}),
          ...(input.dateOfBirth !== undefined ? { date_of_birth: input.dateOfBirth } : {}),
          ...(input.contactEmail !== undefined
            ? { contact_email: input.contactEmail?.toLowerCase() ?? null }
            : {}),
          ...(input.agencyWorkerReference !== undefined
            ? { agency_worker_reference: input.agencyWorkerReference }
            : {}),
          updated_by: actor,
        })
        .where('id', '=', input.personId)
        .where('deleted_at', 'is', null)
        .returningAll()
        .executeTakeFirstOrThrow();

      // On-write duplicate check: flag new strong matches against other persons.
      const others = await trx
        .selectFrom('platform.person as p')
        .select([
          'p.id',
          'p.given_name',
          'p.family_name',
          'p.date_of_birth',
          'p.agency_worker_reference',
        ])
        .where('p.id', '<>', input.personId)
        .where('p.deleted_at', 'is', null)
        .where('p.status', '<>', 'superseded')
        .execute();

      for (const other of others) {
        const result = matchDuplicate(attrs(row), attrs(other));
        if (!result.match) continue;
        const [min, max] = [input.personId, other.id].sort();
        const already = await trx
          .selectFrom('platform.domain_event')
          .select('id')
          .where('event_type', 'in', [
            'platform.person.duplicate_flagged',
            'platform.person.duplicate_dismissed',
          ])
          .where('stream_id', '=', min)
          .where(sql`payload->>'otherPersonId'`, '=', max)
          .executeTakeFirst();
        if (already) continue;
        await appendEvent(trx, {
          kind: 'security',
          streamType: 'platform.person',
          streamId: min,
          eventType: 'platform.person.duplicate_flagged',
          payload: { otherPersonId: max, reasons: result.reasons as DuplicateMatchReason[] },
          actorPersonId: actor,
          correlationId: ctx.correlationId,
        });
      }
      return row;
    });
    return { person: updated };
  }),

  // --- Mutations: lifecycle transitions ----------------------------------

  /** Guard-checked profile-status transition (CORE-01); journals the history record. */
  setProfileStatus: adminProcedure.input(setProfileStatusInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    const person = await loadPerson(ctx, input.personId);
    if (!canTransition(person.profile_status, input.to)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Illegal profile-status transition: ${person.profile_status} → ${input.to}`,
      });
    }
    // Activation guard (ON-050): interim = authorised admin + mandatory reason
    // (both already enforced). The readiness consult lands with plan 17.
    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('platform.person')
        .set({ profile_status: input.to, updated_by: actor })
        .where('id', '=', input.personId)
        .execute();
      await appendEvent(trx, {
        kind: 'security',
        streamType: 'platform.person',
        streamId: input.personId,
        eventType: 'platform.person.profile_status_changed',
        payload: { from: person.profile_status, to: input.to, reason: input.reason },
        actorPersonId: actor,
        correlationId: ctx.correlationId,
      });
    });
    return { from: person.profile_status, to: input.to };
  }),

  /** Non-employee→employee conversion: keeps the id/history, clears access expiry. */
  convertToEmployee: adminProcedure
    .input(convertToEmployeeInput)
    .mutation(async ({ ctx, input }) => {
      const actor = requireActor(ctx);
      const person = await loadPerson(ctx, input.personId);
      if (person.relationship_type === 'employee') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Person is already an employee' });
      }
      await ctx.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('platform.person')
          .set({ relationship_type: 'employee', access_valid_until: null, updated_by: actor })
          .where('id', '=', input.personId)
          .execute();
        await appendEvent(trx, {
          kind: 'security',
          streamType: 'platform.person',
          streamId: input.personId,
          eventType: 'platform.person.relationship_changed',
          payload: {
            from: person.relationship_type,
            to: 'employee',
            via: 'conversion',
            reason: input.reason,
          },
          actorPersonId: actor,
          correlationId: ctx.correlationId,
        });
      });
      return { personId: input.personId };
    }),

  // --- Mutations: safeguarding flags -------------------------------------

  addFlag: adminProcedure.input(addFlagInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    await loadPerson(ctx, input.personId);
    const flagId = newUuidV7();
    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('platform.person_flag')
        .values({
          id: flagId,
          person_id: input.personId,
          flag_type: input.flagType,
          reason: input.reason,
          raised_by: actor,
          raised_at: new Date(),
        })
        .execute();
      await appendEvent(trx, {
        kind: 'security',
        streamType: 'platform.person',
        streamId: input.personId,
        eventType: 'platform.person.flag_added',
        payload: { flagId, flagType: input.flagType },
        actorPersonId: actor,
        correlationId: ctx.correlationId,
      });
    });
    return { flagId };
  }),

  endFlag: adminProcedure.input(endFlagInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    const flag = await ctx.db
      .selectFrom('platform.person_flag')
      .selectAll()
      .where('id', '=', input.flagId)
      .executeTakeFirst();
    if (!flag) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flag not found' });
    if (flag.ended_at) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Flag already ended' });

    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('platform.person_flag')
        .set({ ended_by: actor, ended_at: new Date(), end_reason: input.reason })
        .where('id', '=', input.flagId)
        .execute();
      await appendEvent(trx, {
        kind: 'security',
        streamType: 'platform.person',
        streamId: flag.person_id,
        eventType: 'platform.person.flag_ended',
        payload: { flagId: input.flagId, flagType: flag.flag_type },
        actorPersonId: actor,
        correlationId: ctx.correlationId,
      });
    });
    return { flagId: input.flagId };
  }),

  // --- Mutations: access window & merge ----------------------------------

  setAccessValidUntil: adminProcedure
    .input(setAccessValidUntilInput)
    .mutation(async ({ ctx, input }) => {
      const actor = requireActor(ctx);
      const person = await loadPerson(ctx, input.personId);
      if (person.relationship_type === 'employee') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Employees have no access-expiry date',
        });
      }
      await ctx.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('platform.person')
          .set({ access_valid_until: new Date(input.accessValidUntil), updated_by: actor })
          .where('id', '=', input.personId)
          .execute();
        await appendEvent(trx, {
          kind: 'security',
          streamType: 'platform.person',
          streamId: input.personId,
          eventType: 'platform.person.access_expiry_set',
          payload: { accessValidUntil: input.accessValidUntil },
          actorPersonId: actor,
          correlationId: ctx.correlationId,
        });
      });
      return { personId: input.personId };
    }),

  /** Reactivate an expired external against the SAME person (PL-042). */
  reengage: adminProcedure.input(reengageInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    const person = await loadPerson(ctx, input.personId);
    if (person.status !== 'inactive') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Only an inactive person can be re-engaged',
      });
    }
    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('platform.person')
        .set({
          status: 'active',
          access_valid_until: new Date(input.accessValidUntil),
          updated_by: actor,
        })
        .where('id', '=', input.personId)
        .execute();
      await enableSignIn(trx, input.personId);
      await appendEvent(trx, {
        kind: 'security',
        streamType: 'platform.person',
        streamId: input.personId,
        eventType: 'platform.person.reengaged',
        payload: { accessValidUntil: input.accessValidUntil },
        actorPersonId: actor,
        correlationId: ctx.correlationId,
      });
    });
    return { personId: input.personId };
  }),

  /** Merge two persons onto one surrogate id — reversible, flags unioned (PL-038/040). */
  merge: adminProcedure.input(mergePersonsInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    if (input.survivingPersonId === input.supersededPersonId) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot merge a person with itself' });
    }
    const survivor = await loadPerson(ctx, input.survivingPersonId);
    const loser = await loadPerson(ctx, input.supersededPersonId);
    if (survivor.status !== 'active' || loser.status !== 'active') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Both persons must be active to merge' });
    }
    const liveMerge = await ctx.db
      .selectFrom('platform.person_merge')
      .select('id')
      .where('superseded_person_id', '=', input.supersededPersonId)
      .where('reversed_at', 'is', null)
      .executeTakeFirst();
    if (liveMerge) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'That person is already superseded by a live merge',
      });
    }

    const mergeId = newUuidV7();
    const copiedFlagIds = await ctx.db.transaction().execute(async (trx) => {
      const movedUserIds = await repointUsers(trx, {
        fromPersonId: input.supersededPersonId,
        toPersonId: input.survivingPersonId,
      });
      await trx
        .insertInto('platform.person_merge')
        .values({
          id: mergeId,
          superseded_person_id: input.supersededPersonId,
          surviving_person_id: input.survivingPersonId,
          reason: input.reason,
          moved_user_ids: JSON.stringify(movedUserIds),
          merged_by: actor,
          merged_at: new Date(),
        })
        .execute();

      // Flag union — never-lose (PL-040).
      const survivorFlags = await trx
        .selectFrom('platform.person_flag')
        .select(['id', 'flag_type', 'reason'])
        .where('person_id', '=', input.survivingPersonId)
        .where('ended_at', 'is', null)
        .execute();
      const loserFlags = await trx
        .selectFrom('platform.person_flag')
        .select(['id', 'flag_type', 'reason'])
        .where('person_id', '=', input.supersededPersonId)
        .where('ended_at', 'is', null)
        .execute();
      const copies = planFlagUnion(
        survivorFlags.map((f) => ({ id: f.id, flagType: f.flag_type, reason: f.reason })),
        loserFlags.map((f) => ({ id: f.id, flagType: f.flag_type, reason: f.reason })),
      );
      const copiedIds: string[] = [];
      for (const copy of copies) {
        const id = newUuidV7();
        copiedIds.push(id);
        await trx
          .insertInto('platform.person_flag')
          .values({
            id,
            person_id: input.survivingPersonId,
            flag_type: copy.flagType,
            reason: copy.reason,
            source_merge_id: mergeId,
            source_flag_id: copy.sourceFlagId,
            raised_by: actor,
            raised_at: new Date(),
          })
          .execute();
      }

      await trx
        .updateTable('platform.person')
        .set({ status: 'superseded', updated_by: actor })
        .where('id', '=', input.supersededPersonId)
        .execute();

      await appendEvent(trx, {
        kind: 'security',
        streamType: 'platform.person',
        streamId: input.survivingPersonId,
        eventType: 'platform.person.merged',
        payload: {
          mergeId,
          supersededPersonId: input.supersededPersonId,
          movedUserIds,
          copiedFlagIds: copiedIds,
        },
        actorPersonId: actor,
        correlationId: ctx.correlationId,
      });
      return copiedIds;
    });
    return { mergeId, copiedFlagIds };
  }),

  /** Reverse a merge: restore users, reactivate the superseded person (PL-039). */
  unmerge: adminProcedure.input(unmergeInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    const merge = await ctx.db
      .selectFrom('platform.person_merge')
      .selectAll()
      .where('id', '=', input.mergeId)
      .executeTakeFirst();
    if (!merge) throw new TRPCError({ code: 'NOT_FOUND', message: 'Merge not found' });
    if (merge.reversed_at)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Merge already reversed' });

    const movedUserIds = merge.moved_user_ids as string[];
    await ctx.db.transaction().execute(async (trx) => {
      await restoreUsers(trx, { userIds: movedUserIds, toPersonId: merge.superseded_person_id });
      await trx
        .updateTable('platform.person')
        .set({ status: 'active', updated_by: actor })
        .where('id', '=', merge.superseded_person_id)
        .execute();
      await trx
        .updateTable('platform.person_merge')
        .set({ reversed_by: actor, reversed_at: new Date(), reversal_reason: input.reason })
        .where('id', '=', input.mergeId)
        .execute();
      await appendEvent(trx, {
        kind: 'security',
        streamType: 'platform.person',
        streamId: merge.surviving_person_id,
        eventType: 'platform.person.merge_reversed',
        payload: { mergeId: input.mergeId, supersededPersonId: merge.superseded_person_id },
        actorPersonId: actor,
        correlationId: ctx.correlationId,
      });
    });
    return { mergeId: input.mergeId };
  }),

  // --- Invitation (PL-036) — the only external account-creation path ------

  invite: adminProcedure.input(invitePersonInput).mutation(async ({ ctx, input }) => {
    const actor = requireActor(ctx);
    await loadPerson(ctx, input.personId);
    const { reused } = await ctx.db.transaction().execute(async (trx) => {
      const result = await provisionInvitedUser(trx, {
        personId: input.personId,
        email: input.email,
      });
      await appendEvent(trx, {
        kind: 'security',
        streamType: 'platform.person',
        streamId: input.personId,
        eventType: 'platform.person.invited',
        payload: { reinvited: result.reused },
        actorPersonId: actor,
        correlationId: ctx.correlationId,
      });
      return result;
    });
    // Email after commit — a delivery failure must not roll back the provisioning.
    await ctx.email.sendInvitation(input.email);
    ctx.logger.info('platform.identity.invite', { personId: input.personId, reused });
    return { invited: true, reinvited: reused };
  }),
});
