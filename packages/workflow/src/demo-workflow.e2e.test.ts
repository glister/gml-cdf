import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@repo/logging';
import { db, newUuidV7, type DomainEventRecord } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import { demoRequestV1 } from '@repo/domain';
import { DEMO_SUBJECT_STREAM_TYPE } from './demo.js';
import { effectMessagesFor, type EffectMessage } from './effects/fanout.js';
import { requireEffect } from './effects/registry.js';
// Loading the barrel is what registers the built-in `workflow.transition`
// handler and the demo's loader and effect — the same side effect every real
// consumer gets from importing `@repo/workflow`.
import './index.js';
import { executeTransition, startWorkflow } from './runtime.js';
import { drainDueActions, type DueAction } from './scheduler.js';
import { eventsFor, grant, insertPerson, reseedRoles } from './test-helpers.js';

/**
 * The pilot slice, end to end, with no HR module in existence (core plan 07 §10,
 * AC-D2/D3/D6/D7).
 *
 * This is the test the whole plan exists to make possible: plans 08, 09 and 10
 * are built on this runtime *before* any of them can demonstrate it, so the demo
 * shape has to. It exercises every feature at once — a config-resolved `by`
 * policy, a hard guard, a soft warning, effects fanned through the outbox, a
 * timer that fires a transition, and the cancellation of that timer when a human
 * gets there first.
 *
 * The Service Bus is stubbed **in process**, and only the Service Bus: real
 * Postgres, the real relay mapping, the real effect registry, the real handlers.
 * What a broker would add here is latency and ordering noise, not a different
 * answer — and the properties that matter (at-least-once, deterministic
 * MessageIds, idempotent handlers) are asserted directly rather than hoped for.
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

const logger = createLogger({ service: 'workflow-e2e', level: 'silent' });

let approver: string;
let correlationId: string;

beforeEach(async () => {
  await truncateAll(db);
  await reseedRoles();
  approver = await insertPerson('Demo Approver');
  await grant(approver, 'administrator');
  correlationId = newUuidV7();
});

/** Wednesday 20:00 UTC — inside the 72-hour window, outside working hours. */
const OUT_OF_HOURS = new Date('2026-08-05T20:00:00.000Z');

async function startDemo(now = new Date()) {
  return db.transaction().execute((trx) =>
    startWorkflow(trx, {
      workflowKey: demoRequestV1.key,
      subject: { streamType: DEMO_SUBJECT_STREAM_TYPE, streamId: newUuidV7() },
      actorPersonId: approver,
      now,
      correlationId,
    }),
  );
}

/**
 * The in-process bus. It does exactly what the relay does — read journal rows,
 * turn any `effects` payload into messages — and returns them rather than
 * sending them, so a test can deliver each one as many times as it likes.
 *
 * Scoped to one instance's stream rather than to `published_at IS NULL`: the
 * journal is append-only, so `truncateAll` deliberately skips it and rows
 * accumulate across the suite. Per-test scratch scoping is the discipline
 * `@repo/db/test-support` documents.
 */
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

/** Deliver one effect message to its registered handler, as the worker would. */
async function deliver(message: EffectMessage): Promise<void> {
  await requireEffect(message.envelope.effect)(message.envelope, { db, logger });
}

/** Deliver a timer's effect, as the scheduler → worker path would. */
async function deliverTimer(action: DueAction): Promise<void> {
  await requireEffect(action.envelope.effect)(action.envelope, { db, logger });
}

async function demoOutcomes(instanceId: string) {
  const events = await eventsFor('platform.workflow_instance', instanceId);
  return events.filter((e) => e.event_type === 'platform.workflow_instance.demo_outcome_recorded');
}

describe('scenario 1 — a human approves before the deadline', () => {
  it('runs the whole loop, and a re-delivered effect produces exactly one fact', async () => {
    const { instance } = await startDemo();

    // The definition's initialSchedule created the expiry timer.
    const timerBefore = await db
      .selectFrom('platform.scheduled_action')
      .selectAll()
      .where('workflow_instance_id', '=', instance.id)
      .executeTakeFirstOrThrow();
    expect(timerBefore.status).toBe('pending');
    expect(timerBefore.action_type).toBe('workflow.transition');

    // Approve as the config-resolved role, out of hours so the soft guard fires.
    const result = await executeTransition(db, {
      instanceId: instance.id,
      action: 'approve',
      actorPersonId: approver,
      now: OUT_OF_HOURS,
      correlationId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // AC-D3: the warning reached the caller and was recorded, and nothing blocked.
    expect(result.warnings.map((w) => w.guard)).toEqual(['demo.outOfHoursWarning']);
    expect(result.instance.current_state).toBe('approved');

    // AC-D7: a human got there first, so the pending timer is already cancelled —
    // in the same transaction as the completion, so there is no window in which a
    // finished case has a live timer pointing at it.
    const timerAfter = await db
      .selectFrom('platform.scheduled_action')
      .selectAll()
      .where('id', '=', timerBefore.id)
      .executeTakeFirstOrThrow();
    expect(timerAfter.status).toBe('cancelled');

    // The relay turns the committed transition into effect messages.
    const messages = await relayEffects(instance.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe(`t:${result.transition.id}:demo.recordOutcome`);
    expect(messages[0]?.envelope).toMatchObject({
      effect: 'demo.recordOutcome',
      params: { outcome: 'approved' },
      source: { kind: 'transition', transitionId: result.transition.id },
      subject: { streamType: DEMO_SUBJECT_STREAM_TYPE },
      correlationId,
    });

    // AC-D6 / T-W3: delivered three times, one business fact.
    await deliver(messages[0]!);
    await deliver(messages[0]!);
    await deliver(messages[0]!);

    const outcomes = await demoOutcomes(instance.id);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.payload).toEqual({ outcome: 'approved' });
  });

  it('carries no profile data anywhere in the trail (ADR-0019)', async () => {
    const { instance } = await startDemo();
    const result = await executeTransition(db, {
      instanceId: instance.id,
      action: 'approve',
      actorPersonId: approver,
      now: OUT_OF_HOURS,
      correlationId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const message of await relayEffects(instance.id)) await deliver(message);

    // Everything the transition and its cascade wrote, as text.
    const events = await db
      .selectFrom('platform.domain_event')
      .select(['payload'])
      .where('correlation_id', '=', correlationId)
      .execute();
    const written = JSON.stringify([
      events.map((e) => e.payload),
      result.transition.resolved_config,
      result.transition.guard_results,
      result.transition.effects,
    ]);

    // The approver's name is on their person row and nowhere else. Ids, keys,
    // state names and primitive decision values only.
    expect(written).not.toContain('Demo Approver');
  });
});

describe('scenario 2 — nobody acts, so the timer fires', () => {
  it('drains the due timer and expires the case', async () => {
    // Started long enough ago that its 72-hour timer is already due.
    const { instance } = await startDemo(new Date(Date.now() - 100 * 3_600_000));

    const drained: DueAction[] = [];
    const count = await drainDueActions(db, 10, async (actions) => {
      drained.push(...actions);
    });
    expect(count).toBe(1);
    expect(drained[0]?.envelope.params).toMatchObject({
      action: 'expire',
      expectedState: 'pending',
    });

    await deliverTimer(drained[0]!);

    const after = await db
      .selectFrom('platform.workflow_instance')
      .selectAll()
      .where('id', '=', instance.id)
      .executeTakeFirstOrThrow();
    expect(after.current_state).toBe('rejected');
    expect(after.completed_at).not.toBeNull();

    // The timer is marked executed, and the expiry transition is journalled with
    // no actor — the system took it.
    const timer = await db
      .selectFrom('platform.scheduled_action')
      .selectAll()
      .where('workflow_instance_id', '=', instance.id)
      .executeTakeFirstOrThrow();
    expect(timer.status).toBe('executed');

    const transitions = await db
      .selectFrom('platform.workflow_transition')
      .selectAll()
      .where('instance_id', '=', instance.id)
      .execute();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.action).toBe('expire');
    expect(transitions[0]?.actor_person_id).toBeNull();

    // And its effect flows the same way a human decision's would.
    const messages = await relayEffects(instance.id);
    const outcomeMessage = messages.find((m) => m.envelope.effect === 'demo.recordOutcome');
    expect(outcomeMessage?.envelope.params).toEqual({ outcome: 'expired' });
    await deliver(outcomeMessage!);
    await deliver(outcomeMessage!);
    expect(await demoOutcomes(instance.id)).toHaveLength(1);
  });
});

describe('scenario 3 — the timer fires after a human already decided', () => {
  it('is a recorded no-op: no second transition, no state change, no error', async () => {
    const { instance } = await startDemo(new Date(Date.now() - 100 * 3_600_000));

    // Claim the timer first, so the message is genuinely in flight…
    const drained: DueAction[] = [];
    await drainDueActions(db, 10, async (actions) => {
      drained.push(...actions);
    });
    expect(drained).toHaveLength(1);

    // …then a human approves before the worker gets to it. `demo.notExpired`
    // would block an approval this late, so use `reject`, which the definition
    // guards the same way — the point here is the race, not the guard.
    await db
      .updateTable('platform.workflow_instance')
      .set({ created_at: new Date() })
      .where('id', '=', instance.id)
      .execute();
    const approved = await executeTransition(db, {
      instanceId: instance.id,
      action: 'approve',
      actorPersonId: approver,
      now: OUT_OF_HOURS,
      correlationId,
    });
    expect(approved.ok).toBe(true);

    // Now the timer's message arrives. `expectedState: 'pending'` no longer
    // matches, so it does nothing at all — and does not throw.
    await expect(deliverTimer(drained[0]!)).resolves.toBeUndefined();

    const after = await db
      .selectFrom('platform.workflow_instance')
      .selectAll()
      .where('id', '=', instance.id)
      .executeTakeFirstOrThrow();
    expect(after.current_state).toBe('approved');

    const transitions = await db
      .selectFrom('platform.workflow_transition')
      .selectAll()
      .where('instance_id', '=', instance.id)
      .execute();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.action).toBe('approve');

    // Redelivering the stale timer is equally harmless.
    await deliverTimer(drained[0]!);
    expect(
      await db
        .selectFrom('platform.workflow_transition')
        .selectAll()
        .where('instance_id', '=', instance.id)
        .execute(),
    ).toHaveLength(1);
  });
});
