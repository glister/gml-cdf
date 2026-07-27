import * as React from 'react';
import { cn } from '~/lib/utils';

/* Ported from the CD Fencing Design System (components/feedback/Callout),
   translated to Tailwind. Inline message banner for notes, warnings and
   confirmations. `title` is the bold heading; body is `children`. */

export type CalloutTone = 'brand' | 'info' | 'success' | 'warning' | 'danger';

const TONES: Record<CalloutTone, string> = {
  brand: 'border-border-brand bg-brand-subtle text-body',
  info: 'border-state-info-border bg-state-info-bg text-state-info-text',
  success: 'border-state-success-border bg-state-success-bg text-state-success-text',
  warning: 'border-state-pending-border bg-state-pending-bg text-state-pending-text',
  danger: 'border-state-danger-border bg-state-danger-bg text-state-danger-text',
};

const ICON_TONES: Record<CalloutTone, string> = {
  brand: 'text-brand',
  info: 'text-state-info',
  success: 'text-state-success',
  warning: 'text-state-pending',
  danger: 'text-state-danger',
};

export interface CalloutProps {
  tone?: CalloutTone;
  title?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

export function Callout({ tone = 'info', title, icon, className, children }: CalloutProps) {
  return (
    <div
      className={cn(
        'flex gap-2.5 rounded-md border px-3.5 py-3 font-sans text-sm leading-normal',
        TONES[tone],
        className,
      )}
    >
      {icon && <span className={cn('mt-px inline-flex shrink-0', ICON_TONES[tone])}>{icon}</span>}
      <div className="min-w-0">
        {title && <div className="font-semibold text-strong">{title}</div>}
        {children && <div className={cn(title && 'mt-0.5')}>{children}</div>}
      </div>
    </div>
  );
}
