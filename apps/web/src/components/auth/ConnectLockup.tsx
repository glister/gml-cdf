import * as React from 'react';

/* Ported from the CD Fencing Design System (components/auth/ConnectLockup).
   App icon + "Connect" wordmark + the "Business Operating System" strapline. */

function FallbackMark({ size }: { size: number }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flexShrink: 0,
        background: 'var(--brand)',
        borderRadius: size * 0.24,
      }}
    >
      <svg
        width={size * 0.6}
        height={size * 0.6}
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

export interface ConnectLockupProps {
  iconSrc?: string | null;
  orientation?: 'horizontal' | 'stacked';
  tone?: 'light' | 'dark';
  size?: number;
  wordmarkSize?: number | null;
  showStrapline?: boolean;
  strapline?: string;
  style?: React.CSSProperties;
}

export function ConnectLockup({
  iconSrc = null,
  orientation = 'horizontal',
  tone = 'light',
  size = 56,
  wordmarkSize = null,
  showStrapline = true,
  strapline = 'Business Operating System',
  style = {},
}: ConnectLockupProps) {
  const stacked = orientation === 'stacked';
  const wm = wordmarkSize || Math.round(size * (stacked ? 0.5 : 0.84));
  const sl = Math.max(9, Math.round(wm * 0.28));
  const light = tone === 'light';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        flexDirection: stacked ? 'column' : 'row',
        gap: stacked ? size * 0.26 : size * 0.34,
        fontFamily: 'var(--font-sans)',
        ...style,
      }}
    >
      {iconSrc ? (
        <img
          src={iconSrc}
          alt="Connect"
          style={{
            width: size,
            height: size,
            flexShrink: 0,
            borderRadius: size * 0.24,
            display: 'block',
          }}
        />
      ) : (
        <FallbackMark size={size} />
      )}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: stacked ? 'center' : 'flex-start',
          lineHeight: 1,
        }}
      >
        <span
          style={{
            font: `800 ${wm}px/1 var(--font-sans)`,
            letterSpacing: 'var(--tracking-tight)',
            color: light ? '#FFFFFF' : 'var(--text-strong)',
          }}
        >
          Connect
        </span>
        {showStrapline && (
          <span
            style={{
              marginTop: Math.round(wm * 0.24),
              font: `700 ${sl}px/1 var(--font-sans)`,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: light ? 'var(--green-400)' : 'var(--brand)',
            }}
          >
            {strapline}
          </span>
        )}
      </div>
    </div>
  );
}
