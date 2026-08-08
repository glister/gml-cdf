import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { z } from 'zod';
import { CALENDAR_KIND_LABELS, CALENDAR_KINDS, type CalendarKind } from '@repo/trpc';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { CalendarGrid } from '~/components/calendar/CalendarGrid';
import { CalendarLegend } from '~/components/calendar/CalendarLegend';
import {
  COLOUR_BY_OPTIONS,
  FilterBar,
  FilterMenu,
  SegmentedControl,
  STATUS_OPTIONS,
  VIEW_OPTIONS,
} from '~/components/calendar/CalendarFilters';
import { addDays, addMonths, gridFor, periodTitle, startOfWeek, toKey } from '~/lib/calendar-grid';
import { cn } from '~/lib/utils';

/**
 * The shared calendar (core plan 12 §5.3, PL-022/PL-023/PL-023a).
 *
 * **All filter state is a route search parameter**, so a filtered month is a URL
 * somebody can send to a colleague, and every change refetches. That is the
 * visible consequence of the rule underneath it: the screen collects intent and
 * the SQL decides what comes back (ADR-0004). There is no `.filter()` here, and
 * there could not usefully be one — the viewer's scope is part of the query, so
 * the rows the browser never receives are the whole point.
 *
 * The window the feed is asked for is the **grid's** window, not the calendar
 * month's: a bar that begins on the 29th of the previous month has to be
 * fetched to be drawn in the leading days of the grid.
 */

const searchSchema = z.object({
  view: z.enum(['month', 'week']).default('month'),
  /** Any day in the period, `YYYY-MM-DD`. Absent means today. */
  anchor: z.iso.date().optional(),
  teams: z.array(z.uuid()).optional(),
  kinds: z.array(z.enum(CALENDAR_KINDS)).optional(),
  status: z.enum(['all', 'approved', 'requested']).default('all'),
  colourBy: z.enum(['type', 'team']).default('type'),
});

export const Route = createFileRoute('/_authenticated/calendar')({
  validateSearch: searchSchema,
  component: SharedCalendar,
});

function SharedCalendar() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const anchor = search.anchor ?? toKey(new Date());
  const { from, to } = React.useMemo(() => gridFor(search.view, anchor), [search.view, anchor]);

  const feed = trpcReact.platform.calendar.feed.useQuery({
    from,
    to,
    status: search.status,
    colourBy: search.colourBy,
    ...(search.teams?.length ? { teamIds: search.teams } : {}),
    ...(search.kinds?.length ? { kinds: search.kinds } : {}),
  });

  const sources = trpcReact.platform.calendar.sources.useQuery();

  // The team list is a reference-data read (`platform.team.list`) an ordinary
  // employee does not hold. That is not a gap to work around: an employee's feed
  // is already their own team, so a team facet would offer them one option.
  // `retry: false` and hiding the control on refusal is the honest rendering —
  // the alternative is a filter that 403s when it is opened.
  const teams = trpcReact.platform.team.list.useQuery(
    { limit: 100 },
    { retry: false, staleTime: 5 * 60_000 },
  );

  /** Every kind any registered source can emit — the filter's honest options. */
  const kindOptions = React.useMemo(() => {
    const available = new Set<CalendarKind>();
    for (const source of sources.data ?? []) for (const kind of source.kinds) available.add(kind);
    return CALENDAR_KINDS.filter((k) => available.has(k)).map((k) => ({
      value: k,
      label: CALENDAR_KIND_LABELS[k],
    }));
  }, [sources.data]);

  const teamOptions = React.useMemo(
    () => (teams.data?.items ?? []).map((team) => ({ value: team.id, label: team.name })),
    [teams.data],
  );

  const setSearch = (next: Partial<z.infer<typeof searchSchema>>): void => {
    void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  };

  const shift = (direction: -1 | 1): void => {
    setSearch({
      anchor:
        search.view === 'month'
          ? addMonths(anchor, direction)
          : addDays(startOfWeek(anchor), direction * 7),
    });
  };

  return (
    <div className="flex flex-col gap-6 pb-10">
      <PageHeader
        title="Calendar"
        description="Leave, absence, company shut-downs, blackout periods and bank holidays — everything date-shaped, scoped to what you may see."
      />

      <section className="rounded-lg border border-border-subtle bg-surface-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Previous period"
              onClick={() => shift(-1)}
              className={navButtonClass}
            >
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Next period"
              onClick={() => shift(1)}
              className={navButtonClass}
            >
              <ChevronRight size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setSearch({ anchor: toKey(new Date()) })}
              className="h-9 rounded-pill border border-border-default px-3.5 font-sans text-sm font-semibold text-body transition-colors hover:bg-gray-50"
            >
              Today
            </button>
            <h2 className="ml-1 font-sans text-md font-bold leading-snug tracking-tight text-strong">
              {periodTitle(search.view, anchor)}
            </h2>
          </div>

          <FilterBar>
            <SegmentedControl
              ariaLabel="Calendar view"
              options={VIEW_OPTIONS}
              value={search.view}
              onChange={(view) => setSearch({ view })}
            />
            <SegmentedControl
              ariaLabel="Colour by"
              options={COLOUR_BY_OPTIONS}
              value={search.colourBy}
              onChange={(colourBy) => setSearch({ colourBy })}
            />
            <SegmentedControl
              ariaLabel="Approval status"
              options={STATUS_OPTIONS}
              value={search.status}
              onChange={(status) => setSearch({ status })}
            />
            {teams.isSuccess && (
              <FilterMenu
                label="Team"
                options={teamOptions}
                value={search.teams ?? []}
                onChange={(next) => setSearch({ teams: next.length ? next : undefined })}
              />
            )}
            <FilterMenu
              label="Kind"
              width={200}
              options={kindOptions}
              value={search.kinds ?? []}
              onChange={(kinds) =>
                setSearch({ kinds: kinds.length ? (kinds as CalendarKind[]) : undefined })
              }
            />
          </FilterBar>
        </div>

        <div className="mt-4">
          {feed.isError ? (
            <Callout tone="danger" title="The calendar could not be loaded">
              {feed.error.message}
            </Callout>
          ) : (
            <div className={cn(feed.isFetching && 'opacity-60 transition-opacity')}>
              <CalendarGrid
                view={search.view}
                anchor={anchor}
                events={feed.data?.events ?? []}
                maxLanes={3}
              />
            </div>
          )}
        </div>

        {feed.data && feed.data.legend.length > 0 && (
          <div className="mt-5 border-t border-border-subtle pt-4">
            <CalendarLegend entries={feed.data.legend} />
          </div>
        )}

        {feed.data && feed.data.events.length === 0 && !feed.isFetching && (
          <p className="mt-4 font-sans text-sm text-muted">
            Nothing in this period that you can see. Leave and absence appear here once the HR
            modules are in use; shut-downs and blackout periods are set in configuration.
          </p>
        )}
      </section>
    </div>
  );
}

const navButtonClass =
  'inline-flex size-9 items-center justify-center rounded-pill border border-border-default text-body transition-colors hover:bg-gray-50';
