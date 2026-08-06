import type { StatusTone } from '~/components/data-display/StatusPill';

/**
 * Presentation helpers for the task screens (core plan 08 §5.3).
 *
 * The design system's task group (`components/tasks/taskModel.jsx`) fixes two
 * things these follow exactly:
 *
 *  - **`blocked` reads informational, never alarming.** A blocked task is not a
 *    problem; it is a task waiting its turn, and colouring it red would train
 *    people to ignore red.
 *  - **Overdue is an emphasis *overlay*, not a state.** It layers on top of
 *    whatever the task's status is (`StatusPill`'s `overdue` prop), which is why
 *    the server returns `overdue` as its own SQL-computed field rather than
 *    folding it into `status`.
 */

/** The four `platform.task.status` values, mapped to the state taxonomy. */
export function taskTone(status: string): StatusTone {
  switch (status) {
    case 'open':
      return 'info';
    case 'blocked':
      // Informational, deliberately (DS taskModel): waiting is not a failure.
      return 'info';
    case 'done':
      return 'success';
    default:
      // cancelled — an intended stop, settled rather than failed.
      return 'neutral';
  }
}

/** Plain English for each status; the column header carries the word "status". */
export const TASK_STATUS_LABEL: Record<string, string> = {
  blocked: 'Blocked',
  open: 'To do',
  done: 'Complete',
  cancelled: 'Cancelled',
};

/** `platform.pilot_case` → `pilot case`. The module prefix is noise in a list. */
export function shortStreamType(streamType: string): string {
  const [module, ...rest] = streamType.split('.');
  const entity = module === 'platform' || module === 'hr' ? rest.join('.') : streamType;
  return entity.replace(/_/g, ' ');
}

/** `2 Sep 2026, 17:00` — the repo's standard instant rendering. */
export function formatInstant(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `2 Sep 2026` — a due date is a day, and the time of day is policy. */
export function formatDueDate(value: string | Date | null | undefined): string {
  if (!value) return 'No due date';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'No due date';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** `in 3 days` / `2 days ago`. Relative to now, for scanning a list quickly. */
export function formatRelativeDay(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.round((date.getTime() - Date.now()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

/**
 * "Start date − 3 days" — how an anchor-relative task explains its own due date.
 *
 * The phrase matters more than the date for these: it is the *rule* that will be
 * re-applied when the anchor moves, and a screen showing only the resolved date
 * hides why it might change tomorrow.
 */
export function anchorPhrase(anchorName: string | null, offsetDays: number | null): string | null {
  if (!anchorName || offsetDays === null) return null;
  const label = anchorName.replace(/_/g, ' ');
  if (offsetDays === 0) return `On ${label}`;
  const n = Math.abs(offsetDays);
  const unit = n === 1 ? 'day' : 'days';
  return `${label[0]!.toUpperCase()}${label.slice(1)} ${offsetDays > 0 ? '+' : '−'} ${n} ${unit}`;
}

/** How far through a lane, as a whole percentage. Cancelled work does not count. */
export function lanePercent(lane: { total: number; done: number; cancelled: number }): number {
  const countable = lane.total - lane.cancelled;
  if (countable <= 0) return 100;
  return Math.round((lane.done / countable) * 100);
}
