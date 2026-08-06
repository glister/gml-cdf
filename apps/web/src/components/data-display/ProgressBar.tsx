import * as React from 'react';
import { cn } from '~/lib/utils';

/* Ported from the CD Fencing Design System (components/feedback/ProgressBar),
   translated to Tailwind. A thin determinate bar — restrained, functional
   motion, no indeterminate sweep here because every consumer so far knows its
   own denominator. */

export type ProgressTone = 'brand' | 'success' | 'neutral';

const FILL: Record<ProgressTone, string> = {
  brand: 'bg-brand',
  success: 'bg-state-success',
  neutral: 'bg-state-neutral',
};

export interface ProgressBarProps {
  /** 0–100. Clamped, so a caller's rounding cannot overflow the track. */
  value: number;
  tone?: ProgressTone;
  label?: string;
  className?: string;
}

export function ProgressBar({ value, tone = 'brand', label, className }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn('h-[7px] w-full overflow-hidden rounded-full bg-gray-200', className)}
    >
      <span
        className={cn('block h-full rounded-full transition-[width] duration-300', FILL[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
