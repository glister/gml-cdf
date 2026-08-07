import * as React from 'react';
import { Bell } from 'lucide-react';
import { cn } from '~/lib/utils';
import { trpcReact } from '~/trpc';
import { capCount } from '~/lib/notifications';
import { NotificationInbox } from './NotificationInbox';

/* Ported from the CD Fencing Design System
   (components/notifications/NotificationBell + NotificationPanel), translated to
   Tailwind: a bell with an unread badge capped at "9+", opening the inbox panel
   beneath it.

   **The badge polls; it does not stream** (core plan 10 §5.8). 60 seconds plus a
   refetch when the window regains focus, which is the freshness bound the plan
   settles on for Phase 1 — websockets or SSE for a company of this size would be
   infrastructure nobody asked for (NFR-006). Focus refetch is the half that
   matters in practice: the common case is someone coming back to the tab. */

const POLL_INTERVAL_MS = 60_000;

export function NotificationBell() {
  const [open, setOpen] = React.useState(false);

  const unread = trpcReact.platform.notifications.myUnreadCount.useQuery(undefined, {
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
    // A failing badge must not break the shell every page renders. An error
    // simply means no badge — the inbox itself will say what went wrong.
    retry: 1,
  });

  const count = unread.data?.count ?? 0;

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'relative inline-flex size-10 items-center justify-center rounded-full text-body transition-colors hover:bg-gray-100',
          open && 'bg-gray-100',
        )}
      >
        <Bell size={20} strokeWidth={2} />
        {count > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-state-danger px-[5px] font-mono text-2xs font-bold leading-none text-white ring-2 ring-surface-card"
          >
            {capCount(count)}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Click-away. A plain button rather than a listener on document, so
              the dismiss target is focusable and keyboard-reachable. */}
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          {/* Anchored to the trigger on desktop; pinned to the viewport below
              `sm`, where a 380px popover hung off a bell near the right edge
              would run off the left of the screen. The design system's mobile
              variant is a full drawer — this is the same intent (a sheet that
              owns the width) expressed in CSS, so there is no `matchMedia` and
              no layout detection, exactly as `AppShell` does it. */}
          <div className="fixed inset-x-3 top-[68px] z-50 sm:absolute sm:inset-x-auto sm:right-0 sm:top-[calc(100%+8px)]">
            <NotificationInbox onClose={() => setOpen(false)} />
          </div>
        </>
      )}
    </div>
  );
}
