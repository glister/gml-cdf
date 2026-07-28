import * as React from 'react';

/* Ported from the CD Fencing Design System (components/navigation/NavSectionLabel),
   translated to Tailwind — dark (brand-green) sidebar variant. */

export function NavSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="select-none px-4 pb-1.5 pt-3.5 font-sans text-2xs font-bold uppercase tracking-caps text-white/50">
      {children}
    </div>
  );
}
