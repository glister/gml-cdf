import * as React from 'react';

/* Ported from the CD Fencing Design System (components/actions/Button).
   The brand's capsule-shaped action control. Function-first: clear states,
   generous hit area. Use this — not the stock shadcn button — for design-system
   surfaces. */

type Variant = 'primary' | 'secondary' | 'neutral' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const SIZES: Record<Size, { padding: string; fontSize: string; height: number; gap: number }> = {
  sm: { padding: '6px 14px', fontSize: 'var(--text-sm)', height: 32, gap: 6 },
  md: { padding: '9px 20px', fontSize: 'var(--text-base)', height: 40, gap: 8 },
  lg: { padding: '12px 26px', fontSize: 'var(--text-md)', height: 48, gap: 10 },
};

interface VariantSpec {
  background: string;
  color: string;
  border: string;
  hoverBg: string;
  hoverBd: string;
  pressBg: string;
}

const VARIANTS: Record<Variant, VariantSpec> = {
  primary: {
    background: 'var(--brand)',
    color: 'var(--text-on-brand)',
    border: '1.5px solid var(--brand)',
    hoverBg: 'var(--brand-hover)',
    hoverBd: 'var(--brand-hover)',
    pressBg: 'var(--brand-press)',
  },
  secondary: {
    background: 'transparent',
    color: 'var(--brand)',
    border: '1.5px solid var(--brand)',
    hoverBg: 'var(--brand-subtle)',
    hoverBd: 'var(--brand-hover)',
    pressBg: 'var(--green-100)',
  },
  neutral: {
    background: 'var(--surface-card)',
    color: 'var(--text-strong)',
    border: '1.5px solid var(--border-default)',
    hoverBg: 'var(--gray-50)',
    hoverBd: 'var(--border-strong)',
    pressBg: 'var(--gray-100)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--text-body)',
    border: '1.5px solid transparent',
    hoverBg: 'var(--gray-100)',
    hoverBd: 'transparent',
    pressBg: 'var(--gray-200)',
  },
  danger: {
    background: 'var(--status-danger)',
    color: '#fff',
    border: '1.5px solid var(--status-danger)',
    hoverBg: '#b23a31',
    hoverBd: '#b23a31',
    pressBg: '#9c3229',
  },
};

export interface CdButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'style'
> {
  variant?: Variant;
  size?: Size;
  shape?: 'pill' | 'square';
  fullWidth?: boolean;
  startIcon?: React.ReactNode;
  endIcon?: React.ReactNode;
  style?: React.CSSProperties;
}

export function CdButton({
  variant = 'primary',
  size = 'md',
  shape = 'pill',
  fullWidth = false,
  disabled = false,
  startIcon = null,
  endIcon = null,
  type = 'button',
  children,
  style = {},
  ...rest
}: CdButtonProps) {
  const sz = SIZES[size] || SIZES.md;
  const vr = VARIANTS[variant] || VARIANTS.primary;
  const radius = shape === 'pill' ? 'var(--radius-pill)' : 'var(--radius-md)';
  const baseBd = vr.border.split(' ').pop() as string;

  const restore = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) return;
    e.currentTarget.style.background = vr.background;
    e.currentTarget.style.borderColor = baseBd;
    e.currentTarget.style.transform = 'none';
  };

  return (
    <button
      type={type}
      disabled={disabled}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = vr.hoverBg;
        e.currentTarget.style.borderColor = vr.hoverBd;
      }}
      onMouseLeave={restore}
      onMouseDown={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = vr.pressBg;
        e.currentTarget.style.transform = 'translateY(0.5px)';
      }}
      onMouseUp={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = vr.hoverBg;
        e.currentTarget.style.transform = 'none';
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: sz.gap,
        padding: sz.padding,
        minHeight: sz.height,
        fontFamily: 'var(--font-sans)',
        fontSize: sz.fontSize,
        fontWeight: 600,
        lineHeight: 1,
        letterSpacing: '0.005em',
        background: vr.background,
        color: vr.color,
        border: vr.border,
        borderRadius: radius,
        cursor: disabled ? 'not-allowed' : 'pointer',
        width: fullWidth ? '100%' : 'auto',
        opacity: disabled ? 0.45 : 1,
        transition:
          'background var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard), transform var(--duration-fast) var(--ease-standard)',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        ...style,
      }}
      {...rest}
    >
      {startIcon && <span style={{ display: 'inline-flex', flexShrink: 0 }}>{startIcon}</span>}
      {children}
      {endIcon && <span style={{ display: 'inline-flex', flexShrink: 0 }}>{endIcon}</span>}
    </button>
  );
}
