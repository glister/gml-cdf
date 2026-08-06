import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, newUuidV7, type DomainEventRecord } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import { pilotChecklistWorkflowV1, PILOT_VERIFICATION_GATE, ROLE_KEYS } from '@repo/domain';
import {
  effectMessagesFor,
  executeTransition,
  requireEffect,
  startWorkflow,
  type EffectHandler,
  type EffectMessage,
} from '@repo/workflow';
// Loading the barrel registers the `tasks.*` effect handlers and the pilot
// subject loader — the same side effect the worker gets from importing it.
import '../index.js';
import { PILOT_CASE_STREAM_TYPE } from '../routers/platform/tasks.js';
import type { RoleKey } from './constants.js';

/**
 * The pilot slice, end to end, with **no HR content** (core plan 08 §9.6, §10).
 *
 * This is the test the plan exists to make possible. The HR module set — the
 * onboarding chain, its lanes and its licence gate — is where these mechanics
 * will earn their keep, and none of it exists yet. So a three-task list with one
 * dependency, one gate and one anchor-relative due date stands in, and proves
 * every acceptance criterion the engine owns:
 *
 *   begin      → three tasks raised: one open, one blocked on it, one gated
 *   complete   → the dependent flips to open, in the same transaction
 *   verify     → the gate opens and frees all and only the gated task
 *   reschedule → the anchor moves and the due dates hanging off it re-resolve
 *
 * The Service Bus is stubbed in process, and only the Service Bus: real
 * Postgres, the real relay mapping, the real effect registry, the real handlers.
 * The properties a broker would add — at-least-once delivery, deterministic
 * MessageIds — are asserted directly here instead of hoped for.
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

/**
 * A silent logger. Cast rather than built with `createLogger`, because
 * `@repo/trpc` deliberately takes its logger as a structural interface and does
 * not depend on `@repo/logging` — a test is not the place to add that edge.
 */
const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Parameters<EffectHandler>[1]['logger'];

let adminId: string;
let correlationId: string;

beforeEach(async () => {
  await truncateAll(db);
  await reseedRoles();
  adminId = await insertPerson('Pilot Administrator');
  await grant(adminId, 'administrator');
  correlationId = newUuidV7();
});

async function reseedRoles(): Promise<void> {
  const existing = await db.selectFrom('platform.role').select('id').executeTakeFirst();
  if (existing) return;
  await db
    .insertInto('platform.role')
    .values(
      ROLE_KEYS.map((key, i) => ({
        id: `019f509e-9e0${i.toString(16)}-7000-8000-00000000000${i.toString(16)}`,
        key,
        name: key,
      })),
    )
    .execute();
}

async function insertPerson(displayName: string): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.person')
    .values({ id, relationship_type: 'employee', display_name: displayName })
    .execute();
  return id;
}

async function grant(personId: string, roleKey: RoleKey): Promise<void> {
  const role = await db
    .selectFrom('platform.role')
    .select('id')
    .where('key', '=', roleKey)
    .executeTakeFirstOrThrow();
  await db
    .insertInto('platform.role_grant')
    .values({
      id: newUuidV7(),
      person_id: personId,
      role_id: role.id,
      module: 'platform',
      valid_from: new Date('2020-01-01T00:00:00.000Z'),
      created_by: personId,
    })
    .execute();
}

/** The relay's half of the outbox: journal rows in, effect messages out. */
async function relayEffects(instanceId: string): Promise<EffectMessage[]> {
  const rows: DomainEventRecord[] = await db
    .selectFrom('platform.domain_event')
    .selectAll()
    .where('stream_type', '=', 'platform.workflow_instance')
    .where('stream_id', '=', instanceId)
    .orderBy('recorded_at')
    .orderBy('id')
    .execute();
  return rows.flatMap(effectMessagesFor);
}

/** Deliver one effect message to its handler, as the worker would. */
async function deliver(message: EffectMessage): Promise<void> {
  await requireEffect(message.envelope.effect)(message.envelope, { db, logger });
}

async function startPilotCase() {
  const streamId = newUuidV7();
  const { instance } = await db.transaction().execute((trx) =>
    startWorkflow(trx, {
      workflowKey: pilotChecklistWorkflowV1.key,
      subject: { streamType: PILOT_CASE_STREAM_TYPE, streamId },
      actorPersonId: adminId,
      now: new Date(),
      correlationId,
    }),
  );
  return { instance, streamId };
}

async function transition(instanceId: string, action: string) {
  const result = await executeTransition(db, {
    instanceId,
    action,
    actorPersonId: adminId,
    now: new Date(),
    correlationId,
  });
  if (!result.ok) throw new Error(`${action} refused: ${result.code} ${result.detail}`);
  return result;
}

/** Fire a transition and deliver every effect it produced. */
async function transitionAndDeliver(instanceId: string, action: string): Promise<EffectMessage[]> {
  const before = (await relayEffects(instanceId)).length;
  await transition(instanceId, action);
  const messages = (await relayEffects(instanceId)).slice(before);
  for (const message of messages) await deliver(message);
  return messages;
}

async function tasksFor(streamId: string) {
  return db
    .selectFrom('platform.task')
    .selectAll()
    .where('stream_type', '=', PILOT_CASE_STREAM_TYPE)
    .where('stream_id', '=', streamId)
    .orderBy('source_ref')
    .execute();
}

describe('the pilot slice, end to end', () => {
  it('raises the list through the effect, with the right initial statuses (ON AC-3)', async () => {
    const { instance, streamId } = await startPilotCase();

    const messages = await transitionAndDeliver(instance.id, 'begin');
    expect(messages.map((m) => m.envelope.effect)).toEqual(['tasks.raiseList']);
    // Ids only on the queue: the list travels as a key, never as its contents.
    expect(JSON.stringify(messages[0]!.envelope.params)).not.toContain('Prepare');

    const tasks = await tasksFor(streamId);
    expect(tasks).toHaveLength(3);

    const byRef = Object.fromEntries(tasks.map((t) => [t.source_ref?.split('#')[1], t]));
    // The ungated IT lane is actionable immediately; the vehicle allocation is
    // blocked on the verification gate; the hand-over waits on its prerequisite.
    expect(byRef.set_up_kit!.status).toBe('open');
    expect(byRef.hand_over!.status).toBe('blocked');
    expect(byRef.assign_van!.status).toBe('blocked');

    // The anchor-relative due date resolved against an anchor the definition
    // declared as "14 days from now" — three days before it.
    expect(byRef.set_up_kit!.due_at).not.toBeNull();
    expect(byRef.set_up_kit!.anchor_offset_days).toBe(-3);
    expect(byRef.hand_over!.due_at).toBeNull();
  });

  it('produces exactly one task list when the effect is delivered twice (AC-D6)', async () => {
    const { instance, streamId } = await startPilotCase();
    const messages = await transitionAndDeliver(instance.id, 'begin');

    // The broker's duplicate detection has a finite window; the handler's claim
    // ledger is the guarantee. Same MessageId, same envelope, second delivery.
    await deliver(messages[0]!);

    expect(await tasksFor(streamId)).toHaveLength(3);
  });

  it('opens the gate on `verify`, freeing all and only the gated task (AC-D3)', async () => {
    const { instance, streamId } = await startPilotCase();
    await transitionAndDeliver(instance.id, 'begin');

    const messages = await transitionAndDeliver(instance.id, 'verify');
    expect(messages.map((m) => m.envelope.effect)).toEqual(['tasks.openGate']);

    const byRef = Object.fromEntries(
      (await tasksFor(streamId)).map((t) => [t.source_ref?.split('#')[1], t]),
    );
    expect(byRef.assign_van!.status).toBe('open');
    // The task-dependency lane is untouched: a gate frees what it was blocking
    // and nothing else.
    expect(byRef.hand_over!.status).toBe('blocked');

    const gateEvent = await db
      .selectFrom('platform.domain_event')
      .selectAll()
      .where('event_type', '=', 'platform.task.gate.opened')
      .where('stream_id', '=', streamId)
      .executeTakeFirstOrThrow();
    expect(gateEvent.payload).toMatchObject({ gateKey: PILOT_VERIFICATION_GATE });
  });

  it('unblocks the dependent when its prerequisite completes (AC-D2)', async () => {
    const { instance, streamId } = await startPilotCase();
    await transitionAndDeliver(instance.id, 'begin');

    const before = await tasksFor(streamId);
    const setUpKit = before.find((t) => t.source_ref?.endsWith('#set_up_kit'))!;

    const { completeTask } = await import('./tasks.js');
    await db.transaction().execute((trx) =>
      completeTask(trx, {
        taskId: setUpKit.id,
        actorPersonId: adminId,
        allowOverride: true,
        correlationId,
        now: new Date(),
      }),
    );

    const after = await tasksFor(streamId);
    expect(after.find((t) => t.source_ref?.endsWith('#hand_over'))!.status).toBe('open');
  });

  it('re-resolves due dates when the case anchor moves (AC-D1)', async () => {
    const { instance, streamId } = await startPilotCase();
    await transitionAndDeliver(instance.id, 'begin');

    const before = (await tasksFor(streamId)).find((t) => t.source_ref?.endsWith('#set_up_kit'))!;
    const messages = await transitionAndDeliver(instance.id, 'reschedule');
    expect(messages.map((m) => m.envelope.effect)).toEqual(['tasks.recomputeDueDates']);

    const after = (await tasksFor(streamId)).find((t) => t.source_ref?.endsWith('#set_up_kit'))!;
    // The definition moved the anchor from +14 days to +21, so the due date
    // moves a week with it.
    expect(after.due_at!.getTime() - before.due_at!.getTime()).toBe(7 * 86_400_000);

    const recomputed = await db
      .selectFrom('platform.domain_event')
      .selectAll()
      .where('event_type', '=', 'platform.task.due_recomputed')
      .where('stream_id', '=', after.id)
      .executeTakeFirstOrThrow();
    expect(recomputed.payload).toMatchObject({
      fromDueAt: before.due_at!.toISOString(),
      toDueAt: after.due_at!.toISOString(),
    });
  });

  it('carries no personal data through the whole trail (ADR-0019)', async () => {
    const { instance, streamId } = await startPilotCase();
    await transitionAndDeliver(instance.id, 'begin');
    await transitionAndDeliver(instance.id, 'verify');

    const taskIds = (await tasksFor(streamId)).map((t) => t.id);
    const trail = JSON.stringify(
      await db
        .selectFrom('platform.domain_event')
        .select(['event_type', 'payload'])
        .where('stream_id', 'in', [...taskIds, streamId, instance.id])
        .execute(),
    );

    for (const forbidden of [
      'Pilot Administrator',
      'Prepare the equipment',
      'Allocate a vehicle',
    ]) {
      expect(trail).not.toContain(forbidden);
    }
  });
});
