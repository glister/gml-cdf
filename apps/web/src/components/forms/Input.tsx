import * as React from 'react';
import { cn } from '~/lib/utils';

/* Ported from the CD Fencing Design System (components/forms/Input), translated
   to Tailwind. Single-line text input; wrap with `Field` for label + help/error.
   `invalid` turns the border red; `startIcon` renders a muted leading glyph. */

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  startIcon?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, startIcon, ...props }, ref) => {
    const control = (
      <input
        ref={ref}
        className={cn(
          'h-10 w-full rounded-md border-[1.5px] bg-surface-card px-3.5 font-sans text-base text-strong outline-none transition-colors placeholder:text-disabled focus-visible:ring-2 focus-visible:ring-brand/40 disabled:bg-gray-50 disabled:text-muted',
          invalid
            ? 'border-status-danger'
            : 'border-border-default focus-visible:border-border-focus',
          startIcon && 'pl-10',
          className,
        )}
        {...props}
      />
    );
    if (!startIcon) return control;
    return (
      <div className="relative flex items-center">
        <span className="pointer-events-none absolute left-3.5 inline-flex text-muted">
          {startIcon}
        </span>
        {control}
      </div>
    );
  },
);
Input.displayName = 'Input';
