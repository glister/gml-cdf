import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { setConfig, workflowDemoApproverRole, workflowDemoExpiryHours } from '@repo/config';
import { db, newUuidV7 } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import {
  defineWorkflow,
  demoRequestV1,
  registerDefinitionForTests,
  unregisterDefinitionForTests,
  type WorkflowDefinition,
} from '@repo/domain';
import { DEMO_SUBJECT_STREAM_TYPE } from './demo.js';
import { executeTransition, startWorkflow, WorkflowAlreadyActiveError } from './runtime.js';
import { eventsFor, grant, insertPerson, reseedRoles } from './test-helpers.js';

/**
 * The transactional runtime against real Postgres (core plan 07 §10 — T-R1…T-R9).
 *
 * Every behaviour asserted here is a SQL property: a row lock serialising two
 * actors, a partial unique index, an append-only trigger, an as-at read inside
 * the transaction that records the decision. A mock-database test would assert
 * none of them (ADR-0004, §10 real-Postgres rule) — which is precisely why the
 * runtime's tests live here and not beside the pure evaluator's.
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

let approver: string;
let outsider: string;
let correlationId: string;

beforeEach(async () => {
  await truncateAll(db);
  await reseedRoles();
  approver = await insertPerson('Demo Approver');
  outsider = await insertPerson('Someone Else');
  await grant(approver, 'administrator');
  await grant(outsider, 'employee');
  correlationId = newUuidV7();
});

/** In hours, from the demo's default 72-hour window. */
const H = 3_600_000;
const NOW = new Date('2026-08-05T12:00:00.000Z');

function subject() {
  return { streamType: DEMO_SUBJECT_STREAM_TYPE, streamId: newUuidV7() };
}

async function start(at = NOW, subj = subject()) {
  return db.transaction().execute((trx) =>
    startWorkflow(trx, {
      workflowKey: demoRequestV1.key,
      subject: subj,
      actorPersonId: approver,
      now: at,
      correlationId,
    }),
  );
}

describe('T-R1 — startWorkflow pins the version and journals in the same transaction', () => {
  it('creates the instance in the initial state, pinned to the latest version', async () => {
    const { instance } = await start();
    expect(instance.workflow_key).toBe('platform.demo.request');
    expect(instance.definition_version).toBe(1);
    expect(instance.current_state).toBe('pending');
    expect(instance.completed_at).toBeNull();
  });

  it('emits platform.workflow_instance.started on the instance stream', async () => {
    const { instance } = await start();
    const events = await eventsFor('platform.workflow_instance', instance.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe('platform.workflow_instance.started');
    expect(events[0]?.payload).toMatchObject({
      workflowKey: 'platform.demo.request',
      definitionVersion: 1,
      initialState: 'pending',
      subjectStreamType: DEMO_SUBJECT_STREAM_TYPE,
    });
  });

  it("creates the definition's initialSchedule timers at the configured lead time", async () => {
    const { instance } = await start();
    const timers = await db
      .selectFrom('platform.scheduled_action')
      .selectAll()
      .where('workflow_instance_id', '=', instance.id)
      .execute();

    expect(timers).toHaveLength(1);
    expect(timers[0]?.action_type).toBe('workflow.transition');
    expect(timers[0]?.status).toBe('pending');
    // 72 hours — the registered default, resolved as-at `now`.
    expect(timers[0]?.due_at.toISOString()).toBe(new Date(NOW.getTime() + 72 * H).toISOString());
    // The runtime stamps the state being entered, which is what makes a
    // superseded firing a harmless no-op later.
    expect(timers[0]?.payload).toMatchObject({ action: 'expire', expectedState: 'pending' });
  });

  it('rolls the instance, its event and its timers back together on failure', async () => {
    // T-R1's atomicity half: force the transaction to fail after startWorkflow
    // has written everything, and assert nothing survives.
    const subj = subject();
    await expect(
      db.transaction().execute(async (trx) => {
        await startWorkflow(trx, {
          workflowKey: demoRequestV1.key,
          subject: subj,
          actorPersonId: approver,
          now: NOW,
          correlationId,
        });
        throw new Error('induced failure');
      }),
    ).rejects.toThrow('induced failure');

    expect(await db.selectFrom('platform.workflow_instance').selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom('platform.scheduled_action').selectAll().execute()).toHaveLength(0);
    expect(
      await db
        .selectFrom('platform.domain_event')
        .selectAll()
        .where('correlation_id', '=', correlationId)
        .execute(),
    ).toHaveLength(0);
  });
});

describe('T-R2 — a transition writes state, transition row and event atomically', () => {
  it('writes all three, and the transition row carries the decision evidence', async () => {
    const { instance } = await start();
    const result = await executeTransition(db, {
      instanceId: instance.id,
      action: 'approve',
      actorPersonId: approver,
      comment: 'looks fine',
      now: NOW,
      correlationId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance.current_state).toBe('approved');
    expect(result.instance.completed_at).not.toBeNull();

    expect(result.transition.from_state).toBe('pending');
    expect(result.transition.to_state).toBe('approved');
    expect(result.transition.action).toBe('approve');
    expect(result.transition.comment).toBe('looks fine');
    // Both of `approve`'s guards recorded a verdict — a soft guard that did not
    // fire still says so, which is what makes the row evidence rather than a
    // list of complaints.
    expect(result.transition.guard_results).toEqual([
      { guard: 'demo.notExpired', outcome: 'pass' },
      { guard: 'demo.outOfHoursWarning', outcome: 'pass' },
    ]);
    // The snapshot that makes the decision reproducible after the configuration
    // moves on (ADR-0016).
    expect(result.transition.resolved_config).toEqual({
      'platform.workflow.demo.approver_role': 'administrator',
      'platform.workflow.demo.expiry_hours': 72,
    });
    expect(result.transition.effects).toEqual([
      { name: 'demo.recordOutcome', params: { outcome: 'approved' } },
    ]);

    const events = await eventsFor('platform.workflow_instance', instance.id);
    expect(events.map((e) => e.event_type)).toEqual([
      'platform.workflow_instance.started',
      'platform.workflow_instance.transitioned',
    ]);
    expect(events[1]?.payload).toMatchObject({
      transitionId: result.transition.id,
      from: 'pending',
      to: 'approved',
      action: 'approve',
      completed: true,
      effects: [{ name: 'demo.recordOutcome', params: { outcome: 'approved' } }],
    });
  });

  it('a soft guard warning reaches the caller and the transition row', async () => {
    const { instance } = await start();
    // 20:00 UTC — outside working hours, still inside the 72-hour window.
    const outOfHours = new Date('2026-08-05T20:00:00.000Z');
    const result = await executeTransition(db, {
      instanceId: instance.id,
      action: 'approve',
      actorPersonId: approver,
      now: outOfHours,
      correlationId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([
      { guard: 'demo.outOfHoursWarning', detail: expect.stringContaining('outside working hours') },
    ]);
    expect(result.transition.guard_results).toContainEqual(
      expect.objectContaining({ guard: 'demo.outOfHoursWarning', outcome: 'warn' }),
    );
  });
});

describe('T-R3 — a blocked guard writes nothing at all', () => {
  it('leaves state, transition log and journal untouched', async () => {
    const { instance } = await start();
    // The expiry window runs from the instance's own `created_at` (the demo's
    // subject loader), which the database stamps — so the "past the deadline"
    // instant is anchored on that row, not on the test's fixed clock.
    const expired = new Date(instance.created_at.getTime() + 73 * H);

    const result = await executeTransition(db, {
      instanceId: instance.id,
      action: 'approve',
      actorPersonId: approver,
      now: expired,
      correlationId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('GUARD_BLOCKED');
    expect(result.detail).toMatch(/expired at/);

    const after = await db
      .selectFrom('platform.workflow_instance')
      .selectAll()
      .where('id', '=', instance.id)
      .executeTakeFirstOrThrow();
    expect(after.current_state).toBe('pending');
    expect(await db.selectFrom('platform.workflow_transition').selectAll().execute()).toHaveLength(
      0,
    );
    expect(await eventsFor('platform.workflow_instance', instance.id)).toHaveLength(1);
  });

  it('an actor outside the by policy is refused, and writes nothing', async () => {
    const { instance } = await start();
    const result = await executeTransition(db, {
      instanceId: instance.id,
      action: 'approve',
      actorPersonId: outsider,
      now: NOW,
      correlationId,
    });

    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await db.selectFrom('platform.workflow_transition').selectAll().execute()).toHaveLength(
      0,
    );
  });

  it('a person may not take a system-only transition', async () => {
    const { instance } = await start();
    const result = await executeTransition(db, {
      instanceId: instance.id,
      action: 'expire',
      actorPersonId: approver,
      now: NOW,
      correlationId,
    });
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });
});

describe('T-R4 — the by policy is configuration, resolved as-at the transition', () => {
  it('changing the approver role changes who may act, with no release', async () => {
    const { instance } = await start();

    // Hand approval to HR User. The administrator loses it in the same move.
    await db.transaction().execute((trx) =>
      setConfig(trx, {
        def: workflowDemoApproverRole,
        value: 'hr_user',
        actorPersonId: approver,
        correlationId,
      }),
    );

    const now = new Date();
    const refused = await executeTransition(db, {
      instanceId: instance.id,
      action: 'approve',
      actorPersonId: approver,
      now,
      correlationId,
    });
    expect(refused).toMatchObject({ ok: false, code: 'FORBIDDEN' });

    const hrPerson = await insertPerson('HR User');
    await grant(hrPerson, 'hr_user');
    const allowed = await executeTransition(db, {
      instanceId: instance.id,
      action: 'approve',
      actorPersonId: hrPerson,
      now,
      correlationId,
    });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.transition.resolved_config).toMatchObject({
      'platform.workflow.demo.approver_role': 'hr_user',
    });
  });

  it('an earlier transition keeps the value that was in force when it happened', async () => {
    // Two instances, a config change between their transitions: the first
    // transition's snapshot must still read the old value afterwards. This is
    // the whole point of `resolved_config` (ADR-0016).
    const first = await start();
    const firstResult = await executeTransition(db, {
      instanceId: first.instance.id,
      action: 'approve',
      actorPersonId: approver,
      now: new Date(),
      correlationId,
    });
    expect(firstResult.ok).toBe(true);

    await db.transaction().execute((trx) =>
      setConfig(trx, {
        def: workflowDemoExpiryHours,
        value: 12,
        actorPersonId: approver,
        correlationId,
      }),
    );

    const second = await start(new Date());
    const secondResult = await executeTransition(db, {
      instanceId: second.instance.id,
      action: 'reject',
      actorPersonId: approver,
      now: new Date(),
      correlationId,
    });

    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok || !firstResult.ok) return;
    expect(secondResult.transition.resolved_config).toMatchObject({
      'platform.workflow.demo.expiry_hours': 12,
    });
    // Re-read the earlier row from the database, not from the in-memory result.
    const earlier = await db
      .selectFrom('platform.workflow_transition')
      .select('resolved_config')
      .where('id', '=', firstResult.transition.id)
      .executeTakeFirstOrThrow();
    expect(earlier.resolved_config).toMatchObject({
      'platform.workflow.demo.expiry_hours': 72,
    });
  });
});

describe('T-R5 — concurrency: exactly one of two racing transitions wins', () => {
  it('the loser gets CONFLICT and exactly one transition row exists', async () => {
    const { instance } = await start();
    const now = new Date();

    const [a, b] = await Promise.all([
      executeTransition(db, {
        instanceId: instance.id,
        action: 'approve',
        actorPersonId: approver,
        now,
        correlationId,
      }),
      executeTransition(db, {
        instanceId: instance.id,
        action: 'reject',
        actorPersonId: approver,
        now,
        correlationId,
      }),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ ok: false, code: 'CONFLICT' });

    const rows = await db
      .selectFrom('platform.workflow_transition')
      .selectAll()
      .where('instance_id', '=', instance.id)
      .execute();
    expect(rows).toHaveLength(1);
  });
});

describe('T-R6 — a running instance stays on the version it started on', () => {
  const V2_KEY = demoRequestV1.key;

  afterAll(() => unregisterDefinitionForTests(V2_KEY, 2));

  it('registering v2 changes nothing for a v1 instance', async () => {
    const { instance } = await start();
    expect(instance.definition_version).toBe(1);

    // v2 renames the action and drops the guard entirely.
    const v2: WorkflowDefinition = defineWorkflow({
      key: V2_KEY,
      version: 2,
      module: 'platform',
      states: ['pending', 'approved', 'rejected'],
      initial: 'pending',
      terminal: ['approved', 'rejected'],
      transitions: [
        { from: 'pending', to: 'approved', action: 'sign_off', by: { role: 'administrator' } },
        { from: 'pending', to: 'rejected', action: 'decline', by: { role: 'administrator' } },
      ],
    });
    registerDefinitionForTests(v2);

    // The v1 instance still speaks v1's vocabulary…
    const v2Action = await executeTransition(db, {
      instanceId: instance.id,
      action: 'sign_off',
      actorPersonId: approver,
      now: NOW,
      correlationId,
    });
    expect(v2Action).toMatchObject({ ok: false, code: 'UNKNOWN_ACTION' });

    // …and v1's `approve` still works, guards and all.
    const v1Action = await executeTransition(db, {
      instanceId: instance.id,
      action: 'approve',
      actorPersonId: approver,
      now: NOW,
      correlationId,
    });
    expect(v1Action.ok).toBe(true);

    // A new instance pins to v2.
    const fresh = await start(NOW);
    expect(fresh.instance.definition_version).toBe(2);
  });
});

describe('T-R7 — the transition log is immutable at the database level', () => {
  it('rejects UPDATE and DELETE on workflow_transition', async () => {
    const { instance } = await start();
    const result = await executeTransition(db, {
      instanceId: instance.id,
      action: 'approve',
      actorPersonId: approver,
      now: NOW,
      correlationId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await expect(
      sql`UPDATE platform.workflow_transition SET comment = 'rewritten' WHERE id = ${result.transition.id}`.execute(
        db,
      ),
    ).rejects.toThrow(/append-only/i);

    await expect(
      sql`DELETE FROM platform.workflow_transition WHERE id = ${result.transition.id}`.execute(db),
    ).rejects.toThrow(/append-only/i);
  });
});

describe('T-R8 — a terminal state completes the case and cancels its timers', () => {
  it('stamps completed_at and cancels every pending timer, with an event each', async () => {
    const { instance } = await start();
    const timerBefore = await db
      .selectFrom('platform.scheduled_action')
      .selectAll()
      .where('workflow_instance_id', '=', instance.id)
      .executeTakeFirstOrThrow();
    expect(timerBefore.status).toBe('pending');

    await executeTransition(db, {
      instanceId: instance.id,
      action: 'approve',
      actorPersonId: approver,
      now: NOW,
      correlationId,
    });

    const timerAfter = await db
      .selectFrom('platform.scheduled_action')
      .selectAll()
      .where('id', '=', timerBefore.id)
      .executeTakeFirstOrThrow();
    expect(timerAfter.status).toBe('cancelled');
    expect(timerAfter.cancel_reason).toMatch(/workflow completed/);

    const timerEvents = await eventsFor('platform.scheduled_action', timerBefore.id);
    expect(timerEvents.map((e) => e.event_type)).toEqual([
      'platform.scheduled_action.scheduled',
      'platform.scheduled_action.cancelled',
    ]);
  });
});

describe('T-R9 — one active instance per subject, but repeatable after completion', () => {
  it('refuses a second active instance and allows one once the first completes', async () => {
    const subj = subject();
    const { instance } = await start(NOW, subj);

    await expect(start(NOW, subj)).rejects.toThrow(WorkflowAlreadyActiveError);

    await executeTransition(db, {
      instanceId: instance.id,
      action: 'reject',
      actorPersonId: approver,
      now: NOW,
      correlationId,
    });

    const second = await start(NOW, subj);
    expect(second.instance.id).not.toBe(instance.id);
    expect(second.instance.current_state).toBe('pending');
  });
});

describe('expectedState — the optimistic check timers rely on', () => {
  it('rejects a transition whose expected state is stale', async () => {
    const { instance } = await start();
    await executeTransition(db, {
      instanceId: instance.id,
      action: 'approve',
      actorPersonId: approver,
      now: NOW,
      correlationId,
    });

    const stale = await executeTransition(db, {
      instanceId: instance.id,
      action: 'expire',
      actorPersonId: null,
      expectedState: 'pending',
      now: NOW,
      correlationId,
    });
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT' });
  });

  it('a missing instance is NOT_FOUND, not a crash', async () => {
    const result = await executeTransition(db, {
      instanceId: newUuidV7(),
      action: 'approve',
      actorPersonId: approver,
      now: NOW,
      correlationId,
    });
    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
});
