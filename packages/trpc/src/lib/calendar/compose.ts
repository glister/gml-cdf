import { sql, type Expression, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import type { DB } from '@repo/db';
import { CALENDAR_KIND_LABELS } from '../constants.js';
import type {
  CalendarColourMode,
  CalendarEventStatus,
  CalendarKind,
  CalendarVisibilityClass,
} from '../constants.js';
import { allocatedPersonIds, managedPersonIds } from '../scope.js';
import {
  calendarSources,
  type CalendarSource,
  type CalendarViewer,
  type CalendarWindow,
} from './registry.js';

/**
 * The feed query (core plan 12 §5.1, PL-022/PL-023/PL-023a).
 *
 * Everything here happens in **one SQL statement** — the union, the team join,
 * the viewer's scope, every requested facet, the colour, and the ordering
 * (ADR-0004's hard rule). The browser collects intent and receives rows; it
 * never filters, sorts or re-colours them. That is not tidiness: the feed's
 * scope decides which people's absences a viewer may see at all, so a predicate
 * that ran in the browser would mean the rows had already been sent.
 *
 * The feed is a **bounded-window read, not a paginated table**, so keyset
 * pagination does not apply. The ADR-0004 obligations that do — every facet in
 * SQL, one expression for display and legend, a deterministic order,
 * real-Postgres validation — are all met.
 */

/** The window a colour came from — the legend groups on this. */
export type ColourDimension = 'type' | 'team' | 'kind';

/** One row as the composer returns it, before camelCasing. */
export interface FeedRow {
  source_key: string;
  source_ref: string;
  person_id: string | null;
  person_label: string | null;
  team_ids: string[] | null;
  starts_on: string;
  ends_on: string;
  day_part: 'am' | 'pm' | null;
  kind: CalendarKind;
  type_ref: string | null;
  label: string;
  status: CalendarEventStatus;
  visibility_class: CalendarVisibilityClass;
  colour: string;
  colour_by: ColourDimension;
  colour_key: string;
  colour_label: string;
}

export interface FeedFacets {
  teamIds?: readonly string[];
  kinds?: readonly CalendarKind[];
  typeRefs?: readonly string[];
  status: 'approved' | 'requested' | 'all';
  colourBy: CalendarColourMode;
}

export interface ComposeFeedArgs {
  window: CalendarWindow;
  facets: FeedFacets;
  viewer: CalendarViewer;
  /** Per-kind fallback colours, from `platform.calendar.kind_colours` (§6). */
  kindColours: Record<CalendarKind, string>;
  /** Defaults to every registered source; a test may pass a subset. */
  sources?: readonly CalendarSource[];
}

/**
 * The people whose items a viewer may see on the calendar.
 *
 * This is **wider than `scopePersons` alone**, and deliberately so. Plan 04's
 * ladder puts a plain employee on `self`, but HL-044 (SoW A5.3.18) requires
 * that when someone requests leave they can see their team's existing leave,
 * *including their manager's* — a calendar showing only your own days off would
 * not answer the question anybody opens it to ask.
 *
 * The widening is **team membership**, not a role exception, and that is what
 * makes it safe:
 *
 *  - an employee sees the people they share an effective-dated
 *    `platform.team_membership` with, and their own rows;
 *  - a line manager additionally sees their roster via `managedPersonIds`,
 *    because a manager is not necessarily a *member* of the team they run;
 *  - a restricted external administrator keeps `allocatedPersonIds` (CORE-05);
 *  - Administrator, HR User and Director are `all` and short-circuit;
 *  - **an external or agency worker is in no team, so the set collapses to
 *    themselves with no special case in this function.** PL-004's "own rows
 *    only" falls out of the data rather than out of a role check somebody could
 *    forget to update.
 *
 * Organisation-wide rows (`person_id IS NULL`) bypass all of it — see
 * {@link visibilityPredicate}.
 */
function teammatePersonIds(viewerPersonId: string): Expression<string> {
  return sql<string>`(
    SELECT m2.person_id
    FROM platform.team_membership m1
    JOIN platform.team_membership m2 ON m2.team_id = m1.team_id
    JOIN platform.team t ON t.id = m1.team_id
    WHERE m1.person_id = ${viewerPersonId}
      AND t.deleted_at IS NULL
      AND m1.valid_from <= current_date AND (m1.valid_to IS NULL OR m1.valid_to > current_date)
      AND m2.valid_from <= current_date AND (m2.valid_to IS NULL OR m2.valid_to > current_date)
  )`;
}

/** The uniform scope predicate over the composed union's `person_id`. */
function uniformScope(viewer: CalendarViewer): Expression<SqlBool> {
  if (viewer.scope === 'all') return sql<SqlBool>`true`;

  const own = sql<SqlBool>`src.person_id = ${viewer.personId}`;
  const teammates = sql<SqlBool>`src.person_id IN ${teammatePersonIds(viewer.personId)}`;

  switch (viewer.scope) {
    case 'team':
      return sql<SqlBool>`(${own} OR ${teammates} OR src.person_id IN ${managedPersonIds(viewer.personId)})`;
    case 'allocated':
      return sql<SqlBool>`(${own} OR ${teammates} OR src.person_id IN ${allocatedPersonIds(viewer.personId)})`;
    case 'self':
      return sql<SqlBool>`(${own} OR ${teammates})`;
  }
}

/**
 * Row visibility, per source.
 *
 * Organisation-wide rows pass every scope — a bank holiday is not somebody's
 * personal data, and a calendar that hid the Christmas shut-down from the people
 * it applies to would be absurd.
 *
 * A source declaring an `audience` predicate (PL-023a) has that predicate
 * applied to **its rows only**, *instead of* the uniform scoping. That is the
 * point of the mechanism: an occupational-health review is visible to HR, the
 * subject and the subject's line manager — a set that is narrower than
 * "teammates" in one direction and wider in another, so intersecting the two
 * would be wrong in both.
 */
function visibilityPredicate(
  viewer: CalendarViewer,
  sources: readonly CalendarSource[],
): Expression<SqlBool> {
  const uniform = uniformScope(viewer);
  const audienced = sources.filter((s) => s.audience);

  const branches: Expression<SqlBool>[] = [];

  const uniformKeys = sources.filter((s) => !s.audience).map((s) => s.key);
  if (uniformKeys.length > 0) {
    branches.push(
      sql<SqlBool>`(src.source_key IN (${sql.join(uniformKeys.map((k) => sql.lit(k)))}) AND ${uniform})`,
    );
  }
  for (const source of audienced) {
    branches.push(
      sql<SqlBool>`(src.source_key = ${sql.lit(source.key)} AND (${source.audience!(viewer)}))`,
    );
  }

  if (branches.length === 0) return sql<SqlBool>`false`;

  return sql<SqlBool>`(src.person_id IS NULL OR ${sql.join(branches, sql` OR `)})`;
}

/**
 * The colour, resolved as one `CASE` so the bar, the filter and the legend can
 * never disagree (§6).
 *
 * Order: **type colour → team colour → kind default**, with the team branch
 * live only in colour-by-team mode. The type colour is projected by the owning
 * module's own fragment (ADR-0008 — the calendar does not join `hr.leave_type`
 * itself), and a restricted source cannot supply one at all, which is what makes
 * AC-D4's "kind-level colour only" structural rather than a UI convention.
 *
 * The same expression also reports **which** dimension won, so the router can
 * build the legend by grouping the rows it is already returning rather than by
 * running a second, potentially divergent query.
 */
function colourExpressions(
  colourBy: CalendarColourMode,
  kindColours: Record<CalendarKind, string>,
): { colour: RawBuilder<string>; by: RawBuilder<ColourDimension>; key: RawBuilder<string> } {
  const kindDefault = sql<string>`COALESCE(${sql.raw(kindColourCase(kindColours))}, '#64748b')`;

  if (colourBy === 'team') {
    return {
      colour: sql<string>`COALESCE(tc.team_colour, ${kindDefault})`,
      by: sql<ColourDimension>`CASE WHEN tc.team_colour IS NOT NULL THEN 'team' ELSE 'kind' END`,
      key: sql<string>`CASE WHEN tc.team_colour IS NOT NULL THEN tc.team_id ELSE src.kind END`,
    };
  }
  return {
    colour: sql<string>`COALESCE(src.type_colour, ${kindDefault})`,
    by: sql<ColourDimension>`CASE WHEN src.type_colour IS NOT NULL THEN 'type' ELSE 'kind' END`,
    key: sql<string>`CASE WHEN src.type_colour IS NOT NULL THEN COALESCE(src.type_ref, src.kind) ELSE src.kind END`,
  };
}

/**
 * The kind fallback, inlined as literals.
 *
 * The values come from a configuration entry, and they are inlined rather than
 * bound because the map's *keys* are a fixed vocabulary and its values are
 * validated hex on write and on read by the config registry (`^#[0-9a-f]{6}$`).
 * The escape is belt-and-braces on a value that already cannot contain a quote.
 */
function kindColourCase(kindColours: Record<CalendarKind, string>): string {
  const whens = Object.entries(kindColours)
    .map(([kind, colour]) => `WHEN ${quote(kind)} THEN ${quote(colour)}`)
    .join(' ');
  return `(CASE src.kind ${whens} ELSE NULL END)`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The legend label for whichever dimension won.
 *
 * The kind fallback is written out rather than left as the raw key: a legend
 * reading `bank_holiday` is a database column leaking onto the screen, and the
 * mapping belongs beside the colours it labels rather than in the browser (§6 —
 * one expression for the bars and the key).
 */
function colourLabelExpression(colourBy: CalendarColourMode): RawBuilder<string> {
  const kindLabel = sql.raw(
    `(CASE src.kind ${Object.entries(CALENDAR_KIND_LABELS)
      .map(([kind, label]) => `WHEN ${quote(kind)} THEN ${quote(label)}`)
      .join(' ')} ELSE src.kind END)`,
  );

  if (colourBy === 'team') {
    return sql<string>`CASE WHEN tc.team_colour IS NOT NULL THEN tc.team_name ELSE ${kindLabel} END`;
  }
  return sql<string>`CASE
    WHEN src.type_colour IS NOT NULL THEN COALESCE(src.type_label, src.type_ref)
    ELSE ${kindLabel}
  END`;
}

/**
 * Compose and run the feed.
 *
 * Returns rows in a **total, deterministic order** — `starts_on, kind,
 * source_key, source_ref` — because a union has no natural order and two
 * requests returning the same rows in different orders would make the month
 * grid shuffle under the user for no reason.
 */
export async function composeFeed(db: Kysely<DB>, args: ComposeFeedArgs): Promise<FeedRow[]> {
  const sources = args.sources ?? calendarSources();
  if (sources.length === 0) return [];

  const fragments = sources.map((source) => source.fragment(args.window));
  const union = sql.join(fragments, sql` UNION ALL `);

  const { colour, by, key } = colourExpressions(args.facets.colourBy, args.kindColours);
  const colourLabel = colourLabelExpression(args.facets.colourBy);

  const facets: Expression<SqlBool>[] = [visibilityPredicate(args.viewer, sources)];

  if (args.facets.kinds && args.facets.kinds.length > 0) {
    facets.push(sql<SqlBool>`src.kind = ANY(${sql.val<string[]>([...args.facets.kinds])}::text[])`);
  }
  if (args.facets.typeRefs && args.facets.typeRefs.length > 0) {
    facets.push(
      sql<SqlBool>`src.type_ref = ANY(${sql.val<string[]>([...args.facets.typeRefs])}::text[])`,
    );
  }
  if (args.facets.status !== 'all') {
    facets.push(sql<SqlBool>`src.status = ${args.facets.status}`);
  }
  if (args.facets.teamIds && args.facets.teamIds.length > 0) {
    // Organisation-wide rows always pass a team facet: a bank holiday belongs to
    // every team, so filtering it out when someone narrows to one team would
    // remove exactly the context the narrowing was for.
    facets.push(
      sql<SqlBool>`(src.person_id IS NULL OR tm.team_ids && ${sql.val<string[]>([...args.facets.teamIds])}::uuid[])`,
    );
  }

  const query = sql<FeedRow>`
    WITH src AS (${union})
    SELECT
      src.source_key,
      src.source_ref,
      src.person_id,
      p.display_name                          AS person_label,
      COALESCE(tm.team_ids, '{}'::uuid[])     AS team_ids,
      to_char(src.starts_on, 'YYYY-MM-DD')    AS starts_on,
      to_char(src.ends_on, 'YYYY-MM-DD')      AS ends_on,
      src.day_part,
      src.kind,
      src.type_ref,
      src.label,
      src.status,
      src.visibility_class,
      ${colour}                               AS colour,
      ${by}                                   AS colour_by,
      ${key}                                  AS colour_key,
      ${colourLabel}                          AS colour_label
    FROM src
    LEFT JOIN platform.person p
      ON p.id = src.person_id AND p.deleted_at IS NULL
    LEFT JOIN LATERAL (
      -- Membership effective **during the window**, not merely today: a person
      -- who changes team mid-month should colour and filter correctly on both
      -- sides of the move rather than snapping the whole month to wherever they
      -- happen to be when the page is opened.
      SELECT array_agg(DISTINCT m.team_id) AS team_ids
      FROM platform.team_membership m
      JOIN platform.team t ON t.id = m.team_id AND t.deleted_at IS NULL
      WHERE m.person_id = src.person_id
        AND m.valid_from <= ${args.window.to}::date
        AND (m.valid_to IS NULL OR m.valid_to > ${args.window.from}::date)
    ) tm ON true
    LEFT JOIN LATERAL (
      -- The team that supplies the colour in colour-by-team mode. A person can
      -- be in several; picking the first **with a colour set**, by name, is a
      -- deterministic rule rather than a meaningful one — but a stable arbitrary
      -- choice beats a row whose colour changes between two identical requests.
      SELECT t.id::text AS team_id, t.name AS team_name, t.colour AS team_colour
      FROM platform.team_membership m
      JOIN platform.team t ON t.id = m.team_id AND t.deleted_at IS NULL
      WHERE m.person_id = src.person_id
        AND t.colour IS NOT NULL
        AND m.valid_from <= ${args.window.to}::date
        AND (m.valid_to IS NULL OR m.valid_to > ${args.window.from}::date)
      ORDER BY t.name, t.id
      LIMIT 1
    ) tc ON true
    WHERE ${sql.join(facets, sql` AND `)}
    ORDER BY src.starts_on, src.kind, src.source_key, src.source_ref
  `;

  const result = await query.execute(db);
  return result.rows;
}
