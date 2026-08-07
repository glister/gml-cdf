import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import {
  appendEvent,
  newUuidV7,
  type DB,
  type NotificationDeliveryRecord,
  type NotificationRecord,
} from '@repo/db';
import { nextOccurrence, untilReached } from '@repo/domain';
import {
  getConfig,
  notificationsChannelEmailEnabled,
  notificationsChannelInAppEnabled,
  notificationsChannelPushEnabled,
  notificationsDefaultReminderCadence,
  notificationsKindChannelOverrides,
  parseConfigRef,
  requireConfigKey,
  type ConfigKeyDef,
} from '@repo/config';
import {
  markScheduledActionExecuted,
  registerEffect,
  scheduleAction,
  type EffectHandler,
} from '@repo/workflow';
import { NOTIFICATION_CHANNELS, type NotificationChannel } from './constants.js';
import { channelAdapter } from './notify-channels.js';
import {
  NOTIFICATION_DISPATCH_EFFECT,
  NOTIFICATION_RETRY_EFFECT,
  NOTIFICATION_STREAM_TYPE,
  REMINDER_ACTION_TYPE,
  requestNotification,
} from './notify.js';
import { recipientRefOf, resolveRecipients } from './notify-resolve.js';
import { requireReminderKind } from './notify-reminders.js';
import { recipientSpecSchema } from '../schemas.js';

/**
 * The send pipeline's three effect handlers (core plan 10 §5.6).
 *
 * All three are registered in **plan 07's** effect registry and dispatched by
 * its single `effects`-queue consumer, so this plan adds no Service Bus consumer
 * of its own. They live in `@repo/trpc` beside the services they wrap, per the
 * shape core plan 08 established and the set overview's 2026-08-05
 * reconciliation records; the worker's handler barrel imports `@repo/trpc` for
 * the side effect, which is what populates the registry in that process.
 *
 * ## The one structural decision
 *
 * **Delivery rows are committed before anything is sent.** The dispatcher opens
 * a transaction to resolve recipients and insert one row per person per channel,
 * commits, and only then talks to the adapters. Sending inside the transaction
 * would put an SMTP round trip inside a database lock, and a crash mid-send
 * would roll back the record that the send happened.
 *
 * The cost is that a crash between commit and send leaves rows `pending` — which
 * is exactly the state the retry sweep exists for, and a far better failure than
 * an email nobody can prove was sent.
 *
 * ## Idempotency, in three layers
 *
 * 1. The queue's duplicate detection, keyed on the deterministic `MessageId`.
 * 2. `delivery_once_per_person_channel`, which makes the second insert a no-op.
 * 3. The status filter: only `pending`/`failed` deliveries are attempted, so a
 *    redelivered dispatch re-sends nothing that already landed.
 *
 * Layer 2 is the one that holds after the broker's dedupe window closes, and
 * layer 3 is the one that stops a duplicate producing a duplicate email.
 */

/** How many attempts a delivery gets before it is `dead`. Operational tuning. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Backoff between attempts, in minutes (§5.6). A code constant by design: this
 * is not a business decision point, it is a guess about how long a mail provider
 * stays down, and nobody at CDF has an opinion about it (§6).
 */
const RETRY_BACKOFF_MINUTES = [1, 5, 30, 120, 480];

const dispatchParams = z.object({ notificationId: z.uuid() });

/** Per-channel enablement, read as-at the send (§6, AC-D8). */
const CHANNEL_ENABLED_KEYS: Record<NotificationChannel, ConfigKeyDef<z.ZodBoolean>> = {
  in_app: notificationsChannelInAppEnabled,
  email: notificationsChannelEmailEnabled,
  push: notificationsChannelPushEnabled,
};

interface ChannelPolicy {
  enabled: Record<NotificationChannel, boolean>;
  /** Per-kind override from configuration; `undefined` = no override. */
  overrideFor: (kind: string) => readonly NotificationChannel[] | undefined;
}

async function loadChannelPolicy(db: Kysely<DB>, at: Date): Promise<ChannelPolicy> {
  const [inApp, email, push, overrides] = await Promise.all([
    getConfig(db, notificationsChannelInAppEnabled, { at }),
    getConfig(db, notificationsChannelEmailEnabled, { at }),
    getConfig(db, notificationsChannelPushEnabled, { at }),
    getConfig(db, notificationsKindChannelOverrides, { at }),
  ]);
  return {
    enabled: { in_app: inApp, email, push },
    overrideFor: (kind) => overrides[kind],
  };
}

/** Why a channel was suppressed, in the words the diagnostics screen shows. */
function suppressionReason(
  channel: NotificationChannel,
  kind: string,
  policy: ChannelPolicy,
): string | null {
  if (!policy.enabled[channel]) {
    return `the ${channel} channel is disabled in configuration`;
  }
  const override = policy.overrideFor(kind);
  if (override && !override.includes(channel)) {
    return `configuration overrides '${kind}' to [${override.join(', ') || 'no channels'}]`;
  }
  return null;
}

/**
 * `notification.dispatch` — resolve, fan out, send.
 *
 * Skips silently when the notification is already `dispatched`: that is the
 * cheapest of the three idempotency layers and the one that catches the common
 * redelivery.
 */
export const dispatchNotificationEffect: EffectHandler = async (envelope, { db, logger }) => {
  const { notificationId } = dispatchParams.parse(envelope.params);
  const now = new Date();

  const notification = await db
    .selectFrom('platform.notification')
    .selectAll()
    .where('id', '=', notificationId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();

  if (!notification) {
    // Nothing to send and nothing redelivery can fix. Not thrown: a dead-letter
    // here would be an alert about a row someone deleted.
    logger.warn('notification.dispatch: no such notification', { notificationId });
    return;
  }
  if (notification.status !== 'pending') {
    logger.info('notification.dispatch: already dispatched', { notificationId });
    return;
  }

  const policy = await loadChannelPolicy(db, now);

  // --- Phase 1: resolve and record, in one transaction -----------------------
  const recipients = await resolveRecipients(db, notification, now);

  if (recipients.length === 0) {
    // Loud, and terminal. No amount of redelivery populates an empty role, and
    // a dispatch left failing would look like an outage rather than the
    // configuration mistake it is (§5.1, §12.3).
    await db.transaction().execute(async (trx) => {
      await markDispatched(trx, notification, now);
      await appendEvent(trx, {
        streamType: NOTIFICATION_STREAM_TYPE,
        streamId: notification.id,
        eventType: 'platform.notification.unresolved',
        payload: {
          kind: notification.kind,
          recipientKind: notification.recipient_kind,
          recipientRef: recipientRefOf(notification),
        },
        actorPersonId: null,
        correlationId: envelope.correlationId,
      });
    });
    logger.warn('notification.dispatch: resolved to nobody', {
      notificationId,
      kind: notification.kind,
      recipientKind: notification.recipient_kind,
    });
    return;
  }

  const people = await db
    .selectFrom('platform.person')
    .select(['id', 'contact_email', 'given_name', 'family_name', 'display_name'])
    .where(
      'id',
      'in',
      recipients.map((r) => r.personId),
    )
    .execute();
  const personById = new Map(people.map((person) => [person.id, person]));

  await db.transaction().execute(async (trx) => {
    for (const recipient of recipients) {
      for (const channel of notification.channels) {
        const suppressed = suppressionReason(channel, notification.kind, policy);
        await trx
          .insertInto('platform.notification_delivery')
          .values({
            id: newUuidV7(),
            notification_id: notification.id,
            person_id: recipient.personId,
            resolved_via: recipient.resolvedVia,
            channel,
            status: suppressed ? 'suppressed' : 'pending',
            // Recorded, never silently skipped: "why didn't I get an email?" is
            // answerable from the row rather than from an absence (AC-D8).
            last_error: suppressed,
          })
          // The idempotency backstop. A redelivered dispatch finds every row
          // already there and inserts nothing.
          .onConflict((oc) => oc.constraint('delivery_once_per_person_channel').doNothing())
          .execute();
      }
    }
  });

  // --- Phase 2: send, outside any transaction -------------------------------
  const pending = await db
    .selectFrom('platform.notification_delivery')
    .selectAll()
    .where('notification_id', '=', notification.id)
    .where('status', 'in', ['pending', 'failed'])
    .execute();

  let anyFailed = false;
  for (const delivery of pending) {
    const person = personById.get(delivery.person_id);
    const outcome = await attemptDelivery(db, {
      delivery,
      notification,
      recipient: {
        personId: delivery.person_id,
        email: person?.contact_email ?? null,
        displayName: person?.display_name ?? 'there',
      },
      logger,
    });
    if (!outcome) anyFailed = true;
  }

  // --- Phase 3: record the outcome ------------------------------------------
  const suppressedChannels = [...new Set(notification.channels)].filter(
    (channel) => suppressionReason(channel, notification.kind, policy) !== null,
  );

  await db.transaction().execute(async (trx) => {
    await markDispatched(trx, notification, new Date());
    await appendEvent(trx, {
      streamType: NOTIFICATION_STREAM_TYPE,
      streamId: notification.id,
      eventType: 'platform.notification.sent',
      payload: {
        kind: notification.kind,
        recipientPersonIds: recipients.map((r) => r.personId),
        channels: [...notification.channels],
        suppressedChannels,
      },
      actorPersonId: null,
      correlationId: envelope.correlationId,
    });

    if (anyFailed) {
      await scheduleRetry(trx, notification, 1, envelope.correlationId);
    }
  });

  logger.info('notification.dispatch: complete', {
    notificationId,
    kind: notification.kind,
    recipients: recipients.length,
    deliveries: pending.length,
    anyFailed,
  });
};

/** Mark the message dispatched — guarded, so a race cannot double-journal. */
async function markDispatched(
  trx: Transaction<DB>,
  notification: NotificationRecord,
  at: Date,
): Promise<void> {
  await trx
    .updateTable('platform.notification')
    .set({ status: 'dispatched', dispatched_at: at })
    .where('id', '=', notification.id)
    .where('status', '=', 'pending')
    .execute();
}

interface AttemptInput {
  delivery: NotificationDeliveryRecord;
  notification: NotificationRecord;
  recipient: { personId: string; email: string | null; displayName: string };
  logger: { warn(message: string, meta?: unknown): void };
}

/**
 * Run one delivery through its adapter and record what happened. Returns `true`
 * when it landed.
 *
 * Never throws for a delivery failure: throwing would abandon the whole message
 * and re-attempt *every* delivery in it, including the ones that already
 * succeeded. The failure belongs on the row.
 */
async function attemptDelivery(db: Kysely<DB>, input: AttemptInput): Promise<boolean> {
  const { delivery, notification, recipient } = input;
  const attemptedAt = new Date();
  const adapter = channelAdapter(delivery.channel);

  let result: { ok: true; providerRef?: string | null } | { ok: false; error: string };
  if (!adapter) {
    // A missing adapter is a process that was assembled wrong — the email
    // adapter lives in `apps/worker` and is registered at boot. Recorded as a
    // failure so it retries (a redeploy fixes it) and shows up in diagnostics,
    // rather than being skipped as though the channel had been asked not to.
    result = {
      ok: false,
      error: `no adapter registered for channel '${delivery.channel}' in this process`,
    };
  } else if (delivery.channel === 'email' && !recipient.email) {
    result = { ok: false, error: 'the recipient has no email address on their person record' };
  } else {
    try {
      result = await adapter.send({ delivery, notification, recipient });
    } catch (error) {
      // An adapter that throws anyway is a bug in the adapter, not a reason to
      // lose the other deliveries in this message.
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const attemptCount = delivery.attempt_count + 1;
  if (result.ok) {
    await db
      .updateTable('platform.notification_delivery')
      .set({
        status: 'sent',
        attempt_count: attemptCount,
        attempted_at: attemptedAt,
        last_error: null,
        provider_ref: result.providerRef ?? null,
      })
      .where('id', '=', delivery.id)
      .execute();
    return true;
  }

  await db
    .updateTable('platform.notification_delivery')
    .set({
      status: 'failed',
      attempt_count: attemptCount,
      attempted_at: attemptedAt,
      last_error: result.error.slice(0, 2000),
    })
    .where('id', '=', delivery.id)
    .execute();
  input.logger.warn('notification delivery failed', {
    deliveryId: delivery.id,
    channel: delivery.channel,
    attempt: attemptCount,
    error: result.error,
  });
  return false;
}

/**
 * Schedule the next retry sweep for a notification.
 *
 * Through plan 07's `scheduleAction`, not a broker-scheduled message: ADR-0013
 * chose DB-backed timers precisely so a pending one is queryable and
 * cancellable, and a retry is a timer like any other.
 */
async function scheduleRetry(
  trx: Transaction<DB>,
  notification: NotificationRecord,
  attempt: number,
  correlationId: string,
): Promise<void> {
  const minutes = RETRY_BACKOFF_MINUTES[Math.min(attempt, RETRY_BACKOFF_MINUTES.length) - 1]!;
  await scheduleAction(trx, {
    dueAt: new Date(Date.now() + minutes * 60_000),
    actionType: NOTIFICATION_RETRY_EFFECT,
    payload: { notificationId: notification.id },
    subject: { streamType: NOTIFICATION_STREAM_TYPE, streamId: notification.id },
    source: 'system',
    createdBy: null,
    correlationId,
  });
}

/**
 * `notification.retry` — re-attempt what failed, and give up honestly.
 *
 * A delivery that has exhausted `MAX_DELIVERY_ATTEMPTS` becomes `dead` and
 * journals `platform.notification.delivery_failed`. That event is the point of
 * the whole retry mechanism: a failure that ends in silence is indistinguishable
 * from a message nobody sent, and "the email bounced five times" is something an
 * administrator can act on (AC-D4).
 */
export const retryNotificationEffect: EffectHandler = async (envelope, { db, logger }) => {
  const { notificationId } = dispatchParams.parse(envelope.params);
  const now = new Date();

  if (envelope.source.kind === 'scheduled_action') {
    const claimed = await markScheduledActionExecuted(db, envelope.source.scheduledActionId);
    if (!claimed) {
      logger.info('notification.retry: duplicate delivery ignored', { notificationId });
      return;
    }
  }

  const notification = await db
    .selectFrom('platform.notification')
    .selectAll()
    .where('id', '=', notificationId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!notification) return;

  const failed = await db
    .selectFrom('platform.notification_delivery')
    .selectAll()
    .where('notification_id', '=', notificationId)
    .where('status', 'in', ['pending', 'failed'])
    .execute();
  if (failed.length === 0) return;

  const personIds = [...new Set(failed.map((d) => d.person_id))];
  const people = await db
    .selectFrom('platform.person')
    .select(['id', 'contact_email', 'given_name', 'family_name', 'display_name'])
    .where('id', 'in', personIds)
    .execute();
  const personById = new Map(people.map((person) => [person.id, person]));

  let stillFailing = 0;
  let maxAttempts = 0;

  for (const delivery of failed) {
    if (delivery.attempt_count >= MAX_DELIVERY_ATTEMPTS) {
      await db.transaction().execute(async (trx) => {
        // Guarded on the current status so two concurrent sweeps cannot both
        // journal the death of one delivery.
        const dead = await trx
          .updateTable('platform.notification_delivery')
          .set({ status: 'dead' })
          .where('id', '=', delivery.id)
          .where('status', 'in', ['pending', 'failed'])
          .returning('id')
          .executeTakeFirst();
        if (!dead) return;
        await appendEvent(trx, {
          streamType: NOTIFICATION_STREAM_TYPE,
          streamId: notification.id,
          eventType: 'platform.notification.delivery_failed',
          payload: {
            kind: notification.kind,
            deliveryId: delivery.id,
            personId: delivery.person_id,
            channel: delivery.channel,
            attemptCount: delivery.attempt_count,
          },
          actorPersonId: null,
          correlationId: envelope.correlationId,
        });
      });
      logger.error('notification delivery dead', {
        deliveryId: delivery.id,
        channel: delivery.channel,
        attempts: delivery.attempt_count,
      });
      continue;
    }

    const person = personById.get(delivery.person_id);
    const ok = await attemptDelivery(db, {
      delivery,
      notification,
      recipient: {
        personId: delivery.person_id,
        email: person?.contact_email ?? null,
        displayName: person?.display_name ?? 'there',
      },
      logger,
    });
    if (!ok) {
      stillFailing += 1;
      maxAttempts = Math.max(maxAttempts, delivery.attempt_count + 1);
    }
  }

  if (stillFailing > 0) {
    await db.transaction().execute(async (trx) => {
      await scheduleRetry(trx, notification, maxAttempts, envelope.correlationId);
    });
  }
  logger.info('notification.retry: swept', { notificationId, stillFailing, at: now.toISOString() });
};

// --- notification.reminder ---------------------------------------------------

/**
 * The occurrence payload core plans 08 and 09 have been writing since before
 * this handler existed (§4.5). Parsed loosely on purpose — a payload written by
 * an older release must still fire, so `timeZone`, `anchor` and `until` are all
 * optional and defaulted rather than required.
 */
const reminderPayload = z.object({
  reminderKind: z.string().min(1),
  sourceType: z.string().min(1),
  sourceId: z.uuid(),
  recipient: recipientSpecSchema,
  subject: z.object({ streamType: z.string(), streamId: z.uuid() }).optional(),
  cadenceRef: z.string().min(1).optional(),
  occurrence: z.number().int().min(1).default(1),
  timeZone: z.string().default('Europe/London'),
  until: z
    .object({
      notAfter: z.iso.datetime().optional(),
      maxOccurrences: z.number().int().min(1).optional(),
    })
    .optional(),
});

/**
 * `notification.reminder` — the chase, and the place recurrence lives (§4.5).
 *
 * Everything happens in one transaction: the claim on the timer row, the
 * satisfaction check, the send request, the next occurrence and the journal
 * event. A failure anywhere rolls the claim back with it, so the occurrence is
 * redelivered rather than silently lost — which for a reminder means the chase
 * simply happens on the next scheduler pass instead of never.
 *
 * **The satisfaction check runs before every send, unconditionally.** That is
 * what makes the cancel-on-complete contract's eager half an optimisation rather
 * than a correctness requirement: the worst case if a consumer forgets to call
 * `cancelReminders` is one chase that finds the source already satisfied and
 * sends nothing.
 */
export const reminderEffect: EffectHandler = async (envelope, { db, logger }) => {
  const payload = reminderPayload.parse(envelope.params);
  const now = new Date();
  const source = { sourceType: payload.sourceType, sourceId: payload.sourceId };

  await db.transaction().execute(async (trx) => {
    if (envelope.source.kind === 'scheduled_action') {
      // Claimed **inside** the transaction, so a failure below rolls the claim
      // back and the occurrence fires again rather than vanishing.
      const claimed = await markScheduledActionExecuted(trx, envelope.source.scheduledActionId);
      if (!claimed) {
        logger.info('notification.reminder: duplicate firing ignored', source);
        return;
      }
    }

    const kind = requireReminderKind(payload.reminderKind);

    const until = payload.until
      ? {
          notAfter: payload.until.notAfter ? new Date(payload.until.notAfter) : undefined,
          maxOccurrences: payload.until.maxOccurrences,
        }
      : undefined;

    // Two ways to stop, checked before anything is sent.
    const satisfied = await kind.isSatisfied(trx, { ...source, at: now });
    const valveReached = untilReached(until, now, payload.occurrence);

    if (satisfied || valveReached) {
      await appendEvent(trx, {
        // On the **source**, not on a reminder row: a series has none, each
        // occurrence being a `scheduled_action`. The documented ADR-0021
        // exception (§4.4), and it puts "chased, then stopped" on the chased
        // thing's own trail.
        streamType: payload.sourceType,
        streamId: payload.sourceId,
        eventType: 'platform.reminder.completed',
        payload: {
          reminderKind: payload.reminderKind,
          sourceType: payload.sourceType,
          sourceId: payload.sourceId,
          reason: satisfied ? 'satisfied' : 'until_reached',
          occurrences: payload.occurrence - 1,
        },
        actorPersonId: null,
        correlationId: envelope.correlationId,
      });
      logger.info('notification.reminder: series complete', {
        ...source,
        reason: satisfied ? 'satisfied' : 'until_reached',
      });
      return;
    }

    const description = await kind.describe(trx, { ...source, at: now });
    if (!description) {
      // The source vanished between the two reads. Treated as satisfied rather
      // than as an error: chasing someone about a record they cannot open is
      // worse than not chasing.
      logger.info('notification.reminder: source gone, stopping', source);
      return;
    }

    // The cadence is re-read **as-at now** on every firing, which is the whole
    // of AC-D7: an administrator lengthening it moves the next chase for
    // everything outstanding, with no release and no backfill.
    const cadenceKey: ConfigKeyDef = payload.cadenceRef
      ? parseConfigRef(payload.cadenceRef)
      : requireConfigKey('platform.notifications.default_reminder_cadence');
    const cadence = (await getConfig(trx, cadenceKey, { at: now })) as string | null;
    const effectiveCadence =
      cadence ?? (await getConfig(trx, notificationsDefaultReminderCadence, { at: now }));

    await requestNotification(trx, {
      kind: 'reminder.chase',
      recipient: payload.recipient,
      subject: payload.subject ?? { streamType: payload.sourceType, streamId: payload.sourceId },
      payload: {
        sourceLabel: description.sourceLabel,
        label: description.label,
        occurrence: payload.occurrence,
        dueDate: description.dueDate,
        actionUrl: description.actionUrl,
      },
      // Occurrence-scoped, so a redelivered firing that got past the claim
      // still sends exactly one chase (§4.5).
      dedupeKey: `reminder:${payload.sourceType}:${payload.sourceId}:${payload.reminderKind}:${payload.occurrence}`,
      requestedBy: null,
      correlationId: envelope.correlationId,
      now,
    });

    const nextDueAt = nextOccurrence(
      effectiveCadence,
      now,
      now,
      { timeZone: payload.timeZone },
      {
        occurrence: payload.occurrence,
        until,
      },
    );

    if (nextDueAt) {
      await scheduleAction(trx, {
        dueAt: nextDueAt,
        actionType: REMINDER_ACTION_TYPE,
        payload: { ...payload, occurrence: payload.occurrence + 1 },
        subject: { streamType: payload.sourceType, streamId: payload.sourceId },
        source: 'system',
        createdBy: null,
        correlationId: envelope.correlationId,
      });
    }

    await appendEvent(trx, {
      streamType: payload.sourceType,
      streamId: payload.sourceId,
      eventType: 'platform.reminder.chased',
      payload: {
        reminderKind: payload.reminderKind,
        sourceType: payload.sourceType,
        sourceId: payload.sourceId,
        occurrence: payload.occurrence,
        // The cadence **in force at this firing** — so a change is visible in
        // the trail rather than only in its effects.
        cadence: effectiveCadence,
        nextDueAt: nextDueAt ? nextDueAt.toISOString() : null,
      },
      actorPersonId: null,
      correlationId: envelope.correlationId,
    });

    logger.info('notification.reminder: chased', {
      ...source,
      occurrence: payload.occurrence,
      cadence: effectiveCadence,
    });
  });
};

/** Effect-registry names, exported so a conformance test can assert them. */
export const NOTIFICATION_EFFECTS = {
  dispatch: NOTIFICATION_DISPATCH_EFFECT,
  retry: NOTIFICATION_RETRY_EFFECT,
  reminder: REMINDER_ACTION_TYPE,
} as const;

/** Every channel the enum knows — asserted against the config keys at load. */
for (const channel of NOTIFICATION_CHANNELS) {
  if (!CHANNEL_ENABLED_KEYS[channel]) {
    throw new Error(`no enablement config key registered for notification channel '${channel}'`);
  }
}

registerEffect(NOTIFICATION_EFFECTS.dispatch, dispatchNotificationEffect);
registerEffect(NOTIFICATION_EFFECTS.retry, retryNotificationEffect);
registerEffect(NOTIFICATION_EFFECTS.reminder, reminderEffect);
