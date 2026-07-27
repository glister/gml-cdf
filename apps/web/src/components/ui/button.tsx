import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '~/lib/utils';

/**
 * The CD Fencing Design System action control (design project group
 * `components/actions/Button`), translated to Tailwind utilities backed by the
 * `@theme` tokens (apps/web/src/app.css). Capsule-shaped by default, echoing the
 * brand's oval logo; function-first with clear hover/press/focus states.
 */
const buttonVariants = cva(
  'inline-flex select-none items-center justify-center whitespace-nowrap font-sans font-semibold leading-none tracking-[0.005em] transition-[background-color,border-color,transform] duration-100 ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:pointer-events-none disabled:opacity-45 active:translate-y-[0.5px]',
  {
    variants: {
      variant: {
        primary:
          'border-[1.5px] border-brand bg-brand text-on-brand hover:border-brand-hover hover:bg-brand-hover active:bg-brand-press',
        secondary:
          'border-[1.5px] border-brand bg-transparent text-brand hover:border-brand-hover hover:bg-brand-subtle active:bg-green-100',
        neutral:
          'border-[1.5px] border-border-default bg-surface-card text-strong hover:border-border-strong hover:bg-gray-50 active:bg-gray-100',
        ghost:
          'border-[1.5px] border-transparent bg-transparent text-body hover:bg-gray-100 active:bg-gray-200',
        danger:
          'border-[1.5px] border-status-danger bg-status-danger text-white hover:brightness-95 active:brightness-90',
      },
      size: {
        sm: 'min-h-8 gap-1.5 px-[14px] py-[6px] text-sm',
        md: 'min-h-10 gap-2 px-5 py-[9px] text-base',
        lg: 'min-h-12 gap-2.5 px-[26px] py-3 text-md',
      },
      shape: {
        pill: 'rounded-full',
        square: 'rounded-md',
      },
      fullWidth: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md', shape: 'pill', fullWidth: false },
  },
);

export interface ButtonProps
  extends
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'>,
    VariantProps<typeof buttonVariants> {
  startIcon?: React.ReactNode;
  endIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      shape,
      fullWidth,
      type = 'button',
      startIcon,
      endIcon,
      children,
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size, shape, fullWidth }), className)}
      {...props}
    >
      {startIcon && <span className="inline-flex shrink-0">{startIcon}</span>}
      {children}
      {endIcon && <span className="inline-flex shrink-0">{endIcon}</span>}
    </button>
  ),
);
Button.displayName = 'Button';

export { buttonVariants };
