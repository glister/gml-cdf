import { sql, type Transaction } from 'kysely';
import { appendEvent, newUuidV7, type DB, type TaskRecord } from '@repo/db';
import {
  assertAcyclic,
  evaluateUnlocks,
  initialStatus,
  nextTaskStatus,
  resolveDueDate,
  dueDateChanged,
  type AnchorMap,
  type BlockerRef,
  type DependencyEdge,
  type DueDateOptions,
  type DueSpec,
  type TaskStatus,
} from '@repo/domain';
import { cancelReminders, scheduleReminder } from './notify.js';
import {
  getConfig,
  qualifiedName,
  tasksDueTimeOfDay,
  tasksDueTimeZone,
  tasksReminderCadence,
  tasksReminderNoDueDate,
  tasksReminderStartOffsetDays,
} from '@repo/config';
import type { DueSpec as DueSpecInput, TaskSpec } from '../schemas.js';

/**
 * The task engine's transactional core (core plan 08 §5.1) — the single write
 * path for `platform.task` and `platform.task_dependency` (ADR-0022).
 *
 * Every function here takes a `Transaction<DB>`, not a `Kysely<DB>`, and that is
 * the whole design. A task list and the events that record it, a completion and
 * the unlocks it causes, a gate opening and the tasks it frees — each is one
 * fact, and half of one of those committed on its own is a case that is quietly
 * wrong. Passing the root instance is a type error, so "same transaction" is
 * structural rather than remembered (ADR-0010).
 *
 * Two callers use these: the `platform.tasks.*` procedures, and the worker's
 * `tasks.*` effect handlers. Neither has its own copy of the rules —
 * **`satisfyAndUnlock` in particular is one code path shared by the completion,
 * cancellation and gate routes**, because three implementations of "which tasks
 * did that just unblock?" would be three chances to disagree (§12.3).
 *
 * ## What lives here and what does not
 *
 * Decisions are made in `@repo/domain` (due-date arithmetic, cycle detection,
 * the status machine); this layer resolves configuration as-at, reads and writes
 * rows, and journals. Authorisation is checked here **as well as** at the
 * procedure boundary (ADR-0015, defence in depth): `completeTask` verifies the
 * actor's grant against the task's assignee role inside the transaction, so a
 * future caller that forgets the procedure guard still cannot complete another
 * role's work.
 */

// --- Errors ------------------------------------------------------------------

/** The actor may not take this action on this task (mapped to FORBIDDEN). */
export class TaskForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskForbiddenError';
  }
}

/** No such task, or none the caller may see (mapped to NOT_FOUND). */
export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super('No such task');
    this.name = 'TaskNotFoundError';
  }
}

/** A raise-list or manual task that does not describe a legal graph. */
export class TaskSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskSpecError';
  }
}

// --- Configuration -----------------------------------------------------------

/**
 * The decision points a raise reads, resolved **as-at `now` inside the caller's
 * transaction** — so a due date and the policy that produced it are consistent,
 * and re-reading the journal later with the same instant reproduces it
 * (ADR-0016).
 */
export interface TaskEngineConfig {
  due: DueDateOptions;
  reminder: {
    cadenceRef: string;
    startOffsetDays: number;
    noDueDate: 'from_raise' | 'none';
    /** The zone the chase's wall clock is read in — plan 10's cadence maths. */
    timeZone: string;
  };
}

/**
 * The `config:` reference plan 10's reminder handler re-resolves at each firing
 * — built from the registered key rather than written out, so a rename cannot
 * leave scheduled rows pointing at a key that no longer exists.
 */
export const REMINDER_CADENCE_REF = `config:${qualifiedName(tasksReminderCadence)}`;

/** The reminder kind plan 10 binds a satisfaction check to (its §5.5 registry). */
export const TASK_REMINDER_KIND = 'task.incomplete';

/** The stream vocabulary a reminder chases against (`sourceType`, plan 10 §4.5). */
export const TASK_STREAM_TYPE = 'platform.task';

export async function loadTaskEngineConfig(
  trx: Transaction<DB>,
  at: Date,
): Promise<TaskEngineConfig> {
  const [timeOfDay, timeZone, startOffsetDays, noDueDate] = await Promise.all([
    getConfig(trx, tasksDueTimeOfDay, { at }),
    getConfig(trx, tasksDueTimeZone, { at }),
    getConfig(trx, tasksReminderStartOffsetDays, { at }),
    getConfig(trx, tasksReminderNoDueDate, { at }),
  ]);
  return {
    due: { timeOfDay, timeZone },
    reminder: { cadenceRef: REMINDER_CADENCE_REF, startOffsetDays, noDueDate, timeZone },
  };
}

// --- Shared internals --------------------------------------------------------

/** The wire due spec (ISO strings) as the domain engine wants it (instants). */
function toDomainDueSpec(spec: DueSpecInput): DueSpec {
  switch (spec.mode) {
    case 'none':
      return { mode: 'none' };
    case 'absolute':
      return { mode: 'absolute', dueAt: new Date(spec.dueAt) };
    case 'anchor_relative':
      return {
        mode: 'anchor_relative',
        anchorName: spec.anchorName,
        offsetDays: spec.offsetDays,
      };
  }
}

/** The three due columns a spec and its resolved instant write. */
function dueColumns(
  spec: DueSpecInput,
  dueAt: Date | null,
): Pick<TaskRecord, 'due_mode' | 'anchor_name' | 'anchor_offset_days' | 'due_at'> {
  return {
    due_mode: spec.mode,
    anchor_name: spec.mode === 'anchor_relative' ? spec.anchorName : null,
    anchor_offset_days: spec.mode === 'anchor_relative' ? spec.offsetDays : null,
    due_at: dueAt,
  };
}

/** Does this person hold this exact role, active at `now`, in any module? */
async function holdsRole(
  trx: Transaction<DB>,
  personId: string,
  roleId: string,
  now: Date,
): Promise<boolean> {
  // Any module: a task names a role, not a role-in-a-module, because the module
  // a task belongs to is a property of its case rather than of the assignment.
  // Procedure-level `roleProcedure` still gates the surface by module.
  const row = await trx
    .selectFrom('platform.role_grant')
    .select('id')
    .where('person_id', '=', personId)
    .where('role_id', '=', roleId)
    .where('revoked_at', 'is', null)
    .where('deleted_at', 'is', null)
    .where('valid_from', '<=', now)
    .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', now)]))
    .executeTakeFirst();
  return row !== undefined;
}

async function requireTask(trx: Transaction<DB>, taskId: string): Promise<TaskRecord> {
  // `FOR UPDATE`: two people completing the same task, or a completion racing a
  // cancellation, must serialise — otherwise both would compute unlocks from the
  // same pre-state and journal two contradictory facts.
  const task = await trx
    .selectFrom('platform.task')
    .selectAll()
    .where('id', '=', taskId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!task) throw new TaskNotFoundError(taskId);
  return task;
}

/**
 * Satisfy every unsatisfied edge waiting on `blocker`, open the tasks whose last
 * blocker that was, and journal one `platform.task.unblocked` each.
 *
 * **The single unlock path.** Completion, cancellation and gate opening all come
 * through here, so "which tasks did that free?" is answered once. The pure
 * `evaluateUnlocks` is asked *before* the rows are stamped, because it needs to
 * see which other edges were already satisfied — a task waiting on two things is
 * not unblocked by one of them.
 */
async function satisfyAndUnlock(
  trx: Transaction<DB>,
  input: {
    blocker: BlockerRef;
    /** Gate edges are case-scoped, so a gate satisfaction needs the case. */
    stream?: { streamType: string; streamId: string };
    actorPersonId: string | null;
    correlationId: string;
    now: Date;
  },
): Promise<{ dependenciesSatisfied: number; unblockedTaskIds: string[] }> {
  const { blocker, now } = input;

  // 1. The edges this satisfaction clears. A gate is scoped to its case, which
  //    this table cannot express on its own — the task it blocks carries the
  //    stream, so the scope comes from the join.
  let matching = trx
    .selectFrom('platform.task_dependency as d')
    .innerJoin('platform.task as t', 't.id', 'd.task_id')
    .select(['d.id', 'd.task_id'])
    .where('d.satisfied_at', 'is', null)
    .where('t.deleted_at', 'is', null);

  if (blocker.kind === 'task') {
    matching = matching.where('d.depends_on_task_id', '=', blocker.taskId);
  } else {
    if (!input.stream) {
      throw new Error('a gate satisfaction needs the case stream it is scoped to');
    }
    matching = matching
      .where('d.gate_key', '=', blocker.gateKey)
      .where('t.stream_type', '=', input.stream.streamType)
      .where('t.stream_id', '=', input.stream.streamId);
  }

  const matched = await matching.execute();
  if (matched.length === 0) return { dependenciesSatisfied: 0, unblockedTaskIds: [] };

  const affectedTaskIds = [...new Set(matched.map((row) => row.task_id))];

  // 2. Every edge of every affected task, as it stands *before* stamping.
  const edgeRows = await trx
    .selectFrom('platform.task_dependency')
    .select(['task_id', 'depends_on_kind', 'depends_on_task_id', 'gate_key', 'satisfied_at'])
    .where('task_id', 'in', affectedTaskIds)
    .execute();

  const edges: DependencyEdge[] = edgeRows.map((row) => ({
    taskId: row.task_id,
    blocker:
      row.depends_on_kind === 'task'
        ? { kind: 'task', taskId: row.depends_on_task_id! }
        : { kind: 'gate', gateKey: row.gate_key! },
    satisfied: row.satisfied_at !== null,
  }));
  const candidateIds = evaluateUnlocks(edges, blocker);

  // 3. Stamp the cleared edges.
  await trx
    .updateTable('platform.task_dependency')
    .set({ satisfied_at: now })
    .where(
      'id',
      'in',
      matched.map((row) => row.id),
    )
    .execute();

  // 4. Open the tasks that are now free — but only those still `blocked`. A
  //    cancelled task is not resurrected by its prerequisite finishing.
  const unblockedTaskIds: string[] = [];
  for (const taskId of candidateIds) {
    const task = await requireTask(trx, taskId);
    if (task.status !== 'blocked') continue;
    nextTaskStatus(task.status as TaskStatus, 'unblock');

    await trx
      .updateTable('platform.task')
      .set({ status: 'open', updated_by: input.actorPersonId })
      .where('id', '=', taskId)
      .execute();

    await appendEvent(trx, {
      streamType: TASK_STREAM_TYPE,
      streamId: taskId,
      eventType: 'platform.task.unblocked',
      payload: {
        caseStreamType: task.stream_type,
        caseStreamId: task.stream_id,
        assigneeRoleId: task.assignee_role_id,
        satisfiedBy: blocker,
      },
      actorPersonId: input.actorPersonId,
      correlationId: input.correlationId,
    });
    unblockedTaskIds.push(taskId);
  }

  return { dependenciesSatisfied: matched.length, unblockedTaskIds };
}

/**
 * Schedule the first chase for a task, through core plan 10's
 * `scheduleReminder` (its §5.2).
 *
 * This used to build the `scheduled_action` row by hand, against plan 10's
 * §4.5 payload shape, because that plan did not exist yet — the row and its
 * journal event were identical either way, which is what made the hand-off free
 * when plan 10 landed (2026-08-07). Nothing was migrated: the rows simply
 * started being executed, and this call site moved onto the wrapper.
 *
 * One behaviour improved in the move. The offset is now applied as **calendar
 * days in the configured zone** rather than as milliseconds, so a "-2 days from
 * a 17:00 deadline" chase still lands at 17:00 across a daylight-saving
 * boundary instead of drifting to 16:00 (plan 10 §9.2).
 */
async function scheduleTaskReminder(
  trx: Transaction<DB>,
  input: {
    task: Pick<TaskRecord, 'id' | 'stream_type' | 'stream_id' | 'assignee_role_id' | 'due_at'>;
    workflowInstanceId: string | null;
    config: TaskEngineConfig['reminder'];
    actorPersonId: string | null;
    correlationId: string;
    now: Date;
  },
): Promise<void> {
  const { task, config } = input;

  // `none` for an undated task means exactly that: no chase. Chasing everything
  // daily from the moment it is raised is how a notification system teaches
  // people to ignore it.
  if (task.due_at === null && config.noDueDate !== 'from_raise') return;

  await scheduleReminder(trx, {
    reminderKind: TASK_REMINDER_KIND,
    source: { streamType: TASK_STREAM_TYPE, streamId: task.id },
    // The case, not the task — a contextual recipient (a subject's line
    // manager) is a property of what the work is about.
    subject: { streamType: task.stream_type, streamId: task.stream_id },
    recipient: { kind: 'role', roleId: task.assignee_role_id },
    // A first occurrence whose computed instant has already passed fires on the
    // next scheduler pass, which is the honest behaviour for a task raised after
    // its own deadline — `firstOccurrence` deliberately does not clamp.
    anchor:
      task.due_at === null
        ? { mode: 'from_now' }
        : { mode: 'instant', at: task.due_at, offsetDays: config.startOffsetDays },
    cadenceRef: config.cadenceRef,
    timeZone: config.timeZone,
    workflowInstanceId: input.workflowInstanceId,
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
    now: input.now,
  });
}

/**
 * Stop chasing a task, eagerly, in the transaction that satisfied it — plan 10's
 * cancel-on-complete contract, step 2 (its §4.5). Its handler re-checks
 * satisfaction before every send regardless, so the worst case if this were ever
 * missed is one redundant chase, never a chase after completion.
 */
async function cancelTaskReminders(
  trx: Transaction<DB>,
  input: { taskId: string; reason: string; actorPersonId: string | null; correlationId: string },
): Promise<void> {
  await cancelReminders(trx, {
    source: { streamType: TASK_STREAM_TYPE, streamId: input.taskId },
    reason: input.reason,
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });
}

// --- raiseTaskList -----------------------------------------------------------

/**
 * A task to raise. `dependsOn` names siblings in the same list by their local
 * `ref` (they have no ids yet); `dependsOnTaskIds` names tasks that already
 * exist in the case, which is how a manual task joins a graph already underway.
 */
export type TaskListItem = TaskSpec & { dependsOnTaskIds?: readonly string[] };

export interface RaiseTaskListInput {
  streamType: string;
  streamId: string;
  workflowInstanceId?: string | null;
  /** Anchor name → date, supplied by the raising module (it owns the semantics). */
  anchors: AnchorMap;
  tasks: readonly TaskListItem[];
  source: 'workflow' | 'manual';
  actorPersonId: string | null;
  correlationId: string;
  now: Date;
}

export interface RaisedTask {
  id: string;
  ref: string;
  status: 'blocked' | 'open';
}

/**
 * Raise a list of tasks against a case, with their dependencies, in one
 * transaction (PL-013/014). Invoked as the workflow effect `tasks.raiseList`, and
 * by `createManual` for a single-task list.
 *
 * The sequence, and why it is this order:
 *
 *  1. **Resolve configuration as-at `now`** — due time-of-day and the reminder
 *     policy, inside this transaction (ADR-0016).
 *  2. **Check the graph is acyclic** over the list-local edges *plus* the case's
 *     existing task→task edges. A new task can close a loop that neither half
 *     contains alone, and a cycle must be rejected before anything is written.
 *  3. **Resolve due dates.** An anchor the caller did not supply throws, so a
 *     task never lands with a date nobody chose.
 *  4. **Pre-satisfy gate edges whose gate already opened** — the late-raise case
 *     (§4.1): a bounded, keyed journal lookup for `platform.task.gate.opened` on
 *     this case. Without it a lane raised after the licence check passed would
 *     sit blocked on a gate that will never open again.
 *  5. Insert tasks and edges, compute each initial status from its unsatisfied
 *     edge count, journal one `platform.task.raised` each, and schedule the
 *     first chase.
 */
export async function raiseTaskList(
  trx: Transaction<DB>,
  input: RaiseTaskListInput,
): Promise<RaisedTask[]> {
  const { tasks, now } = input;
  if (tasks.length === 0) return [];

  const refs = new Set<string>();
  for (const spec of tasks) {
    if (refs.has(spec.ref)) {
      throw new TaskSpecError(`duplicate task ref '${spec.ref}' in one list`);
    }
    refs.add(spec.ref);
  }

  const config = await loadTaskEngineConfig(trx, now);

  // 2. Cycle check over list-local edges plus what is already in the case.
  const existingEdges = await trx
    .selectFrom('platform.task_dependency as d')
    .innerJoin('platform.task as t', 't.id', 'd.task_id')
    .select(['d.task_id', 'd.depends_on_task_id'])
    .where('d.depends_on_kind', '=', 'task')
    .where('t.stream_type', '=', input.streamType)
    .where('t.stream_id', '=', input.streamId)
    .where('t.deleted_at', 'is', null)
    .execute();

  // Ids are minted up front so the cycle check runs in one node space — new
  // tasks by their fresh id, existing ones by their real id — rather than
  // half in refs and half in ids.
  const idByRef = new Map(tasks.map((spec) => [spec.ref, newUuidV7()]));

  const referencedTaskIds = [...new Set(tasks.flatMap((spec) => spec.dependsOnTaskIds ?? []))];
  if (referencedTaskIds.length > 0) {
    const found = await trx
      .selectFrom('platform.task')
      .select('id')
      .where('id', 'in', referencedTaskIds)
      .where('stream_type', '=', input.streamType)
      .where('stream_id', '=', input.streamId)
      .where('deleted_at', 'is', null)
      .execute();
    const foundIds = new Set(found.map((row) => row.id));
    const missing = referencedTaskIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      // Depending on another case's task would make one case's progress
      // silently contingent on another's — rejected rather than resolved.
      throw new TaskSpecError(
        `dependency on ${missing.length === 1 ? 'a task' : 'tasks'} that ${missing.length === 1 ? 'is' : 'are'} not in this case: ${missing.join(', ')}`,
      );
    }
  }

  const localEdges = tasks.flatMap((spec) => [
    ...spec.dependsOn.map((dependsOnRef) => {
      if (!refs.has(dependsOnRef)) {
        throw new TaskSpecError(
          `task '${spec.ref}' depends on '${dependsOnRef}', which is not in the same list — list-local dependencies name a sibling's ref`,
        );
      }
      return { taskRef: idByRef.get(spec.ref)!, dependsOnRef: idByRef.get(dependsOnRef)! };
    }),
    ...(spec.dependsOnTaskIds ?? []).map((taskId) => ({
      taskRef: idByRef.get(spec.ref)!,
      dependsOnRef: taskId,
    })),
  ]);
  assertAcyclic([
    ...localEdges,
    ...existingEdges.map((edge) => ({
      taskRef: edge.task_id,
      dependsOnRef: edge.depends_on_task_id!,
    })),
  ]);

  // 4. Which of this case's gates have already opened?
  const openGates = await openGateKeysFor(trx, input.streamType, input.streamId);

  const raised: RaisedTask[] = [];

  for (const spec of tasks) {
    const id = idByRef.get(spec.ref)!;
    const dueSpec = toDomainDueSpec(spec.due);
    const dueAt = resolveDueDate(dueSpec, input.anchors, config.due);

    // Gate edges for gates already open are created **pre-satisfied**, so the
    // task starts actionable rather than waiting for an event that has been and
    // gone.
    const gateEdges = spec.gates.map((gateKey) => ({
      gateKey,
      satisfiedAt: openGates.has(gateKey) ? now : null,
    }));
    // An existing prerequisite that already finished does not block: a manual
    // task added late to a case must not wait for work that is already done.
    const existingBlockers = await unfinishedAmong(trx, spec.dependsOnTaskIds ?? []);
    const unsatisfied =
      spec.dependsOn.length +
      existingBlockers.length +
      gateEdges.filter((g) => !g.satisfiedAt).length;
    const status = initialStatus(unsatisfied);

    const task = await trx
      .insertInto('platform.task')
      .values({
        id,
        stream_type: input.streamType,
        stream_id: input.streamId,
        workflow_instance_id: input.workflowInstanceId ?? null,
        lane: spec.lane ?? null,
        title: spec.title,
        description: spec.description ?? null,
        assignee_role_id: spec.assigneeRoleId,
        ...dueColumns(spec.due, dueAt),
        status,
        source: input.source,
        source_ref: spec.sourceRef ?? null,
        created_by: input.actorPersonId,
        updated_by: input.actorPersonId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const taskBlockers = [
      ...spec.dependsOn.map((ref) => ({ id: idByRef.get(ref)!, satisfiedAt: null as Date | null })),
      ...(spec.dependsOnTaskIds ?? []).map((taskId) => ({
        id: taskId,
        satisfiedAt: existingBlockers.includes(taskId) ? null : now,
      })),
    ];
    for (const blocker of taskBlockers) {
      await trx
        .insertInto('platform.task_dependency')
        .values({
          id: newUuidV7(),
          task_id: id,
          depends_on_kind: 'task',
          depends_on_task_id: blocker.id,
          satisfied_at: blocker.satisfiedAt,
          created_by: input.actorPersonId,
        })
        .execute();
    }
    for (const gate of gateEdges) {
      await trx
        .insertInto('platform.task_dependency')
        .values({
          id: newUuidV7(),
          task_id: id,
          depends_on_kind: 'gate',
          gate_key: gate.gateKey,
          satisfied_at: gate.satisfiedAt,
          created_by: input.actorPersonId,
        })
        .execute();
    }

    await appendEvent(trx, {
      streamType: TASK_STREAM_TYPE,
      streamId: id,
      eventType: 'platform.task.raised',
      payload: {
        caseStreamType: input.streamType,
        caseStreamId: input.streamId,
        assigneeRoleId: spec.assigneeRoleId,
        lane: spec.lane ?? null,
        dueMode: spec.due.mode,
        dueAt: dueAt?.toISOString() ?? null,
        anchorName: spec.due.mode === 'anchor_relative' ? spec.due.anchorName : null,
        anchorOffsetDays: spec.due.mode === 'anchor_relative' ? spec.due.offsetDays : null,
        source: input.source,
        sourceRef: spec.sourceRef ?? null,
        workflowInstanceId: input.workflowInstanceId ?? null,
        initialStatus: status,
        blockedBy: [
          ...taskBlockers
            .filter((blocker) => blocker.satisfiedAt === null)
            .map((blocker) => ({ kind: 'task' as const, taskId: blocker.id })),
          ...gateEdges
            .filter((g) => !g.satisfiedAt)
            .map((g) => ({ kind: 'gate' as const, gateKey: g.gateKey })),
        ],
      },
      actorPersonId: input.actorPersonId,
      correlationId: input.correlationId,
    });

    await scheduleTaskReminder(trx, {
      task,
      workflowInstanceId: input.workflowInstanceId ?? null,
      config: config.reminder,
      actorPersonId: input.actorPersonId,
      correlationId: input.correlationId,
      now,
    });

    raised.push({ id, ref: spec.ref, status });
  }

  return raised;
}

/** Which of these tasks have not reached a terminal state? */
async function unfinishedAmong(
  trx: Transaction<DB>,
  taskIds: readonly string[],
): Promise<string[]> {
  if (taskIds.length === 0) return [];
  const rows = await trx
    .selectFrom('platform.task')
    .select('id')
    .where('id', 'in', [...taskIds])
    .where('status', 'in', ['blocked', 'open'])
    .where('deleted_at', 'is', null)
    .execute();
  return rows.map((row) => row.id);
}

/**
 * The gate keys already opened for a case, from the journal (§4.1, §12.1).
 *
 * A **keyed lookup of a recorded fact**, not a replayed projection: it reads one
 * stream's events of one type, which the journal's stream index answers
 * directly. ADR-0010 says the journal is never replayed to serve screens; this
 * serves a write path's precondition, and the alternative — a gate-state table —
 * would be a second source of truth for a fact the journal already holds.
 */
export async function openGateKeysFor(
  trx: Transaction<DB>,
  streamType: string,
  streamId: string,
): Promise<Set<string>> {
  const rows = await trx
    .selectFrom('platform.domain_event')
    .select(sql<string>`payload ->> 'gateKey'`.as('gate_key'))
    .where('stream_type', '=', streamType)
    .where('stream_id', '=', streamId)
    .where('event_type', '=', 'platform.task.gate.opened')
    .execute();
  return new Set(rows.map((row) => row.gate_key).filter((key): key is string => key !== null));
}

// --- completeTask ------------------------------------------------------------

export interface CompleteTaskServiceInput {
  taskId: string;
  actorPersonId: string;
  /** HR/Administrator may complete a task assigned to a role they do not hold. */
  allowOverride: boolean;
  onBehalfOf?: string | null;
  note?: string | null;
  correlationId: string;
  now: Date;
}

export interface CompleteTaskResult {
  task: TaskRecord;
  unblockedTaskIds: string[];
  override: boolean;
}

/**
 * Complete a task and everything that follows from it, in one transaction:
 * guard, status, completion metadata, journal, dependent unlocks, and the end of
 * its reminder chase.
 */
export async function completeTask(
  trx: Transaction<DB>,
  input: CompleteTaskServiceInput,
): Promise<CompleteTaskResult> {
  const task = await requireTask(trx, input.taskId);

  // Throws for a blocked, done or cancelled task, with the user-facing reason.
  nextTaskStatus(task.status as TaskStatus, 'complete');

  const inRole = await holdsRole(trx, input.actorPersonId, task.assignee_role_id, input.now);
  if (!inRole && !input.allowOverride) {
    throw new TaskForbiddenError(
      'this task is assigned to a role you do not hold — ask someone in that role, or have HR complete it on their behalf',
    );
  }
  const override = !inRole;

  const updated = await trx
    .updateTable('platform.task')
    .set({
      status: 'done',
      completed_at: input.now,
      completed_by: input.actorPersonId,
      completion_note: input.note ?? null,
      updated_by: input.actorPersonId,
    })
    .where('id', '=', task.id)
    .returningAll()
    .executeTakeFirstOrThrow();

  const { unblockedTaskIds } = await satisfyAndUnlock(trx, {
    blocker: { kind: 'task', taskId: task.id },
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
    now: input.now,
  });

  await cancelTaskReminders(trx, {
    taskId: task.id,
    reason: 'task completed',
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });

  await appendEvent(trx, {
    streamType: TASK_STREAM_TYPE,
    streamId: task.id,
    eventType: 'platform.task.completed',
    payload: {
      caseStreamType: task.stream_type,
      caseStreamId: task.stream_id,
      assigneeRoleId: task.assignee_role_id,
      noteProvided: Boolean(input.note),
      override,
      overdue: task.due_at !== null && task.due_at.getTime() < input.now.getTime(),
      unblockedTaskIds,
    },
    actorPersonId: input.actorPersonId,
    onBehalfOf: input.onBehalfOf ?? null,
    correlationId: input.correlationId,
  });

  return { task: updated, unblockedTaskIds, override };
}

// --- cancelTask --------------------------------------------------------------

export interface CancelTaskServiceInput {
  taskId: string;
  reason: string;
  actorPersonId: string;
  correlationId: string;
  now: Date;
}

/**
 * Cancel a task. Its reverse edges are satisfied like a completion's: a
 * prerequisite that was cancelled will never finish, and leaving its dependents
 * blocked for good would strand the case (§4.1; §12.2 Q3 records that CDF may
 * yet prefer cancellation to propagate instead).
 */
export async function cancelTask(
  trx: Transaction<DB>,
  input: CancelTaskServiceInput,
): Promise<{ task: TaskRecord; unblockedTaskIds: string[] }> {
  const task = await requireTask(trx, input.taskId);
  nextTaskStatus(task.status as TaskStatus, 'cancel');

  const updated = await trx
    .updateTable('platform.task')
    .set({ status: 'cancelled', cancel_reason: input.reason, updated_by: input.actorPersonId })
    .where('id', '=', task.id)
    .returningAll()
    .executeTakeFirstOrThrow();

  const { unblockedTaskIds } = await satisfyAndUnlock(trx, {
    blocker: { kind: 'task', taskId: task.id },
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
    now: input.now,
  });

  await cancelTaskReminders(trx, {
    taskId: task.id,
    reason: 'task cancelled',
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });

  await appendEvent(trx, {
    streamType: TASK_STREAM_TYPE,
    streamId: task.id,
    eventType: 'platform.task.cancelled',
    payload: {
      caseStreamType: task.stream_type,
      caseStreamId: task.stream_id,
      assigneeRoleId: task.assignee_role_id,
      reason: input.reason,
      unblockedTaskIds,
    },
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });

  return { task: updated, unblockedTaskIds };
}

// --- claim / release ---------------------------------------------------------

/**
 * Take a task to work on. A claim is **metadata, not a state**: it never stops
 * another member of the role completing the task, because the unit of assignment
 * is the role and a claim that excluded colleagues would be named-individual
 * assignment through the back door (§4.3, §12.2 Q2 — informational by default).
 */
export async function claimTask(
  trx: Transaction<DB>,
  input: { taskId: string; actorPersonId: string; correlationId: string; now: Date },
): Promise<TaskRecord> {
  const task = await requireTask(trx, input.taskId);
  if (task.status === 'done' || task.status === 'cancelled') {
    throw new TaskForbiddenError('this task is finished — there is nothing to claim');
  }
  if (!(await holdsRole(trx, input.actorPersonId, task.assignee_role_id, input.now))) {
    throw new TaskForbiddenError('this task is assigned to a role you do not hold');
  }

  const updated = await trx
    .updateTable('platform.task')
    .set({
      claimed_by: input.actorPersonId,
      claimed_at: input.now,
      updated_by: input.actorPersonId,
    })
    .where('id', '=', task.id)
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendEvent(trx, {
    streamType: TASK_STREAM_TYPE,
    streamId: task.id,
    eventType: 'platform.task.claimed',
    payload: {
      caseStreamType: task.stream_type,
      caseStreamId: task.stream_id,
      assigneeRoleId: task.assignee_role_id,
    },
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });
  return updated;
}

/** Give up a claim. Anyone in the role may release it — including to unstick a leaver's. */
export async function releaseTask(
  trx: Transaction<DB>,
  input: { taskId: string; actorPersonId: string; correlationId: string; now: Date },
): Promise<TaskRecord> {
  const task = await requireTask(trx, input.taskId);
  if (!(await holdsRole(trx, input.actorPersonId, task.assignee_role_id, input.now))) {
    throw new TaskForbiddenError('this task is assigned to a role you do not hold');
  }

  const updated = await trx
    .updateTable('platform.task')
    .set({ claimed_by: null, claimed_at: null, updated_by: input.actorPersonId })
    .where('id', '=', task.id)
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendEvent(trx, {
    streamType: TASK_STREAM_TYPE,
    streamId: task.id,
    eventType: 'platform.task.released',
    payload: {
      caseStreamType: task.stream_type,
      caseStreamId: task.stream_id,
      assigneeRoleId: task.assignee_role_id,
    },
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });
  return updated;
}

// --- openGate ----------------------------------------------------------------

export interface OpenGateInput {
  streamType: string;
  streamId: string;
  gateKey: string;
  workflowInstanceId?: string | null;
  actorPersonId: string | null;
  correlationId: string;
  now: Date;
}

/**
 * Open a named gate for a case: journal the fact, satisfy every edge waiting on
 * it, and open the tasks that frees (invoked as the effect `tasks.openGate`).
 *
 * **Idempotent, and deliberately still journalled on re-open.** A gate that is
 * already open satisfies no further edges and unblocks nothing, so a redelivered
 * effect is a no-op in every way that matters — but the effect handler's claim
 * ledger stops the second event, and this function stays honest about what it
 * did either way.
 */
export async function openGate(
  trx: Transaction<DB>,
  input: OpenGateInput,
): Promise<{ dependenciesSatisfied: number; unblockedTaskIds: string[] }> {
  const result = await satisfyAndUnlock(trx, {
    blocker: { kind: 'gate', gateKey: input.gateKey },
    stream: { streamType: input.streamType, streamId: input.streamId },
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
    now: input.now,
  });

  // On the case's stream, not the task's — a gate has no task and may open
  // before any gated task exists (§4.2).
  await appendEvent(trx, {
    streamType: input.streamType,
    streamId: input.streamId,
    eventType: 'platform.task.gate.opened',
    payload: {
      gateKey: input.gateKey,
      dependenciesSatisfied: result.dependenciesSatisfied,
      unblockedTaskIds: result.unblockedTaskIds,
      workflowInstanceId: input.workflowInstanceId ?? null,
    },
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });

  return result;
}

// --- recomputeDueDates -------------------------------------------------------

export interface RecomputeDueDatesInput {
  streamType: string;
  streamId: string;
  anchors: AnchorMap;
  actorPersonId: string | null;
  correlationId: string;
  now: Date;
}

/**
 * Re-resolve the due dates of a case's anchor-relative tasks after an anchor
 * moved — a start date pushed back a week (PL-013, invoked as the effect
 * `tasks.recomputeDueDates`).
 *
 * Three restrictions, each of them the point:
 *
 *  - **Only anchor-relative tasks.** An absolute due date was chosen explicitly
 *    and is not the anchor's to move (AC-D1's "untouched" clause).
 *  - **Only non-terminal tasks.** Moving the deadline of something already done
 *    would rewrite history for no benefit.
 *  - **Only anchors actually supplied.** A caller reporting that `start_date`
 *    moved says nothing about `review_date`, and re-resolving on a missing anchor
 *    would throw rather than skip.
 *
 * A recomputation that lands on the same instant journals nothing: it is not a
 * fact that a date did not change.
 */
export async function recomputeDueDates(
  trx: Transaction<DB>,
  input: RecomputeDueDatesInput,
): Promise<{ changed: number }> {
  const anchorNames = Object.keys(input.anchors);
  if (anchorNames.length === 0) return { changed: 0 };

  const config = await loadTaskEngineConfig(trx, input.now);

  const tasks = await trx
    .selectFrom('platform.task')
    .selectAll()
    .where('stream_type', '=', input.streamType)
    .where('stream_id', '=', input.streamId)
    .where('deleted_at', 'is', null)
    .where('due_mode', '=', 'anchor_relative')
    .where('status', 'in', ['blocked', 'open'])
    .where('anchor_name', 'in', anchorNames)
    .forUpdate()
    .execute();

  let changed = 0;
  for (const task of tasks) {
    const next = resolveDueDate(
      {
        mode: 'anchor_relative',
        anchorName: task.anchor_name!,
        offsetDays: task.anchor_offset_days!,
      },
      input.anchors,
      config.due,
    );
    if (next === null || !dueDateChanged(task.due_at, next)) continue;

    await trx
      .updateTable('platform.task')
      .set({ due_at: next, updated_by: input.actorPersonId })
      .where('id', '=', task.id)
      .execute();

    await appendEvent(trx, {
      streamType: TASK_STREAM_TYPE,
      streamId: task.id,
      eventType: 'platform.task.due_recomputed',
      payload: {
        caseStreamType: task.stream_type,
        caseStreamId: task.stream_id,
        anchorName: task.anchor_name!,
        anchorOffsetDays: task.anchor_offset_days!,
        fromDueAt: task.due_at?.toISOString() ?? null,
        toDueAt: next.toISOString(),
      },
      actorPersonId: input.actorPersonId,
      correlationId: input.correlationId,
    });

    // The chase follows the deadline: cancel the pending occurrence and schedule
    // a fresh first one from the new date. Leaving the old row would chase
    // against a deadline that has moved.
    await cancelTaskReminders(trx, {
      taskId: task.id,
      reason: 'due date recomputed',
      actorPersonId: input.actorPersonId,
      correlationId: input.correlationId,
    });
    await scheduleTaskReminder(trx, {
      task: { ...task, due_at: next },
      workflowInstanceId: task.workflow_instance_id,
      config: config.reminder,
      actorPersonId: input.actorPersonId,
      correlationId: input.correlationId,
      now: input.now,
    });

    changed += 1;
  }

  return { changed };
}
