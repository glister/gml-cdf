import type { StatusTone } from '~/components/data-display/StatusPill';

/**
 * Presentation helpers for the workflow admin screens (core plan 07 §5.7).
 *
 * The interesting problem here is that the runtime is **generic**: it executes
 * whatever shapes are registered, so it does not know whether a state called
 * `rejected` is a bad outcome or a routine one, and a screen that guessed would
 * eventually guess wrong. So the colour comes from what the runtime genuinely
 * knows — is this case still running? — and the state name is rendered as text.
 * Timers are different: their four statuses are a fixed, code-enforced lifecycle,
 * so they map cleanly onto the design system's state taxonomy.
 */

/** `platform.demo.request` → `demo.request`. The module prefix is noise in a list. */
export function shortWorkflowKey(key: string): string {
  const [module, ...rest] = key.split('.');
  return module === 'platform' || module === 'hr' ? rest.join('.') : key;
}

/**
 * The tone for an instance's `current_state`.
 *
 * Deliberately only two: a completed case is settled (neutral), a running one is
 * in flight (info). Mapping `approved` to success and `rejected` to danger would
 * read the state names of one workflow and apply them to every other — and a
 * `rejected` expenses claim, a `closed` absence and a `cancelled` booking are
 * not all failures.
 */
export function instanceTone(completedAt: string | Date | null): StatusTone {
  return completedAt ? 'neutral' : 'info';
}

/** The fixed `scheduled_action` lifecycle, mapped to the state taxonomy. */
export function timerTone(status: string): StatusTone {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'enqueued':
      return 'info';
    case 'executed':
      return 'success';
    default:
      return 'neutral'; // cancelled — an intended stop, not a failure
  }
}

/** Plain English for the four timer statuses; the column header carries "status". */
export const TIMER_STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting',
  enqueued: 'Sent to the worker',
  executed: 'Fired',
  cancelled: 'Cancelled',
};

/**
 * A pending timer whose due date has passed is **overdue** — not merely due.
 *
 * The scheduler runs every five minutes, so a couple of minutes past due is
 * normal; well past it means the cron Job has not run. That is the one piece of
 * operational trouble this screen can surface on its own, and the taxonomy's
 * overdue-is-an-overlay rule is exactly how to show it.
 */
const SCHEDULER_GRACE_MS = 10 * 60 * 1000;

export function isTimerOverdue(status: string, dueAt: string | Date): boolean {
  if (status !== 'pending') return false;
  const due = dueAt instanceof Date ? dueAt : new Date(dueAt);
  return Date.now() - due.getTime() > SCHEDULER_GRACE_MS;
}

/** `2 Sep 2026, 09:00` — the repo's standard instant rendering. */
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

/** "in 3 days" / "6 hours ago" — the relative half a due date needs to be read. */
export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const deltaMs = date.getTime() - Date.now();
  const abs = Math.abs(deltaMs);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  const format = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (abs >= ms) return format.format(Math.round(deltaMs / ms), unit);
  }
  return 'now';
}

/** One soft-guard verdict as recorded on a transition row. */
export interface GuardResultRow {
  guard: string;
  outcome: 'pass' | 'warn';
  detail?: string;
}

export function parseGuardResults(value: unknown): GuardResultRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { guard, outcome, detail } = entry as Record<string, unknown>;
    if (typeof guard !== 'string') return [];
    return [
      {
        guard,
        outcome: outcome === 'warn' ? 'warn' : 'pass',
        ...(typeof detail === 'string' ? { detail } : {}),
      },
    ];
  });
}

/** One effect as recorded on a transition row. */
export interface EffectRow {
  name: string;
  params: Record<string, unknown>;
}

export function parseEffects(value: unknown): EffectRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { name, params } = entry as Record<string, unknown>;
    if (typeof name !== 'string') return [];
    return [
      {
        name,
        params:
          typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {},
      },
    ];
  });
}

/** The `config:` values a transition acted on, as `[qualified name, value]` pairs. */
export function parseResolvedConfig(value: unknown): Array<[string, string]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    typeof entry === 'string' ? entry : JSON.stringify(entry),
  ]);
}

/**
 * Narrow a `jsonb` column to a plain params object.
 *
 * The parameter is `unknown` on purpose. A `jsonb` column's generated type is a
 * recursive union, and narrowing one inline inside a `.map()` that feeds a
 * TanStack Table row type makes TypeScript give up (TS2589). Widening to
 * `unknown` at this one boundary cuts the recursion, and nothing is lost —
 * effect params are ids and primitives, rendered as text.
 */
export function asParams(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Compact JSON for a params object; `—` when there is nothing to show. */
export function formatParams(params: Record<string, unknown>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return '—';
  return entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ');
}
