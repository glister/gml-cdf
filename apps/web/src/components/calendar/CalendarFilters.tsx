import * as React from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Popover } from '~/components/feedback/Popover';
import { cn } from '~/lib/utils';

/**
 * The filter bar (core plan 12 §5.3, PL-022; design system
 * `components/calendar/CalendarHeader` + `components/tables/FilterMenu`).
 *
 * **It collects intent and nothing else.** Every control here writes a route
 * search parameter; the parameter goes to `platform.calendar.feed`; the feed
 * applies it as SQL. Nothing on this screen filters, sorts or hides a row it
 * has already been given (ADR-0004's hard rule, and AC-D2 asks to see it in the
 * network tab).
 */

export interface FilterOption {
  value: string;
  label: string;
}

/** A checkbox menu over a set of options — the design system's FilterMenu. */
export function FilterMenu({
  label,
  options,
  value,
  onChange,
  width = 240,
}: {
  label: string;
  options: readonly FilterOption[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  width?: number;
}) {
  const count = value.length;
  const toggle = (option: string) =>
    onChange(value.includes(option) ? value.filter((v) => v !== option) : [...value, option]);

  return (
    <Popover
      width={width}
      content={
        <div>
          <ul className="flex max-h-72 flex-col overflow-y-auto p-1.5">
            {options.map((option) => {
              const selected = value.includes(option.value);
              return (
                <li key={option.value}>
                  <button
                    type="button"
                    onClick={() => toggle(option.value)}
                    aria-pressed={selected}
                    className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left font-sans text-sm text-body hover:bg-gray-100"
                  >
                    <span
                      className={cn(
                        'inline-flex size-4 shrink-0 items-center justify-center rounded-xs border',
                        selected
                          ? 'border-brand bg-brand text-on-brand'
                          : 'border-border-default bg-surface-card',
                      )}
                    >
                      {selected && <Check size={11} strokeWidth={3} aria-hidden="true" />}
                    </span>
                    <span className="truncate">{option.label}</span>
                  </button>
                </li>
              );
            })}
            {options.length === 0 && (
              <li className="px-2 py-3 font-sans text-sm text-muted">Nothing to filter by yet.</li>
            )}
          </ul>
          {count > 0 && (
            <div className="border-t border-border-subtle p-1.5">
              <button
                type="button"
                onClick={() => onChange([])}
                className="w-full rounded-sm px-2 py-1.5 text-left font-sans text-sm font-semibold text-link hover:bg-gray-100"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      }
    >
      <button
        type="button"
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-pill border px-3.5 font-sans text-sm font-semibold transition-colors',
          count > 0
            ? 'border-border-brand bg-brand-subtle text-brand'
            : 'border-border-default bg-surface-card text-body hover:bg-gray-50',
        )}
      >
        {label}
        {count > 0 && (
          <span className="inline-flex min-w-4 items-center justify-center rounded-pill bg-brand px-1 font-sans text-2xs font-bold leading-none text-on-brand">
            {count}
          </span>
        )}
        <ChevronDown size={14} aria-hidden="true" className="opacity-70" />
      </button>
    </Popover>
  );
}

/** A capsule segmented control — the design system's SegmentedControl. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex h-9 items-center rounded-pill border border-border-default bg-surface-card p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'h-8 rounded-pill px-3.5 font-sans text-sm font-semibold transition-colors',
            value === option.value ? 'bg-brand text-on-brand' : 'text-body hover:bg-gray-50',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The status facet, as a segmented control over the feed's three values. */
export const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'approved', label: 'Approved' },
  { value: 'requested', label: 'Requested' },
] as const;

export const COLOUR_BY_OPTIONS = [
  { value: 'type', label: 'By type' },
  { value: 'team', label: 'By team' },
] as const;

export const VIEW_OPTIONS = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
] as const;

/** Wraps the toolbar so it reflows sensibly on a phone (§9.4 responsive pass). */
export function FilterBar({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}
