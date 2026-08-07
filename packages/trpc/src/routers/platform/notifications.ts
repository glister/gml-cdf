import { TRPCError } from '@trpc/server';
import { sql } from 'kysely';
import { protectedProcedure, roleProcedure, router, type TRPCContext } from '../../trpc.js';
import {
  adminDeliveriesInput,
  adminDeliveriesOutput,
  markNotificationReadInput,
  myNotificationsInput,
  myNotificationsOutput,
  sendTestNotificationInput,
  sendTestNotificationOutput,
  unreadCountOutput,
} from '../../schemas.js';
import { decodeCursor, encodeCursor, keysetBoundary, timestampSortKey } from '../../lib/keyset.js';
import { requestNotification } from '../../lib/notify.js';
import { resolveRecipients } from '../../lib/notify-resolve.js';
import { NotificationKindUnknownError } from '../../lib/notify-kinds.js';

/**
 * The notification service's tRPC surface (core plan 10 §5.5).
 *
 * Two shapes of procedure, and the boundary between them is the whole of §8.
 *
 * **The inbox is self-scoping.** `myList`, `myUnreadCount`, `markRead` and
 * `markAllRead` are `protectedProcedure` with no role list — not because they
 * are unguarded, but because the guard is in the SQL: every one of them carries
 * `person_id = ctx.actorPersonId` in its `WHERE`, so there is no role that could
 * be required beyond having a person record. There is deliberately **no
 * procedure that reads another person's inbox**, for any role: an administrator
 * debugging delivery uses `adminDeliveries`, which shows metadata and the
 * notification's own generic title, and never more content than the recipient
 * already received (which is already SA-023-clean by construction, §4.6).
 *
 * **The admin surface is `roleProcedure(['administrator'], { module: 'platform' })`.**
 * §5.5 says `adminProcedure`; that builder is framework-only since core plan 04
 * Q1, and the set overview's 2026-07-28 reconciliation makes the substitution
 * explicit for every plan that named it.
 *
 * Every facet — the unread filter, the diagnostics status/channel/kind filters,
 * the ordering — is a SQL `where`/`order by`. Nothing is filtered over a fetched
 * page: with keyset pagination that would silently operate on a partial set and
 * corrupt the page boundary (ADR-0004, the data-tables hard rule).
 */

/** Administrators only: send-test and delivery diagnostics (§8). */
const notificationAdmin = roleProcedure(['administrator'], { module: 'platform' });

function requireActor(ctx: TRPCContext): string {
  if (!ctx.actorPersonId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The acting user is not linked to a person record',
    });
  }
  return ctx.actorPersonId;
}

/**
 * The visibility predicate for an inbox row — the single expression the list,
 * the badge count and mark-all-read all read.
 *
 * Three clauses, and the third is the one that is easy to forget: a message past
 * its `expires_at` horizon drops out of the inbox (§6). Written once, because a
 * badge counting rows the list does not show is the classic inbox bug.
 */
const INBOX_VISIBLE_SQL = sql<boolean>`(
  d.channel = 'in_app'
  AND d.status = 'sent'
  AND (n.expires_at IS NULL OR n.expires_at > now())
  AND n.deleted_at IS NULL
)`;

export const notificationsRouter = router({
  /**
   * The signed-in person's in-app inbox, keyset-paginated.
   *
   * Ordered `created_at DESC, id DESC` — newest first, because an inbox is read
   * from the top. `unreadOnly` is `read_at IS NULL` in SQL rather than a filter
   * over the page, which is not a preference: the client holds one page, so
   * filtering there would show "3 unread" from a page that happens to contain
   * three and hide the rest.
   */
  myList: protectedProcedure
    .input(myNotificationsInput)
    .output(myNotificationsOutput)
    .query(async ({ ctx, input }) => {
      const actorPersonId = requireActor(ctx);
      const sortKey = timestampSortKey('d.created_at');

      let query = ctx.db
        .selectFrom('platform.notification_delivery as d')
        .innerJoin('platform.notification as n', 'n.id', 'd.notification_id')
        .select([
          'd.id as delivery_id',
          'n.id as notification_id',
          'n.kind',
          'n.title',
          'n.body',
          'n.action_url',
          'n.subject_stream_type',
          'n.subject_stream_id',
          'd.created_at',
          'd.read_at',
        ])
        .select(sortKey.as('sort_key'))
        // The record-level guard, in the query. There is no code path here that
        // could read another person's inbox, because the predicate is not
        // optional.
        .where('d.person_id', '=', actorPersonId)
        .where(INBOX_VISIBLE_SQL);

      if (input.unreadOnly) query = query.where('d.read_at', 'is', null);

      if (input.cursor) {
        const cursor = decodeCursor(input.cursor);
        if (cursor) query = query.where(keysetBoundary(sortKey, 'd.id', cursor, 'desc'));
      }

      const rows = await query
        .orderBy(sortKey, 'desc')
        .orderBy('d.id', 'desc')
        .limit(input.limit + 1)
        .execute();

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items.at(-1);

      return {
        items: items.map((row) => ({
          deliveryId: row.delivery_id,
          notificationId: row.notification_id,
          kind: row.kind,
          title: row.title,
          body: row.body,
          actionUrl: row.action_url,
          subjectStreamType: row.subject_stream_type,
          subjectStreamId: row.subject_stream_id,
          createdAt: row.created_at.toISOString(),
          readAt: row.read_at?.toISOString() ?? null,
        })),
        nextCursor:
          hasMore && last ? encodeCursor({ key: last.sort_key, id: last.delivery_id }) : null,
      };
    }),

  /**
   * The badge count. Polled by every authenticated page, so it is a `COUNT(*)`
   * over the partial unread index and reads the same visibility expression the
   * list does — a badge that counts rows the inbox will not show is worse than
   * no badge.
   */
  myUnreadCount: protectedProcedure.output(unreadCountOutput).query(async ({ ctx }) => {
    const actorPersonId = requireActor(ctx);
    const row = await ctx.db
      .selectFrom('platform.notification_delivery as d')
      .innerJoin('platform.notification as n', 'n.id', 'd.notification_id')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('d.person_id', '=', actorPersonId)
      .where('d.read_at', 'is', null)
      .where(INBOX_VISIBLE_SQL)
      .executeTakeFirstOrThrow();
    return { count: Number(row.count) };
  }),

  /**
   * Mark one of the caller's own deliveries read.
   *
   * `person_id` is in the `WHERE`, so marking someone else's row read is not a
   * refusal the caller can distinguish from a no-op — it simply matches nothing.
   * Already-read is also a no-op rather than an error: clicking a notification
   * twice is not a mistake worth reporting, and re-stamping `read_at` would move
   * a timestamp that already recorded the truth.
   */
  markRead: protectedProcedure.input(markNotificationReadInput).mutation(async ({ ctx, input }) => {
    const actorPersonId = requireActor(ctx);
    const updated = await ctx.db
      .updateTable('platform.notification_delivery')
      .set({ read_at: new Date(), updated_by: actorPersonId })
      .where('id', '=', input.deliveryId)
      .where('person_id', '=', actorPersonId)
      .where('channel', '=', 'in_app')
      .where('status', '=', 'sent')
      .where('read_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    // Deliberately not journalled: reading a notification is UI telemetry, not
    // a business fact (§4.4). The documented judgement call under ADR-0010.
    return { updated: updated !== undefined };
  }),

  /** Clear the badge. Touches only the caller's own unread in-app deliveries. */
  markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
    const actorPersonId = requireActor(ctx);
    const result = await ctx.db
      .updateTable('platform.notification_delivery')
      .set({ read_at: new Date(), updated_by: actorPersonId })
      .where('person_id', '=', actorPersonId)
      .where('channel', '=', 'in_app')
      .where('status', '=', 'sent')
      .where('read_at', 'is', null)
      .executeTakeFirst();
    return { updated: Number(result.numUpdatedRows ?? 0n) };
  }),

  /**
   * Fire a real end-to-end send (§9.7) — the pilot slice, and the demonstration
   * of PL-021 that needs no HR module in existence.
   *
   * It resolves the spec **twice**, and that is on purpose. The dispatch will
   * resolve it again asynchronously; this one exists so the administrator gets
   * an immediate, honest answer to "how many people did that reach?" — including
   * **zero**, which is the answer that matters. A send-test that reported
   * success while resolving to nobody would hide exactly the misconfiguration it
   * is meant to surface.
   */
  sendTest: notificationAdmin
    .input(sendTestNotificationInput)
    .output(sendTestNotificationOutput)
    .mutation(async ({ ctx, input }) => {
      const actorPersonId = requireActor(ctx);
      const now = new Date();

      try {
        const notification = await ctx.db.transaction().execute((trx) =>
          requestNotification(trx, {
            kind: 'admin.test',
            recipient: input.recipient,
            payload: { note: input.note ?? null, resolvedVia: input.recipient.kind },
            channels: input.channels,
            requestedBy: actorPersonId,
            correlationId: ctx.correlationId,
            now,
          }),
        );
        if (!notification) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'That test notification has already been requested',
          });
        }

        const resolved = await resolveRecipients(ctx.db, notification, now);
        return { notificationId: notification.id, resolvedRecipients: resolved.length };
      } catch (error) {
        if (error instanceof NotificationKindUnknownError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
        }
        throw error;
      }
    }),

  /**
   * Delivery diagnostics — where `dead`, `suppressed` and unresolved problems
   * surface (§5.5).
   *
   * Every facet is a SQL `where`, including the status and channel lists: an
   * administrator looking for "every dead email in the last week" is looking
   * across the whole table, and a client-side filter over one keyset page would
   * answer a different question convincingly.
   */
  adminDeliveries: notificationAdmin
    .input(adminDeliveriesInput)
    .output(adminDeliveriesOutput)
    .query(async ({ ctx, input }) => {
      const sortKey =
        input.sort === 'attempted_at'
          ? // Coalesced to a fixed sentinel: a null sort key breaks the row-value
            // cursor comparison outright, and a never-attempted row belongs at the
            // far end rather than nowhere (ADR-0004).
            sql<string>`to_char(coalesce(d.attempted_at, timestamptz '1970-01-01 00:00:00+00'), 'YYYY-MM-DD"T"HH24:MI:SS.US')`
          : timestampSortKey('d.created_at');

      let query = ctx.db
        .selectFrom('platform.notification_delivery as d')
        .innerJoin('platform.notification as n', 'n.id', 'd.notification_id')
        .leftJoin('platform.person as p', 'p.id', 'd.person_id')
        .select([
          'd.id as delivery_id',
          'n.id as notification_id',
          'n.kind',
          // The notification's own title and nothing more: an administrator
          // debugging delivery sees no more content than the recipient did (§8).
          'n.title',
          'd.person_id',
          'p.display_name as person_name',
          'd.resolved_via',
          'd.channel',
          'd.status',
          'd.attempt_count',
          'd.attempted_at',
          'd.last_error',
          'd.provider_ref',
          'd.read_at',
          'd.created_at',
        ])
        .select(sortKey.as('sort_key'));

      if (input.status) query = query.where('d.status', 'in', input.status);
      if (input.channel) query = query.where('d.channel', 'in', input.channel);
      if (input.kind) query = query.where('n.kind', '=', input.kind);
      if (input.personId) query = query.where('d.person_id', '=', input.personId);

      if (input.cursor) {
        const cursor = decodeCursor(input.cursor);
        if (cursor) query = query.where(keysetBoundary(sortKey, 'd.id', cursor, input.sortDir));
      }

      const rows = await query
        .orderBy(sortKey, input.sortDir)
        .orderBy('d.id', input.sortDir)
        .limit(input.limit + 1)
        .execute();

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items.at(-1);

      return {
        items: items.map((row) => ({
          deliveryId: row.delivery_id,
          notificationId: row.notification_id,
          kind: row.kind,
          title: row.title,
          personId: row.person_id,
          personName: row.person_name,
          resolvedVia: row.resolved_via,
          channel: row.channel,
          status: row.status,
          attemptCount: row.attempt_count,
          attemptedAt: row.attempted_at?.toISOString() ?? null,
          lastError: row.last_error,
          providerRef: row.provider_ref,
          readAt: row.read_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
        })),
        nextCursor:
          hasMore && last ? encodeCursor({ key: last.sort_key, id: last.delivery_id }) : null,
      };
    }),
});
