import { TRPCError } from '@trpc/server';
import { sql } from 'kysely';
import { newUuidV7 } from '@repo/db';
import { hasRole, requireDefinition, WorkflowNotRegisteredError } from '@repo/domain';
import {
  cancelScheduledAction,
  executeTransition,
  rescheduleAction,
  type TransitionFailureCode,
} from '@repo/workflow';
import { protectedProcedure, roleProcedure, router, type TRPCContext } from '../../trpc.js';
import {
  cancelScheduledActionInput,
  listScheduledActionsInput,
  rescheduleActionInput,
  workflowInstanceRefInput,
  workflowListInstancesInput,
  workflowTransitionInput,
} from '../../schemas.js';
import { decodeCursor, encodeCursor, keysetBoundary, timestampSortKey } from '../../lib/keyset.js';
import { ROLE_KEYS, type ModuleKey } from '../../lib/constants.js';

/**
 * The workflow runtime's tRPC surface (core plan 07 §5.3).
 *
 * **The generic `transition` procedure is the runtime API.** Plans 08/09/10 and
 * the HR shapes add thin per-domain wrappers only where they need richer input
 * validation — and because the `by`-policy check runs inside `executeTransition`
 * rather than only here, a wrapper cannot bypass authorisation (ADR-0015,
 * defence in depth). That is the property that makes a generic mutation safe to
 * expose at all.
 *
 * `startWorkflow` is deliberately **not** exposed. Instances are created by
 * owning-domain code alongside their subject (plan 09's "submit request", say),
 * in one transaction, so every instance has a real subject and no caller can
 * mint an orphan.
 *
 * The three admin surfaces (`listInstances`, `listScheduledActions`,
 * `cancelScheduledAction`, `rescheduleAction`) are Administrator-only: the
 * runtime is substrate, and its instance list spans every module at once, so
 * it cannot be scoped by any one module's record rules.
 */

/**
 * Runtime administration. Per the set overview's 2026-07-28 reconciliation,
 * `adminProcedure` is Better Auth framework-only; product surfaces compose
 * `roleProcedure`, once, beside their primary router.
 */
const workflowAdmin = roleProcedure(['administrator'], { module: 'platform' });

function requireActor(ctx: TRPCContext): string {
  if (!ctx.actorPersonId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The acting user is not linked to a person record',
    });
  }
  return ctx.actorPersonId;
}

/**
 * A `jsonb` column, flattened to a plain object for the wire.
 *
 * `@repo/db`'s generated `Json` alias is recursive. That is correct for the
 * database layer, but a recursive type inside a router's *inferred output* is
 * something TanStack Table's column typing cannot instantiate on the client
 * (TS2589) — so the timers list would be untypeable in the very screen it
 * exists for. Payloads here are ids and primitives, rendered as text, so a flat
 * object loses nothing.
 */
function asJsonObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The runtime's failure codes, mapped to the tRPC vocabulary. */
const TRPC_CODE: Record<
  TransitionFailureCode,
  'CONFLICT' | 'FORBIDDEN' | 'BAD_REQUEST' | 'NOT_FOUND'
> = {
  CONFLICT: 'CONFLICT',
  FORBIDDEN: 'FORBIDDEN',
  // A guard block is a rejected request, not a server error: the caller asked
  // for something the rules do not permit, and the guard's own words say why.
  GUARD_BLOCKED: 'BAD_REQUEST',
  UNKNOWN_ACTION: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
};

/**
 * May this caller see this instance?
 *
 * **The Phase 1 rule, pending §12.2 Q4:** an Administrator sees everything;
 * anyone else must either have started the case or hold a role in the module the
 * workflow belongs to. "Permitted on the subject" is what the plan asks for, and
 * it is not yet expressible — a subject is an arbitrary stream, and only the
 * owning module knows how to authorise one. Approximating it by the workflow's
 * own module is coarse but **fails closed** for anyone outside the area, and it
 * is the rule Q4 will refine once plan 09 has real subjects with real record
 * scopes to check against.
 *
 * Deliberately reported as NOT_FOUND rather than FORBIDDEN: a distinct
 * "forbidden" would confirm the case exists, which is the same leak
 * `getPerson` avoids.
 */
function canView(
  ctx: TRPCContext,
  instance: { workflow_key: string; definition_version: number; created_by: string },
): boolean {
  const now = new Date();
  if (hasRole(ctx.grants, ['administrator'], 'platform', now)) return true;
  if (ctx.actorPersonId && instance.created_by === ctx.actorPersonId) return true;
  try {
    const def = requireDefinition(instance.workflow_key, instance.definition_version);
    return hasRole(ctx.grants, ROLE_KEYS, def.module as ModuleKey, now);
  } catch (error) {
    // A definition retired out from under a live instance is a deployment
    // mistake, not a visibility question — fail closed and let the admin list
    // (which does not need the definition) surface it.
    if (error instanceof WorkflowNotRegisteredError) return false;
    throw error;
  }
}

export const workflowRouter = router({
  /**
   * Execute a named action on an instance.
   *
   * `protectedProcedure`, not a role builder: *which* role may take *this*
   * transition is the definition's `by` policy, resolved from configuration at
   * execution time, so it cannot be known at the procedure boundary. The check
   * happens inside the service, against the workflow's own module.
   */
  transition: protectedProcedure.input(workflowTransitionInput).mutation(async ({ ctx, input }) => {
    const actorPersonId = requireActor(ctx);
    const result = await executeTransition(ctx.db, {
      instanceId: input.instanceId,
      action: input.action,
      actorPersonId,
      onBehalfOf: input.onBehalfOf ?? null,
      comment: input.comment ?? null,
      input: input.input ?? {},
      ...(input.expectedState === undefined ? {} : { expectedState: input.expectedState }),
      now: new Date(),
      correlationId: newUuidV7(),
    });

    if (!result.ok) {
      throw new TRPCError({ code: TRPC_CODE[result.code], message: result.detail });
    }

    return {
      instanceId: result.instance.id,
      state: result.instance.current_state,
      completedAt: result.instance.completed_at?.toISOString() ?? null,
      transitionId: result.transition.id,
      /** Soft-guard warnings — shown to the caller, already recorded (PL-017). */
      warnings: result.warnings,
    };
  }),

  /**
   * One instance plus its full transition history — the "how did this case get
   * here?" read (PL-026/028). Ordered oldest-first, because a timeline is read
   * forwards.
   */
  get: protectedProcedure.input(workflowInstanceRefInput).query(async ({ ctx, input }) => {
    // Explicit columns rather than `selectAll()`: the return type is a DTO on
    // the wire, and naming the columns keeps it one — and keeps `@repo/db`'s
    // generated row types out of the router's public signature.
    const instance = await ctx.db
      .selectFrom('platform.workflow_instance as i')
      .leftJoin('platform.person as starter', 'starter.id', 'i.created_by')
      .select([
        'i.id',
        'i.workflow_key',
        'i.definition_version',
        'i.subject_stream_type',
        'i.subject_stream_id',
        'i.current_state',
        'i.completed_at',
        'i.created_at',
        'i.created_by',
        'i.updated_at',
        'starter.display_name as started_by_name',
      ])
      .where('i.id', '=', input.instanceId)
      .where('i.deleted_at', 'is', null)
      .executeTakeFirst();

    if (!instance || !canView(ctx, instance)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No such workflow instance' });
    }

    const transitions = await ctx.db
      .selectFrom('platform.workflow_transition as t')
      .leftJoin('platform.person as actor', 'actor.id', 't.actor_person_id')
      .select([
        't.id',
        't.from_state',
        't.to_state',
        't.action',
        't.actor_person_id',
        'actor.display_name as actor_name',
        't.on_behalf_of',
        't.comment',
        't.guard_results',
        't.resolved_config',
        't.effects',
        't.occurred_at',
        't.recorded_at',
      ])
      .where('t.instance_id', '=', instance.id)
      .orderBy('t.occurred_at')
      .orderBy('t.id')
      .execute();

    // The three `jsonb` columns are widened to `unknown` on the wire, for the
    // reason `asJsonObject` documents: a recursive type in the inferred output
    // is unusable on the client. Each has a different shape, so the client
    // narrows them itself (`~/lib/workflow`) — which it would have to do
    // regardless, since these columns are deliberately schema-less in SQL.
    const transitionDtos = transitions.map((t) => ({
      id: t.id,
      fromState: t.from_state,
      toState: t.to_state,
      action: t.action,
      actorPersonId: t.actor_person_id,
      actorName: t.actor_name,
      onBehalfOf: t.on_behalf_of,
      comment: t.comment,
      guardResults: t.guard_results as unknown,
      resolvedConfig: t.resolved_config as unknown,
      effects: t.effects as unknown,
      occurredAt: t.occurred_at,
      recordedAt: t.recorded_at,
    }));

    // Timers for the case, so the detail view can answer "what happens next if
    // nobody acts?" without a second round trip.
    const timers = await ctx.db
      .selectFrom('platform.scheduled_action')
      .select(['id', 'action_type', 'due_at', 'status', 'cancel_reason', 'executed_at'])
      .where('workflow_instance_id', '=', instance.id)
      .orderBy('due_at')
      .execute();

    return { instance, transitions: transitionDtos, timers };
  }),

  /** Keyset-paginated instance list; every facet applied in SQL (ADR-0004). */
  listInstances: workflowAdmin.input(workflowListInstancesInput).query(async ({ ctx, input }) => {
    const sortKey =
      input.sort === 'updated_at'
        ? timestampSortKey('i.updated_at')
        : timestampSortKey('i.created_at');

    let query = ctx.db
      .selectFrom('platform.workflow_instance as i')
      .leftJoin('platform.person as starter', 'starter.id', 'i.created_by')
      .select([
        'i.id',
        'i.workflow_key',
        'i.definition_version',
        'i.subject_stream_type',
        'i.subject_stream_id',
        'i.current_state',
        'i.completed_at',
        'i.created_at',
        'i.updated_at',
        'starter.display_name as started_by_name',
      ])
      .select(sortKey.as('sort_key'))
      .where('i.deleted_at', 'is', null);

    if (input.workflowKey) query = query.where('i.workflow_key', '=', input.workflowKey);
    if (input.currentState) query = query.where('i.current_state', '=', input.currentState);
    if (input.active !== undefined) {
      query = input.active
        ? query.where('i.completed_at', 'is', null)
        : query.where('i.completed_at', 'is not', null);
    }
    if (input.subjectStreamType) {
      query = query.where('i.subject_stream_type', '=', input.subjectStreamType);
    }
    if (input.subjectStreamId) {
      query = query.where('i.subject_stream_id', '=', input.subjectStreamId);
    }
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      if (cursor) query = query.where(keysetBoundary(sortKey, 'i.id', cursor, input.sortDir));
    }

    const rows = await query
      .orderBy(sortKey, input.sortDir)
      .orderBy('i.id', input.sortDir)
      .limit(input.limit + 1)
      .execute();

    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ key: last.sort_key, id: last.id }) : null;
    return { items: items.map(({ sort_key: _sk, ...rest }) => rest), nextCursor };
  }),

  /** Keyset-paginated timers — the demonstrable face of "queryable" (WF-9). */
  listScheduledActions: workflowAdmin
    .input(listScheduledActionsInput)
    .query(async ({ ctx, input }) => {
      const sortKey =
        input.sort === 'created_at'
          ? timestampSortKey('s.created_at')
          : timestampSortKey('s.due_at');

      let query = ctx.db
        .selectFrom('platform.scheduled_action as s')
        .leftJoin('platform.workflow_instance as i', 'i.id', 's.workflow_instance_id')
        .select([
          's.id',
          's.due_at',
          's.action_type',
          's.payload',
          's.status',
          's.source',
          's.subject_stream_type',
          's.subject_stream_id',
          's.workflow_instance_id',
          'i.workflow_key',
          'i.current_state',
          's.enqueued_at',
          's.executed_at',
          's.cancelled_at',
          's.cancel_reason',
          's.created_at',
        ])
        .select(sortKey.as('sort_key'))
        .where('s.deleted_at', 'is', null);

      if (input.status) query = query.where('s.status', '=', input.status);
      if (input.actionType) query = query.where('s.action_type', '=', input.actionType);
      if (input.dueFrom) query = query.where('s.due_at', '>=', new Date(input.dueFrom));
      if (input.dueTo) query = query.where('s.due_at', '<=', new Date(input.dueTo));
      if (input.workflowInstanceId) {
        query = query.where('s.workflow_instance_id', '=', input.workflowInstanceId);
      }
      if (input.subjectStreamType) {
        query = query.where('s.subject_stream_type', '=', input.subjectStreamType);
      }
      if (input.subjectStreamId) {
        query = query.where('s.subject_stream_id', '=', input.subjectStreamId);
      }
      if (input.cursor) {
        const cursor = decodeCursor(input.cursor);
        if (cursor) query = query.where(keysetBoundary(sortKey, 's.id', cursor, input.sortDir));
      }

      const rows = await query
        .orderBy(sortKey, input.sortDir)
        .orderBy('s.id', input.sortDir)
        .limit(input.limit + 1)
        .execute();

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items.at(-1);
      const nextCursor = hasMore && last ? encodeCursor({ key: last.sort_key, id: last.id }) : null;
      return {
        items: items.map(({ sort_key: _sk, payload, ...rest }) => ({
          ...rest,
          payload: asJsonObject(payload),
        })),
        nextCursor,
      };
    }),

  /**
   * Cancel a pending timer with a reason.
   *
   * A timer that is no longer pending returns `{ cancelled: false }` rather than
   * raising: an administrator clicking cancel a moment after the scheduler
   * claimed the row has done nothing wrong, and the honest answer is "too late",
   * not an error. The UI renders that as a message and refetches.
   */
  cancelScheduledAction: workflowAdmin
    .input(cancelScheduledActionInput)
    .mutation(async ({ ctx, input }) => {
      const actorPersonId = requireActor(ctx);
      const cancelled = await ctx.db.transaction().execute((trx) =>
        cancelScheduledAction(trx, {
          id: input.id,
          reason: input.reason,
          actorPersonId,
          correlationId: newUuidV7(),
        }),
      );
      return { cancelled };
    }),

  /** Amend a pending timer's due date. Same "only while pending" semantics. */
  rescheduleAction: workflowAdmin.input(rescheduleActionInput).mutation(async ({ ctx, input }) => {
    const actorPersonId = requireActor(ctx);
    const dueAt = new Date(input.dueAt);
    const { now } = await sql<{ now: Date }>`SELECT now() AS now`
      .execute(ctx.db)
      .then((r) => r.rows[0]!);
    if (dueAt.getTime() <= now.getTime()) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'A timer must be rescheduled to a future instant — the past has already passed',
      });
    }

    const rescheduled = await ctx.db.transaction().execute((trx) =>
      rescheduleAction(trx, {
        id: input.id,
        dueAt,
        actorPersonId,
        correlationId: newUuidV7(),
      }),
    );
    return { rescheduled };
  }),
});
