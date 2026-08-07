import * as React from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createColumnHelper, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/trpc';
import { Bell } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { Button } from '~/components/ui/button';
import { NotificationRow } from '~/components/notifications/NotificationRow';
import { groupByDay } from '~/lib/notifications';
import { cn } from '~/lib/utils';

export const Route = createFileRoute('/_authenticated/notifications')({
  component: NotificationsInbox,
});

type Item = inferRouterOutputs<AppRouter>['platform']['notifications']['myList']['items'][number];

const columnHelper = createColumnHelper<Item>();

/**
 * The full notification inbox (core plan 10 §5.8, PL-019).
 *
 * **The unread filter is a query parameter, not a predicate over the rows on
 * screen.** That is the difference between an inbox and a lie: the client holds
 * one keyset page, so filtering here would show "the unread ones out of the
 * twenty-five that happened to load" while presenting itself as the answer
 * (ADR-0004, and AC-D6 asks for exactly this).
 *
 * The design system renders notifications as a grouped card list rather than a
 * grid (`components/notifications/NotificationPage`), so that is what this
 * screen looks like — but the row model is still TanStack Table in manual mode,
 * with pagination and filtering owned by the server. The headless model is the
 * repo's standard for any server-driven list; using it without `<td>`s is a
 * presentation choice, not an escape from it.
 */
function NotificationsInbox() {
  const router = useRouter();
  const utils = trpcReact.useUtils();
  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const [cursorStack, setCursorStack] = React.useState<string[]>([]);
  const cursor = cursorStack[cursorStack.length - 1];

  React.useEffect(() => {
    setCursorStack([]);
  }, [unreadOnly]);

  const query = trpcReact.platform.notifications.myList.useQuery({
    limit: 25,
    unreadOnly,
    cursor,
  });
  const unreadCount = trpcReact.platform.notifications.myUnreadCount.useQuery();

  const invalidate = async (): Promise<void> => {
    await Promise.all([
      utils.platform.notifications.myList.invalidate(),
      utils.platform.notifications.myUnreadCount.invalidate(),
    ]);
  };

  const markRead = trpcReact.platform.notifications.markRead.useMutation({
    onSuccess: invalidate,
  });
  const markAllRead = trpcReact.platform.notifications.markAllRead.useMutation({
    onSuccess: invalidate,
  });

  // Columns are the row model's contract even though the presentation is a card
  // list: `deliveryId` is the row key and the rest is rendered by the design
  // system's row component.
  const columns = React.useMemo(
    () => [columnHelper.accessor('deliveryId', { id: 'delivery', header: 'Notification' })],
    [],
  );

  const rows = React.useMemo(() => query.data?.items ?? [], [query.data]);

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.deliveryId,
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
  });

  function open(item: Item): void {
    if (item.readAt === null) markRead.mutate({ deliveryId: item.deliveryId });
    if (item.actionUrl) void router.navigate({ to: item.actionUrl });
  }

  const modelRows = table.getRowModel().rows.map((row) => row.original);
  const { today, earlier } = groupByDay(modelRows);
  const hasNext = Boolean(query.data?.nextCursor);
  const hasPrev = cursorStack.length > 0;
  const unread = unreadCount.data?.count ?? 0;

  function renderGroup(label: string, items: Item[]): React.ReactNode {
    if (items.length === 0) return null;
    return (
      <div className="flex flex-col gap-2">
        <h2 className="font-sans text-2xs font-bold uppercase tracking-wide text-muted">{label}</h2>
        <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface-card">
          {items.map((item, index) => (
            <React.Fragment key={item.deliveryId}>
              {index > 0 && <div className="h-px bg-border-subtle" />}
              <NotificationRow {...item} onClick={() => open(item)} />
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[820px] flex-col gap-4">
      <PageHeader
        title="Notifications"
        description="Everything the platform has told you. Who receives a notification is resolved from role membership when it is sent, so this list follows the roles you hold rather than a list your name was added to."
        primaryAction={
          unread > 0 ? (
            <Button
              variant="ghost"
              onClick={() => markAllRead.mutate()}
              disabled={markAllRead.isPending}
            >
              Mark all read
            </Button>
          ) : undefined
        }
      />

      {query.error && (
        <Callout tone="danger" title="Couldn’t load your notifications">
          {query.error.message}
        </Callout>
      )}

      {/* The filter is a query parameter. Both pills set `unreadOnly` on the
          request; neither touches the rows already on screen. */}
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            { value: false, label: 'All' },
            { value: true, label: unread > 0 ? `Unread (${unread})` : 'Unread' },
          ] as const
        ).map((option) => (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => setUnreadOnly(option.value)}
            aria-pressed={unreadOnly === option.value}
            className={cn(
              'inline-flex h-8 items-center rounded-full border px-3.5 font-sans text-2xs font-semibold transition-colors',
              unreadOnly === option.value
                ? 'border-brand bg-brand-subtle text-link'
                : 'border-border-default bg-surface-card text-body hover:bg-gray-50',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {query.isLoading ? (
        <p className="py-10 text-center font-sans text-sm text-muted">Loading…</p>
      ) : modelRows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-border-subtle bg-surface-card px-4 py-14 text-center">
          <Bell size={28} className="text-muted" aria-hidden="true" />
          <p className="font-sans text-sm font-semibold text-strong">
            {unreadOnly ? 'Nothing unread' : 'No notifications yet'}
          </p>
          <p className="font-sans text-2xs text-muted">
            {unreadOnly
              ? 'You have read everything here.'
              : 'When something needs your attention, it will appear here.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {renderGroup('Today', today)}
          {renderGroup('Earlier', earlier)}
        </div>
      )}

      {(hasPrev || hasNext) && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            disabled={!hasPrev}
            onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            disabled={!hasNext}
            onClick={() => {
              const next = query.data?.nextCursor;
              if (next) setCursorStack((stack) => [...stack, next]);
            }}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
