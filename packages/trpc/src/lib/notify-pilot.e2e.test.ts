import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, newUuidV7 } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import { notificationsDefaultReminderCadence, qualifiedName, setConfig } from '@repo/config';
import {
  drainDueActions,
  effectMessagesFor,
  SCHEDULER_BATCH_SIZE,
  type DueAction,
  type EffectHandlerContext,
} from '@repo/workflow';
import { appRouter } from '../router.js';
import type { ContextGrant, TRPCContext } from '../trpc.js';
import { ROLE_KEYS, type RoleKey } from './constants.js';
import { scheduleReminder } from './notify.js';
import { dispatchNotificationEffect, reminderEffect } from './notify-effects.js';

/**
 * The pilot slice (core plan 10 §9.7) — **the whole capability demonstrated with
 * no HR module in existence**, which is the point of it.
 *
 * Two acceptance criteria are proven here end to end, through the real pipeline
 * rather than by calling the pieces:
 *
 *  - **AC-D1 / ON AC-5** — an administrator sends to a role, reassigns that
 *    role's membership, and sends again. The new holder receives it and the
 *    former holder does not, **with no notification, reminder or configuration
 *    touched between the two sends**. Nothing is reassigned because nothing
 *    stores a person.
 *  - **AC-D2** — a reminder chases an unsatisfied source on its cadence and
 *    stops the moment the source is satisfied. The source here is "has the test
 *    notification been read?", so the loop closes on a real user action rather
 *    than on a flag the test sets.
 *
 * The pipeline is exercised as the platform runs it: the requester's
 * transaction journals the request, the relay's fan-out rule turns that event
 * into the dispatch effect, the handler resolves recipients and delivers, and
 * the scheduler's drained occurrences run the reminder handler. Only the
 * transport is stubbed.
 */

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as EffectHandlerContext['logger'];

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

let admin: string;
let onCallA: string;
let onCallB: string;

beforeEach(async () => {
  await truncateAll(db);
  await reseedRoles();
  admin = await insertPerson('Pilot Admin', 'pilot-admin@cdf.test');
  onCallA = await insertPerson('On Call A', 'a@cdf.test');
  onCallB = await insertPerson('On Call B', 'b@cdf.test');
  await grant(admin, 'administrator');
});

// --- Harness -----------------------------------------------------------------

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

async function insertPerson(displayName: string, email: string): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.person')
    .values({
      id,
      relationship_type: 'employee',
      display_name: displayName,
      contact_email: email,
    })
    .execute();
  return id;
}

async function grant(personId: string, roleKey: RoleKey): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.role_grant')
    .values({
      id,
      person_id: personId,
      role_id: await roleId(roleKey),
      module: 'platform',
      valid_from: new Date('2020-01-01T00:00:00.000Z'),
      created_by: personId,
    })
    .execute();
  return id;
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
    // Core plan 11 §4.7: SES evidence records where a signature came from,
    // taken server-side. Null outside an HTTP request — nothing signs from here.
    requestIp: null,
    userAgent: null,
    correlationId: newUuidV7(),
    actorPersonId: personId,
    grants,
  };
}

async function callerFor(personId: string) {
  return appRouter.createCaller(makeCtx(personId, await loadGrants(personId)));
}

/**
 * The relay's half: read unpublished journal rows, turn payload-carried effects
 * into envelopes, and run each through its handler. This is what
 * `apps/worker/src/relay/outbox-relay.ts` does with a Service Bus in between —
 * the same `effectMessagesFor`, so the fan-out rule itself is under test rather
 * than mimicked.
 */
async function drainOutbox(): Promise<number> {
  const events = await db
    .selectFrom('platform.domain_event')
    .selectAll()
    .where('published_at', 'is', null)
    .orderBy('recorded_at')
    .execute();

  let dispatched = 0;
  for (const event of events) {
    for (const { envelope } of effectMessagesFor(event)) {
      if (envelope.effect !== 'notification.dispatch') continue;
      await dispatchNotificationEffect(envelope, { db, logger: noopLogger });
      dispatched += 1;
    }
  }
  await db
    .updateTable('platform.domain_event')
    .set({ published_at: new Date() })
    .where('published_at', 'is', null)
    .execute();
  return dispatched;
}

/**
 * The scheduler's half, through **plan 07's own `drainDueActions`** rather than
 * a hand-rolled equivalent — so this covers §9.6's "confirm
 * `action_type='notification.reminder'` rows flow scheduler → effects → reminder
 * handler end to end" with the scheduler's real SQL (`FOR UPDATE SKIP LOCKED`,
 * the envelope it builds, the `enqueued` stamp) rather than a mimic of it.
 *
 * Handlers run **after** the drain returns, exactly as the worker runs them:
 * `drainDueActions` stamps `enqueued` inside its own transaction, and the
 * handler's claim (`markScheduledActionExecuted`) requires that stamp.
 */
async function drainDueReminders(): Promise<number> {
  const claimed: DueAction[] = [];
  await drainDueActions(db, SCHEDULER_BATCH_SIZE, (actions) => {
    claimed.push(...actions);
    return Promise.resolve();
  });

  for (const action of claimed) {
    if (action.actionType !== 'notification.reminder') continue;
    await reminderEffect(action.envelope, { db, logger: noopLogger });
  }
  return claimed.length;
}

/** Bring every pending occurrence forward so the next drain fires it. */
async function fastForwardReminders(): Promise<void> {
  await db
    .updateTable('platform.scheduled_action')
    .set({ due_at: new Date(Date.now() - 1000) })
    .where('action_type', '=', 'notification.reminder')
    .where('status', '=', 'pending')
    .execute();
}

async function inboxOf(personId: string) {
  const caller = await callerFor(personId);
  return caller.platform.notifications.myList({ limit: 50 });
}

// --- The pilot ---------------------------------------------------------------

describe('the pilot slice — the capability, with no HR module in existence', () => {
  // AC-D1 / ON AC-5.
  it('redirects a send when a role changes hands, with nothing else touched', async () => {
    const onCall = await roleId('line_manager');
    const grantA = await grant(onCallA, 'line_manager');
    const caller = await callerFor(admin);

    // 1. Send to the role. A holds it.
    const first = await caller.platform.notifications.sendTest({
      recipient: { kind: 'role', roleId: onCall },
      note: 'first send',
    });
    expect(first.resolvedRecipients).toBe(1);
    await drainOutbox();

    expect((await inboxOf(onCallA)).items).toHaveLength(1);
    expect((await inboxOf(onCallB)).items).toHaveLength(0);

    // 2. Reassign the role in admin. Nothing else: no notification edited, no
    //    reminder rescheduled, no configuration written. This is the whole of
    //    PL-021 — there is nothing to reconfigure because nothing stores a
    //    person.
    const configBefore = await db
      .selectFrom('platform.config_entry')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();

    await db
      .updateTable('platform.role_grant')
      .set({ revoked_at: new Date() })
      .where('id', '=', grantA)
      .execute();
    await grant(onCallB, 'line_manager');

    // 3. Send again.
    const second = await caller.platform.notifications.sendTest({
      recipient: { kind: 'role', roleId: onCall },
      note: 'second send',
    });
    expect(second.resolvedRecipients).toBe(1);
    await drainOutbox();

    // B receives it; A does not. A keeps the first, which was correctly
    // delivered at the time — history is not rewritten by a membership change.
    expect((await inboxOf(onCallB)).items).toHaveLength(1);
    expect((await inboxOf(onCallA)).items).toHaveLength(1);

    // And no configuration was written between the two sends.
    const configAfter = await db
      .selectFrom('platform.config_entry')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    expect(configAfter.count).toBe(configBefore.count);
  });

  // AC-D2, with the source condition being a real user action.
  it('chases an unread test notification until it is read, then stops', async () => {
    const onCall = await roleId('line_manager');
    await grant(onCallA, 'line_manager');
    const caller = await callerFor(admin);

    const test = await caller.platform.notifications.sendTest({
      recipient: { kind: 'role', roleId: onCall },
      note: 'please read me',
    });
    await drainOutbox();

    // Chase the notification itself until its in-app copy is read.
    await db.transaction().execute((trx) =>
      scheduleReminder(trx, {
        reminderKind: 'admin.test_unread',
        source: { streamType: 'platform.notification', streamId: test.notificationId },
        recipient: { kind: 'role', roleId: onCall },
        anchor: { mode: 'from_now' },
        cadenceRef: `config:${qualifiedName(notificationsDefaultReminderCadence)}`,
        timeZone: 'Europe/London',
        actorPersonId: admin,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    // First chase.
    expect(await drainDueReminders()).toBe(1);
    await drainOutbox();
    expect(await chaseCount()).toBe(1);

    // Second chase — still unread, so it recurs. This is the half that would
    // silently not happen if recurrence were only scheduled once.
    await fastForwardReminders();
    expect(await drainDueReminders()).toBe(1);
    await drainOutbox();
    expect(await chaseCount()).toBe(2);

    // The recipient reads the test notification. Nothing else happens — no
    // cancel call, no admin action. The satisfaction check is what stops it.
    const recipient = await callerFor(onCallA);
    const inbox = await recipient.platform.notifications.myList({ limit: 50 });
    const testRow = inbox.items.find((item) => item.kind === 'admin.test');
    expect(testRow).toBeDefined();
    await recipient.platform.notifications.markRead({ deliveryId: testRow!.deliveryId });

    // Third firing: satisfied, so nothing is sent and the series completes.
    await fastForwardReminders();
    expect(await drainDueReminders()).toBe(1);
    await drainOutbox();
    expect(await chaseCount()).toBe(2);

    const completed = await db
      .selectFrom('platform.domain_event')
      .selectAll()
      .where('event_type', '=', 'platform.reminder.completed')
      .where('stream_id', '=', test.notificationId)
      .execute();
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toMatchObject({
      reminderKind: 'admin.test_unread',
      reason: 'satisfied',
      occurrences: 2,
    });

    // Nothing is left pending: no chase can arrive after satisfaction.
    const pending = await db
      .selectFrom('platform.scheduled_action')
      .select('id')
      .where('action_type', '=', 'notification.reminder')
      .where('status', '=', 'pending')
      .execute();
    expect(pending).toHaveLength(0);
  });

  // AC-D7, through the admin surface rather than through the service.
  it('follows a cadence changed in configuration, with no release', async () => {
    const onCall = await roleId('line_manager');
    await grant(onCallA, 'line_manager');
    const caller = await callerFor(admin);

    const test = await caller.platform.notifications.sendTest({
      recipient: { kind: 'role', roleId: onCall },
    });
    await drainOutbox();

    await db.transaction().execute((trx) =>
      scheduleReminder(trx, {
        reminderKind: 'admin.test_unread',
        source: { streamType: 'platform.notification', streamId: test.notificationId },
        recipient: { kind: 'role', roleId: onCall },
        anchor: { mode: 'from_now' },
        cadenceRef: `config:${qualifiedName(notificationsDefaultReminderCadence)}`,
        timeZone: 'Europe/London',
        actorPersonId: admin,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    // An administrator lengthens the cadence to weekly. No deploy, no restart.
    await db.transaction().execute((trx) =>
      setConfig(trx, {
        def: notificationsDefaultReminderCadence,
        value: 'P1W',
        actorPersonId: admin,
        correlationId: newUuidV7(),
      }),
    );

    const before = Date.now();
    await drainDueReminders();

    const next = await db
      .selectFrom('platform.scheduled_action')
      .selectAll()
      .where('action_type', '=', 'notification.reminder')
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();
    const daysOut = (next.due_at.getTime() - before) / 86_400_000;
    expect(daysOut).toBeGreaterThan(6.5);
    expect(daysOut).toBeLessThan(7.5);
  });
});

async function chaseCount(): Promise<number> {
  const row = await db
    .selectFrom('platform.notification')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('kind', '=', 'reminder.chase')
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
