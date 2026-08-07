import type { StatusTone } from '~/components/data-display/StatusPill';

/**
 * Notification presentation helpers (core plan 10 §5.8).
 *
 * Ported from the CD Fencing Design System's
 * `components/notifications/notificationModel.jsx`: the event-type registry
 * (label + tinted disc tone + glyph), relative-time formatting and the
 * today/earlier split the panel and the page both group by.
 *
 * **The mapping from our `kind` to a design-system event type lives here and
 * nowhere else.** A notification kind is a server-side registration
 * (`notify-kinds.ts`) and is deliberately open-ended — every HR module will add
 * some — so the client must degrade gracefully rather than switch exhaustively:
 * an unrecognised kind renders as a system notice with its own title, which is
 * still a correct, readable notification.
 */

export type NotificationEventType =
  | 'task_assigned'
  | 'approval_requested'
  | 'document_sign'
  | 'reminder'
  | 'fit_note'
  | 'threshold'
  | 'system';

export interface EventTypeMeta {
  label: string;
  tone: StatusTone;
  icon: NotificationIconName;
}

export type NotificationIconName =
  'check-square' | 'inbox' | 'pen' | 'clock' | 'clipboard' | 'alert' | 'info';

/** Hues stay in the state family, so an event type never reads as a status. */
const EVENT_TYPE: Record<NotificationEventType, EventTypeMeta> = {
  task_assigned: { label: 'Task assigned', tone: 'info', icon: 'check-square' },
  approval_requested: { label: 'Approval requested', tone: 'pending', icon: 'inbox' },
  document_sign: { label: 'Document to sign', tone: 'info', icon: 'pen' },
  reminder: { label: 'Reminder', tone: 'pending', icon: 'clock' },
  fit_note: { label: 'Fit note required', tone: 'pending', icon: 'clipboard' },
  threshold: { label: 'Threshold alert', tone: 'danger', icon: 'alert' },
  system: { label: 'System notice', tone: 'neutral', icon: 'info' },
};

export const eventTypeMeta = (type: NotificationEventType): EventTypeMeta => EVENT_TYPE[type];

/** The event types offered as filters, in the order the page shows them. */
export const NOTIFICATION_EVENT_TYPES: NotificationEventType[] = [
  'task_assigned',
  'approval_requested',
  'document_sign',
  'reminder',
  'system',
];

/**
 * A server-side notification `kind` → the design system's event type.
 *
 * Prefix-matched rather than enumerated, deliberately. The kind registry is
 * open — an HR module registering `hr.absence.recorded` should get a sensible
 * icon without a release here — and anything unrecognised falls through to
 * `system`, which reads perfectly well: the title and body are the message, and
 * the disc is decoration.
 */
export function eventTypeForKind(kind: string): NotificationEventType {
  if (kind.startsWith('reminder.')) return 'reminder';
  if (kind.startsWith('task.')) return 'task_assigned';
  if (kind.startsWith('approval')) return 'approval_requested';
  if (kind.startsWith('document.') || kind.includes('.sign')) return 'document_sign';
  if (kind.includes('fit_note')) return 'fit_note';
  if (kind.startsWith('threshold.') || kind.endsWith('.breached')) return 'threshold';
  return 'system';
}

/** A chase carries a repeat indicator, because reminders recur until complete. */
export function isReminderKind(kind: string): boolean {
  return kind.startsWith('reminder.');
}

/**
 * Relative time, matching the design system's scale: `just now`, `5m`, `3h`,
 * `2d`, `3w`, then a bare date.
 *
 * Short by design — an inbox row has one line for it, and "17 minutes ago"
 * crowds out the thing the row is actually telling you.
 */
export function notificationTimeAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const date = new Date(then);
  return `${date.getDate()}/${date.getMonth() + 1}`;
}

/**
 * Split a page of notifications into Today / Earlier by calendar day.
 *
 * **This is presentation, not filtering.** It groups the rows the server
 * already chose and drops none of them — the distinction matters because every
 * facet that *selects* rows (unread, kind) is a SQL `where` on the server, and
 * doing either of those here would silently operate on one keyset page
 * (ADR-0004).
 */
export function groupByDay<T extends { createdAt: string }>(
  items: readonly T[],
  now: Date = new Date(),
): { today: T[]; earlier: T[] } {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const today: T[] = [];
  const earlier: T[] = [];
  for (const item of items) {
    (new Date(item.createdAt).getTime() >= startOfToday ? today : earlier).push(item);
  }
  return { today, earlier };
}

/** The badge caps at "9+" — a precise count above that is noise. */
export function capCount(count: number, cap = 9): string {
  return count > cap ? `${cap}+` : String(count);
}

/** Delivery-status labels for the admin diagnostics table (§5.5). */
export const DELIVERY_STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  sent: 'Sent',
  failed: 'Failed',
  dead: 'Given up',
  suppressed: 'Suppressed',
};

export function deliveryTone(status: string): StatusTone {
  switch (status) {
    case 'sent':
      return 'success';
    case 'failed':
      return 'pending';
    case 'dead':
      return 'danger';
    case 'suppressed':
      return 'neutral';
    default:
      return 'info';
  }
}

export const CHANNEL_LABEL: Record<string, string> = {
  in_app: 'In-app',
  email: 'Email',
  push: 'Push',
};
