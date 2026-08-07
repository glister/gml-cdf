import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '~/lib/utils';

/**
 * Ported from the CD Fencing Design System (`components/forms/Checkbox`),
 * translated to Tailwind: brand-green fill, controlled or uncontrolled.
 *
 * **Why a component rather than classes on a native input.** A bare
 * `<input type="checkbox">` is drawn by the browser, and the browser draws it
 * according to the OS colour scheme — on a dark-mode machine an unchecked box
 * renders as a dark filled square, which is how it looked before this existed.
 * `accent-color` only tints the *checked* state, so it cannot fix the unchecked
 * one. The design system's answer is to hide the native control and draw the
 * box, which also gets the brand green and the radius for free.
 *
 * The real input stays in the DOM, absolutely positioned and transparent over
 * the box, so keyboard focus, form participation, `aria-*` and label clicks all
 * behave exactly as a native checkbox does. It is hidden with `opacity: 0`
 * rather than `display: none` for that reason.
 */

export interface CheckboxProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'size'
> {
  label?: React.ReactNode;
  /** Aligns the box with the first line of a multi-line label. */
  align?: 'center' | 'start';
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  {
    checked,
    defaultChecked,
    disabled = false,
    label,
    align = 'center',
    className,
    onChange,
    ...rest
  },
  ref,
) {
  const [internal, setInternal] = React.useState(defaultChecked ?? false);
  const isControlled = checked !== undefined;
  const on = isControlled ? checked : internal;

  return (
    <label
      className={cn(
        'inline-flex gap-2.5',
        align === 'start' ? 'items-start' : 'items-center',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className,
      )}
    >
      <span
        className={cn(
          'relative inline-flex size-5 shrink-0 items-center justify-center rounded border-[1.5px] transition-colors',
          align === 'start' && 'mt-0.5',
          on ? 'border-brand bg-brand' : 'border-border-strong bg-surface-card',
        )}
      >
        <input
          ref={ref}
          type="checkbox"
          checked={on}
          disabled={disabled}
          onChange={(e) => {
            if (!isControlled) setInternal(e.target.checked);
            onChange?.(e);
          }}
          className="absolute inset-0 m-0 cursor-[inherit] opacity-0"
          {...rest}
        />
        {on && <Check size={13} strokeWidth={3.5} className="text-white" aria-hidden="true" />}
      </span>
      {label && <span className="font-sans text-sm text-body">{label}</span>}
    </label>
  );
});
