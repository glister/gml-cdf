import type { Transaction } from 'kysely';
import {
  appendEvent,
  isUniqueViolation,
  newUuidV7,
  type DB,
  type NotificationRecord,
} from '@repo/db';
import { cadenceDays, firstOccurrence, type ReminderAnchor } from '@repo/domain';
import { getConfig, notificationsDefaultExpiry } from '@repo/config';
import { cancelScheduledActions, scheduleAction } from '@repo/workflow';
import { renderNotification } from './notify-kinds.js';
import type { NotificationChannel } from './constants.js';
import type { RecipientSpec } from '../schemas.js';

/**
 * The notification service's transactional core (core plan 10 §5.2) — the single
 * write path for `platform.notification` and for reminder occurrences
 * (ADR-0022), and the reason no consuming capability ever grows a mail send of
 * its own.
 *
 * Every function here takes a `Transaction<DB>` rather than the root instance,
 * and that is the design rather than a convention. A state change and the
 * notification it warrants are **one business fact**: half of it committed alone
 * is a task assigned to nobody's knowledge, or a chase still running against
 * something already finished. Passing the root instance is a type error, so
 * "same transaction" is structural (ADR-0010).
 *
 * ## The send is asynchronous, and that is not a compromise
 *
 * `requestNotification` inserts the row and journals
 * `platform.notification.requested` — and stops. The event's payload carries
 * `effects: [{ name: 'notification.dispatch' }]`, which the outbox relay fans
 * onto the `effects` queue after the caller's transaction commits (plan 07
 * §5.4). So there is no moment at which a state change is committed and its
 * notification has been lost, and no dual write to get wrong: a Service Bus
 * outage delays a notification, it never desynchronises one. Sending inline
 * would put an SMTP round trip inside a database transaction, which is the
 * other way to lose both.
 *
 * ## What is deliberately absent
 *
 * There is **no `notifyPerson(personId, …)`**, and there will not be one. A
 * caller who wants to tell a specific human something wants a role, an approver
 * policy, or a contextual reference to the subject — and the right moment to say
 * so is at the call site, in review, rather than after a leaver kept receiving
 * their old team's chases for six months (PL-021, §1 anti-scope).
 */

/** The effect that dispatches a notification, and the queue name it rides on. */
export const NOTIFICATION_DISPATCH_EFFECT = 'notification.dispatch';
/** The effect that re-attempts failed deliveries with backoff (§5.6). */
export const NOTIFICATION_RETRY_EFFECT = 'notification.retry';
/** Plan 07's effect-registry name for a reminder occurrence (§4.5). */
export const REMINDER_ACTION_TYPE = 'notification.reminder';
/** The stream a notification's own events hang on (ADR-0021). */
export const NOTIFICATION_STREAM_TYPE = 'platform.notification';

export interface RequestNotificationInput {
  /** A registered kind (`notify-kinds.ts`). Unregistered throws. */
  kind: string;
  recipient: RecipientSpec;
  /** Validated against the kind's **strict** schema before anything renders. */
  payload: Record<string, unknown>;
  subject?: { streamType: string; streamId: string } | null;
  /**
   * Overrides the kind's default channels. Only the admin send-test passes this
   * — a real caller takes the kind's answer, so the per-kind configuration
   * override (§6) stays the one lever that governs volume.
   */
  channels?: readonly NotificationChannel[];
  /**
   * Idempotency key for at-least-once delivery. A second request with the same
   * key is a no-op returning `null`, which is how a redelivered reminder
   * occurrence sends exactly once (§4.5).
   */
  dedupeKey?: string | null;
  /** Overrides the configured inbox horizon. Rarely wanted. */
  expiresAt?: Date | null;
  /** `null` for system-originated — a reminder firing, a workflow effect. */
  requestedBy: string | null;
  correlationId: string;
  now: Date;
}

/**
 * Record a notification and ask for it to be sent, in the caller's transaction.
 *
 * Returns `null` when `dedupeKey` was already taken — the notification exists,
 * this call did nothing, and that is success rather than an error.
 *
 * The order matters. **Rendering happens first**, before any row is written, so
 * a kind whose payload does not fit its schema fails the caller's transaction
 * rather than leaving an unrenderable row behind. Nothing re-renders later,
 * which is why the in-app entry, the email and the diagnostics screen cannot
 * show three different things.
 */
export async function requestNotification(
  trx: Transaction<DB>,
  input: RequestNotificationInput,
): Promise<NotificationRecord | null> {
  const { def, params, rendered } = renderNotification(input.kind, input.payload);

  const channels = [...(input.channels ?? def.defaultChannels)];
  const expiry = await getConfig(trx, notificationsDefaultExpiry, { at: input.now });
  const expiresAt =
    input.expiresAt !== undefined
      ? input.expiresAt
      : new Date(input.now.getTime() + cadenceDays(expiry) * 86_400_000);

  const id = newUuidV7();
  const recipient = input.recipient;

  let row: NotificationRecord;
  try {
    row = await trx
      .insertInto('platform.notification')
      .values({
        id,
        kind: input.kind,
        recipient_kind: recipient.kind,
        recipient_role_id: recipient.kind === 'role' ? recipient.roleId : null,
        recipient_team_id: recipient.kind === 'role' ? (recipient.teamId ?? null) : null,
        recipient_policy_ref: recipient.kind === 'policy' ? recipient.policyRef : null,
        recipient_contextual: recipient.kind === 'contextual' ? recipient.ref : null,
        subject_stream_type: input.subject?.streamType ?? null,
        subject_stream_id: input.subject?.streamId ?? null,
        title: rendered.title,
        body: rendered.body,
        action_url: rendered.actionUrl,
        payload: JSON.stringify(params) as never,
        channels,
        status: 'pending',
        expires_at: expiresAt,
        dedupe_key: input.dedupeKey ?? null,
        created_by: input.requestedBy,
        updated_by: input.requestedBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (error) {
    // The partial unique index is the real guarantee, not a pre-flight SELECT
    // that would race — and it is what makes a redelivered reminder occurrence
    // idempotent without a claim ledger of its own.
    if (isUniqueViolation(error, 'notification_dedupe_key_uq')) return null;
    throw error;
  }

  await appendEvent(trx, {
    streamType: NOTIFICATION_STREAM_TYPE,
    streamId: id,
    eventType: 'platform.notification.requested',
    payload: {
      kind: input.kind,
      recipientKind: recipient.kind,
      subjectStreamType: input.subject?.streamType ?? null,
      subjectStreamId: input.subject?.streamId ?? null,
      channels,
      // The outbox record. The relay reads `payload.effects` and fans this onto
      // the `effects` queue after the caller's transaction commits — so the
      // dispatch cannot be split from the fact that asked for it (§4.4, §9.6).
      effects: [{ name: NOTIFICATION_DISPATCH_EFFECT, params: { notificationId: id } }],
    },
    actorPersonId: input.requestedBy,
    correlationId: input.correlationId,
  });

  return row;
}

// --- Reminders (§4.5) --------------------------------------------------------

export interface ScheduleReminderInput {
  /** A registered reminder kind — binds the satisfaction check (§5.5). */
  reminderKind: string;
  /** What is being chased, in journal stream vocabulary. */
  source: { streamType: string; streamId: string };
  /** Who to chase. Re-resolved at **every** firing, never a person list. */
  recipient: RecipientSpec;
  /** What the chase is about, for contextual resolution. Defaults to `source`. */
  subject?: { streamType: string; streamId: string };
  /** Where the first occurrence falls (`from_now`, an instant, a date). */
  anchor: ReminderAnchor;
  /** `config:<name>` — re-read as-at each firing, so a change needs no release. */
  cadenceRef: string;
  /** Safety valves. Serialised as ISO strings on the occurrence payload. */
  until?: { notAfter?: Date; maxOccurrences?: number };
  /** The instance whose cancellation should take the chase with it, if any. */
  workflowInstanceId?: string | null;
  /** IANA zone the cadence's wall clock is read in (core plan 08 §6). */
  timeZone: string;
  actorPersonId: string | null;
  correlationId: string;
  now: Date;
}

/**
 * Schedule the first chase, in the transaction that created the thing being
 * chased.
 *
 * A `platform.scheduled_action` row, through plan 07's `scheduleAction` — this
 * plan adds **no second timer mechanism** (§1 anti-scope). Core plans 08 and 09
 * were already writing exactly this row shape by hand before this function
 * existed; both now call it, and nothing had to be migrated because the row was
 * the same either way.
 */
export async function scheduleReminder(
  trx: Transaction<DB>,
  input: ScheduleReminderInput,
): Promise<void> {
  const dueAt = firstOccurrence(input.anchor, input.now, { timeZone: input.timeZone });
  const subject = input.subject ?? input.source;

  await scheduleAction(trx, {
    // A first occurrence whose computed instant has already passed fires on the
    // next scheduler pass — the honest behaviour for something raised after its
    // own deadline, and the reason `firstOccurrence` does not clamp.
    dueAt,
    actionType: REMINDER_ACTION_TYPE,
    payload: {
      reminderKind: input.reminderKind,
      sourceType: input.source.streamType,
      sourceId: input.source.streamId,
      recipient: input.recipient,
      subject: { streamType: subject.streamType, streamId: subject.streamId },
      cadenceRef: input.cadenceRef,
      occurrence: 1,
      timeZone: input.timeZone,
      ...(input.until
        ? {
            until: {
              ...(input.until.notAfter ? { notAfter: input.until.notAfter.toISOString() } : {}),
              ...(input.until.maxOccurrences !== undefined
                ? { maxOccurrences: input.until.maxOccurrences }
                : {}),
            },
          }
        : {}),
    },
    subject: { streamType: input.source.streamType, streamId: input.source.streamId },
    workflowInstanceId: input.workflowInstanceId ?? null,
    source: 'workflow',
    createdBy: input.actorPersonId,
    correlationId: input.correlationId,
  });
}

/**
 * Stop chasing, in the transaction that satisfied the source — the
 * cancel-on-complete contract's step 2 (§4.5).
 *
 * This is an **optimisation, not a correctness requirement**, and the difference
 * matters to every capability that consumes the contract. The reminder handler
 * re-runs the satisfaction check before every send regardless, so a consumer
 * that forgets to call this costs at most one redundant chase — never a chase
 * after completion. Making the eager cancel load-bearing would mean every future
 * HR module had to remember it, and one of them would not.
 */
export async function cancelReminders(
  trx: Transaction<DB>,
  input: {
    source: { streamType: string; streamId: string };
    reason: string;
    actorPersonId: string | null;
    correlationId: string;
  },
): Promise<number> {
  return cancelScheduledActions(trx, {
    subject: { streamType: input.source.streamType, streamId: input.source.streamId },
    actionType: REMINDER_ACTION_TYPE,
    reason: input.reason,
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });
}
