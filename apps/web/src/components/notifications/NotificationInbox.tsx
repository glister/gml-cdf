import * as React from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { Bell, X } from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/trpc';
import { trpcReact } from '~/trpc';
import { groupByDay } from '~/lib/notifications';
import { NotificationRow } from './NotificationRow';

/* Ported from the CD Fencing Design System
   (components/notifications/NotificationPanel), translated to Tailwind: header
   with unread count and mark-all-read, Today / Earlier sections with sticky
   labels, a scrollable list, a compact empty state, and a view-all footer.

   The panel shows the **latest page only** — twelve rows, no pagination. That is
   deliberate: a dropdown is for "what happened while I was away", and anyone
   wanting to work through a backlog goes to the full inbox, where the filters
   are SQL rather than a scroll position. */

type Item = inferRouterOutputs<AppRouter>['platform']['notifications']['myList']['items'][number];

const PANEL_PAGE_SIZE = 12;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-10 bg-surface-page px-3.5 pb-1.5 pt-2.5 font-sans text-2xs font-bold uppercase tracking-wide text-muted">
      {children}
    </div>
  );
}

export function NotificationInbox({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const utils = trpcReact.useUtils();

  const list = trpcReact.platform.notifications.myList.useQuery({ limit: PANEL_PAGE_SIZE });
  const markRead = trpcReact.platform.notifications.markRead.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.platform.notifications.myList.invalidate(),
        utils.platform.notifications.myUnreadCount.invalidate(),
      ]);
    },
  });
  const markAllRead = trpcReact.platform.notifications.markAllRead.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.platform.notifications.myList.invalidate(),
        utils.platform.notifications.myUnreadCount.invalidate(),
      ]);
    },
  });

  const items = list.data?.items ?? [];
  const unread = items.filter((item) => item.readAt === null).length;
  const { today, earlier } = groupByDay(items);

  /**
   * Reading a notification and going where it points are one gesture.
   *
   * The mark is fired without awaiting the navigation: the read state is UI
   * telemetry (it is not journalled — §4.4), so blocking a click on it would
   * trade the thing the user asked for against a bookkeeping write.
   */
  function open(item: Item): void {
    if (item.readAt === null) markRead.mutate({ deliveryId: item.deliveryId });
    onClose();
    if (item.actionUrl) {
      // Stored app-relative and validated as such server-side, so this can never
      // navigate off-site (core plan 10 §4.2, `assertAppRelative`).
      void router.navigate({ to: item.actionUrl });
    }
  }

  function renderSection(label: string, list_: Item[]): React.ReactNode {
    if (list_.length === 0) return null;
    return (
      <div>
        <SectionLabel>{label}</SectionLabel>
        {list_.map((item, index) => (
          <React.Fragment key={item.deliveryId}>
            {index > 0 && <div className="h-px bg-border-subtle" />}
            <NotificationRow {...item} onClick={() => open(item)} />
          </React.Fragment>
        ))}
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Notifications"
      className="flex max-h-[min(460px,calc(100vh-6rem))] w-full flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-card font-sans shadow-xl sm:w-[380px]"
    >
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border-subtle px-3.5 py-3">
        <span className="text-base font-bold tracking-tight text-strong">Notifications</span>
        {unread > 0 && (
          <span className="font-mono text-2xs font-semibold text-muted">{unread} unread</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {unread > 0 && (
            <button
              type="button"
              onClick={() => markAllRead.mutate()}
              disabled={markAllRead.isPending}
              className="rounded-sm px-1.5 py-1 text-2xs font-semibold text-link transition-colors hover:bg-gray-100 disabled:opacity-60"
            >
              Mark all read
            </button>
          )}
          <button
            type="button"
            aria-label="Close notifications"
            onClick={onClose}
            className="inline-flex size-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-gray-100"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isLoading ? (
          <p className="px-3.5 py-10 text-center text-sm text-muted">Loading…</p>
        ) : list.error ? (
          <p className="px-3.5 py-10 text-center text-sm text-status-danger">
            {list.error.message}
          </p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3.5 py-10 text-center">
            <Bell size={26} className="text-muted" aria-hidden="true" />
            <p className="text-sm font-semibold text-strong">You&rsquo;re all caught up</p>
            <p className="text-2xs text-muted">New notifications will appear here.</p>
          </div>
        ) : (
          <>
            {renderSection('Today', today)}
            {today.length > 0 && earlier.length > 0 && <div className="h-px bg-border-subtle" />}
            {renderSection('Earlier', earlier)}
          </>
        )}
      </div>

      <Link
        to="/notifications"
        onClick={onClose}
        className="shrink-0 border-t border-border-subtle bg-surface-card px-3.5 py-3 text-center text-sm font-bold text-link transition-colors hover:bg-gray-50"
      >
        View all notifications
      </Link>
    </div>
  );
}
