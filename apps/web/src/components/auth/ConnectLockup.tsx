import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '~/lib/utils';

/* Ported from the CD Fencing Design System (components/auth/ConnectLockup),
   translated to Tailwind. App icon + "Connect" wordmark + the "Business
   Operating System" strapline. Discrete sizes (the design's runtime-numeric
   sizing collapses to the sm/md/lg actually used). */

const ICON = {
  xs: 'size-9 rounded-[10px]',
  sm: 'size-11 rounded-[11px]',
  md: 'size-14 rounded-[13px]',
  lg: 'size-[72px] rounded-[17px]',
};
const WORDMARK = { xs: 'text-[21px]', sm: 'text-[37px]', md: 'text-[47px]', lg: 'text-[60px]' };
const STRAPLINE = {
  xs: 'mt-1.5 text-[8px]',
  sm: 'mt-2 text-[10px]',
  md: 'mt-2.5 text-[13px]',
  lg: 'mt-3 text-[17px]',
};

const lockupVariants = cva('inline-flex items-center font-sans', {
  variants: {
    orientation: { horizontal: 'flex-row', stacked: 'flex-col' },
    size: { xs: 'gap-2.5', sm: 'gap-3.5', md: 'gap-5', lg: 'gap-6' },
  },
  defaultVariants: { orientation: 'horizontal', size: 'md' },
});

function FallbackMark({ className }: { className: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center bg-brand', className)}>
      <svg
        className="size-[60%]"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#fff"
        strokeWidth="2.1"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M9.5 14.5 14.5 9.5" />
        <path d="M11 6.6l1.6-1.6a4 4 0 0 1 5.7 5.7L16.7 12.3" />
        <path d="M13 17.4l-1.6 1.6a4 4 0 0 1-5.7-5.7L7.3 11.7" />
      </svg>
    </span>
  );
}

export interface ConnectLockupProps extends VariantProps<typeof lockupVariants> {
  iconSrc?: string | null;
  tone?: 'light' | 'dark';
  showStrapline?: boolean;
  strapline?: string;
  className?: string;
}

export function ConnectLockup({
  iconSrc = null,
  orientation = 'horizontal',
  tone = 'light',
  size = 'md',
  showStrapline = true,
  strapline = 'Business Operating System',
  className,
}: ConnectLockupProps) {
  const light = tone === 'light';
  const s = size ?? 'md';
  const iconCls = ICON[s];
  return (
    <div className={cn(lockupVariants({ orientation, size }), className)}>
      {iconSrc ? (
        <img src={iconSrc} alt="Connect" className={cn('block shrink-0 object-cover', iconCls)} />
      ) : (
        <FallbackMark className={iconCls} />
      )}
      <div
        className={cn(
          'flex flex-col leading-none',
          orientation === 'stacked' ? 'items-center' : 'items-start',
        )}
      >
        <span
          className={cn(
            'whitespace-nowrap font-extrabold leading-none tracking-tight',
            WORDMARK[s],
            light ? 'text-white' : 'text-strong',
          )}
        >
          Connect
        </span>
        {showStrapline && (
          <span
            className={cn(
              'whitespace-nowrap font-bold uppercase leading-none tracking-[0.16em]',
              STRAPLINE[s],
              light ? 'text-green-400' : 'text-brand',
            )}
          >
            {strapline}
          </span>
        )}
      </div>
    </div>
  );
}
