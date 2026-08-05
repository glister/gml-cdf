import * as React from 'react';
import { cn } from '~/lib/utils';

/* Ported from the CD Fencing Design System (components/forms/Switch),
   translated to Tailwind: a brand-green track with a white knob, driven by a
   visually-hidden native checkbox so keyboard and screen-reader behaviour come
   from the platform rather than from ARIA we would have to maintain. */

export interface SwitchProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'size'
> {
  label?: React.ReactNode;
}

export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, label, checked, disabled, ...props }, ref) => (
    <label
      className={cn(
        'inline-flex items-center gap-2.5',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className,
      )}
    >
      <span
        className={cn(
          'relative h-6 w-10 shrink-0 rounded-full transition-colors',
          checked ? 'bg-brand' : 'bg-gray-300',
        )}
      >
        <input
          ref={ref}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          className="peer absolute inset-0 m-0 cursor-inherit opacity-0"
          {...props}
        />
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute top-[3px] size-[18px] rounded-full bg-white shadow-sm transition-[left] peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40',
            checked ? 'left-[19px]' : 'left-[3px]',
          )}
        />
      </span>
      {label && <span className="font-sans text-base text-body">{label}</span>}
    </label>
  ),
);
Switch.displayName = 'Switch';
