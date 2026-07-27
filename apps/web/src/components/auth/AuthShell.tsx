import * as React from 'react';
import { ConnectLockup } from './ConnectLockup.js';

/* Ported from the CD Fencing Design System (components/auth/AuthShell),
   translated to Tailwind. A deep-forest brand panel + a photo panel with the
   auth card floating over it, collapsing to a stacked layout below the `auth`
   breakpoint (860px). The split↔stacked switch is a real CSS media query
   (`auth:` variants) — no JS. The card body (`children`) is rendered ONCE; the
   surrounding brand chrome is duplicated per layout (it holds no state/ids). */

const DEFAULT_CONTACT = {
  address: 'Cocklebury Road, Chippenham, Wiltshire, SN15 3QE',
  phone: '01249 460187',
  email: 'info@cdfencing.co.uk',
};

const DEFAULT_TAGLINE = ['One system.', 'Every part of the business.'];

export interface AuthShellContact {
  address: string;
  phone: string;
  email: string;
}

export interface AuthShellProps {
  iconSrc?: string | null;
  tagline?: string | string[];
  url?: string;
  /** Site photograph shown behind the card on the split (desktop) layout. */
  backgroundImage?: string | null;
  children?: React.ReactNode;
  contact?: AuthShellContact;
  footer?: React.ReactNode;
  showFooter?: boolean;
}

export function AuthShell({
  iconSrc = null,
  tagline = DEFAULT_TAGLINE,
  url = 'connect.cdfencing.co.uk',
  backgroundImage = null,
  children,
  contact = DEFAULT_CONTACT,
  footer,
  showFooter = false,
}: AuthShellProps) {
  const c = { ...DEFAULT_CONTACT, ...(contact || {}) };
  const lines = Array.isArray(tagline) ? tagline : [tagline];
  // The photo URL is genuinely dynamic (a prop), so it rides on a CSS variable;
  // WHERE it applies (desktop only, cover/center) stays a media-query class.
  const style = backgroundImage
    ? ({ '--auth-photo': `url(${backgroundImage})` } as React.CSSProperties)
    : undefined;

  const taglineLines = lines.map((l, i) => (
    <span key={i} className="block">
      {l}
    </span>
  ));

  const footerNode = showFooter
    ? (footer ?? (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-white/60">
          <span>{c.address}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono">{c.phone}</span>
          <span aria-hidden="true">·</span>
          <span>{c.email}</span>
        </div>
      ))
    : null;

  return (
    <div
      style={style}
      className="flex min-h-screen w-full flex-col bg-green-900 font-sans auth:flex-row"
    >
      {/* Brand column — split (desktop) layout only */}
      <aside className="hidden flex-col justify-between p-[clamp(36px,4.4vw,66px)] text-white auth:flex auth:w-[44%] auth:shrink-0">
        <div className="flex flex-1 flex-col justify-center gap-[clamp(38px,6vh,66px)]">
          <ConnectLockup iconSrc={iconSrc} size="lg" tone="light" />
          <p className="text-pretty text-[clamp(19px,1.7vw,25px)] font-normal leading-[1.45] text-white">
            {taglineLines}
          </p>
        </div>
        <div className="flex flex-col gap-2.5">
          {url && <p className="text-base text-white/[0.78]">{url}</p>}
          {footerNode}
        </div>
      </aside>

      {/* Brand header — stacked (mobile) layout only */}
      <div className="flex justify-center pt-9 auth:hidden">
        <ConnectLockup iconSrc={iconSrc} size="sm" tone="light" />
      </div>

      {/* Photo panel + card (the card renders once, in both layouts) */}
      <div className="flex flex-1 items-center justify-center p-[clamp(24px,4vw,64px)] auth:bg-[image:var(--auth-photo)] auth:bg-cover auth:bg-center">
        <div className="w-full max-w-[404px] rounded-lg bg-surface-card p-[clamp(20px,5vw,26px)] shadow-xl auth:p-[clamp(26px,2.4vw,36px)]">
          {children}
        </div>
      </div>

      {/* Tagline + address — stacked (mobile) layout only */}
      <div className="mt-auto flex flex-col gap-3 px-5 pb-6 pt-2 text-white auth:hidden">
        <p className="text-md leading-[1.45] text-white">{taglineLines}</p>
        {url && <p className="text-sm text-white/[0.72]">{url}</p>}
        {footerNode}
      </div>
    </div>
  );
}
