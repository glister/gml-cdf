import * as React from 'react';
import { cn } from '~/lib/utils';

/* Ported from the CD Fencing Design System (components/feedback/Popover),
   translated to Tailwind. Click-triggered, anchored below its trigger, closing
   on outside click and Escape.

   Deliberately not Radix: the design system's Popover is a small anchored panel
   and the calendar is its only consumer so far. Radix Popover would be a new
   runtime dependency for positioning we get from `relative`/`absolute`, and the
   accessibility this needs — Escape, outside-click, `aria-expanded` — is the
   part written out below. If a future surface needs collision detection or
   portalling, this is the place to swap the implementation. */

export interface PopoverProps {
  /** Rendered inside the panel. */
  content: React.ReactNode;
  /** Panel width in pixels. */
  width?: number;
  /** Align the panel's right edge to the trigger's — for triggers near the edge. */
  align?: 'start' | 'end';
  children: React.ReactElement<{ onClick?: (e: React.MouseEvent) => void }>;
}

export function Popover({ content, width = 260, align = 'start', children }: PopoverProps) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const trigger = React.cloneElement(children, {
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      children.props.onClick?.(e);
      setOpen((v) => !v);
    },
  });

  return (
    <span ref={ref} className="relative inline-block">
      {trigger}
      {open && (
        <div
          role="dialog"
          style={{ width }}
          className={cn(
            'absolute top-[calc(100%+6px)] z-40 overflow-hidden rounded-md border border-border-subtle bg-surface-card shadow-lg',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {content}
        </div>
      )}
    </span>
  );
}
