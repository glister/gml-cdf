import * as React from 'react';
import { cn } from '~/lib/utils';

/* Ported from the CD Fencing Design System (components/forms/Textarea),
   translated to Tailwind. Multi-line text; wrap with `Field` for label + error.
   `invalid` turns the border red. */

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, rows = 3, ...props }, ref) => (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        'w-full resize-y rounded-md border-[1.5px] bg-surface-card px-3.5 py-2.5 font-sans text-base leading-normal text-strong outline-none transition-colors placeholder:text-disabled focus-visible:ring-2 focus-visible:ring-brand/40',
        invalid
          ? 'border-status-danger'
          : 'border-border-default focus-visible:border-border-focus',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
