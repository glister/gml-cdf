import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, newUuidV7, type NotificationRecord } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import {
  notificationsChannelEmailEnabled,
  notificationsDefaultReminderCadence,
  notificationsKindChannelOverrides,
  qualifiedName,
  setConfig,
} from '@repo/config';
import { effectMessagesFor, type EffectHandlerContext } from '@repo/workflow';
import { appRouter } from '../../router.js';
import type { ContextGrant, TRPCContext } from '../../trpc.js';
import { ROLE_KEYS, type RoleKey } from '../../lib/constants.js';
import { cancelReminders, requestNotification, scheduleReminder } from '../../lib/notify.js';
import {
  registerChannelAdapter,
  unregisterChannelAdapterForTests,
  type ChannelAdapter,
} from '../../lib/notify-channels.js';
import {
  dispatchNotificationEffect,
  reminderEffect,
  retryNotificationEffect,
  MAX_DELIVERY_ATTEMPTS,
} from '../../lib/notify-effects.js';
import {
  registerReminderKind,
  unregisterReminderKindForTests,
} from '../../lib/notify-reminders.js';
import {
  registerSubjectContext,
  resolveRecipients,
  unregisterSubjectContextForTests,
} from '../../lib/notify-resolve.js';

/**
 * The notification service against real Postgres (core plan 10 §10).
 *
 * Five things are proven here that a mock database cannot prove at all:
 *
 *  - **PL-021 / AC-D1** — a role's membership changes between two sends and the
 *    resolved set changes with it, with **zero configuration touched and zero
 *    writes to any notification row**. That is the requirement, and it is only
 *    demonstrable against live grants.
 *  - **Dispatch idempotency** — the handler run twice creates no duplicate
 *    deliveries, which rests on a unique constraint rather than on a check.
 *  - **The reminder loop** (AC-D2/D7) — recurrence, an as-at cadence change
 *    taking effect with no release, and the stop the moment the source is
 *    satisfied.
 *  - **Keyset paging** over the inbox, where a partial page filtered after the
 *    fetch would corrupt the boundary rather than merely be slow (ADR-0004).
 *  - **Suppression** (AC-D8) — a channel disabled in configuration records a
 *    row saying so rather than skipping silently.
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

let admin: string;
let managerA: string;
let managerB: string;
let outsider: string;

beforeEach(async () => {
  await truncateAll(db);
  await reseedRoles();
  admin = await insertPerson('Admin');
  managerA = await insertPerson('Manager A', 'a@cdf.test');
  managerB = await insertPerson('Manager B', 'b@cdf.test');
  outsider = await insertPerson('Outsider', 'o@cdf.test');
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

async function insertPerson(displayName: string, email?: string): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.person')
    .values({
      id,
      relationship_type: 'employee',
      display_name: displayName,
      contact_email: email ?? null,
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

async function revoke(grantId: string): Promise<void> {
  await db
    .updateTable('platform.role_grant')
    .set({ revoked_at: new Date() })
    .where('id', '=', grantId)
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
 * A silent stand-in for the effect context's logger.
 *
 * Cast rather than constructed: plan 07 types the field as winston's `Logger`,
 * this package deliberately depends on no concrete service (see its CLAUDE.md),
 * and these handlers use four methods of it. The cast is confined to the test.
 */
const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as EffectHandlerContext['logger'];

/** Run the dispatch handler exactly as the effects consumer would. */
async function dispatch(notificationId: string): Promise<void> {
  await dispatchNotificationEffect(
    {
      effect: 'notification.dispatch',
      params: { notificationId },
      source: { kind: 'event', eventId: newUuidV7() },
      subject: { streamType: 'platform.notification', streamId: notificationId },
      correlationId: newUuidV7(),
    },
    { db, logger: noopLogger },
  );
}

async function requestTest(
  recipient: Parameters<typeof requestNotification>[1]['recipient'],
  options: { note?: string; channels?: ('in_app' | 'email' | 'push')[] } = {},
): Promise<NotificationRecord> {
  const row = await db.transaction().execute((trx) =>
    requestNotification(trx, {
      kind: 'admin.test',
      recipient,
      payload: { note: options.note ?? null, resolvedVia: recipient.kind },
      channels: options.channels,
      requestedBy: admin,
      correlationId: newUuidV7(),
      now: new Date(),
    }),
  );
  if (!row) throw new Error('expected a notification');
  return row;
}

async function deliveriesFor(notificationId: string) {
  return db
    .selectFrom('platform.notification_delivery')
    .selectAll()
    .where('notification_id', '=', notificationId)
    .orderBy('person_id')
    .orderBy('channel')
    .execute();
}

/**
 * Journal rows of one type **on one stream**.
 *
 * `platform.domain_event` is append-only, so `truncateAll` deliberately leaves
 * it alone (ADR-0011) and rows accumulate across the whole suite. Every
 * assertion here is therefore scoped to the stream under test — an unscoped
 * count would pass or fail depending on which tests ran before it, which is the
 * worst kind of flake because it looks like a real regression.
 */
async function eventsOfType(eventType: string, streamId: string) {
  return db
    .selectFrom('platform.domain_event')
    .selectAll()
    .where('event_type', '=', eventType)
    .where('stream_id', '=', streamId)
    .orderBy('recorded_at')
    .execute();
}

/** Distinct people a notification reached (one row per channel per person). */
async function recipientsOf(notificationId: string): Promise<string[]> {
  const rows = await deliveriesFor(notificationId);
  return [...new Set(rows.map((d) => d.person_id))].sort();
}

// --- Recipient resolution (PL-021) -------------------------------------------

describe('resolveRecipients — the heart of PL-021', () => {
  it('resolves a role to its current active holders only', async () => {
    const grantA = await grant(managerA, 'line_manager');
    await grant(managerB, 'line_manager');
    // An expired grant and a revoked one must both be excluded.
    const expired = newUuidV7();
    await db
      .insertInto('platform.role_grant')
      .values({
        id: expired,
        person_id: outsider,
        role_id: await roleId('line_manager'),
        module: 'platform',
        valid_from: new Date('2020-01-01T00:00:00.000Z'),
        valid_until: new Date('2020-06-01T00:00:00.000Z'),
        created_by: outsider,
      })
      .execute();

    const notification = await requestTest({ kind: 'role', roleId: await roleId('line_manager') });
    const resolved = await resolveRecipients(db, notification, new Date());
    expect(resolved.map((r) => r.personId).sort()).toEqual([managerA, managerB].sort());
    expect(resolved.every((r) => r.resolvedVia === 'role')).toBe(true);

    await revoke(grantA);
    const after = await resolveRecipients(db, notification, new Date());
    expect(after.map((r) => r.personId)).toEqual([managerB]);
  });

  // AC-D1 / ON AC-5, and the reason this plan exists in the shape it does.
  it('redirects a send after a membership change with ZERO writes to the notification', async () => {
    const grantA = await grant(managerA, 'line_manager');
    const roleIdValue = await roleId('line_manager');

    const first = await requestTest({ kind: 'role', roleId: roleIdValue });
    await dispatch(first.id);
    expect(await recipientsOf(first.id)).toEqual([managerA]);

    // Reassign the role. Nothing else changes: no notification is edited, no
    // reminder rescheduled, no configuration written.
    await revoke(grantA);
    await grant(managerB, 'line_manager');

    const second = await requestTest({ kind: 'role', roleId: roleIdValue });
    await dispatch(second.id);
    const recipients = await recipientsOf(second.id);
    expect(recipients).toEqual([managerB]);
    expect(recipients).not.toContain(managerA);

    // The first notification row is untouched by any of it.
    const firstRow = await db
      .selectFrom('platform.notification')
      .selectAll()
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow();
    expect(firstRow.recipient_role_id).toBe(roleIdValue);
    expect(firstRow).not.toHaveProperty('recipient_person_id');
  });

  it('narrows a role spec to holders who are in the named team', async () => {
    await grant(managerA, 'line_manager');
    await grant(managerB, 'line_manager');
    const teamId = newUuidV7();
    await db
      .insertInto('platform.team')
      .values({
        id: teamId,
        name: 'Fitters',
        manager_person_id: admin,
        created_by: admin,
        updated_by: admin,
      })
      .execute();
    await db
      .insertInto('platform.team_membership')
      .values({
        id: newUuidV7(),
        team_id: teamId,
        person_id: managerA,
        valid_from: '2020-01-01',
        created_by: admin,
        updated_by: admin,
      })
      .execute();

    const notification = await requestTest({
      kind: 'role',
      roleId: await roleId('line_manager'),
      teamId,
    });
    const resolved = await resolveRecipients(db, notification, new Date());
    expect(resolved.map((r) => r.personId)).toEqual([managerA]);
  });

  it('resolves a contextual requester from the subject stream', async () => {
    registerSubjectContext('platform.test_case', () =>
      Promise.resolve({ requesterPersonId: outsider }),
    );
    try {
      const notification = await requestTest({ kind: 'contextual', ref: 'requester' }, {}).catch(
        () => null,
      );
      // A contextual spec needs a subject; request one properly.
      expect(notification).toBeNull();

      const withSubject = await db.transaction().execute((trx) =>
        requestNotification(trx, {
          kind: 'admin.test',
          recipient: { kind: 'contextual', ref: 'requester' },
          subject: { streamType: 'platform.test_case', streamId: newUuidV7() },
          payload: { note: null, resolvedVia: 'contextual' },
          requestedBy: admin,
          correlationId: newUuidV7(),
          now: new Date(),
        }),
      );
      const resolved = await resolveRecipients(db, withSubject!, new Date());
      expect(resolved).toEqual([{ personId: outsider, resolvedVia: 'contextual' }]);
    } finally {
      unregisterSubjectContextForTests('platform.test_case');
    }
  });

  it('journals `unresolved` for an empty role and does not throw', async () => {
    // A silent drop is how a critical notification goes to nobody and nobody
    // notices — the event is what makes the misconfiguration visible (§12.3).
    const notification = await requestTest({ kind: 'role', roleId: await roleId('director') });
    await dispatch(notification.id);

    expect(await deliveriesFor(notification.id)).toHaveLength(0);
    const events = await eventsOfType('platform.notification.unresolved', notification.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      kind: 'admin.test',
      recipientKind: 'role',
      recipientRef: await roleId('director'),
    });
    // Still marked dispatched: retrying would not populate an empty role.
    const row = await db
      .selectFrom('platform.notification')
      .select('status')
      .where('id', '=', notification.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('dispatched');
  });
});

// --- Dispatch ----------------------------------------------------------------

describe('notification.dispatch', () => {
  it('creates one delivery per resolved person per requested channel', async () => {
    await grant(managerA, 'line_manager');
    await grant(managerB, 'line_manager');
    const notification = await requestTest({ kind: 'role', roleId: await roleId('line_manager') });

    await dispatch(notification.id);
    const deliveries = await deliveriesFor(notification.id);
    // 2 people × 2 channels (the kind asks for in_app + email).
    expect(deliveries).toHaveLength(4);
    expect(new Set(deliveries.map((d) => d.channel))).toEqual(new Set(['in_app', 'email']));
  });

  it('is idempotent: run twice, no duplicate deliveries', async () => {
    await grant(managerA, 'line_manager');
    const notification = await requestTest({ kind: 'role', roleId: await roleId('line_manager') });

    await dispatch(notification.id);
    const first = await deliveriesFor(notification.id);
    await dispatch(notification.id);
    const second = await deliveriesFor(notification.id);

    expect(second).toHaveLength(first.length);
    expect(second.map((d) => d.id).sort()).toEqual(first.map((d) => d.id).sort());
    // And the second run did not re-attempt what already landed.
    const inApp = second.find((d) => d.channel === 'in_app')!;
    expect(inApp.attempt_count).toBe(1);
  });

  // AC-D8.
  it('records a `suppressed` delivery when a channel is disabled in configuration', async () => {
    await grant(managerA, 'line_manager');
    await db.transaction().execute((trx) =>
      setConfig(trx, {
        def: notificationsChannelEmailEnabled,
        value: false,
        actorPersonId: admin,
        correlationId: newUuidV7(),
      }),
    );

    const notification = await requestTest({ kind: 'role', roleId: await roleId('line_manager') });
    await dispatch(notification.id);

    const deliveries = await deliveriesFor(notification.id);
    const email = deliveries.find((d) => d.channel === 'email')!;
    expect(email.status).toBe('suppressed');
    expect(email.last_error).toContain('disabled in configuration');
    // The in-app entry is unaffected — the point of recording rather than skipping.
    expect(deliveries.find((d) => d.channel === 'in_app')!.status).toBe('sent');

    const sent = await eventsOfType('platform.notification.sent', notification.id);
    expect(sent[0]!.payload).toMatchObject({ suppressedChannels: ['email'] });
  });

  it('honours a per-kind channel override from configuration', async () => {
    await grant(managerA, 'line_manager');
    await db.transaction().execute((trx) =>
      setConfig(trx, {
        def: notificationsKindChannelOverrides,
        value: { 'admin.test': ['in_app'] },
        actorPersonId: admin,
        correlationId: newUuidV7(),
      }),
    );

    const notification = await requestTest({ kind: 'role', roleId: await roleId('line_manager') });
    await dispatch(notification.id);

    const deliveries = await deliveriesFor(notification.id);
    expect(deliveries.find((d) => d.channel === 'email')!.status).toBe('suppressed');
    expect(deliveries.find((d) => d.channel === 'in_app')!.status).toBe('sent');
  });

  it('records a failing adapter on the row and schedules a retry', async () => {
    await grant(managerA, 'line_manager');
    const failing: ChannelAdapter = {
      channel: 'email',
      send: () => Promise.resolve({ ok: false as const, error: 'provider refused the message' }),
    };
    registerChannelAdapter(failing);
    try {
      const notification = await requestTest({
        kind: 'role',
        roleId: await roleId('line_manager'),
      });
      await dispatch(notification.id);

      const email = (await deliveriesFor(notification.id)).find((d) => d.channel === 'email')!;
      expect(email.status).toBe('failed');
      expect(email.attempt_count).toBe(1);
      expect(email.last_error).toBe('provider refused the message');

      const retries = await db
        .selectFrom('platform.scheduled_action')
        .selectAll()
        .where('action_type', '=', 'notification.retry')
        .execute();
      expect(retries).toHaveLength(1);
    } finally {
      unregisterChannelAdapterForTests('email');
    }
  });

  it('marks a delivery dead after the attempt ceiling and journals the failure', async () => {
    await grant(managerA, 'line_manager');
    const failing: ChannelAdapter = {
      channel: 'email',
      send: () => Promise.resolve({ ok: false as const, error: 'still refusing' }),
    };
    registerChannelAdapter(failing);
    try {
      const notification = await requestTest({
        kind: 'role',
        roleId: await roleId('line_manager'),
      });
      await dispatch(notification.id);

      // Sweep until the ceiling. Each pass re-attempts, then the pass after the
      // ceiling buries it.
      for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 1; i += 1) {
        await retryNotificationEffect(
          {
            effect: 'notification.retry',
            params: { notificationId: notification.id },
            source: { kind: 'event', eventId: newUuidV7() },
            subject: { streamType: 'platform.notification', streamId: notification.id },
            correlationId: newUuidV7(),
          },
          { db, logger: noopLogger },
        );
      }

      const email = (await deliveriesFor(notification.id)).find((d) => d.channel === 'email')!;
      expect(email.status).toBe('dead');
      expect(email.attempt_count).toBeGreaterThanOrEqual(MAX_DELIVERY_ATTEMPTS);

      const failures = await eventsOfType('platform.notification.delivery_failed', notification.id);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.payload).toMatchObject({ channel: 'email', kind: 'admin.test' });
    } finally {
      unregisterChannelAdapterForTests('email');
    }
  });
});

// --- Journal discipline (ADR-0010 / ADR-0019) --------------------------------

describe('journal discipline', () => {
  it('writes the notification row and its `requested` event in one transaction', async () => {
    await grant(managerA, 'line_manager');
    const roleIdValue = await roleId('line_manager');

    const before = await db
      .selectFrom('platform.domain_event')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('event_type', '=', 'platform.notification.requested')
      .executeTakeFirstOrThrow();
    const requestedBefore = Number(before.count);

    // An induced failure after the insert must roll both back.
    await expect(
      db.transaction().execute(async (trx) => {
        await requestNotification(trx, {
          kind: 'admin.test',
          recipient: { kind: 'role', roleId: roleIdValue },
          payload: { note: 'doomed', resolvedVia: 'role' },
          requestedBy: admin,
          correlationId: newUuidV7(),
          now: new Date(),
        });
        throw new Error('induced');
      }),
    ).rejects.toThrow('induced');

    expect(await db.selectFrom('platform.notification').selectAll().execute()).toHaveLength(0);
    // The event went with it. Counted rather than listed, because the journal is
    // append-only and carries every earlier test's rows.
    const after = await db
      .selectFrom('platform.domain_event')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('event_type', '=', 'platform.notification.requested')
      .executeTakeFirstOrThrow();
    expect(Number(after.count)).toBe(requestedBefore);
  });

  it('carries ids and codes only — never the rendered content (ADR-0019)', async () => {
    await grant(managerA, 'line_manager');
    const notification = await requestTest(
      { kind: 'role', roleId: await roleId('line_manager') },
      { note: 'a distinctive phrase nobody should find in the journal' },
    );
    await dispatch(notification.id);

    const events = await db
      .selectFrom('platform.domain_event')
      .select(['event_type', 'payload'])
      .where('event_type', 'like', 'platform.notification.%')
      .execute();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const json = JSON.stringify(event.payload);
      expect(json).not.toContain('a distinctive phrase');
      expect(json).not.toContain(notification.title);
      expect(json).not.toContain(notification.body);
    }
  });

  it('carries the dispatch effect so the relay fans it onto the effects queue', async () => {
    // §9.6: the payload-carried-effects rule, exercised end to end rather than
    // asserted in prose. Without this the notification would be journalled and
    // never sent.
    await grant(managerA, 'line_manager');
    const notification = await requestTest({ kind: 'role', roleId: await roleId('line_manager') });

    const [event] = await eventsOfType('platform.notification.requested', notification.id);
    const messages = effectMessagesFor(event!);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.envelope).toMatchObject({
      effect: 'notification.dispatch',
      params: { notificationId: notification.id },
      source: { kind: 'event', eventId: event!.id },
      subject: { streamType: 'platform.notification', streamId: notification.id },
    });
    expect(messages[0]!.messageId).toBe(`e:${event!.id}:notification.dispatch`);
  });
});

// --- Reminders (AC-D2 / AC-D7) -----------------------------------------------

describe('the reminder loop', () => {
  const KIND = 'test.chase';
  let satisfied = false;

  beforeEach(() => {
    satisfied = false;
    registerReminderKind({
      reminderKind: KIND,
      registeredBy: 'test',
      isSatisfied: () => Promise.resolve(satisfied),
      describe: () =>
        Promise.resolve({
          sourceLabel: 'test item',
          label: 'Something outstanding',
          dueDate: null,
          actionUrl: '/tasks',
        }),
    });
  });

  afterEach(() => unregisterReminderKindForTests(KIND));

  async function fireDueOccurrences(): Promise<number> {
    const due = await db
      .selectFrom('platform.scheduled_action')
      .selectAll()
      .where('action_type', '=', 'notification.reminder')
      .where('status', '=', 'pending')
      .where('due_at', '<=', new Date())
      .execute();

    for (const row of due) {
      await db
        .updateTable('platform.scheduled_action')
        .set({ status: 'enqueued', enqueued_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      await reminderEffect(
        {
          effect: 'notification.reminder',
          params: row.payload as Record<string, never>,
          source: { kind: 'scheduled_action', scheduledActionId: row.id },
          subject: { streamType: row.subject_stream_type!, streamId: row.subject_stream_id! },
          correlationId: newUuidV7(),
        },
        { db, logger: noopLogger },
      );
    }
    return due.length;
  }

  it('chases an unsatisfied source and schedules the next occurrence', async () => {
    const managerRole = await roleId('line_manager');
    await grant(managerA, 'line_manager');
    const sourceId = newUuidV7();
    await db.transaction().execute((trx) =>
      scheduleReminder(trx, {
        reminderKind: KIND,
        source: { streamType: 'platform.test_source', streamId: sourceId },
        recipient: { kind: 'role', roleId: managerRole },
        anchor: { mode: 'from_now' },
        cadenceRef: `config:${qualifiedName(notificationsDefaultReminderCadence)}`,
        timeZone: 'Europe/London',
        actorPersonId: admin,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    expect(await fireDueOccurrences()).toBe(1);

    const chases = await db
      .selectFrom('platform.notification')
      .selectAll()
      .where('kind', '=', 'reminder.chase')
      .execute();
    expect(chases).toHaveLength(1);
    expect(chases[0]!.dedupe_key).toBe(`reminder:platform.test_source:${sourceId}:${KIND}:1`);

    // The next occurrence exists, a day out, with the occurrence number bumped.
    const next = await db
      .selectFrom('platform.scheduled_action')
      .selectAll()
      .where('action_type', '=', 'notification.reminder')
      .where('status', '=', 'pending')
      .execute();
    expect(next).toHaveLength(1);
    expect((next[0]!.payload as { occurrence: number }).occurrence).toBe(2);

    const chased = await eventsOfType('platform.reminder.chased', sourceId);
    expect(chased).toHaveLength(1);
    expect(chased[0]!.stream_type).toBe('platform.test_source');
    expect(chased[0]!.payload).toMatchObject({ occurrence: 1, cadence: 'P1D' });
  });

  // AC-D2: recurrence stops the moment the source is satisfied.
  it('stops the moment the source is satisfied, sending nothing further', async () => {
    const managerRole = await roleId('line_manager');
    await grant(managerA, 'line_manager');
    const sourceId = newUuidV7();
    await db.transaction().execute((trx) =>
      scheduleReminder(trx, {
        reminderKind: KIND,
        source: { streamType: 'platform.test_source', streamId: sourceId },
        recipient: { kind: 'role', roleId: managerRole },
        anchor: { mode: 'from_now' },
        cadenceRef: `config:${qualifiedName(notificationsDefaultReminderCadence)}`,
        timeZone: 'Europe/London',
        actorPersonId: admin,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );
    await fireDueOccurrences();
    expect(
      await db
        .selectFrom('platform.notification')
        .select('id')
        .where('kind', '=', 'reminder.chase')
        .execute(),
    ).toHaveLength(1);

    // Satisfy it, and bring the next occurrence forward so it fires.
    satisfied = true;
    await db
      .updateTable('platform.scheduled_action')
      .set({ due_at: new Date(Date.now() - 1000) })
      .where('action_type', '=', 'notification.reminder')
      .where('status', '=', 'pending')
      .execute();

    await fireDueOccurrences();

    // No second chase, and the series is recorded as complete.
    expect(
      await db
        .selectFrom('platform.notification')
        .select('id')
        .where('kind', '=', 'reminder.chase')
        .execute(),
    ).toHaveLength(1);
    const completed = await eventsOfType('platform.reminder.completed', sourceId);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toMatchObject({ reason: 'satisfied' });
    // And nothing further is pending.
    expect(
      await db
        .selectFrom('platform.scheduled_action')
        .select('id')
        .where('action_type', '=', 'notification.reminder')
        .where('status', '=', 'pending')
        .execute(),
    ).toHaveLength(0);
  });

  // AC-D7: an administrator changes the cadence; the next occurrence follows it.
  it('re-reads the cadence as-at each firing, so a config change needs no release', async () => {
    const managerRole = await roleId('line_manager');
    await grant(managerA, 'line_manager');
    const sourceId = newUuidV7();
    await db.transaction().execute((trx) =>
      scheduleReminder(trx, {
        reminderKind: KIND,
        source: { streamType: 'platform.test_source', streamId: sourceId },
        recipient: { kind: 'role', roleId: managerRole },
        anchor: { mode: 'from_now' },
        cadenceRef: `config:${qualifiedName(notificationsDefaultReminderCadence)}`,
        timeZone: 'Europe/London',
        actorPersonId: admin,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    await db.transaction().execute((trx) =>
      setConfig(trx, {
        def: notificationsDefaultReminderCadence,
        value: 'P1W',
        actorPersonId: admin,
        correlationId: newUuidV7(),
      }),
    );

    const before = Date.now();
    await fireDueOccurrences();

    const next = await db
      .selectFrom('platform.scheduled_action')
      .selectAll()
      .where('action_type', '=', 'notification.reminder')
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();
    const daysOut = (next.due_at.getTime() - before) / 86_400_000;
    expect(daysOut).toBeGreaterThan(6.5);
    expect(daysOut).toBeLessThan(7.5);

    const chased = await eventsOfType('platform.reminder.chased', sourceId);
    expect(chased[0]!.payload).toMatchObject({ cadence: 'P1W' });
  });

  it('cancels eagerly when the satisfying transaction says so', async () => {
    const managerRole = await roleId('line_manager');
    const sourceId = newUuidV7();
    await db.transaction().execute((trx) =>
      scheduleReminder(trx, {
        reminderKind: KIND,
        source: { streamType: 'platform.test_source', streamId: sourceId },
        recipient: { kind: 'role', roleId: managerRole },
        anchor: { mode: 'from_now' },
        cadenceRef: `config:${qualifiedName(notificationsDefaultReminderCadence)}`,
        timeZone: 'Europe/London',
        actorPersonId: admin,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    const cancelled = await db.transaction().execute((trx) =>
      cancelReminders(trx, {
        source: { streamType: 'platform.test_source', streamId: sourceId },
        reason: 'source completed',
        actorPersonId: admin,
        correlationId: newUuidV7(),
      }),
    );
    expect(cancelled).toBe(1);
    expect(await fireDueOccurrences()).toBe(0);
  });

  it('sends one chase when an occurrence is fired twice', async () => {
    const managerRole = await roleId('line_manager');
    await grant(managerA, 'line_manager');
    const sourceId = newUuidV7();
    await db.transaction().execute((trx) =>
      scheduleReminder(trx, {
        reminderKind: KIND,
        source: { streamType: 'platform.test_source', streamId: sourceId },
        recipient: { kind: 'role', roleId: managerRole },
        anchor: { mode: 'from_now' },
        cadenceRef: `config:${qualifiedName(notificationsDefaultReminderCadence)}`,
        timeZone: 'Europe/London',
        actorPersonId: admin,
        correlationId: newUuidV7(),
        now: new Date(),
      }),
    );

    const row = await db
      .selectFrom('platform.scheduled_action')
      .selectAll()
      .where('action_type', '=', 'notification.reminder')
      .executeTakeFirstOrThrow();
    await db
      .updateTable('platform.scheduled_action')
      .set({ status: 'enqueued', enqueued_at: new Date() })
      .where('id', '=', row.id)
      .execute();

    const envelope = {
      effect: 'notification.reminder',
      params: row.payload as Record<string, never>,
      source: { kind: 'scheduled_action' as const, scheduledActionId: row.id },
      subject: { streamType: row.subject_stream_type!, streamId: row.subject_stream_id! },
      correlationId: newUuidV7(),
    };
    await reminderEffect(envelope, { db, logger: noopLogger });
    // The redelivery. The claim on the timer row absorbs it.
    await reminderEffect(envelope, { db, logger: noopLogger });

    expect(
      await db
        .selectFrom('platform.notification')
        .select('id')
        .where('kind', '=', 'reminder.chase')
        .execute(),
    ).toHaveLength(1);
  });
});

// --- The tRPC surface --------------------------------------------------------

describe('platform.notifications — the inbox', () => {
  async function seedInbox(count: number): Promise<void> {
    await grant(managerA, 'line_manager');
    const roleIdValue = await roleId('line_manager');
    for (let i = 0; i < count; i += 1) {
      const notification = await requestTest(
        { kind: 'role', roleId: roleIdValue },
        {
          note: `message ${i}`,
        },
      );
      await dispatch(notification.id);
    }
  }

  it('pages the whole set in order, with no duplicates and no gaps', async () => {
    await seedInbox(25);
    const caller = await callerFor(managerA);

    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await caller.platform.notifications.myList({ limit: 7, cursor });
      seen.push(...result.items.map((i) => i.deliveryId));
      cursor = result.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);

    // Newest first: the sequence must be strictly descending by (createdAt, id).
    const all = await caller.platform.notifications.myList({ limit: 50 });
    expect(all.items.map((i) => i.deliveryId)).toEqual(seen);
  });

  it('filters to unread in SQL, over the whole set rather than a page', async () => {
    await seedInbox(12);
    const caller = await callerFor(managerA);

    const firstPage = await caller.platform.notifications.myList({ limit: 5 });
    for (const item of firstPage.items) {
      await caller.platform.notifications.markRead({ deliveryId: item.deliveryId });
    }

    const unread = await caller.platform.notifications.myList({ limit: 50, unreadOnly: true });
    expect(unread.items).toHaveLength(7);
    expect(unread.items.every((i) => i.readAt === null)).toBe(true);

    const { count } = await caller.platform.notifications.myUnreadCount();
    expect(count).toBe(7);
  });

  it('refuses to mark another person’s delivery read, and leaves the row untouched', async () => {
    await seedInbox(1);
    const caller = await callerFor(managerA);
    const [item] = (await caller.platform.notifications.myList({ limit: 1 })).items;

    const intruder = await callerFor(outsider);
    const result = await intruder.platform.notifications.markRead({ deliveryId: item!.deliveryId });
    expect(result.updated).toBe(false);

    const row = await db
      .selectFrom('platform.notification_delivery')
      .select('read_at')
      .where('id', '=', item!.deliveryId)
      .executeTakeFirstOrThrow();
    expect(row.read_at).toBeNull();
  });

  it('marks all read for the caller only', async () => {
    await seedInbox(3);
    await grant(outsider, 'line_manager');
    const other = await requestTest({ kind: 'role', roleId: await roleId('line_manager') });
    await dispatch(other.id);

    const caller = await callerFor(managerA);
    await caller.platform.notifications.markAllRead();
    expect((await caller.platform.notifications.myUnreadCount()).count).toBe(0);

    const outsiderCaller = await callerFor(outsider);
    expect((await outsiderCaller.platform.notifications.myUnreadCount()).count).toBe(1);
  });

  it('hides expired notifications from the inbox and the badge alike', async () => {
    await seedInbox(2);
    await db
      .updateTable('platform.notification')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();

    const caller = await callerFor(managerA);
    expect((await caller.platform.notifications.myList({ limit: 50 })).items).toHaveLength(0);
    expect((await caller.platform.notifications.myUnreadCount()).count).toBe(0);
  });

  it('denies sendTest and adminDeliveries to a non-administrator', async () => {
    const caller = await callerFor(managerA);
    await expect(
      caller.platform.notifications.sendTest({
        recipient: { kind: 'role', roleId: await roleId('line_manager') },
      }),
    ).rejects.toThrow(/Requires one of/);
    await expect(caller.platform.notifications.adminDeliveries({})).rejects.toThrow(
      /Requires one of/,
    );
  });

  it('reports zero resolved recipients honestly from sendTest', async () => {
    // The answer that matters: a send-test reporting success while resolving to
    // nobody would hide exactly the misconfiguration it exists to surface.
    const caller = await callerFor(admin);
    const result = await caller.platform.notifications.sendTest({
      recipient: { kind: 'role', roleId: await roleId('director') },
    });
    expect(result.resolvedRecipients).toBe(0);
  });

  it('surfaces suppressed and failed deliveries to the admin diagnostics', async () => {
    await grant(managerA, 'line_manager');
    await db.transaction().execute((trx) =>
      setConfig(trx, {
        def: notificationsChannelEmailEnabled,
        value: false,
        actorPersonId: admin,
        correlationId: newUuidV7(),
      }),
    );
    const notification = await requestTest({ kind: 'role', roleId: await roleId('line_manager') });
    await dispatch(notification.id);

    const caller = await callerFor(admin);
    const suppressed = await caller.platform.notifications.adminDeliveries({
      status: ['suppressed'],
    });
    expect(suppressed.items).toHaveLength(1);
    expect(suppressed.items[0]).toMatchObject({ channel: 'email', status: 'suppressed' });

    // The filter is SQL: asking for a status nothing has returns nothing.
    const dead = await caller.platform.notifications.adminDeliveries({ status: ['dead'] });
    expect(dead.items).toHaveLength(0);
  });
});
