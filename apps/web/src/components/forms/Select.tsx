import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '~/lib/utils';

/* Ported from the CD Fencing Design System (components/forms/Select), translated
   to Tailwind. A styled native <select> (accessible, keyboard-native); wrap with
   `Field` for label + error. `invalid` turns the border red. */

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, invalid, children, ...props }, ref) => (
    <div className="relative flex items-center">
      <select
        ref={ref}
        className={cn(
          'h-10 w-full appearance-none rounded-md border-[1.5px] bg-surface-card pl-3.5 pr-10 font-sans text-base text-strong outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/40 disabled:bg-gray-50 disabled:text-muted',
          invalid
            ? 'border-status-danger'
            : 'border-border-default focus-visible:border-border-focus',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        size={16}
        aria-hidden="true"
        className="pointer-events-none absolute right-3.5 text-muted"
      />
    </div>
  ),
);
Select.displayName = 'Select';
