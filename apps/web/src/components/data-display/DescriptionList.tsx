import * as React from 'react';
import { cn } from '~/lib/utils';

/* Ported from the CD Fencing Design System (components/data-display/DescriptionList),
   translated to Tailwind. Key-value pairs for record detail pages. Values may be
   any node (a StatusPill, PersonCell, mono reference). `columns` 1 or 2 (two
   collapses responsively to one when narrow); `bordered` draws a divider under
   each row; put per-field controls in `action`. */

export interface DescriptionItem {
  term: React.ReactNode;
  value: React.ReactNode;
  action?: React.ReactNode;
  mono?: boolean;
}

export interface DescriptionListProps {
  items: DescriptionItem[];
  columns?: 1 | 2;
  bordered?: boolean;
  className?: string;
}

export function DescriptionList({
  items,
  columns = 2,
  bordered = false,
  className,
}: DescriptionListProps) {
  return (
    <dl
      className={cn(
        columns >= 2
          ? cn('grid grid-cols-1 gap-x-8 sm:grid-cols-2', bordered ? 'gap-y-0' : 'gap-y-[18px]')
          : cn('flex flex-col', bordered ? 'gap-0' : 'gap-3.5'),
        className,
      )}
    >
      {items.map((it, i) => (
        <div
          key={i}
          className={cn(
            'flex min-w-0 flex-col gap-1',
            bordered && 'border-b border-border-subtle py-2.5',
          )}
        >
          <div className="flex items-center justify-between gap-2.5">
            <dt className="font-sans text-xs font-semibold text-muted">{it.term}</dt>
            {it.action}
          </div>
          <dd
            className={cn(
              'm-0 min-w-0 break-words font-medium leading-snug text-strong',
              it.mono ? 'font-mono text-sm' : 'font-sans text-base',
            )}
          >
            {it.value === null || it.value === undefined || it.value === '' ? (
              <span className="text-disabled">—</span>
            ) : (
              it.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
