import * as React from 'react';
import { ConnectLockup } from './ConnectLockup.js';

/* Ported from the CD Fencing Design System (components/auth/AuthShell).
   The Connect sign-in shell: a deep-forest brand panel + a photo panel with the
   auth card floating over it, collapsing to a stacked layout below `breakpoint`. */

const DEFAULT_CONTACT = {
  address: 'Cocklebury Road, Chippenham, Wiltshire, SN15 3QE',
  phone: '01249 460187',
  email: 'info@cdfencing.co.uk',
  hours: 'Mon–Fri 08:00–17:30',
};

const DEFAULT_TAGLINE = ['One system.', 'Every part of the business.'];

function useStacked(layout: string, breakpoint: number): boolean {
  const [stacked, setStacked] = React.useState(layout === 'stacked');
  React.useEffect(() => {
    if (layout !== 'auto') {
      setStacked(layout === 'stacked');
      return undefined;
    }
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const sync = () => setStacked(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [layout, breakpoint]);
  return stacked;
}

export interface AuthShellContact {
  address: string;
  phone: string;
  email: string;
  hours?: string;
}

export interface AuthShellProps {
  lockup?: React.ReactNode;
  iconSrc?: string | null;
  tagline?: string | string[] | React.ReactNode;
  url?: string;
  backgroundImage?: string | null;
  children?: React.ReactNode;
  maxWidth?: number;
  brandPanelWidth?: string;
  layout?: 'auto' | 'split' | 'stacked';
  breakpoint?: number;
  contact?: AuthShellContact;
  footer?: React.ReactNode;
  showFooter?: boolean;
  style?: React.CSSProperties;
}

export function AuthShell({
  lockup,
  iconSrc = null,
  tagline = DEFAULT_TAGLINE,
  url = 'connect.cdfencing.co.uk',
  backgroundImage = null,
  children,
  maxWidth = 404,
  brandPanelWidth = '44%',
  layout = 'auto',
  breakpoint = 860,
  contact = DEFAULT_CONTACT,
  footer,
  showFooter = false,
  style = {},
}: AuthShellProps) {
  const stacked = useStacked(layout, breakpoint);
  const c = { ...DEFAULT_CONTACT, ...(contact || {}) };
  const brand = lockup || <ConnectLockup iconSrc={iconSrc} size={stacked ? 44 : 72} />;

  const taglineNode = Array.isArray(tagline)
    ? tagline.map((line, i) => (
        <span key={i} style={{ display: 'block' }}>
          {line}
        </span>
      ))
    : tagline;

  const card = (
    <div
      style={{
        width: '100%',
        maxWidth,
        boxSizing: 'border-box',
        background: 'var(--surface-card)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-xl)',
        padding: stacked ? 'clamp(20px, 5vw, 26px)' : 'clamp(26px, 2.4vw, 36px)',
      }}
    >
      {children}
    </div>
  );

  const footerNode = showFooter
    ? footer || (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '2px 12px',
            fontSize: 'var(--text-xs)',
            color: 'rgba(255,255,255,0.62)',
          }}
        >
          <span>{c.address}</span>
          <span aria-hidden="true">·</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{c.phone}</span>
          <span aria-hidden="true">·</span>
          <span>{c.email}</span>
        </div>
      )
    : null;

  const photo: React.CSSProperties = backgroundImage
    ? {
        backgroundImage: `url(${backgroundImage})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }
    : { background: 'linear-gradient(160deg, var(--green-700) 0%, var(--green-900) 100%)' };

  if (stacked) {
    return (
      <div
        style={{
          minHeight: '100vh',
          width: '100%',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 26,
          padding: '38px 20px 26px',
          background: 'var(--green-900)',
          fontFamily: 'var(--font-sans)',
          ...style,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center' }}>{brand}</div>
        <div style={{ display: 'flex', justifyContent: 'center' }}>{card}</div>
        <div
          style={{
            marginTop: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            paddingTop: 8,
          }}
        >
          <p
            style={{
              margin: 0,
              font: `400 var(--text-md)/1.45 var(--font-sans)`,
              color: '#FFFFFF',
            }}
          >
            {taglineNode}
          </p>
          {url && (
            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'rgba(255,255,255,0.72)' }}>
              {url}
            </p>
          )}
          {footerNode}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100%',
        display: 'flex',
        alignItems: 'stretch',
        fontFamily: 'var(--font-sans)',
        background: 'var(--green-900)',
        ...style,
      }}
    >
      {/* brand panel */}
      <div
        style={{
          width: brandPanelWidth,
          flexShrink: 0,
          boxSizing: 'border-box',
          background: 'var(--green-900)',
          color: '#FFFFFF',
          display: 'flex',
          flexDirection: 'column',
          padding: 'clamp(36px, 4.4vw, 66px)',
        }}
      >
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 'clamp(38px, 6vh, 66px)',
          }}
        >
          {brand}
          {tagline && (
            <p
              style={{
                margin: 0,
                font: '400 clamp(19px, 1.7vw, 25px)/1.45 var(--font-sans)',
                color: '#FFFFFF',
                textWrap: 'pretty',
              }}
            >
              {taglineNode}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {url && (
            <p style={{ margin: 0, fontSize: 'var(--text-base)', color: 'rgba(255,255,255,0.78)' }}>
              {url}
            </p>
          )}
          {footerNode}
        </div>
      </div>

      {/* photo panel + card */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'clamp(24px, 4vw, 64px)',
          ...photo,
        }}
      >
        {card}
      </div>
    </div>
  );
}
