import { sql } from 'kysely';
import { leaveBlackoutPeriods, leaveShutdownPeriods, qualifiedName } from '@repo/config';
import { canonicalFragment, registerCalendarSource, type CalendarWindow } from '../registry.js';

/**
 * The platform-owned calendar source (core plan 12 §4.1.2, PL-023): blackout
 * and company shut-down periods, read straight out of the configuration store.
 *
 * **Why these are configuration and not reference data (PL-005e).** A blackout
 * period is a date range with a label. It has no lifecycle, no membership, and
 * nothing points at it — a Tier-3 entity would be a table, a router, a form and
 * a migration for something whose entire content is three fields an HR user
 * edits twice a year. So it lives in `platform.config_entry` under
 * `hr.leave.blackout_periods` / `hr.leave.shutdown_periods`, which plan 06's
 * catalogue fixed and this plan registered (§6).
 *
 * **Reading `hr.*` config keys from platform code is not a boundary breach**
 * (ADR-0008). The configuration store is a platform service; the namespace is
 * the key's *owner*, not a table in another module's schema. What would be a
 * breach — and is not done here — is reading `hr.leave_booking`.
 *
 * ## As-at the window, so a past month does not get rewritten
 *
 * The fragment resolves the config entry **as at the instant the requested
 * window closes**, not "in force today". Looking back at March shows the
 * shut-down that was configured in March, not the one somebody set last week
 * (ADR-0016: "a threshold change never rewrites the past"). Looking forward at
 * a month past a **staged** change shows the staged value, because that is the
 * one that will actually be in force — plan 06 lets an administrator schedule a
 * change, and a calendar that ignored it would be lying about the future in
 * exactly the way it refuses to lie about the past.
 *
 * `platform.config_entry` windows are half-open `[valid_from, valid_to)`, so
 * "the end of the window" is the day after `to` at midnight — the first instant
 * the window no longer covers.
 */

/** Kind emitted per config key. */
const PERIOD_KINDS = {
  [qualifiedName(leaveBlackoutPeriods)]: 'blackout',
  [qualifiedName(leaveShutdownPeriods)]: 'shutdown',
} as const;

export const CONFIG_PERIOD_SOURCE_KEY = 'platform.config_period';

export const configPeriodSource = registerCalendarSource({
  key: CONFIG_PERIOD_SOURCE_KEY,
  kinds: ['blackout', 'shutdown'],
  visibilityClass: 'normal',
  fragment: (window: CalendarWindow) => configPeriodFragment(window),
});

function configPeriodFragment(window: CalendarWindow) {
  // The instant the configuration is read at — see the docblock.
  const asAt = sql`(${window.to}::date + 1)::timestamptz`;

  return canonicalFragment(
    { key: CONFIG_PERIOD_SOURCE_KEY, visibilityClass: 'normal' },
    {
      // `<key>:<position>` — unique within the source, and stable while the
      // array is. Positional rather than date-derived because two periods may
      // legitimately share dates (a blackout labelled per site, say) and a
      // colliding ref would make one of them disappear from the grid.
      sourceRef: sql`ce.key || ':' || p.ord`,
      // Organisation-wide: a shut-down applies to everybody, so it belongs to
      // nobody in particular and passes every viewer's scope.
      personId: sql`NULL`,
      startsOn: sql`p."from"`,
      endsOn: sql`p."to"`,
      kind: sql`CASE ce.namespace || '.' || ce.key
                  ${sql.join(
                    Object.entries(PERIOD_KINDS).map(
                      ([name, kind]) => sql`WHEN ${sql.lit(name)} THEN ${sql.lit(kind)}`,
                    ),
                    sql` `,
                  )}
                END`,
      label: sql`p.label`,
      // A period is a fact, not a request: there is nothing to approve.
      status: sql`'approved'`,
    },
    // `ROWS FROM (…) WITH ORDINALITY` rather than a plain column definition
    // list: Postgres refuses `WITH ORDINALITY` beside one, and the ordinality is
    // what gives each period a stable `source_ref`.
    sql`FROM platform.config_entry ce
        CROSS JOIN LATERAL ROWS FROM (
          jsonb_to_recordset(ce.value) AS ("from" date, "to" date, label text)
        ) WITH ORDINALITY AS p("from", "to", label, ord)
        WHERE ce.namespace || '.' || ce.key IN (${sql.join(
          Object.keys(PERIOD_KINDS).map((name) => sql.lit(name)),
        )})
          AND ce.valid_from <= ${asAt}
          AND (ce.valid_to IS NULL OR ce.valid_to > ${asAt})
          -- The window predicate, pushed into the fragment (§5.1 step 1).
          AND p."from" <= ${window.to}::date
          AND p."to"   >= ${window.from}::date`,
  );
}
