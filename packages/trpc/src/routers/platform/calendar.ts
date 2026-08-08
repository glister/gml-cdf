import { TRPCError } from '@trpc/server';
import { appendEvent, newUuidV7 } from '@repo/db';
import { isGrantActive } from '@repo/domain';
import { calendarKindColours, calendarOutlookSyncEnabled, getConfig } from '@repo/config';
import {
  protectedProcedure,
  roleProcedure,
  router,
  type ContextGrant,
  type TRPCContext,
} from '../../trpc.js';
import {
  calendarFeedInput,
  demoOutlookSyncInput,
  type CalendarEvent,
  type CalendarFeedOutput,
  type CalendarLegendEntry,
  type CalendarSourceSummary,
  type DemoOutlookSyncOutput,
} from '../../schemas.js';
import { scopeFor } from '../../lib/scope.js';
import { composeFeed, type FeedRow } from '../../lib/calendar/compose.js';
import { calendarSources, type CalendarViewer } from '../../lib/calendar/registry.js';
// Side-effect import: registering a source is what puts it in the feed. The
// platform's own config-period source is the only one this plan ships; the HR
// plans add theirs the same way, and the composer needs no change for either.
import '../../lib/calendar/sources/config-periods.js';
import { demoSourceRef } from '../../lib/calendar/sources/demo.js';

/**
 * The shared calendar (core plan 12 §5.1, PL-022…024).
 *
 * `feed` is the whole capability. Everything the screen can ask for — the
 * window, the teams, the kinds, the types, approved-versus-requested, and which
 * dimension drives the colour — is a parameter of one SQL statement, and the
 * viewer's record scope is a predicate inside it (ADR-0004/ADR-0015). The web
 * filter bar collects intent; it never filters rows.
 */

/** Running the pilot rail is an Administrator act (§8). */
const calendarAdminProcedure = roleProcedure(['administrator'], { module: 'platform' });

/** The viewer, as the composer and any audience predicate see them. */
function viewerFor(ctx: TRPCContext): CalendarViewer {
  if (!ctx.actorPersonId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The acting user is not linked to a person record',
    });
  }
  const now = new Date();
  return {
    personId: ctx.actorPersonId,
    scope: scopeFor(ctx.grants, 'platform', now),
    // Evaluated per call, never pre-filtered when the context was built: an
    // expiring grant has to stop working without a re-login (plan 04).
    roleKeys: ctx.grants
      .filter((g: ContextGrant) => g.module === 'platform' && isGrantActive(g, now))
      .map((g: ContextGrant) => g.roleKey),
  };
}

/** camelCase one composed row. Formatting only — nothing is dropped or reordered. */
function toEvent(row: FeedRow): CalendarEvent {
  return {
    sourceKey: row.source_key,
    sourceRef: row.source_ref,
    personId: row.person_id,
    personLabel: row.person_label,
    teamIds: row.team_ids ?? [],
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    dayPart: row.day_part,
    kind: row.kind,
    typeRef: row.type_ref,
    label: row.label,
    status: row.status,
    visibilityClass: row.visibility_class,
    colour: row.colour,
  };
}

/**
 * The legend, built from **the rows themselves**.
 *
 * Not from a second query, and not from the configuration map: the point of
 * resolving the colour in one SQL `CASE` (§6) is that the swatch beside a bar
 * and the swatch in the legend are the same value. Deriving the legend from
 * anything but the returned rows would reintroduce exactly the divergence the
 * single expression exists to prevent — and would also list colours for kinds
 * the viewer cannot see.
 */
function legendFor(rows: FeedRow[]): CalendarLegendEntry[] {
  const entries = new Map<string, CalendarLegendEntry>();
  for (const row of rows) {
    const id = `${row.colour_by}:${row.colour_key}`;
    if (!entries.has(id)) {
      entries.set(id, {
        key: row.colour_key,
        label: row.colour_label,
        colour: row.colour,
        by: row.colour_by,
      });
    }
  }
  return [...entries.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export const calendarRouter = router({
  /**
   * The windowed, filtered, viewer-scoped union of every registered source.
   *
   * `protectedProcedure`, not a role gate: everybody with a login has a
   * calendar. What differs by role is *whose* items appear, and that is decided
   * by the scope predicate in the SQL, not by who may call this.
   */
  feed: protectedProcedure
    .input(calendarFeedInput)
    .query(async ({ ctx, input }): Promise<CalendarFeedOutput> => {
      const kindColours = await getConfig(ctx.db, calendarKindColours);

      const rows = await composeFeed(ctx.db, {
        window: { from: input.from, to: input.to },
        facets: {
          teamIds: input.teamIds,
          kinds: input.kinds,
          typeRefs: input.typeRefs,
          status: input.status,
          colourBy: input.colourBy,
        },
        viewer: viewerFor(ctx),
        kindColours,
      });

      return { events: rows.map(toEvent), legend: legendFor(rows) };
    }),

  /**
   * The registered sources, for the filter bar.
   *
   * The registry is code, so this is not a query and there is nothing to
   * paginate — the row count is fixed at build time.
   */
  sources: protectedProcedure.query((): CalendarSourceSummary[] =>
    calendarSources().map((source) => ({
      key: source.key,
      kinds: [...source.kinds],
      visibilityClass: source.visibilityClass,
      syncsToOutlook: source.outlookSync !== undefined,
    })),
  ),

  /**
   * The pilot slice (§5.1): drive create → update → cancel against the caller's
   * own Outlook calendar, with no HR module in existence.
   *
   * It emits a journal event and stops. The rail does the rest — outbox relay,
   * `calendar-sync` subscription, `@repo/m365` — which is the point: if this
   * procedure called Graph itself it would prove nothing about the thing that
   * has to work in production (ADR-0017: Graph is worker-only, queued, retried).
   */
  demoOutlookSync: calendarAdminProcedure
    .input(demoOutlookSyncInput)
    .mutation(async ({ ctx, input }): Promise<DemoOutlookSyncOutput> => {
      const actorPersonId = ctx.actorPersonId;
      const syncEnabled = await getConfig(ctx.db, calendarOutlookSyncEnabled);
      const correlationId = newUuidV7();

      if (input.action !== 'cancel' && (!input.startsOn || !input.endsOn)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'startsOn and endsOn are required to approve or amend a demo item',
        });
      }
      if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'endsOn precedes startsOn' });
      }

      // `platform.demo` is core plan 02's pseudo-entity for the pilots, and the
      // stream is the administrator whose calendar this is — the demo item has
      // no row, deliberately (§4.3).
      const envelope = {
        streamType: 'platform.demo',
        streamId: actorPersonId,
        actorPersonId,
        correlationId,
      } as const;

      const event = await ctx.db.transaction().execute((trx) => {
        switch (input.action) {
          case 'approve':
            return appendEvent(trx, {
              ...envelope,
              eventType: 'platform.demo.calendar_item_approved',
              payload: { ref: input.ref, startsOn: input.startsOn!, endsOn: input.endsOn! },
            });
          case 'amend':
            return appendEvent(trx, {
              ...envelope,
              eventType: 'platform.demo.calendar_item_rescheduled',
              payload: { ref: input.ref, startsOn: input.startsOn!, endsOn: input.endsOn! },
            });
          case 'cancel':
            return appendEvent(trx, {
              ...envelope,
              eventType: 'platform.demo.calendar_item_cancelled',
              payload: { ref: input.ref },
            });
        }
      });

      return {
        eventId: event.id,
        eventType: event.event_type,
        sourceRef: demoSourceRef(actorPersonId, input.ref),
        syncEnabled,
      };
    }),
});
