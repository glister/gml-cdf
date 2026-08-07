import * as React from 'react';
import {
  CheckSquare,
  ClipboardList,
  Clock,
  Inbox,
  Info,
  PenLine,
  Repeat,
  TriangleAlert,
} from 'lucide-react';
import { cn } from '~/lib/utils';
import {
  eventTypeForKind,
  eventTypeMeta,
  isReminderKind,
  notificationTimeAgo,
  type NotificationIconName,
} from '~/lib/notifications';

/* Ported from the CD Fencing Design System
   (components/notifications/NotificationRow), translated to Tailwind.

   One notification: an event-type glyph in a small tinted disc, a plain-sentence
   title, an optional detail line, a relative timestamp, an unread dot and a
   subtle brand tint while unread. A reminder carries a repeat indicator on the
   disc, because reminders recur on a cadence until the item is complete — the
   row says so rather than looking like a duplicate of yesterday's.

   The content it renders was produced **once**, server-side, from a
   registry-validated payload, and is PII-minimal by construction (core plan 10
   §4.6). Nothing here interpolates anything: a row that could add a detail line
   of its own would be a second place capable of putting something on screen
   that SA-023 keeps out of the message. */

const ICONS: Record<NotificationIconName, React.ComponentType<{ size?: number }>> = {
  'check-square': CheckSquare,
  inbox: Inbox,
  pen: PenLine,
  clock: Clock,
  clipboard: ClipboardList,
  alert: TriangleAlert,
  info: Info,
};

const DISC_TONES: Record<string, string> = {
  info: 'bg-state-info-bg text-state-info',
  pending: 'bg-state-pending-bg text-state-pending',
  success: 'bg-state-success-bg text-state-success',
  danger: 'bg-state-danger-bg text-state-danger',
  neutral: 'bg-state-neutral-bg text-state-neutral',
};

export interface NotificationRowProps {
  kind: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  /** Rendered as a button when the notification has somewhere to go. */
  onClick?: () => void;
  className?: string;
}

export function NotificationRow({
  kind,
  title,
  body,
  createdAt,
  readAt,
  onClick,
  className,
}: NotificationRowProps) {
  const meta = eventTypeMeta(eventTypeForKind(kind));
  const Icon = ICONS[meta.icon];
  const read = readAt !== null;
  const reminder = isReminderKind(kind);

  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(event) => {
        if (!onClick) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'flex w-full items-start gap-3 px-3.5 py-3 text-left font-sans transition-colors',
        onClick && 'cursor-pointer',
        read ? 'bg-surface-card hover:bg-gray-50' : 'bg-brand-subtle hover:bg-brand-subtle/70',
        className,
      )}
    >
      <span aria-hidden="true" className="relative shrink-0">
        <span
          className={cn(
            'inline-flex size-9 items-center justify-center rounded-md',
            DISC_TONES[meta.tone],
          )}
        >
          <Icon size={18} />
        </span>
        {reminder && (
          <span
            title="Recurring reminder"
            className="absolute -bottom-1 -right-1 inline-flex size-4 items-center justify-center rounded-full bg-surface-card text-muted ring-[1.5px] ring-surface-card"
          >
            <Repeat size={11} />
          </span>
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block text-sm leading-[1.4] text-strong',
            read ? 'font-medium' : 'font-semibold',
          )}
        >
          {title}
        </span>
        <span className="mt-0.5 block text-2xs leading-[1.45] text-muted">{body}</span>
        <span className="mt-1.5 flex items-center gap-2.5">
          <span className="font-mono text-2xs text-muted">{notificationTimeAgo(createdAt)}</span>
          {reminder && <span className="text-2xs text-muted">· recurring</span>}
        </span>
      </span>

      <span aria-hidden="true" className="flex w-2.5 shrink-0 justify-center pt-1.5">
        {!read && <span className="size-2.5 rounded-full bg-brand" />}
      </span>
    </div>
  );
}
