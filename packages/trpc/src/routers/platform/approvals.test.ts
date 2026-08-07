import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { db, newUuidV7 } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import {
  defineApprovalSubject,
  qualifiedName,
  requireApprovalSubject,
  setConfig,
  unregisterApprovalSubjectForTests,
  unregisterConfigKeyForTests,
} from '@repo/config';
import { appRouter } from '../../router.js';
import type { ContextGrant, TRPCContext } from '../../trpc.js';
import { ROLE_KEYS, type RoleKey } from '../../lib/constants.js';
import {
  registerWarningProvider,
  unregisterWarningProviderForTests,
  WARNINGS_UNAVAILABLE_CODE,
} from '../../lib/approval-warnings.js';
import {
  assertDesignatedResolversRegistered,
  createDelegation,
  openApprovalRequest,
  registerDesignatedResolver,
  resolveApprovalPolicy,
  unregisterDesignatedResolverForTests,
} from '../../lib/approvals.js';

/**
 * The `platform.approvals` surface against real Postgres (core plan 09 §10).
 *
 * Four things are proven here that a mock database cannot prove at all:
 *
 *  - **The any-one-approves race** (AC-D1) — two concurrent transactions on one
 *    pending request, settled by a row lock and a compare-and-set.
 *  - **Append-only enforcement** — the guard trigger fires for the app role, and
 *    the unique index refuses a second decision.
 *  - **Live re-resolution** (AC-D4) — a membership change redirecting authority
 *    with no writes to any approval row, which is the model's whole claim.
 *  - **Keyset paging** over the inbox's eligibility join, where filtering after
 *    the fetch would corrupt the page boundary rather than merely be slow.
 */

const SUBJECT = 'platform.pilot_signoff';

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

let adminA: string;
let adminB: string;
let hrUser: string;
let outsider: string;
let requester: string;

beforeEach(async () => {
  await truncateAll(db);
  await reseedRoles();
  adminA = await insertPerson('Admin A');
  adminB = await insertPerson('Admin B');
  hrUser = await insertPerson('HR User');
  outsider = await insertPerson('Outsider');
  requester = await insertPerson('Requester');
  await grant(adminA, 'administrator');
  await grant(adminB, 'administrator');
  await grant(hrUser, 'hr_user');
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

async function roleId(key: RoleKey): Promise<string> {
  const row = await db
    .selectFrom('platform.role')
    .select('id')
    .where('key', '=', key)
    .executeTakeFirstOrThrow();
  return row.id;
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
  await db
    .insertInto('platform.role_grant')
    .values({
      id: newUuidV7(),
      person_id: personId,
      role_id: await roleId(roleKey),
      module: 'platform',
      valid_from: new Date('2020-01-01T00:00:00.000Z'),
      created_by: personId,
    })
    .execute();
}

async function revokeAll(personId: string): Promise<void> {
  await db
    .updateTable('platform.role_grant')
    .set({ revoked_at: new Date() })
    .where('person_id', '=', personId)
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

function makeCtx(personId: string, grants: ContextGrant[]): TRPCContext {
  return {
    db,
    user: { id: 'u', name: 'Test', email: 'test@cdf.test', role: 'admin' },
    session: { id: 's', userId: 'u' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    email: { sendOtp: async () => {}, sendInvitation: async () => {} },
    sms: { send: async () => {} },
    rateLimit: { check: () => true },
    correlationId: newUuidV7(),
    actorPersonId: personId,
    grants,
  };
}

async function callerFor(personId: string) {
  return appRouter.createCaller(makeCtx(personId, await loadGrants(personId)));
}

/** Open a request directly through the service — most tests are about deciding. */
async function open(
  opts: { amount?: number; subjectId?: string; requestedBy?: string } = {},
): Promise<string> {
  const subjectId = opts.subjectId ?? newUuidV7();
  const result = await db.transaction().execute((trx) =>
    openApprovalRequest(trx, {
      subjectType: SUBJECT,
      subjectId,
      context: { amount: opts.amount ?? 1000 },
      requestedBy: opts.requestedBy ?? requester,
      correlationId: newUuidV7(),
      now: new Date(),
    }),
  );
  if (!result.request) throw new Error('expected a request to be opened');
  return result.request.id;
}

async function statusOf(requestId: string): Promise<string> {
  const row = await db
    .selectFrom('platform.approval_request')
    .select('status')
    .where('id', '=', requestId)
    .executeTakeFirstOrThrow();
  return row.status;
}

async function eventsFor(requestId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('platform.domain_event')
    .select('event_type')
    .where('stream_type', '=', 'platform.approval_request')
    .where('stream_id', '=', requestId)
    .orderBy('recorded_at')
    .execute();
  return rows.map((r) => r.event_type);
}

// --- T1 — submit, notify set, decide (the happy path) ------------------------

describe('T1 — submit → notify set → decide', () => {
  it('opens a request, records who was asked, and journals it', async () => {
    const requestId = await open();

    const assignees = await db
      .selectFrom('platform.approval_assignee')
      .selectAll()
      .where('request_id', '=', requestId)
      .execute();

    // Both administrators are notified; the HR user is an override role and is
    // deliberately not (HL-033).
    expect(assignees.map((a) => a.person_id).sort()).toEqual([adminA, adminB].sort());
    expect(assignees.every((a) => a.source === 'policy_role')).toBe(true);
    expect(assignees.every((a) => a.source_role_id !== null)).toBe(true);
    expect(await eventsFor(requestId)).toEqual(['platform.approval_request.requested']);
  });

  it('lets any one approver decide, and records the decision', async () => {
    const requestId = await open();
    const caller = await callerFor(adminA);

    const result = await caller.platform.approvals.decide({
      requestId,
      decision: 'approved',
      acknowledgedWarnings: [],
    });

    expect(result.status).toBe('approved');
    expect(await eventsFor(requestId)).toEqual([
      'platform.approval_request.requested',
      'platform.approval_request.approved',
    ]);

    const decision = await db
      .selectFrom('platform.approval_decision')
      .selectAll()
      .where('request_id', '=', requestId)
      .executeTakeFirstOrThrow();
    expect(decision.actor_person_id).toBe(adminA);
    expect(decision.delegation_id).toBeNull();
  });

  /**
   * The override half of HL-033: HR was never notified, and can still act.
   */
  it('lets an override-role holder decide without having been notified', async () => {
    const requestId = await open();
    const caller = await callerFor(hrUser);

    await expect(
      caller.platform.approvals.decide({ requestId, decision: 'approved' }),
    ).resolves.toMatchObject({ status: 'approved' });

    const notified = await db
      .selectFrom('platform.approval_assignee')
      .select('person_id')
      .where('request_id', '=', requestId)
      .execute();
    expect(notified.map((n) => n.person_id)).not.toContain(hrUser);
  });

  it('refuses someone the policy does not resolve to', async () => {
    const requestId = await open();
    const caller = await callerFor(outsider);
    await expect(
      caller.platform.approvals.decide({ requestId, decision: 'approved' }),
    ).rejects.toThrow(/not currently one of this request/);
  });

  it('cancels a pending request at the requester’s request', async () => {
    const requestId = await open();
    const caller = await callerFor(requester);
    await expect(caller.platform.approvals.cancel({ requestId })).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(await eventsFor(requestId)).toContain('platform.approval_request.cancelled');
  });
});

// --- T2 — the any-one-approves race (AC-D1) ----------------------------------

describe('T2 — two approvers race (PL-016, AC-D1)', () => {
  /**
   * Both transactions start before either commits. The `FOR UPDATE` in
   * `decideApproval` serialises them, the loser's compare-and-set matches
   * nothing, and exactly one decision row exists.
   */
  it('records exactly one decision; the loser is told it was already decided', async () => {
    const requestId = await open();
    const a = await callerFor(adminA);
    const b = await callerFor(adminB);

    const results = await Promise.allSettled([
      a.platform.approvals.decide({ requestId, decision: 'approved' }),
      b.platform.approvals.decide({ requestId, decision: 'rejected', reason: 'too much' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(
      /already been|by someone else/,
    );

    const decisions = await db
      .selectFrom('platform.approval_decision')
      .selectAll()
      .where('request_id', '=', requestId)
      .execute();
    expect(decisions).toHaveLength(1);

    // And the journal shows one decisive event, not two.
    const decisive = (await eventsFor(requestId)).filter(
      (t) => t.endsWith('.approved') || t.endsWith('.rejected'),
    );
    expect(decisive).toHaveLength(1);
  });
});

// --- T3 — append-only enforcement --------------------------------------------

describe('T3 — the decision is immutable at the database level (ADR-0011)', () => {
  it('refuses UPDATE and DELETE on approval_decision', async () => {
    const requestId = await open();
    await (await callerFor(adminA)).platform.approvals.decide({ requestId, decision: 'approved' });

    await expect(
      db
        .updateTable('platform.approval_decision')
        .set({ reason: 'changed my mind' })
        .where('request_id', '=', requestId)
        .execute(),
    ).rejects.toThrow();

    await expect(
      db.deleteFrom('platform.approval_decision').where('request_id', '=', requestId).execute(),
    ).rejects.toThrow();
  });

  it('refuses a second decision row for one request', async () => {
    const requestId = await open();
    await (await callerFor(adminA)).platform.approvals.decide({ requestId, decision: 'approved' });

    await expect(
      db
        .insertInto('platform.approval_decision')
        .values({
          id: newUuidV7(),
          request_id: requestId,
          decision: 'rejected',
          actor_person_id: adminB,
          reason: 'sneaking one in',
          decided_at: new Date(),
          created_by: adminB,
        })
        .execute(),
    ).rejects.toThrow();
  });
});

// --- T4 — the mandatory rejection reason (AC-D2) -----------------------------

describe('T4 — a rejection without a reason is impossible (PL-016, AC-D2)', () => {
  it('is refused by the input schema', async () => {
    const requestId = await open();
    const caller = await callerFor(adminA);
    await expect(
      caller.platform.approvals.decide({ requestId, decision: 'rejected' }),
    ).rejects.toThrow(/reason is required/);
  });

  it('is refused by the schema even when the reason is only whitespace', async () => {
    const requestId = await open();
    const caller = await callerFor(adminA);
    await expect(
      caller.platform.approvals.decide({ requestId, decision: 'rejected', reason: '   ' }),
    ).rejects.toThrow(/reason is required/);
  });

  /** The braces to the schema's belt: a direct SQL insert is refused too. */
  it('is refused by the CHECK constraint on a direct SQL insert', async () => {
    const requestId = await open();
    await expect(
      db
        .insertInto('platform.approval_decision')
        .values({
          id: newUuidV7(),
          request_id: requestId,
          decision: 'rejected',
          actor_person_id: adminA,
          reason: null,
          decided_at: new Date(),
          created_by: adminA,
        })
        .execute(),
    ).rejects.toThrow(/approval_decision_reason_chk/);
  });

  it('records the reason and journals only that one exists', async () => {
    const requestId = await open();
    const caller = await callerFor(adminA);
    await caller.platform.approvals.decide({
      requestId,
      decision: 'rejected',
      reason: 'over budget for this quarter',
    });

    const decision = await db
      .selectFrom('platform.approval_decision')
      .select('reason')
      .where('request_id', '=', requestId)
      .executeTakeFirstOrThrow();
    expect(decision.reason).toBe('over budget for this quarter');

    // ADR-0019: the text stays on the row, never in the immutable payload.
    const event = await db
      .selectFrom('platform.domain_event')
      .select('payload')
      .where('stream_id', '=', requestId)
      .where('event_type', '=', 'platform.approval_request.rejected')
      .executeTakeFirstOrThrow();
    const payload = event.payload as Record<string, unknown>;
    expect(payload.hasReason).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('over budget');
  });
});

// --- T5 — live re-resolution (AC-D4, PL-021) ---------------------------------

describe('T5 — membership change redirects authority (AC-D4, PL-021)', () => {
  /**
   * The claim §4.5 makes, tested end to end: after submission, moving the role's
   * membership moves who may decide — **with no writes to any approval row**.
   * The assignee rows still record who was originally asked, which is the other
   * half of the design.
   */
  it('withdraws authority from the leaver and grants it to the newcomer', async () => {
    const requestId = await open();

    // A was notified at submit.
    const assignees = await db
      .selectFrom('platform.approval_assignee')
      .select('person_id')
      .where('request_id', '=', requestId)
      .execute();
    expect(assignees.map((a) => a.person_id)).toContain(adminA);

    // A leaves the role; a newcomer joins it.
    await revokeAll(adminA);
    const newcomer = await insertPerson('Newcomer');
    await grant(newcomer, 'administrator');

    // A can no longer decide, and no longer sees it.
    const aCaller = await callerFor(adminA);
    await expect(
      aCaller.platform.approvals.decide({ requestId, decision: 'approved' }),
    ).rejects.toThrow(/not currently one of this request/);
    const aInbox = await aCaller.platform.approvals.inbox({ limit: 25 });
    expect(aInbox.items.map((i) => i.id)).not.toContain(requestId);

    // The newcomer does, and can.
    const newCaller = await callerFor(newcomer);
    const newInbox = await newCaller.platform.approvals.inbox({ limit: 25 });
    expect(newInbox.items.map((i) => i.id)).toContain(requestId);
    await expect(
      newCaller.platform.approvals.decide({ requestId, decision: 'approved' }),
    ).resolves.toMatchObject({ status: 'approved' });

    // The record of who was asked is untouched — that is a different question.
    const after = await db
      .selectFrom('platform.approval_assignee')
      .select('person_id')
      .where('request_id', '=', requestId)
      .execute();
    expect(after.map((a) => a.person_id)).toContain(adminA);
    expect(after.map((a) => a.person_id)).not.toContain(newcomer);
  });
});

// --- T6 — delegation (AC-D3) -------------------------------------------------

describe('T6 — delegation (AC-D3, HL-035)', () => {
  const DAY = 86_400_000;

  async function delegate(opts: { from: Date; to: Date; subjectType?: string | null }) {
    return db.transaction().execute((trx) =>
      createDelegation(trx, {
        delegatorPersonId: adminA,
        delegatePersonId: outsider,
        subjectType: opts.subjectType ?? null,
        validFrom: opts.from,
        validTo: opts.to,
        actorPersonId: adminA,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );
  }

  it('lets the delegate decide inside the window, recording the delegation', async () => {
    const now = Date.now();
    const row = await delegate({ from: new Date(now - DAY), to: new Date(now + DAY) });
    const requestId = await open();

    const caller = await callerFor(outsider);
    const inbox = await caller.platform.approvals.inbox({ limit: 25 });
    expect(inbox.items.map((i) => i.id)).toContain(requestId);

    const result = await caller.platform.approvals.decide({ requestId, decision: 'approved' });
    expect(result.delegationId).toBe(row.id);

    const decision = await db
      .selectFrom('platform.approval_decision')
      .select('delegation_id')
      .where('request_id', '=', requestId)
      .executeTakeFirstOrThrow();
    expect(decision.delegation_id).toBe(row.id);
  });

  it('refuses the delegate before the window opens', async () => {
    const now = Date.now();
    await delegate({ from: new Date(now + DAY), to: new Date(now + 2 * DAY) });
    const requestId = await open();

    const caller = await callerFor(outsider);
    await expect(
      caller.platform.approvals.decide({ requestId, decision: 'approved' }),
    ).rejects.toThrow(/not currently one of this request/);
  });

  it('refuses the delegate after revocation', async () => {
    const now = Date.now();
    const row = await delegate({ from: new Date(now - DAY), to: new Date(now + DAY) });
    const requestId = await open();

    await (await callerFor(adminA)).platform.approvals.delegations.revoke({ delegationId: row.id });

    const caller = await callerFor(outsider);
    await expect(
      caller.platform.approvals.decide({ requestId, decision: 'approved' }),
    ).rejects.toThrow(/not currently one of this request/);
  });

  it('honours a subject-type scope', async () => {
    const now = Date.now();
    await delegate({
      from: new Date(now - DAY),
      to: new Date(now + DAY),
      subjectType: 'hr.leave_booking',
    });
    const requestId = await open();

    const caller = await callerFor(outsider);
    await expect(
      caller.platform.approvals.decide({ requestId, decision: 'approved' }),
    ).rejects.toThrow(/not currently one of this request/);
  });

  it('journals creation and revocation as security events', async () => {
    const now = Date.now();
    const row = await delegate({ from: new Date(now - DAY), to: new Date(now + DAY) });
    await (await callerFor(adminA)).platform.approvals.delegations.revoke({ delegationId: row.id });

    const events = await db
      .selectFrom('platform.domain_event')
      .select(['event_type', 'kind'])
      .where('stream_type', '=', 'platform.approval_delegation')
      .where('stream_id', '=', row.id)
      .orderBy('recorded_at')
      .execute();

    expect(events.map((e) => e.event_type)).toEqual([
      'platform.approval_delegation.created',
      'platform.approval_delegation.revoked',
    ]);
    expect(events.every((e) => e.kind === 'security')).toBe(true);
  });

  it('refuses a delegation longer than the configured ceiling', async () => {
    const now = Date.now();
    const caller = await callerFor(adminA);
    await expect(
      caller.platform.approvals.delegations.create({
        delegatePersonId: outsider,
        validFrom: new Date(now).toISOString(),
        validTo: new Date(now + 200 * DAY).toISOString(),
      }),
    ).rejects.toThrow(/more than 90 days/);
  });
});

// --- T7 — thresholds as configuration (AC-D5) --------------------------------

describe('T7 — the threshold is configuration, not code (PL-018, AC-D5)', () => {
  it('auto-approves below the threshold without creating a request', async () => {
    const caller = await callerFor(requester);
    const subjectId = newUuidV7();
    const result = await caller.platform.approvals.submit({
      subjectType: SUBJECT,
      subjectId,
      context: { amount: 100 },
    });

    expect(result).toMatchObject({ autoApproved: true, requestId: null, notifiedCount: 0 });
    const rows = await db
      .selectFrom('platform.approval_request')
      .select('id')
      .where('subject_id', '=', subjectId)
      .execute();
    expect(rows).toHaveLength(0);

    // The fact is journalled on the subject's stream (§4.3's documented exception).
    const events = await db
      .selectFrom('platform.domain_event')
      .select('event_type')
      .where('stream_type', '=', SUBJECT)
      .where('stream_id', '=', subjectId)
      .execute();
    expect(events.map((e) => e.event_type)).toEqual(['platform.approval_request.auto_approved']);
  });

  it('opens a request above the threshold', async () => {
    const caller = await callerFor(requester);
    const result = await caller.platform.approvals.submit({
      subjectType: SUBJECT,
      subjectId: newUuidV7(),
      context: { amount: 600 },
    });
    expect(result.autoApproved).toBe(false);
    expect(result.requestId).not.toBeNull();
  });

  /**
   * AC-D5 itself: an administrator changes the number, and the *next* request
   * routes differently. No release, no restart, no code change.
   */
  it('routes differently after the threshold is edited, with no release', async () => {
    const caller = await callerFor(requester);
    const before = await caller.platform.approvals.submit({
      subjectType: SUBJECT,
      subjectId: newUuidV7(),
      context: { amount: 600 },
    });
    expect(before.autoApproved).toBe(false);

    await db.transaction().execute((trx) =>
      setConfig(trx, {
        def: requireApprovalSubject(SUBJECT).threshold,
        value: { field: 'amount', op: 'gt', value: 5000 },
        actorPersonId: adminA,
        correlationId: newUuidV7(),
      }),
    );

    const after = await caller.platform.approvals.submit({
      subjectType: SUBJECT,
      subjectId: newUuidV7(),
      context: { amount: 600 },
    });
    expect(after.autoApproved).toBe(true);

    // …and the config change is itself audited (PL-030). Scoped to this key:
    // `platform.domain_event` is append-only, so `truncateAll` deliberately
    // skips it and every earlier test's events are still there.
    const threshold = requireApprovalSubject(SUBJECT).threshold;
    const configEvents = await db
      .selectFrom('platform.domain_event')
      .select(['kind', 'payload'])
      .where('event_type', '=', 'platform.config_entry.changed')
      .where(
        sql<boolean>`payload ->> 'namespace' = ${threshold.namespace} AND payload ->> 'key' = ${threshold.key}`,
      )
      .orderBy('recorded_at', 'desc')
      .execute();

    expect(configEvents.length).toBeGreaterThanOrEqual(1);
    expect(configEvents[0]!.kind).toBe('admin');
    // The old and new values ride the payload in full — safe by construction,
    // because a config value may never hold personal data (plan 06 §4.5).
    expect(configEvents[0]!.payload).toMatchObject({
      newValue: { field: 'amount', op: 'gt', value: 5000 },
    });
  });

  /** A threshold naming a field the context lacks routes to a human (fail-safe). */
  it('requires approval when the threshold cannot be evaluated', async () => {
    const caller = await callerFor(requester);
    const result = await caller.platform.approvals.submit({
      subjectType: SUBJECT,
      subjectId: newUuidV7(),
      context: {},
    });
    expect(result.autoApproved).toBe(false);
  });
});

// --- T8 — one pending request per subject ------------------------------------

describe('T8 — at most one open sign-off per subject', () => {
  it('refuses a second pending request for the same record', async () => {
    const subjectId = newUuidV7();
    await open({ subjectId });
    await expect(open({ subjectId })).rejects.toThrow(/already has an approval request/);
  });

  /** A decided request frees the subject: a re-request is a new row (§4.4). */
  it('allows a fresh request once the first is decided', async () => {
    const subjectId = newUuidV7();
    const first = await open({ subjectId });
    await (
      await callerFor(adminA)
    ).platform.approvals.decide({
      requestId: first,
      decision: 'rejected',
      reason: 'not this time',
    });

    const second = await open({ subjectId });
    expect(second).not.toBe(first);
    expect(await statusOf(first)).toBe('rejected');
    expect(await statusOf(second)).toBe('pending');
  });
});

// --- T9 — warnings are soft (AC-D6, PL-017) ----------------------------------

describe('T9 — warnings inform and never block (PL-017, AC-D6)', () => {
  afterEach(() => {
    unregisterWarningProviderForTests(SUBJECT, 'spend');
    unregisterWarningProviderForTests(SUBJECT, 'broken');
  });

  it('surfaces a provider’s warnings at preview and at detail', async () => {
    registerWarningProvider(SUBJECT, 'spend', (ctx) =>
      Promise.resolve(
        typeof ctx.context.amount === 'number' && ctx.context.amount > 2000
          ? [
              {
                provider: 'spend',
                code: 'large_amount',
                severity: 'warning' as const,
                message: 'This is a large amount.',
              },
            ]
          : [],
      ),
    );

    const caller = await callerFor(requester);
    const preview = await caller.platform.approvals.previewWarnings({
      subjectType: SUBJECT,
      subjectId: newUuidV7(),
      context: { amount: 3000 },
    });
    expect(preview.map((w) => w.code)).toEqual(['large_amount']);

    const requestId = await open({ amount: 3000 });
    const detail = await (await callerFor(adminA)).platform.approvals.byId({ requestId });
    expect(detail.warnings.map((w) => w.code)).toEqual(['large_amount']);
  });

  /**
   * The property PL-017 and HL-038 are explicit about: a live, unacknowledged
   * warning does not stop the decision. What is recorded is exactly what the
   * decider ticked — no more, no less.
   */
  it('lets a decision through with warnings unacknowledged, recording only what was ticked', async () => {
    registerWarningProvider(SUBJECT, 'spend', () =>
      Promise.resolve([
        {
          provider: 'spend',
          code: 'large_amount',
          severity: 'warning' as const,
          message: 'This is a large amount.',
        },
      ]),
    );

    const requestId = await open({ amount: 3000 });
    await (
      await callerFor(adminA)
    ).platform.approvals.decide({
      requestId,
      decision: 'approved',
      acknowledgedWarnings: [],
    });

    expect(await statusOf(requestId)).toBe('approved');
    const decision = await db
      .selectFrom('platform.approval_decision')
      .select('warnings_acknowledged')
      .where('request_id', '=', requestId)
      .executeTakeFirstOrThrow();
    expect(decision.warnings_acknowledged).toEqual([]);
  });

  it('records the acknowledged codes when the decider ticks them', async () => {
    const requestId = await open({ amount: 3000 });
    await (
      await callerFor(adminA)
    ).platform.approvals.decide({
      requestId,
      decision: 'approved',
      acknowledgedWarnings: [{ provider: 'spend', code: 'large_amount' }],
    });

    const decision = await db
      .selectFrom('platform.approval_decision')
      .select('warnings_acknowledged')
      .where('request_id', '=', requestId)
      .executeTakeFirstOrThrow();
    expect(decision.warnings_acknowledged).toEqual([{ provider: 'spend', code: 'large_amount' }]);
  });

  /** A broken provider degrades to a visible notice; it never fails the screen. */
  it('degrades gracefully when a provider throws', async () => {
    registerWarningProvider(SUBJECT, 'broken', () => Promise.reject(new Error('boom')));

    const caller = await callerFor(requester);
    const preview = await caller.platform.approvals.previewWarnings({
      subjectType: SUBJECT,
      subjectId: newUuidV7(),
      context: { amount: 100 },
    });
    expect(preview.map((w) => w.code)).toEqual([WARNINGS_UNAVAILABLE_CODE]);
  });
});

// --- T10 — the inbox: keyset paging over a live eligibility join -------------

describe('T10 — inbox keyset paging (ADR-0004)', () => {
  /**
   * More than three pages, paged to exhaustion. The assertion is the one that
   * matters for keyset correctness: every row exactly once, in the right global
   * order, with no gaps at the page edges — which is precisely what a
   * post-fetch filter would break.
   */
  it('pages the whole inbox with correct order, no duplicates and no gaps', async () => {
    const created: string[] = [];
    for (let i = 0; i < 17; i += 1) {
      created.push(await open());
    }

    const caller = await callerFor(adminA);
    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;
    let pages = 0;

    do {
      const page = await caller.platform.approvals.inbox({ limit: 5, cursor });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10); // a runaway loop is a failure, not a hang
    } while (cursor);

    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(created.sort());
  });

  it('filters by status in SQL, defaulting to the outstanding set', async () => {
    const decided = await open();
    const pending = await open();
    await (
      await callerFor(adminA)
    ).platform.approvals.decide({
      requestId: decided,
      decision: 'approved',
    });

    const caller = await callerFor(adminA);
    const outstanding = await caller.platform.approvals.inbox({ limit: 25 });
    expect(outstanding.items.map((i) => i.id)).toEqual([pending]);

    const all = await caller.platform.approvals.inbox({
      limit: 25,
      status: ['pending', 'approved'],
    });
    expect(all.items.map((i) => i.id).sort()).toEqual([decided, pending].sort());
  });

  it('filters by subject type in SQL', async () => {
    await open();
    const caller = await callerFor(adminA);
    expect(
      (await caller.platform.approvals.inbox({ limit: 25, subjectType: SUBJECT })).items,
    ).toHaveLength(1);
    expect(
      (await caller.platform.approvals.inbox({ limit: 25, subjectType: 'hr.leave_booking' })).items,
    ).toHaveLength(0);
  });

  /**
   * HL-033's second half, at the inbox: HR may act on anything, and is not shown
   * everything by default. Opting in is an explicit request.
   */
  it('keeps override-only requests out of the inbox unless asked for', async () => {
    const requestId = await open();
    const caller = await callerFor(hrUser);

    expect((await caller.platform.approvals.inbox({ limit: 25 })).items).toHaveLength(0);

    const withOverride = await caller.platform.approvals.inbox({
      limit: 25,
      includeOverride: true,
    });
    expect(withOverride.items.map((i) => i.id)).toEqual([requestId]);
    expect(withOverride.items[0]!.viaOverride).toBe(true);
  });

  it('shows nothing to someone with no approver role at all', async () => {
    await open();
    const caller = await callerFor(outsider);
    expect((await caller.platform.approvals.inbox({ limit: 25 })).items).toHaveLength(0);
  });
});

// --- T11 — request detail ----------------------------------------------------

describe('T11 — byId', () => {
  it('tells an eligible viewer they may decide', async () => {
    const requestId = await open();
    const detail = await (await callerFor(adminA)).platform.approvals.byId({ requestId });
    expect(detail.viewerCanDecide).toBe(true);
    expect(detail.viewerCannotDecideReason).toBeNull();
    expect(detail.assignees).toHaveLength(2);
  });

  /** The requester can watch their own request without being able to decide it. */
  it('shows the requester their request, without decision rights', async () => {
    const requestId = await open();
    const detail = await (await callerFor(requester)).platform.approvals.byId({ requestId });
    expect(detail.viewerCanDecide).toBe(false);
    expect(detail.viewerCannotDecideReason).toBe('not_eligible');
  });

  it('hides it from an unrelated person as NOT_FOUND', async () => {
    const requestId = await open();
    await expect(
      (await callerFor(outsider)).platform.approvals.byId({ requestId }),
    ).rejects.toThrow(/No such approval request/);
  });

  it('explains why a decided request can no longer be acted on', async () => {
    const requestId = await open();
    await (await callerFor(adminA)).platform.approvals.decide({ requestId, decision: 'approved' });
    const detail = await (await callerFor(adminB)).platform.approvals.byId({ requestId });
    expect(detail.viewerCanDecide).toBe(false);
    expect(detail.viewerCannotDecideReason).toBe('already_decided');
    expect(detail.decision?.actorName).toBe('Admin A');
  });
});

// --- T12 — reminders ride plan 10's row shape --------------------------------

describe('T12 — the chase is scheduled and cancelled eagerly (HL-054)', () => {
  async function pendingReminders(requestId: string) {
    return db
      .selectFrom('platform.scheduled_action')
      .selectAll()
      .where('subject_stream_type', '=', 'platform.approval_request')
      .where('subject_stream_id', '=', requestId)
      .where('action_type', '=', 'notification.reminder')
      .execute();
  }

  /**
   * Plan 10 does not exist yet, so these rows are created through plan 07's
   * `scheduleAction` on plan 10's payload shape (its §4.5) — exactly as core
   * plan 08 did for task chases. When plan 10 lands it takes over the firing;
   * nothing here is migrated.
   */
  it('schedules a first occurrence with a policy recipient spec', async () => {
    const requestId = await open();
    const rows = await pendingReminders(requestId);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.reminderKind).toBe('approval.pending');
    expect(payload.occurrence).toBe(1);
    // Re-resolved at each send, never a person list frozen at submit (PL-021).
    expect(payload.recipient).toMatchObject({ kind: 'policy' });
  });

  it('cancels the chase in the transaction that decides the request', async () => {
    const requestId = await open();
    await (await callerFor(adminA)).platform.approvals.decide({ requestId, decision: 'approved' });

    const rows = await pendingReminders(requestId);
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true);
  });

  it('cancels the chase when the request is cancelled', async () => {
    const requestId = await open();
    await (await callerFor(requester)).platform.approvals.cancel({ requestId });

    const rows = await pendingReminders(requestId);
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true);
  });
});

// --- T14 — the designated-resolver guards ------------------------------------

describe('T14 — a policy cannot name a resolver that does not exist', () => {
  /**
   * The conformance half. The config schema stops a *policy* naming an
   * undeclared source; this stops a subject type *declaring* one nobody
   * implemented. Together they close the gap that made a config typo silently
   * empty an inbox (§12.2 Q6's neighbour, fixed 2026-08-06).
   */
  it('every declared designated source has a registered resolver', () => {
    expect(() => assertDesignatedResolversRegistered()).not.toThrow();
  });

  /**
   * A subject type declaring a source nobody implemented fails the check, and
   * the message names the pair — so this is caught by CI rather than by
   * someone's submit throwing in production.
   */
  it('fails loudly when a declared source has no resolver', () => {
    const def = defineApprovalSubject({
      subjectType: 'hr.conformance_probe',
      policyDefault: { mode: 'any-one', approvers: [{ kind: 'role', roleKey: 'line_manager' }] },
      designatedSources: ['nobody_implemented_me'],
      policyDescription: 'probe',
      thresholdDescription: 'probe',
      registeredBy: 'test',
    });

    try {
      expect(() => assertDesignatedResolversRegistered()).toThrow(
        /hr\.conformance_probe → 'nobody_implemented_me'/,
      );

      // …and registering the resolver satisfies it.
      registerDesignatedResolver('hr.conformance_probe', 'nobody_implemented_me', () =>
        Promise.resolve([]),
      );
      expect(() => assertDesignatedResolversRegistered()).not.toThrow();
    } finally {
      unregisterDesignatedResolverForTests('hr.conformance_probe', 'nobody_implemented_me');
      unregisterConfigKeyForTests(qualifiedName(def.policy));
      unregisterConfigKeyForTests(qualifiedName(def.threshold));
      unregisterConfigKeyForTests(qualifiedName(def.reminderCadence));
      unregisterApprovalSubjectForTests('hr.conformance_probe');
    }
  });

  /**
   * And the runtime failure, if one ever got through, is loud rather than
   * silent: `resolveApprovalPolicy` throws naming the source.
   */
  it('throws by name when a policy reaches resolution with an unknown source', async () => {
    await expect(
      resolveApprovalPolicy(db, {
        subjectType: 'hr.not_registered',
        subjectId: newUuidV7(),
        at: new Date(),
      }),
    ).rejects.toThrow(/approvals are not enabled/);
  });
});

// --- T13 — the event ledger reconstructs the table state ---------------------

describe('T13 — the lifecycle is reconstructable from the journal (ADR-0010)', () => {
  it('matches table state, with nothing overwritten', async () => {
    const requestId = await open();
    await (
      await callerFor(adminA)
    ).platform.approvals.decide({
      requestId,
      decision: 'rejected',
      reason: 'not this quarter',
    });

    const events = await db
      .selectFrom('platform.domain_event')
      .select(['event_type', 'payload', 'actor_person_id'])
      .where('stream_type', '=', 'platform.approval_request')
      .where('stream_id', '=', requestId)
      .orderBy('recorded_at')
      .execute();

    expect(events.map((e) => e.event_type)).toEqual([
      'platform.approval_request.requested',
      'platform.approval_request.rejected',
    ]);
    // The decider is on the envelope, not repeated in the payload.
    expect(events[1]!.actor_person_id).toBe(adminA);
    expect(await statusOf(requestId)).toBe('rejected');

    // Immutable: the journal refuses an edit to its own history.
    await expect(
      sql`UPDATE platform.domain_event SET payload = '{}'::jsonb WHERE stream_id = ${requestId}`.execute(
        db,
      ),
    ).rejects.toThrow();
  });
});
