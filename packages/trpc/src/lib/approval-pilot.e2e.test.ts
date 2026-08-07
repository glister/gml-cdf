import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, newUuidV7, type DomainEventRecord } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import { setConfig, requireApprovalSubject } from '@repo/config';
import { PILOT_SIGNOFF_KEY, PILOT_SIGNOFF_SUBJECT } from '@repo/domain';
import {
  effectMessagesFor,
  executeTransition,
  requireEffect,
  startWorkflow,
  type EffectHandler,
  type EffectMessage,
} from '@repo/workflow';
// Loading the barrel is what registers the `approval.*` effect handlers and the
// pilot's warning provider and subject loader — the same module-load side effect
// every real consumer gets from `import '@repo/trpc'`, and the reason the worker's
// handler barrel imports this package rather than the handler files.
import '../index.js';
import { appRouter } from '../router.js';
import type { ContextGrant, TRPCContext } from '../trpc.js';
import { ROLE_KEYS, type RoleKey } from './constants.js';
import { PILOT_LARGE_AMOUNT_CODE, PILOT_WARNING_PROVIDER } from './approval-pilot.js';

/**
 * The approval engine's pilot slice, end to end, with no HR module in existence
 * (core plan 09 §9.8, §11 AC-D1…D7).
 *
 * This is the demonstration the plan asks for, run as a test rather than as a
 * script: submit below the threshold and nothing is asked of anyone; submit
 * above it and a request opens; two administrators race and one wins; a
 * reasonless rejection is impossible; a delegate decides; and editing the
 * threshold in configuration changes the routing with no release.
 *
 * The **workflow-bound** entry point is the part only this file can prove
 * (AC-D7): a transition opens the request through the `approval.open` effect,
 * and the decisive decision fires the transition back the other way inside the
 * decision's own transaction.
 *
 * The Service Bus is stubbed in process, and only the Service Bus — real
 * Postgres, the real relay mapping, the real effect registry, the real handlers.
 * Plan 07's own e2e suite takes the same approach for the same reason.
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

/**
 * A silent logger for the effect handlers.
 *
 * `EffectHandlerContext.logger` is typed as winston's `Logger`, but the handlers
 * use four methods of it. `@repo/trpc` deliberately does not depend on
 * `@repo/logging` — every service reaches it structurally, through the tRPC
 * context — and taking a dependency here purely to satisfy a test would weaken
 * that for no gain, so the stub is cast rather than the package widened.
 */
const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Parameters<EffectHandler>[1]['logger'];

let adminA: string;
let adminB: string;
let deputy: string;
let correlationId: string;

beforeEach(async () => {
  await truncateAll(db);
  await reseedRoles();
  adminA = await insertPerson('Pilot Admin A');
  adminB = await insertPerson('Pilot Admin B');
  deputy = await insertPerson('Pilot Deputy');
  await grant(adminA, 'administrator');
  await grant(adminB, 'administrator');
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

async function loadGrants(personId: string): Promise<ContextGrant[]> {
  const rows = await db
    .selectFrom('platform.role_grant as g')
    .innerJoin('platform.role as r', 'r.id', 'g.role_id')
    .select(['r.key as roleKey', 'g.module', 'g.valid_from', 'g.valid_until', 'g.revoked_at'])
    .where('g.person_id', '=', personId)
    .where('g.revoked_at', 'is', null)
    .execute();
  return rows.map((r) => ({
    roleKey: r.roleKey as RoleKey,
    module: r.module,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    revokedAt: r.revoked_at,
  }));
}

async function callerFor(personId: string) {
  const ctx: TRPCContext = {
    db,
    user: { id: 'u', name: 'Pilot', email: 'pilot@cdf.test', role: 'admin' },
    session: { id: 's', userId: 'u' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    email: { sendOtp: async () => {}, sendInvitation: async () => {} },
    sms: { send: async () => {} },
    rateLimit: { check: () => true },
    correlationId,
    actorPersonId: personId,
    grants: await loadGrants(personId),
  };
  return appRouter.createCaller(ctx);
}

/**
 * The in-process bus: exactly what the relay does — read journal rows, turn any
 * `effects` payload into messages — but returning them so a test can deliver
 * each one as many times as it likes.
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

async function startPilot() {
  const streamId = newUuidV7();
  const { instance } = await db.transaction().execute((trx) =>
    startWorkflow(trx, {
      workflowKey: PILOT_SIGNOFF_KEY,
      subject: { streamType: PILOT_SIGNOFF_SUBJECT, streamId },
      actorPersonId: adminA,
      now: new Date(),
      correlationId,
    }),
  );
  return { instance, streamId };
}

/** Take `submit`, then drain the effect it fanned — the request opens here. */
async function submitPilot() {
  const { instance, streamId } = await startPilot();
  const result = await executeTransition(db, {
    instanceId: instance.id,
    action: 'submit',
    actorPersonId: adminA,
    now: new Date(),
    correlationId,
  });
  expect(result.ok).toBe(true);

  for (const message of await relayEffects(instance.id)) await deliver(message);

  const request = await db
    .selectFrom('platform.approval_request')
    .selectAll()
    .where('subject_type', '=', PILOT_SIGNOFF_SUBJECT)
    .where('subject_id', '=', streamId)
    .executeTakeFirst();

  return { instance, streamId, request };
}

async function instanceState(instanceId: string): Promise<string> {
  const row = await db
    .selectFrom('platform.workflow_instance')
    .select('current_state')
    .where('id', '=', instanceId)
    .executeTakeFirstOrThrow();
  return row.current_state;
}

// --- AC-D7 — the two entry points --------------------------------------------

describe('AC-D7 — a workflow-bound approval, and a standalone one', () => {
  it('opens a request from the transition, and the decision fires the transition back', async () => {
    const { instance, request } = await submitPilot();

    expect(instance.current_state).toBe('draft');
    expect(await instanceState(instance.id)).toBe('awaiting_approval');
    expect(request).toBeDefined();
    expect(request!.workflow_instance_id).toBe(instance.id);
    expect(request!.workflow_action).toBe('approve');

    // The decisive approval — and the case moves with it, atomically.
    const caller = await callerFor(adminA);
    const decided = await caller.platform.approvals.decide({
      requestId: request!.id,
      decision: 'approved',
    });

    expect(decided.status).toBe('approved');
    expect(decided.workflowAction).toBe('approve');
    expect(await instanceState(instance.id)).toBe('approved');
  });

  /**
   * The transition and the decision are one transaction, so they share a
   * correlation id — which is how an auditor gets from "the case moved" back to
   * "this person decided it", given the transition itself is `by: system`.
   */
  it('ties the transition to the human decision by correlation id', async () => {
    const { instance, request } = await submitPilot();
    await (
      await callerFor(adminA)
    ).platform.approvals.decide({
      requestId: request!.id,
      decision: 'approved',
    });

    const transitioned = await db
      .selectFrom('platform.domain_event')
      .select(['correlation_id', 'actor_person_id'])
      .where('stream_type', '=', 'platform.workflow_instance')
      .where('stream_id', '=', instance.id)
      .where('event_type', '=', 'platform.workflow_instance.transitioned')
      .orderBy('recorded_at', 'desc')
      .executeTakeFirstOrThrow();

    const approved = await db
      .selectFrom('platform.domain_event')
      .select(['correlation_id', 'actor_person_id'])
      .where('stream_type', '=', 'platform.approval_request')
      .where('stream_id', '=', request!.id)
      .where('event_type', '=', 'platform.approval_request.approved')
      .executeTakeFirstOrThrow();

    expect(transitioned.correlation_id).toBe(approved.correlation_id);
    expect(approved.actor_person_id).toBe(adminA);
    // The transition is system-taken; the person is on the approval's event.
    expect(transitioned.actor_person_id).toBeNull();
  });

  it('rolls the case back to awaiting_approval on rejection', async () => {
    const { instance, request } = await submitPilot();
    await (
      await callerFor(adminA)
    ).platform.approvals.decide({
      requestId: request!.id,
      decision: 'rejected',
      reason: 'not this time',
    });
    // `reject` is not the stored `workflow_action`, so the case does not
    // auto-advance — the definition's own reject path is the consumer's to take.
    expect(await instanceState(instance.id)).toBe('awaiting_approval');
  });

  /** The standalone entry point: a sign-off with no workflow instance at all. */
  it('completes a standalone sign-off with no workflow instance', async () => {
    const caller = await callerFor(adminA);
    const submitted = await caller.platform.approvals.submit({
      subjectType: PILOT_SIGNOFF_SUBJECT,
      subjectId: newUuidV7(),
      context: { amount: 900 },
    });
    expect(submitted.requestId).not.toBeNull();

    const row = await db
      .selectFrom('platform.approval_request')
      .select(['workflow_instance_id', 'workflow_action'])
      .where('id', '=', submitted.requestId!)
      .executeTakeFirstOrThrow();
    expect(row.workflow_instance_id).toBeNull();
    expect(row.workflow_action).toBeNull();

    await expect(
      caller.platform.approvals.decide({ requestId: submitted.requestId!, decision: 'approved' }),
    ).resolves.toMatchObject({ status: 'approved', workflowAction: null });
  });
});

// --- The effect is idempotent ------------------------------------------------

describe('the approval.open effect under redelivery', () => {
  it('opens exactly one request however many times it is delivered', async () => {
    const { instance, streamId } = await startPilot();
    await executeTransition(db, {
      instanceId: instance.id,
      action: 'submit',
      actorPersonId: adminA,
      now: new Date(),
      correlationId,
    });

    const messages = await relayEffects(instance.id);
    for (const message of messages) {
      await deliver(message);
      await deliver(message);
      await deliver(message);
    }

    const requests = await db
      .selectFrom('platform.approval_request')
      .select('id')
      .where('subject_id', '=', streamId)
      .execute();
    expect(requests).toHaveLength(1);
  });
});

// --- AC-D1 — the race, through the real surface ------------------------------

describe('AC-D1 — two administrators race on the pilot request', () => {
  it('records one decision and moves the case exactly once', async () => {
    const { instance, request } = await submitPilot();
    const a = await callerFor(adminA);
    const b = await callerFor(adminB);

    const results = await Promise.allSettled([
      a.platform.approvals.decide({ requestId: request!.id, decision: 'approved' }),
      b.platform.approvals.decide({ requestId: request!.id, decision: 'approved' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await instanceState(instance.id)).toBe('approved');

    const transitions = await db
      .selectFrom('platform.workflow_transition')
      .select('id')
      .where('instance_id', '=', instance.id)
      .where('action', '=', 'approve')
      .execute();
    expect(transitions).toHaveLength(1);
  });
});

// --- AC-D5 — the threshold is configuration ----------------------------------

describe('AC-D5 — editing the threshold reroutes the next request, with no release', () => {
  it('auto-approves below and asks above, and the boundary moves when edited', async () => {
    const caller = await callerFor(adminA);

    // Seeded threshold: amount > 500.
    const below = await caller.platform.approvals.submit({
      subjectType: PILOT_SIGNOFF_SUBJECT,
      subjectId: newUuidV7(),
      context: { amount: 400 },
    });
    expect(below.autoApproved).toBe(true);

    const above = await caller.platform.approvals.submit({
      subjectType: PILOT_SIGNOFF_SUBJECT,
      subjectId: newUuidV7(),
      context: { amount: 600 },
    });
    expect(above.autoApproved).toBe(false);

    // An administrator raises the bar. No code changes; no restart.
    await db.transaction().execute((trx) =>
      setConfig(trx, {
        def: requireApprovalSubject(PILOT_SIGNOFF_SUBJECT).threshold,
        value: { field: 'amount', op: 'gt', value: 1000 },
        actorPersonId: adminA,
        correlationId,
      }),
    );

    const afterEdit = await caller.platform.approvals.submit({
      subjectType: PILOT_SIGNOFF_SUBJECT,
      subjectId: newUuidV7(),
      context: { amount: 600 },
    });
    expect(afterEdit.autoApproved).toBe(true);
  });
});

// --- AC-D6 — the pilot warning provider --------------------------------------

describe('AC-D6 — the demo warning informs and never blocks', () => {
  it('warns above £2,000 at preview and at decide, and approval still succeeds', async () => {
    const caller = await callerFor(adminA);
    const subjectId = newUuidV7();

    const preview = await caller.platform.approvals.previewWarnings({
      subjectType: PILOT_SIGNOFF_SUBJECT,
      subjectId,
      context: { amount: 3000 },
    });
    expect(preview.map((w) => w.code)).toEqual([PILOT_LARGE_AMOUNT_CODE]);
    expect(preview[0]!.provider).toBe(PILOT_WARNING_PROVIDER);
    expect(preview[0]!.severity).toBe('warning');

    const submitted = await caller.platform.approvals.submit({
      subjectType: PILOT_SIGNOFF_SUBJECT,
      subjectId,
      context: { amount: 3000 },
      acknowledgedWarnings: [{ provider: PILOT_WARNING_PROVIDER, code: PILOT_LARGE_AMOUNT_CODE }],
    });

    const detail = await caller.platform.approvals.byId({ requestId: submitted.requestId! });
    expect(detail.warnings.map((w) => w.code)).toEqual([PILOT_LARGE_AMOUNT_CODE]);
    expect(detail.viewerCanDecide).toBe(true);

    await expect(
      caller.platform.approvals.decide({
        requestId: submitted.requestId!,
        decision: 'approved',
        acknowledgedWarnings: [{ provider: PILOT_WARNING_PROVIDER, code: PILOT_LARGE_AMOUNT_CODE }],
      }),
    ).resolves.toMatchObject({ status: 'approved' });
  });

  it('says nothing below the provider’s threshold', async () => {
    const caller = await callerFor(adminA);
    const preview = await caller.platform.approvals.previewWarnings({
      subjectType: PILOT_SIGNOFF_SUBJECT,
      subjectId: newUuidV7(),
      context: { amount: 900 },
    });
    expect(preview).toEqual([]);
  });
});

// --- AC-D3 — the delegate decides --------------------------------------------

describe('AC-D3 — a delegate decides the pilot request', () => {
  it('lets the deputy act, and records that it was via the delegation', async () => {
    const { request } = await submitPilot();
    const day = 86_400_000;

    const created = await (
      await callerFor(adminA)
    ).platform.approvals.delegations.create({
      delegatePersonId: deputy,
      validFrom: new Date(Date.now() - day).toISOString(),
      validTo: new Date(Date.now() + day).toISOString(),
      reason: 'annual leave',
    });

    const deputyCaller = await callerFor(deputy);
    const inbox = await deputyCaller.platform.approvals.inbox({ limit: 25 });
    expect(inbox.items.map((i) => i.id)).toContain(request!.id);

    const decided = await deputyCaller.platform.approvals.decide({
      requestId: request!.id,
      decision: 'approved',
    });
    expect(decided.delegationId).toBe(created.delegationId);
  });
});

// --- Withdrawing the case withdraws the sign-off -----------------------------

describe('withdrawing the case cancels the request it was waiting on', () => {
  it('leaves no pending request behind', async () => {
    const { instance, request } = await submitPilot();

    await executeTransition(db, {
      instanceId: instance.id,
      action: 'withdraw',
      actorPersonId: adminA,
      now: new Date(),
      correlationId,
    });
    for (const message of await relayEffects(instance.id)) await deliver(message);

    const after = await db
      .selectFrom('platform.approval_request')
      .select('status')
      .where('id', '=', request!.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('cancelled');
  });
});
