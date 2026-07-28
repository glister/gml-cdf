import * as React from 'react';

/* Ported from the CD Fencing Design System (components/navigation/PageHeader),
   translated to Tailwind. Title + optional description + metadata row + a
   primary action. `children` renders under the header (e.g. a tabs row). */

export interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  meta?: React.ReactNode;
  primaryAction?: React.ReactNode;
  children?: React.ReactNode;
}

export function PageHeader({ title, description, meta, primaryAction, children }: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-4 pt-1">
      <div className="flex flex-wrap items-start gap-5">
        <div className="min-w-[260px] flex-1">
          <h1 className="font-sans text-2xl font-extrabold leading-tight tracking-tight text-strong">
            {title}
          </h1>
          {description && (
            <p className="mt-2 max-w-[640px] font-sans text-md leading-normal text-muted">
              {description}
            </p>
          )}
          {meta && <div className="mt-3 flex flex-wrap items-center gap-3.5">{meta}</div>}
        </div>
        {primaryAction && <div className="flex shrink-0 items-center gap-2">{primaryAction}</div>}
      </div>
      {children}
    </header>
  );
}
