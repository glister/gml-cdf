import { TRPCError } from '@trpc/server';
import { sql } from 'kysely';
import { CycleError, hasRole, UnknownAnchorError } from '@repo/domain';
import { protectedProcedure, roleProcedure, router, type TRPCContext } from '../../trpc.js';
import {
  cancelTaskInput,
  caseProgressInput,
  caseProgressOutput,
  completeTaskInput,
  createManualTaskInput,
  myTasksInput,
  myTasksOutput,
  taskDetailSchema,
  taskRefInput,
} from '../../schemas.js';
import { decodeCursor, encodeCursor, keysetBoundary, timestampSortKey } from '../../lib/keyset.js';
import {
  cancelTask,
  claimTask,
  completeTask,
  openGateKeysFor,
  raiseTaskList,
  releaseTask,
  TaskForbiddenError,
  TaskNotFoundError,
  TaskSpecError,
} from '../../lib/tasks.js';

/**
 * The task engine's tRPC surface (core plan 08 §5.1).
 *
 * **Resolution at read time is the whole model (PL-014).** A task row stores
 * `assignee_role_id` and nothing about people; `myTasks` answers "whose task is
 * this?" by joining the caller's live grants. Changing a role's membership in
 * admin therefore redirects task lists with **zero writes to task rows** —
 * reassignment is not an operation here, it is a consequence (ON AC-5).
 *
 * Every facet is SQL. There is no client-side filtering, and the overdue flag is
 * computed in the query rather than from `dueAt` in JavaScript, so the list, the
 * dashboard counts and the chase all read one expression (ADR-0004).
 */

/**
 * Case administration: creating ad-hoc tasks and cancelling them. Composed once
 * here per the set overview's 2026-08-03 reconciliation, rather than repeating a
 * role list at each procedure.
 */
const taskAdmin = roleProcedure(['administrator', 'hr_user'], { module: 'platform' });

/** Roles that may act on any task, and see any case's progress. */
const OVERSIGHT_ROLES = ['administrator', 'hr_user'] as const;

function requireActor(ctx: TRPCContext): string {
  if (!ctx.actorPersonId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The acting user is not linked to a person record',
    });
  }
  return ctx.actorPersonId;
}

function hasOversight(ctx: TRPCContext, now: Date): boolean {
  return hasRole(ctx.grants, OVERSIGHT_ROLES, 'platform', now);
}

/** Service failures, mapped to the tRPC vocabulary once. */
function toTRPCError(error: unknown): unknown {
  if (error instanceof TaskNotFoundError) {
    return new TRPCError({ code: 'NOT_FOUND', message: error.message });
  }
  if (error instanceof TaskForbiddenError) {
    return new TRPCError({ code: 'FORBIDDEN', message: error.message });
  }
  if (error instanceof CycleError || error instanceof TaskSpecError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  if (error instanceof UnknownAnchorError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  // The status machine's own refusals ("this task is blocked…") are the user's
  // answer, not a server fault — they arrive as plain Errors with a message
  // written for a person.
  if (error instanceof Error && error.name === 'TaskTransitionError') {
    return new TRPCError({ code: 'CONFLICT', message: error.message });
  }
  return error;
}

/**
 * `t.due_at < now()` and still actionable — the single overdue expression.
 *
 * Written once and used by the list, the detail read and `caseProgress`, because
 * three spellings of "overdue" is three chances for the badge on a row and the
 * count on the dashboard to disagree.
 */
const OVERDUE_SQL = sql<boolean>`(t.due_at IS NOT NULL AND t.due_at < now() AND t.status IN ('open', 'blocked'))`;

/** Unsatisfied dependency count — "what is still holding this task up?" */
const BLOCKED_COUNT_SQL = sql<number>`(
  SELECT count(*) FROM platform.task_dependency d
  WHERE d.task_id = t.id AND d.satisfied_at IS NULL
)`;

/**
 * The caller's live role grants, as a subquery.
 *
 * The time window is evaluated **in SQL at query time**, not from the request
 * context: a grant that expires mid-session must stop surfacing work without the
 * user signing in again (core plan 04 §5.1).
 */
function grantedRoleIds(personId: string) {
  return sql<string>`(
    SELECT g.role_id FROM platform.role_grant g
    WHERE g.person_id = ${personId}
      AND g.revoked_at IS NULL
      AND g.deleted_at IS NULL
      AND g.valid_from <= now()
      AND (g.valid_until IS NULL OR g.valid_until > now())
  )`;
}

/**
 * The sort key for `sort='due'`.
 *
 * `due_at` is nullable, and a null sort key breaks the row-value cursor
 * comparison outright, so undated tasks are coalesced to a far-future sentinel —
 * they sort last ascending, which is also where they belong on a list of what to
 * do next. Rendered fixed-width so microsecond precision survives the cursor
 * round trip (ADR-0004; a JS `Date` holds only milliseconds).
 */
const DUE_SORT_KEY = sql<string>`to_char(
  coalesce(t.due_at, timestamptz '9999-12-31 00:00:00+00'),
  'YYYY-MM-DD"T"HH24:MI:SS.US'
)`;

export const tasksRouter = router({
  /**
   * The caller's work: every task assigned to a role they currently hold.
   *
   * `protectedProcedure` with no role list, deliberately — the surface is
   * self-scoping. Which tasks a person sees *is* their grants, so there is no
   * role that could be required beyond having some.
   */
  myTasks: protectedProcedure
    .input(myTasksInput)
    .output(myTasksOutput)
    .query(async ({ ctx, input }) => {
      const actorPersonId = requireActor(ctx);
      const sortKey = input.sort === 'due' ? DUE_SORT_KEY : timestampSortKey('t.created_at');

      let query = ctx.db
        .selectFrom('platform.task as t')
        .innerJoin('platform.role as r', 'r.id', 't.assignee_role_id')
        .leftJoin('platform.person as c', 'c.id', 't.claimed_by')
        .select([
          't.id',
          't.stream_type',
          't.stream_id',
          't.lane',
          't.title',
          't.assignee_role_id',
          'r.name as assignee_role_name',
          't.claimed_by',
          'c.display_name as claimed_by_name',
          't.status',
          't.due_at',
          't.created_at',
        ])
        .select(OVERDUE_SQL.as('overdue'))
        .select(BLOCKED_COUNT_SQL.as('blocked_count'))
        .select(sortKey.as('sort_key'))
        .where('t.deleted_at', 'is', null)
        .where(sql<boolean>`t.assignee_role_id IN ${grantedRoleIds(actorPersonId)}`);

      // Default to the actionable set: a my-tasks list of everything ever
      // completed is a report, not a to-do list.
      query = query.where('t.status', 'in', input.status ?? ['open', 'blocked']);

      if (input.lane) query = query.where('t.lane', '=', input.lane);
      if (input.streamType) query = query.where('t.stream_type', '=', input.streamType);
      if (input.streamId) query = query.where('t.stream_id', '=', input.streamId);
      if (input.overdueOnly) query = query.where(OVERDUE_SQL);
      if (input.dueBefore) query = query.where('t.due_at', '<', new Date(input.dueBefore));
      if (input.search) {
        // Titles are instructions, so a substring match on them is the search a
        // user means. `%` and `_` are escaped: a search for "100%" must not
        // silently become a wildcard.
        const escaped = input.search.replace(/[\\%_]/g, (char) => `\\${char}`);
        query = query.where(sql<boolean>`t.title ILIKE ${'%' + escaped + '%'}`);
      }
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

      return {
        items: items.map((row) => ({
          id: row.id,
          streamType: row.stream_type,
          streamId: row.stream_id,
          lane: row.lane,
          title: row.title,
          assigneeRoleId: row.assignee_role_id,
          assigneeRoleName: row.assignee_role_name,
          claimedBy: row.claimed_by,
          claimedByName: row.claimed_by_name,
          status: row.status,
          dueAt: row.due_at?.toISOString() ?? null,
          overdue: row.overdue,
          blockedCount: Number(row.blocked_count),
          raisedAt: row.created_at.toISOString(),
        })),
        nextCursor: hasMore && last ? encodeCursor({ key: last.sort_key, id: last.id }) : null,
      };
    }),

  /**
   * One task, with what blocks it and what it unlocks.
   *
   * **Visibility, Phase 1:** oversight roles see any task; anyone else must hold
   * the assignee role. The plan also asks for "Line Manager where the case
   * subject is in their team", and that is not yet expressible — a case stream is
   * an arbitrary `(type, id)` pair, and only the owning module knows how to map
   * one to people. This is the same gap core plan 07 §12.2 Q4 records for
   * `workflow.get`, and it will be closed the same way, by the first module that
   * brings real subjects with record scopes. Until then the rule **fails
   * closed**, and refusal is `NOT_FOUND` rather than `FORBIDDEN`: a distinct
   * refusal would confirm the task exists.
   */
  byId: protectedProcedure
    .input(taskRefInput)
    .output(taskDetailSchema)
    .query(async ({ ctx, input }) => {
      const actorPersonId = requireActor(ctx);
      const now = new Date();

      const task = await ctx.db
        .selectFrom('platform.task as t')
        .innerJoin('platform.role as r', 'r.id', 't.assignee_role_id')
        .leftJoin('platform.person as c', 'c.id', 't.claimed_by')
        .leftJoin('platform.person as done_by', 'done_by.id', 't.completed_by')
        .select([
          't.id',
          't.stream_type',
          't.stream_id',
          't.workflow_instance_id',
          't.lane',
          't.title',
          't.description',
          't.assignee_role_id',
          'r.name as assignee_role_name',
          't.claimed_by',
          'c.display_name as claimed_by_name',
          't.claimed_at',
          't.status',
          't.due_mode',
          't.due_at',
          't.anchor_name',
          't.anchor_offset_days',
          't.source',
          't.source_ref',
          't.completed_at',
          't.completion_note',
          'done_by.display_name as completed_by_name',
          't.cancel_reason',
          't.created_at',
        ])
        .select(OVERDUE_SQL.as('overdue'))
        .select(BLOCKED_COUNT_SQL.as('blocked_count'))
        .where('t.id', '=', input.taskId)
        .where('t.deleted_at', 'is', null)
        .executeTakeFirst();

      const canAct = task
        ? await ctx.db
            .selectFrom('platform.role_grant')
            .select('id')
            .where('person_id', '=', actorPersonId)
            .where('role_id', '=', task.assignee_role_id)
            .where('revoked_at', 'is', null)
            .where('deleted_at', 'is', null)
            .where('valid_from', '<=', now)
            .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', now)]))
            .executeTakeFirst()
            .then((row) => row !== undefined)
        : false;

      if (!task || !(canAct || hasOversight(ctx, now))) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No such task' });
      }

      const dependencies = await ctx.db
        .selectFrom('platform.task_dependency as d')
        .leftJoin('platform.task as b', 'b.id', 'd.depends_on_task_id')
        .select([
          'd.id',
          'd.depends_on_kind',
          'd.depends_on_task_id',
          'b.title as blocker_title',
          'b.status as blocker_status',
          'd.gate_key',
          'd.satisfied_at',
        ])
        .where('d.task_id', '=', task.id)
        .orderBy('d.created_at')
        .execute();

      const unlocks = await ctx.db
        .selectFrom('platform.task_dependency as d')
        .innerJoin('platform.task as t', 't.id', 'd.task_id')
        .select(['t.id', 't.title', 't.status', 't.lane'])
        .where('d.depends_on_task_id', '=', task.id)
        .where('t.deleted_at', 'is', null)
        .orderBy('t.created_at')
        .execute();

      return {
        id: task.id,
        streamType: task.stream_type,
        streamId: task.stream_id,
        workflowInstanceId: task.workflow_instance_id,
        lane: task.lane,
        title: task.title,
        description: task.description,
        assigneeRoleId: task.assignee_role_id,
        assigneeRoleName: task.assignee_role_name,
        claimedBy: task.claimed_by,
        claimedByName: task.claimed_by_name,
        claimedAt: task.claimed_at?.toISOString() ?? null,
        status: task.status,
        dueMode: task.due_mode,
        dueAt: task.due_at?.toISOString() ?? null,
        anchorName: task.anchor_name,
        anchorOffsetDays: task.anchor_offset_days,
        overdue: task.overdue,
        blockedCount: Number(task.blocked_count),
        source: task.source,
        sourceRef: task.source_ref,
        completedAt: task.completed_at?.toISOString() ?? null,
        completedByName: task.completed_by_name,
        completionNote: task.completion_note,
        cancelReason: task.cancel_reason,
        raisedAt: task.created_at.toISOString(),
        dependencies: dependencies.map((d) => ({
          id: d.id,
          kind: d.depends_on_kind,
          dependsOnTaskId: d.depends_on_task_id,
          dependsOnTaskTitle: d.blocker_title,
          dependsOnTaskStatus: d.blocker_status,
          gateKey: d.gate_key,
          satisfiedAt: d.satisfied_at?.toISOString() ?? null,
        })),
        unlocks: unlocks.map((u) => ({
          id: u.id,
          title: u.title,
          status: u.status,
          lane: u.lane,
        })),
        canAct,
      };
    }),

  /** Signal "I am working on this". Metadata — it gates nothing (§4.3). */
  claim: protectedProcedure.input(taskRefInput).mutation(async ({ ctx, input }) => {
    const actorPersonId = requireActor(ctx);
    try {
      const task = await ctx.db
        .transaction()
        .execute((trx) =>
          claimTask(trx, {
            ...input,
            actorPersonId,
            correlationId: ctx.correlationId,
            now: new Date(),
          }),
        );
      return { claimedBy: task.claimed_by };
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  release: protectedProcedure.input(taskRefInput).mutation(async ({ ctx, input }) => {
    const actorPersonId = requireActor(ctx);
    try {
      await ctx.db
        .transaction()
        .execute((trx) =>
          releaseTask(trx, {
            ...input,
            actorPersonId,
            correlationId: ctx.correlationId,
            now: new Date(),
          }),
        );
      return { claimedBy: null };
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /**
   * Complete a task, and everything that follows: unlocks, the end of the chase,
   * the events.
   *
   * The role check runs in the service, inside the transaction, so the override
   * decision and the completion cannot disagree. Here we only tell it whether
   * this caller *may* override — which is a property of their grants, not of the
   * task.
   */
  complete: protectedProcedure.input(completeTaskInput).mutation(async ({ ctx, input }) => {
    const actorPersonId = requireActor(ctx);
    const now = new Date();
    try {
      const result = await ctx.db.transaction().execute((trx) =>
        completeTask(trx, {
          taskId: input.taskId,
          actorPersonId,
          allowOverride: hasOversight(ctx, now),
          onBehalfOf: input.onBehalfOf ?? null,
          note: input.note ?? null,
          correlationId: ctx.correlationId,
          now,
        }),
      );
      return {
        status: result.task.status,
        unblockedTaskIds: result.unblockedTaskIds,
        override: result.override,
      };
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /** Cancel a task with a reason. Its dependents are released, not stranded. */
  cancel: taskAdmin.input(cancelTaskInput).mutation(async ({ ctx, input }) => {
    const actorPersonId = requireActor(ctx);
    try {
      const result = await ctx.db.transaction().execute((trx) =>
        cancelTask(trx, {
          taskId: input.taskId,
          reason: input.reason,
          actorPersonId,
          correlationId: ctx.correlationId,
          now: new Date(),
        }),
      );
      return { status: result.task.status, unblockedTaskIds: result.unblockedTaskIds };
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /**
   * An ad-hoc task on a case — the single-task list (§5.1). It goes through
   * `raiseTaskList` rather than a second insert path, so a manual task gets the
   * same cycle check, the same gate pre-satisfaction and the same chase as one
   * raised by a workflow.
   */
  createManual: taskAdmin.input(createManualTaskInput).mutation(async ({ ctx, input }) => {
    const actorPersonId = requireActor(ctx);
    try {
      const [raised] = await ctx.db.transaction().execute((trx) =>
        raiseTaskList(trx, {
          streamType: input.streamType,
          streamId: input.streamId,
          anchors: input.anchors,
          source: 'manual',
          tasks: [
            {
              ref: 'manual',
              title: input.title,
              ...(input.description === undefined ? {} : { description: input.description }),
              ...(input.lane === undefined ? {} : { lane: input.lane }),
              assigneeRoleId: input.assigneeRoleId,
              due: input.due,
              dependsOn: [],
              dependsOnTaskIds: input.dependsOnTaskIds,
              gates: input.gates,
            },
          ],
          actorPersonId,
          correlationId: ctx.correlationId,
          now: new Date(),
        }),
      );
      return { taskId: raised!.id, status: raised!.status };
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /**
   * One case's progress (PL-015) — per-lane counts, gate states and what is
   * holding up the most work.
   *
   * **Every number below is SQL.** There is no stored "percent complete" and no
   * arithmetic over a fetched page: the dashboard reads the same rows the list
   * does, through the same overdue expression, so the two cannot drift.
   *
   * Visibility follows `byId`'s rule: oversight roles see any case; anyone else
   * must hold the assignee role of at least one task in it — you can see how the
   * case you are working on is going, and no further. The Line Manager
   * own-team rule the plan describes waits on the same subject-scoping seam as
   * `byId` (core plan 07 §12.2 Q4).
   */
  caseProgress: protectedProcedure
    .input(caseProgressInput)
    .output(caseProgressOutput)
    .query(async ({ ctx, input }) => {
      const actorPersonId = requireActor(ctx);
      const now = new Date();

      if (!hasOversight(ctx, now)) {
        const involved = await ctx.db
          .selectFrom('platform.task as t')
          .select('t.id')
          .where('t.stream_type', '=', input.streamType)
          .where('t.stream_id', '=', input.streamId)
          .where('t.deleted_at', 'is', null)
          .where(sql<boolean>`t.assignee_role_id IN ${grantedRoleIds(actorPersonId)}`)
          .executeTakeFirst();
        if (!involved) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'No such case' });
        }
      }

      const lanes = await ctx.db
        .selectFrom('platform.task as t')
        .select('t.lane')
        .select(({ fn }) => fn.countAll<string>().as('total'))
        .select(sql<string>`count(*) FILTER (WHERE t.status = 'done')`.as('done'))
        .select(sql<string>`count(*) FILTER (WHERE t.status = 'open')`.as('open'))
        .select(sql<string>`count(*) FILTER (WHERE t.status = 'blocked')`.as('blocked'))
        .select(sql<string>`count(*) FILTER (WHERE t.status = 'cancelled')`.as('cancelled'))
        .select(sql<string>`count(*) FILTER (WHERE ${OVERDUE_SQL})`.as('overdue'))
        .select(
          sql<Date | null>`min(t.due_at) FILTER (WHERE t.status IN ('open', 'blocked'))`.as(
            'next_due_at',
          ),
        )
        .where('t.stream_type', '=', input.streamType)
        .where('t.stream_id', '=', input.streamId)
        .where('t.deleted_at', 'is', null)
        .groupBy('t.lane')
        .orderBy('t.lane')
        .execute();

      // Unsatisfied edges joined to the blocked tasks they hold up: one pass
      // answering both "which gates are shut?" and "what is the bottleneck?".
      const blocking = await ctx.db
        .selectFrom('platform.task_dependency as d')
        .innerJoin('platform.task as t', 't.id', 'd.task_id')
        .leftJoin('platform.task as bt', 'bt.id', 'd.depends_on_task_id')
        .select([
          'd.depends_on_kind as kind',
          sql<string>`coalesce(d.gate_key, d.depends_on_task_id::text)`.as('ref'),
          'bt.title',
        ])
        .select(({ fn }) => fn.countAll<string>().as('blocked_count'))
        .select(sql<Date>`min(t.created_at)`.as('oldest_blocked_raised_at'))
        .where('d.satisfied_at', 'is', null)
        .where('t.status', '=', 'blocked')
        .where('t.deleted_at', 'is', null)
        .where('t.stream_type', '=', input.streamType)
        .where('t.stream_id', '=', input.streamId)
        .groupBy(['d.depends_on_kind', 'd.gate_key', 'd.depends_on_task_id', 'bt.title'])
        .orderBy('blocked_count', 'desc')
        .orderBy('oldest_blocked_raised_at', 'asc')
        .execute();

      // Every gate the case knows about: the ones still blocking something, and
      // the ones already opened. A gate opened before its tasks existed appears
      // only in the journal, and a gate nobody is waiting on any more appears
      // only there too — so the set is the union.
      const gateRows = await ctx.db
        .selectFrom('platform.task_dependency as d')
        .innerJoin('platform.task as t', 't.id', 'd.task_id')
        .select('d.gate_key')
        .where('d.depends_on_kind', '=', 'gate')
        .where('t.stream_type', '=', input.streamType)
        .where('t.stream_id', '=', input.streamId)
        .where('t.deleted_at', 'is', null)
        .groupBy('d.gate_key')
        .execute();

      const openedGates = await ctx.db
        .transaction()
        .execute((trx) => openGateKeysFor(trx, input.streamType, input.streamId));

      const blockedByGate = new Map(
        blocking
          .filter((row) => row.kind === 'gate')
          .map((row) => [row.ref, Number(row.blocked_count)]),
      );

      const gateKeys = [
        ...new Set([
          ...gateRows.map((row) => row.gate_key).filter((key): key is string => key !== null),
          ...openedGates,
        ]),
      ].sort();

      return {
        lanes: lanes.map((row) => ({
          lane: row.lane,
          total: Number(row.total),
          done: Number(row.done),
          open: Number(row.open),
          blocked: Number(row.blocked),
          cancelled: Number(row.cancelled),
          overdue: Number(row.overdue),
          nextDueAt: row.next_due_at?.toISOString() ?? null,
        })),
        gates: gateKeys.map((gateKey) => ({
          gateKey,
          open: openedGates.has(gateKey),
          blockedTaskCount: blockedByGate.get(gateKey) ?? 0,
        })),
        bottlenecks: blocking.map((row) => ({
          kind: row.kind,
          ref: row.ref,
          title: row.title,
          blockedCount: Number(row.blocked_count),
          oldestBlockedRaisedAt: row.oldest_blocked_raised_at.toISOString(),
        })),
      };
    }),
});
