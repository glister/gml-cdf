import * as React from 'react';
import { cn } from '~/lib/utils';
import { Avatar } from './Avatar.js';

/* Ported from the CD Fencing Design System (components/data-display/PersonCell),
   translated to Tailwind. The standard way a person appears in tables/lists:
   avatar + name + secondary line. `link` renders the name with link styling
   (the caller wraps it in a router Link / anchor). */

export interface PersonCellProps {
  name: string;
  secondary?: React.ReactNode;
  src?: string | null;
  size?: 'compact' | 'regular';
  link?: boolean;
  className?: string;
}

export function PersonCell({
  name,
  secondary = null,
  src = null,
  size = 'regular',
  link = false,
  className,
}: PersonCellProps) {
  const compact = size === 'compact';
  return (
    <span
      className={cn('inline-flex min-w-0 items-center', compact ? 'gap-2.5' : 'gap-3', className)}
    >
      <Avatar name={name} src={src} size={compact ? 'sm' : 'md'} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span
          className={cn(
            'truncate font-sans font-semibold text-strong',
            compact ? 'text-sm' : 'text-base',
            link && 'group-hover/person:text-link group-hover/person:underline underline-offset-2',
          )}
        >
          {name}
        </span>
        {secondary && (
          <span className={cn('truncate font-sans text-muted', compact ? 'text-2xs' : 'text-sm')}>
            {secondary}
          </span>
        )}
      </span>
    </span>
  );
}
