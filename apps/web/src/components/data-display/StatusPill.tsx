import * as React from 'react';
import { cn } from '~/lib/utils';

/* Ported from the CD Fencing Design System (components/data-display/StatusPill),
   translated to Tailwind. Small capsule with a dot + label for an entity's
   lifecycle state; consumes the state taxonomy via `tone`. Subtle tinted
   backgrounds only, never solid saturated fills. */

export type StatusTone = 'neutral' | 'info' | 'pending' | 'success' | 'danger';

const TONES: Record<StatusTone, string> = {
  neutral: 'bg-state-neutral-bg border-state-neutral-border text-state-neutral-text',
  info: 'bg-state-info-bg border-state-info-border text-state-info-text',
  pending: 'bg-state-pending-bg border-state-pending-border text-state-pending-text',
  success: 'bg-state-success-bg border-state-success-border text-state-success-text',
  danger: 'bg-state-danger-bg border-state-danger-border text-state-danger-text',
};

const DOTS: Record<StatusTone, string> = {
  neutral: 'bg-state-neutral',
  info: 'bg-state-info',
  pending: 'bg-state-pending',
  success: 'bg-state-success',
  danger: 'bg-state-danger',
};

export interface StatusPillProps {
  tone?: StatusTone;
  children: React.ReactNode;
  dot?: boolean;
  overdue?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function StatusPill({
  tone = 'neutral',
  children,
  dot = true,
  overdue = false,
  size = 'md',
  className,
}: StatusPillProps) {
  const pad = size === 'sm' ? 'px-2 py-0.5' : 'px-2.5 py-[3px]';
  const fs = size === 'sm' ? 'text-2xs' : 'text-xs';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-sans font-semibold leading-[1.4]',
          pad,
          fs,
          TONES[tone],
          className,
        )}
      >
        {dot && (
          <span aria-hidden="true" className={cn('size-[7px] shrink-0 rounded-full', DOTS[tone])} />
        )}
        {children}
      </span>
      {overdue && (
        <span
          title="Overdue"
          className={cn(
            'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-state-danger-border bg-state-danger-bg font-sans font-bold leading-[1.4] text-state-danger-text',
            pad,
            fs,
          )}
        >
          <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-state-danger" />
          Overdue
        </span>
      )}
    </span>
  );
}
