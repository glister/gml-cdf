import type { Transaction } from 'kysely';
import { appendEvent, newUuidV7, type DB } from '@repo/db';
import { projectOutlookEvent } from '@repo/domain';
import { resolveDirectoryObjectId } from '@repo/identity';
import {
  calendarOutlookSyncEnabled,
  getConfig,
  bindingForEventType,
  type SyncableItem,
} from '@repo/trpc';
import {
  createGraphClient,
  deleteCalendarEvent,
  updateCalendarEvent,
  createCalendarEvent,
  GraphPermanentError,
  type CalendarEventBody,
  type GraphClient,
} from '@repo/m365';
import { consumeOnce } from '../lib/consume-once.js';
import { syncHash } from '../lib/sync-hash.js';
import { eventEnvelopeSchema } from '../relay/envelope.js';
import type { SubscriptionHandler } from '../types.js';

/**
 * The Outlook sync rail (core plan 12 §5.2, PL-024).
 *
 * A domain event arrives, the registry says which source bound it and to which
 * operation, the source loads the item, `@repo/domain` projects it, Graph is
 * called, and the outcome is written to `platform.calendar_sync_state` **and**
 * journalled in one transaction.
 *
 * ## Why the handler knows nothing about leave
 *
 * It resolves the binding by **event type** (`bindingForEventType`), so the HR
 * Holiday & Leave plan registers `hr.leave_booking.approved` /
 * `.cancelled` against its own source and this file does not change. That is the
 * whole point of the registry: the rail is generic over its bindings, and a
 * second module wanting Outlook sync should be a registration, not a `switch`.
 *
 * ## Three guards against at-least-once delivery, and each covers a different gap
 *
 *  1. **`consumeOnce`** — the event-consumption ledger (plan 02). A redelivered
 *     message that we already fully processed does nothing at all.
 *  2. **Graph's `transactionId`** — the sync-state row's own id, generated
 *     *before* the create call. This covers the gap `consumeOnce` cannot: a
 *     crash after Graph accepted the POST but before the transaction committed,
 *     where the ledger has no record and the calendar does.
 *  3. **The projection hash** — a redelivered amend whose projected event has
 *     not moved costs a string comparison instead of a Graph call.
 *
 * ## Nothing unapproved reaches Outlook
 *
 * Structurally: a `requested` item has no event bound to it, so there is nothing
 * to deliver. And again at execution time: `load()` returns `null` when the item
 * is no longer approved, so a redelivery arriving after a cancellation creates
 * nothing (§5.2 step 6).
 */

/** Subscription name — also the `event_consumption.consumer` key. */
const CONSUMER = 'calendar-sync';

/**
 * The organisation's timezone for all-day projection (§12.1).
 *
 * A constant, not configuration, and deliberately so: CDF is a single-site UK
 * client, and a configuration key nobody will ever change is a decision point
 * that only looks like one. When a second timezone genuinely appears it belongs
 * on the *person*, not on the organisation — so this becomes a lookup, not a
 * setting.
 */
const ORGANISATION_TIME_ZONE = 'Europe/London';

let cachedClient: GraphClient | null = null;
function graph(): GraphClient | null {
  // Built lazily and cached: `createGraphClient` returns null when credentials
  // are absent (§12.2 Q1), and building it at module load would mean a worker
  // that booted before the secret arrived never picked it up.
  cachedClient ??= createGraphClient();
  return cachedClient;
}

/** Test seam: swap the Graph client and the mailbox resolver. */
export interface CalendarSyncDeps {
  graphClient?: () => GraphClient | null;
  resolveMailbox?: typeof resolveDirectoryObjectId;
}

export const calendarOutlookSyncHandler: SubscriptionHandler = (message, ctx) =>
  handleCalendarSync(message, ctx, {});

export async function handleCalendarSync(
  message: Parameters<SubscriptionHandler>[0],
  { db, logger }: Parameters<SubscriptionHandler>[1],
  deps: CalendarSyncDeps,
): Promise<void> {
  const envelope = eventEnvelopeSchema.parse(message.body);

  // The subscription has no SQL filter locally, so it sees every relayed event.
  // Ignoring what is not ours — and completing the message — is the honest
  // semantic for an unfiltered subscription; the alternative is a dead-letter
  // queue full of events that were relayed perfectly correctly.
  const binding = bindingForEventType(envelope.eventType);
  if (!binding) return;

  const { source, operation } = binding;
  // The owning source decides how its events identify an item. The default is
  // `streamId`, which is right whenever a module's events stream on the row
  // being synced — a leave booking's do.
  const derive = source.outlookSync!.sourceRefFor;
  const sourceRef = derive ? derive(envelope) : envelope.streamId;
  if (!sourceRef) {
    logger.warn('calendar sync: event carries no identifiable item', {
      eventType: envelope.eventType,
      sourceKey: source.key,
    });
    return;
  }

  const enabled = await getConfig(db, calendarOutlookSyncEnabled);
  if (!enabled) {
    // A no-op, not a failure: the rail ships dark until CDF IT grants
    // `Calendars.ReadWrite` admin consent (§12.2 Q1), and everything else about
    // the calendar has to keep working meanwhile.
    logger.info('calendar sync is disabled; skipping', {
      eventType: envelope.eventType,
      sourceKey: source.key,
    });
    return;
  }

  const ran = await consumeOnce(db, CONSUMER, envelope.id, async (trx) => {
    const item = await source.outlookSync!.load(db, sourceRef);

    if (operation !== 'cancel' && !item) {
      // Stale redelivery: the item stopped being approved (or never was) between
      // the event being journalled and this message being handled.
      logger.info('calendar sync: item is no longer syncable; nothing created', {
        sourceKey: source.key,
        sourceRef,
      });
      return;
    }

    const state = await upsertSyncState(trx, {
      sourceKey: source.key,
      sourceRef,
      personId: item?.personId ?? null,
      operation,
    });
    if (!state) return;

    const mailbox = await (deps.resolveMailbox ?? resolveDirectoryObjectId)(db, state.person_id);
    if (!mailbox) {
      // An agency worker or candidate has no CDF mailbox. Recorded against the
      // item rather than skipped, because a source that binds a mailbox-less
      // person to the rail has a bug, and silence would hide it.
      await failSync(trx, state, envelope, source.key, sourceRef, operation, 'no_mailbox');
      return;
    }

    const client = (deps.graphClient ?? graph)();
    if (!client) {
      // Configured on, but no credential. Transient by nature — throwing asks
      // the queue to redeliver once the secret lands.
      throw new Error('Microsoft Graph is not configured but calendar sync is enabled');
    }

    try {
      await runOperation(trx, {
        client,
        mailbox,
        state,
        item,
        operation,
        envelope,
        sourceKey: source.key,
        sourceRef,
      });
    } catch (error) {
      if (error instanceof GraphPermanentError) {
        // Retrying will not fix it. Mark failed, journal a code, and stop —
        // the message completes rather than cycling to a dead-letter queue.
        await failSync(
          trx,
          state,
          envelope,
          source.key,
          sourceRef,
          operation,
          `graph_${error.status}`,
          error.message,
        );
        return;
      }
      // Transient: record the attempt and rethrow so Service Bus redelivers.
      // The rethrow rolls this transaction back, so the attempt counter is
      // deliberately bumped by the upsert above rather than here.
      throw error;
    }
  });

  if (!ran) {
    logger.debug('calendar sync: duplicate delivery ignored', { eventId: envelope.id });
  }
}

interface SyncStateRow {
  id: string;
  person_id: string;
  graph_event_id: string | null;
  last_synced_hash: string | null;
  attempts: number;
}

/**
 * Create or move the sync-state row into its pending status.
 *
 * The row's id **is** the Graph `transactionId`, which is why it is generated
 * here rather than after the call. `ON CONFLICT` on `(source_key, source_ref)`
 * is what makes a redelivered create reuse the same id, and therefore the same
 * transactionId, and therefore the same Outlook event.
 */
async function upsertSyncState(
  trx: Transaction<DB>,
  args: {
    sourceKey: string;
    sourceRef: string;
    personId: string | null;
    operation: 'create' | 'update' | 'cancel';
  },
): Promise<SyncStateRow | null> {
  const pendingStatus =
    args.operation === 'create'
      ? 'pending'
      : args.operation === 'update'
        ? 'amend_pending'
        : 'cancel_pending';

  const existing = await trx
    .selectFrom('platform.calendar_sync_state')
    .select(['id', 'person_id', 'graph_event_id', 'last_synced_hash', 'attempts'])
    .where('source_key', '=', args.sourceKey)
    .where('source_ref', '=', args.sourceRef)
    .executeTakeFirst();

  if (!existing) {
    // A cancel for something never created has nothing to cancel — and creating
    // a row for it would leave a permanent `cancel_pending` nobody can resolve.
    if (args.operation === 'cancel' || !args.personId) return null;

    const inserted = await trx
      .insertInto('platform.calendar_sync_state')
      .values({
        id: newUuidV7(),
        source_key: args.sourceKey,
        source_ref: args.sourceRef,
        person_id: args.personId,
        status: pendingStatus,
        attempts: 1,
      })
      .returning(['id', 'person_id', 'graph_event_id', 'last_synced_hash', 'attempts'])
      .executeTakeFirstOrThrow();
    return inserted;
  }

  const updated = await trx
    .updateTable('platform.calendar_sync_state')
    .set({ status: pendingStatus, attempts: existing.attempts + 1, last_error: null })
    .where('id', '=', existing.id)
    .returning(['id', 'person_id', 'graph_event_id', 'last_synced_hash', 'attempts'])
    .executeTakeFirstOrThrow();
  return updated;
}

async function runOperation(
  trx: Transaction<DB>,
  args: {
    client: GraphClient;
    mailbox: string;
    state: SyncStateRow;
    item: SyncableItem | null;
    operation: 'create' | 'update' | 'cancel';
    envelope: { id: string; correlationId: string; actorPersonId: string | null };
    sourceKey: string;
    sourceRef: string;
  },
): Promise<void> {
  const { client, mailbox, state, item, operation, envelope, sourceKey, sourceRef } = args;
  const target = { userId: mailbox };
  const journal = {
    streamType: 'platform.calendar_sync_state' as const,
    streamId: state.id,
    actorPersonId: envelope.actorPersonId,
    correlationId: envelope.correlationId,
    // The sync is a consequence of the event that triggered it (ADR-0010).
    causationId: envelope.id,
  };

  if (operation === 'cancel') {
    if (!state.graph_event_id) {
      // Cancelled before the create ever landed. The end state is already right.
      await trx
        .updateTable('platform.calendar_sync_state')
        .set({ status: 'cancelled' })
        .where('id', '=', state.id)
        .execute();
      return;
    }

    const { alreadyGone } = await deleteCalendarEvent(client, target, state.graph_event_id);
    await trx
      .updateTable('platform.calendar_sync_state')
      .set({ status: 'cancelled' })
      .where('id', '=', state.id)
      .execute();
    await appendEvent(trx, {
      ...journal,
      eventType: 'platform.calendar_sync_state.outlook_event_cancelled',
      payload: { sourceKey, sourceRef, graphEventId: state.graph_event_id, alreadyGone },
    });
    return;
  }

  const projection = projectOutlookEvent(item!, ORGANISATION_TIME_ZONE);
  const hash = syncHash(projection);
  const body: CalendarEventBody = projection;

  // An amend against an event we never created is a create. This is not
  // defensive padding: with `onAmended` bound, an item can legitimately be
  // rescheduled before its create was ever processed.
  if (operation === 'create' || !state.graph_event_id) {
    const graphEventId = await createCalendarEvent(client, target, body, state.id);
    await trx
      .updateTable('platform.calendar_sync_state')
      .set({ status: 'synced', graph_event_id: graphEventId, last_synced_hash: hash })
      .where('id', '=', state.id)
      .execute();
    await appendEvent(trx, {
      ...journal,
      eventType: 'platform.calendar_sync_state.outlook_event_created',
      payload: { sourceKey, sourceRef, graphEventId },
    });
    return;
  }

  if (hash === state.last_synced_hash) {
    // Nothing moved. Back to `synced` without troubling Graph.
    await trx
      .updateTable('platform.calendar_sync_state')
      .set({ status: 'synced' })
      .where('id', '=', state.id)
      .execute();
    return;
  }

  await updateCalendarEvent(client, target, state.graph_event_id, body);
  await trx
    .updateTable('platform.calendar_sync_state')
    .set({ status: 'synced', last_synced_hash: hash })
    .where('id', '=', state.id)
    .execute();
  await appendEvent(trx, {
    ...journal,
    eventType: 'platform.calendar_sync_state.outlook_event_updated',
    payload: { sourceKey, sourceRef, graphEventId: state.graph_event_id },
  });
}

/** Mark the item failed and journal a **code** — never Graph's message body. */
async function failSync(
  trx: Transaction<DB>,
  state: SyncStateRow,
  envelope: { id: string; correlationId: string; actorPersonId: string | null },
  sourceKey: string,
  sourceRef: string,
  operation: 'create' | 'update' | 'cancel',
  errorCode: string,
  detail?: string,
): Promise<void> {
  await trx
    .updateTable('platform.calendar_sync_state')
    .set({
      status: 'failed',
      // Truncated, and kept out of the journal entirely: a Graph error can quote
      // the request, and the request carries the subject line (ADR-0019).
      last_error: (detail ?? errorCode).slice(0, 1000),
    })
    .where('id', '=', state.id)
    .execute();

  await appendEvent(trx, {
    streamType: 'platform.calendar_sync_state',
    streamId: state.id,
    eventType: 'platform.calendar_sync_state.outlook_sync_failed',
    payload: { sourceKey, sourceRef, operation, errorCode, attempts: state.attempts },
    actorPersonId: envelope.actorPersonId,
    correlationId: envelope.correlationId,
    causationId: envelope.id,
  });
}
