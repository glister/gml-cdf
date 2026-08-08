import type { CalendarLegendEntry } from '@repo/trpc';
import { ColourSwatch } from './EventBar';

/**
 * The colour key (core plan 12 §5.3; design system
 * `components/calendar/CalendarLegend`).
 *
 * **Every entry comes from the feed**, not from a local table of colours. The
 * server resolves the colour in one SQL `CASE` and reports which dimension won
 * (§6), and the legend is grouped from the very rows on screen — so the swatch
 * beside a bar and the swatch in the key are the same value by construction,
 * and the key never lists a colour for something the viewer cannot see.
 *
 * The approved/requested distinction is spelled out here because it is a
 * *treatment*, not a colour: solid versus outlined-and-hatched.
 */

export function CalendarLegend({ entries }: { entries: readonly CalendarLegendEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {entries.map((entry) => (
          <li key={`${entry.by}:${entry.key}`} className="flex items-center gap-2">
            <ColourSwatch colour={entry.colour} />
            <span className="font-sans text-2xs font-semibold leading-none text-body">
              {entry.label}
            </span>
          </li>
        ))}
      </ul>

      <span aria-hidden="true" className="h-4 w-px bg-border-subtle" />

      <ul className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <li className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-[11px] shrink-0 rounded-[3px] border border-gray-500 bg-gray-500"
          />
          <span className="font-sans text-2xs font-semibold leading-none text-body">Approved</span>
        </li>
        <li className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-[11px] shrink-0 rounded-[3px] border border-gray-500"
            style={{
              backgroundImage:
                'repeating-linear-gradient(135deg, rgba(107,118,132,0.25) 0 4px, transparent 4px 8px)',
            }}
          />
          <span className="font-sans text-2xs font-semibold leading-none text-body">Requested</span>
        </li>
      </ul>
    </div>
  );
}
