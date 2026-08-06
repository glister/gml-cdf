import { z } from 'zod';
import { recordConsumptionOnce, type DB } from '@repo/db';
import { requireTaskList, taskSourceRef, type RoleKey } from '@repo/domain';
import {
  effectIdempotencyKey,
  registerEffect,
  registerSubjectLoader,
  type EffectEnvelope,
  type EffectHandler,
} from '@repo/workflow';
import type { Transaction } from 'kysely';
import { openGate, raiseTaskList, recomputeDueDates, type TaskListItem } from './tasks.js';

/**
 * The task engine's workflow effects (core plan 08 §9.6, ADR-0013).
 *
 * A transition names `tasks.raiseList`; the runtime commits, the outbox relay
 * fans the effect onto the `effects` queue, and the worker dispatches here. The
 * consequence therefore arrives **after** the fact that caused it, and can never
 * be split from it by a broker outage (plan 07 §5.4).
 *
 * ## Why these live in `@repo/trpc`
 *
 * They wrap the engine services, and those are in `@repo/trpc/lib/tasks.ts`
 * (§12.2 Q1). `@repo/trpc` imports `@repo/workflow`, so the reverse — handlers
 * beside the runtime, as plan 07's own `demo.*` effects are — is not available
 * without a cycle. Registration happens at module load, so both the API (which
 * never dispatches an effect but does execute transitions) and the worker (which
 * does both) see one registry.
 *
 * ## The idempotency contract
 *
 * Delivery is at-least-once and duplicate detection has a finite window, so each
 * handler **claims first, then acts, in one transaction** — the pattern
 * `demo.recordOutcome` set. A redelivered raise inserts nothing; a redelivered
 * gate opening satisfies nothing (`openGate` is already a no-op once the edges
 * are stamped) and, because the claim fails, does not journal a second time.
 */

/** Effect-registry names, exported so a conformance test can assert them. */
export const TASK_EFFECTS = {
  raiseList: 'tasks.raiseList',
  openGate: 'tasks.openGate',
  recomputeDueDates: 'tasks.recomputeDueDates',
} as const;

/**
 * Anchors a definition can declare.
 *
 * `anchors` are literal dates — right for a module whose subject genuinely has
 * one. `anchorDaysFromNow` is relative to the instant the effect runs, which is
 * what a **definition** can honestly say: a date written into a definition is a
 * business fact frozen in code, and it ages out the day after it is written.
 *
 * A module with a real subject (an onboarding case with a start date on its row)
 * does not use either — it calls `raiseTaskList` directly from its own
 * transaction with the anchors it read. This generic effect exists so a workflow
 * shape can raise tasks with no module behind it, which is exactly the pilot's
 * situation.
 */
const anchorParams = {
  anchors: z.record(z.string().min(1).max(100), z.iso.date()).optional(),
  anchorDaysFromNow: z.record(z.string().min(1).max(100), z.number().int()).optional(),
};

const raiseListParams = z.object({ listKey: z.string().min(1), ...anchorParams });
const openGateParams = z.object({ gateKey: z.string().min(1).max(100) });
const recomputeParams = z.object(anchorParams);

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD`, `days` from `now`, in UTC — an anchor is a calendar date. */
function dateFromNow(now: Date, days: number): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function resolveAnchors(
  params: { anchors?: Record<string, string>; anchorDaysFromNow?: Record<string, number> },
  now: Date,
): Record<string, string> {
  const fromNow = Object.fromEntries(
    Object.entries(params.anchorDaysFromNow ?? {}).map(([name, days]) => [
      name,
      dateFromNow(now, days),
    ]),
  );
  // Literals win: a caller that knows the real date has said so.
  return { ...fromNow, ...(params.anchors ?? {}) };
}

/** The workflow instance behind this effect, when a transition caused it. */
function instanceIdOf(envelope: EffectEnvelope): string | null {
  return envelope.source.kind === 'transition' ? envelope.source.instanceId : null;
}

/** Role keys → ids, resolved at raise time (definitions never hold row ids). */
async function roleIdsByKey(
  trx: Transaction<DB>,
  keys: readonly RoleKey[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await trx
    .selectFrom('platform.role')
    .select(['id', 'key'])
    .where('key', 'in', [...new Set(keys)])
    .where('deleted_at', 'is', null)
    .execute();
  const byKey = new Map(rows.map((row) => [row.key, row.id]));
  for (const key of keys) {
    if (!byKey.has(key)) {
      // A permanent failure: no retry conjures a role. The worker dead-letters
      // it and the DLQ alert is the right place for "the seed is incomplete".
      throw new Error(`no platform.role row for key '${key}' — the role list is not seeded`);
    }
  }
  return byKey;
}

/**
 * `tasks.raiseList` — raise a registered task list against the transition's
 * subject (PL-013/014).
 *
 * The list travels as a **key**, not as its contents: effect parameters ride a
 * queue and are ids-only by contract (ADR-0019), and a list is definition data
 * that belongs in code (`@repo/domain/tasks/lists.ts`).
 */
export const raiseTaskListEffect: EffectHandler = async (envelope, { db, logger }) => {
  const params = raiseListParams.parse(envelope.params);
  const list = requireTaskList(params.listKey);
  const now = new Date();

  await db.transaction().execute(async (trx) => {
    const first = await recordConsumptionOnce(
      trx,
      `effect:${TASK_EFFECTS.raiseList}`,
      effectIdempotencyKey(envelope.source),
    );
    if (!first) {
      logger.info('tasks.raiseList: duplicate delivery ignored', { listKey: params.listKey });
      return;
    }

    const roleIds = await roleIdsByKey(
      trx,
      list.tasks.map((task) => task.assigneeRoleKey),
    );

    const tasks: TaskListItem[] = list.tasks.map((task) => ({
      ref: task.ref,
      title: task.title,
      ...(task.description === undefined ? {} : { description: task.description }),
      ...(task.lane === undefined ? {} : { lane: task.lane }),
      assigneeRoleId: roleIds.get(task.assigneeRoleKey)!,
      due: task.due ?? { mode: 'none' },
      dependsOn: [...(task.dependsOn ?? [])],
      gates: [...(task.gates ?? [])],
      sourceRef: taskSourceRef(list, task.ref),
    }));

    const raised = await raiseTaskList(trx, {
      streamType: envelope.subject.streamType,
      streamId: envelope.subject.streamId,
      workflowInstanceId: instanceIdOf(envelope),
      anchors: resolveAnchors(params, now),
      tasks,
      source: 'workflow',
      // No person behind a queued effect: the actor is on the transition that
      // caused it, and the journal event carries the correlation id back to it.
      actorPersonId: null,
      correlationId: envelope.correlationId,
      now,
    });

    logger.info('tasks.raiseList: raised', { listKey: list.key, count: raised.length });
  });
};

/** `tasks.openGate` — open a named gate for the case (ON-033's shape). */
export const openGateEffect: EffectHandler = async (envelope, { db, logger }) => {
  const params = openGateParams.parse(envelope.params);
  const now = new Date();

  await db.transaction().execute(async (trx) => {
    const first = await recordConsumptionOnce(
      trx,
      `effect:${TASK_EFFECTS.openGate}`,
      effectIdempotencyKey(envelope.source),
    );
    if (!first) {
      logger.info('tasks.openGate: duplicate delivery ignored', { gateKey: params.gateKey });
      return;
    }

    const result = await openGate(trx, {
      streamType: envelope.subject.streamType,
      streamId: envelope.subject.streamId,
      gateKey: params.gateKey,
      workflowInstanceId: instanceIdOf(envelope),
      actorPersonId: null,
      correlationId: envelope.correlationId,
      now,
    });

    logger.info('tasks.openGate: opened', {
      gateKey: params.gateKey,
      unblocked: result.unblockedTaskIds.length,
    });
  });
};

/** `tasks.recomputeDueDates` — an anchor moved; re-resolve what hangs off it. */
export const recomputeDueDatesEffect: EffectHandler = async (envelope, { db, logger }) => {
  const params = recomputeParams.parse(envelope.params);
  const now = new Date();

  await db.transaction().execute(async (trx) => {
    const first = await recordConsumptionOnce(
      trx,
      `effect:${TASK_EFFECTS.recomputeDueDates}`,
      effectIdempotencyKey(envelope.source),
    );
    if (!first) {
      logger.info('tasks.recomputeDueDates: duplicate delivery ignored');
      return;
    }

    const { changed } = await recomputeDueDates(trx, {
      streamType: envelope.subject.streamType,
      streamId: envelope.subject.streamId,
      anchors: resolveAnchors(params, now),
      actorPersonId: null,
      correlationId: envelope.correlationId,
      now,
    });

    logger.info('tasks.recomputeDueDates: recomputed', { changed });
  });
};

registerEffect(TASK_EFFECTS.raiseList, raiseTaskListEffect);
registerEffect(TASK_EFFECTS.openGate, openGateEffect);
registerEffect(TASK_EFFECTS.recomputeDueDates, recomputeDueDatesEffect);

/**
 * The pilot shape's subject loader.
 *
 * Its subject is a synthetic case with no table behind it — deliberately, so the
 * slice proves the engine with no HR content — so there is nothing to fetch and
 * no guard to feed. A real workflow's loader reads its subject's row; the
 * contract is the same either way, and a guard never sees a database handle
 * (plan 07 §9.3).
 */
registerSubjectLoader('platform.pilot.checklist', () => Promise.resolve({}));
