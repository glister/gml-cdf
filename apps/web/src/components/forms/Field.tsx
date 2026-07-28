import * as React from 'react';
import { cn } from '~/lib/utils';

/* Ported from the CD Fencing Design System (components/forms/Field), translated
   to Tailwind. Pairs a label with a control and help/error text. `error` takes
   priority over `hint` and renders in red. Works with any control as its child. */

export interface FieldProps {
  label: React.ReactNode;
  htmlFor?: string;
  required?: boolean;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export function Field({ label, htmlFor, required, hint, error, className, children }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-semibold text-body">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-status-danger">
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p className="text-sm text-status-danger">{error}</p>
      ) : hint ? (
        <p className="text-sm text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
