import * as React from 'react';
import type { CalendarEvent } from '@repo/trpc';
import { Popover } from '~/components/feedback/Popover';
import { cn } from '~/lib/utils';
import {
  dayWashKind,
  eventsOnDay,
  fromKey,
  gridFor,
  layoutWeek,
  toKey,
  WEEKDAYS,
  type CalendarView,
} from '~/lib/calendar-grid';
import { ColourSwatch, EventBar } from './EventBar';

/**
 * The month and week grids (core plan 12 §5.3, PL-022/PL-023).
 *
 * A CSS grid, not a calendar library. §5.3 weighed this up and the reasoning
 * held: shadcn's calendar is a react-day-picker *date picker* and cannot draw a
 * spanning bar at all, and a FullCalendar-class library brings licensing and
 * bundle weight plus a theming fight, for a **read-only** grid with no
 * drag-drop, no editing and no time-of-day lanes. Seven columns, bars positioned
 * with `grid-column: span`, and every pixel inside the design system.
 *
 * **Nothing here filters.** The events are whatever the feed returned for the
 * requested window, already scoped and faceted in SQL (ADR-0004). The grid's
 * only job is to decide which row a bar sits on.
 */

const LANE_H = 20;
const LANE_GAP = 3;

export interface CalendarGridProps {
  view: CalendarView;
  /** Any day in the period to show, `YYYY-MM-DD`. */
  anchor: string;
  events: readonly CalendarEvent[];
  /** Bars per day before a cell collapses to "+N more". */
  maxLanes?: number;
}

/**
 * The day washes for organisation-wide kinds.
 *
 * A bank holiday, a blackout or a shut-down is a property of the **day**, so it
 * tints the cell as well as drawing a bar. That is not decoration: lane overflow
 * can push a bar out of view, and "the office is shut" is precisely the fact
 * that must not be hideable by three people booking leave.
 */
const DAY_WASH: Record<string, string> = {
  bank_holiday: 'bg-state-success-bg',
  blackout: 'bg-state-danger-bg',
  shutdown: 'bg-brand-subtle',
};

export function CalendarGrid({ view, anchor, events, maxLanes = 3 }: CalendarGridProps) {
  const { weeks } = React.useMemo(() => gridFor(view, anchor), [view, anchor]);
  const today = toKey(new Date());
  const anchorMonth = anchor.slice(0, 7);

  // A week view has one row and far more vertical room, so it shows more lanes
  // before collapsing — the same grid, told it has space.
  const lanes = view === 'week' ? Math.max(maxLanes, 8) : maxLanes;
  const barsAreaH = lanes * LANE_H + (lanes - 1) * LANE_GAP;

  return (
    <div className="font-sans">
      <div className="grid grid-cols-7 border-l border-t border-border-subtle">
        {WEEKDAYS.map((day, i) => (
          <div
            key={day}
            className={cn(
              'border-b border-r border-border-subtle px-2.5 py-2',
              'font-sans text-2xs font-bold uppercase leading-none tracking-caps text-muted',
              i >= 5 ? 'bg-gray-50' : 'bg-surface-card',
            )}
          >
            {day}
          </div>
        ))}
      </div>

      {weeks.map((week) => {
        const { segments, overflow } = layoutWeek(events, week, lanes);
        return (
          <div key={week[0]} className="relative grid grid-cols-7 border-l border-border-subtle">
            {week.map((key, col) => {
              const wash = dayWashKind(events, key);
              const weekend = col >= 5;
              const dim = view === 'month' && key.slice(0, 7) !== anchorMonth;
              const more = overflow[col] ?? 0;
              return (
                <div
                  key={key}
                  className={cn(
                    'flex flex-col border-b border-r border-border-subtle px-[5px] pb-[5px] pt-1',
                    wash ? DAY_WASH[wash] : weekend ? 'bg-gray-50' : 'bg-surface-card',
                  )}
                  style={{ minHeight: 24 + barsAreaH + 18 + 8 }}
                >
                  <div className="flex h-5 justify-end">
                    <span
                      className={cn(
                        'inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-pill px-[5px]',
                        'font-sans text-xs font-bold leading-none',
                        key === today
                          ? 'bg-brand text-on-brand'
                          : dim
                            ? 'text-disabled'
                            : weekend
                              ? 'text-muted'
                              : 'text-strong',
                      )}
                    >
                      {fromKey(key).getUTCDate()}
                    </span>
                  </div>
                  <div style={{ height: barsAreaH }} aria-hidden="true" />
                  <div className="mt-auto h-[18px]">
                    {more > 0 && (
                      <Popover
                        width={264}
                        align={col > 4 ? 'end' : 'start'}
                        content={<DayList dayKey={key} events={eventsOnDay(events, key)} />}
                      >
                        <button
                          type="button"
                          className="rounded-sm px-1 py-0.5 font-sans text-2xs font-bold leading-none text-muted hover:bg-gray-100 hover:text-body"
                        >
                          +{more} more
                        </button>
                      </Popover>
                    )}
                  </div>
                </div>
              );
            })}

            <div
              className="pointer-events-none absolute left-0 right-0 top-6 grid grid-cols-7 px-px"
              style={{ height: barsAreaH, gridAutoRows: LANE_H, rowGap: LANE_GAP }}
            >
              {segments.map((seg) => (
                <span
                  key={`${seg.event.sourceKey}:${seg.event.sourceRef}`}
                  className="pointer-events-auto block min-w-0"
                  style={{
                    gridColumn: `${seg.colStart + 1} / span ${seg.span}`,
                    gridRow: seg.lane + 1,
                  }}
                >
                  <EventBar
                    event={seg.event}
                    continuesLeft={seg.continuesLeft}
                    continuesRight={seg.continuesRight}
                  />
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The "+N more" panel: everything on that day, in feed order. */
function DayList({ dayKey, events }: { dayKey: string; events: readonly CalendarEvent[] }) {
  const date = fromKey(dayKey);
  return (
    <div className="min-w-0">
      <div className="border-b border-border-subtle px-3.5 pb-2 pt-3 font-sans text-sm font-bold leading-snug text-strong">
        {date.toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        })}
      </div>
      <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto p-2">
        {events.map((event) => (
          <li
            key={`${event.sourceKey}:${event.sourceRef}`}
            className="flex items-center gap-[9px] rounded-sm px-2 py-[7px]"
          >
            <ColourSwatch colour={event.colour} />
            <span className="min-w-0">
              <span className="block truncate font-sans text-sm font-semibold leading-snug text-strong">
                {event.personLabel ?? event.label}
              </span>
              <span className="block font-sans text-2xs leading-snug text-muted">
                {event.visibilityClass === 'restricted'
                  ? `${event.label} · detail hidden`
                  : `${event.label}${event.status === 'approved' ? '' : ' · requested'}`}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
