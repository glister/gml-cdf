import { DEMO_EXPIRY_HOURS_KEY } from '../demo-config-keys.js';
import type { GuardContext, GuardFn, GuardOutcome } from '../types.js';

/**
 * Guards for the pilot `platform.demo.request` shape (core plan 07 §4.3).
 *
 * The demo exists to exercise every runtime feature end to end without any HR
 * dependency, and these two are the guard half of that: one **hard** guard that
 * blocks and writes nothing, and one **soft** guard that lets the transition
 * proceed while recording a warning (the PL-017 "approve despite a clash"
 * pattern every real approval shape will reuse).
 *
 * Both are pure functions of their context. Note in particular that neither
 * reads a clock or a configuration store: `now` and the resolved decision-point
 * values arrive in `ctx`, which is what lets a test assert the exact boundary
 * instant without faking time (ADR-0009).
 */

/** What the demo's subject loader supplies. Narrowed defensively at the seam. */
export interface DemoRequestSubject {
  /** When the request was raised — the anchor the expiry window runs from. */
  readonly startedAt: Date;
}

function asDemoSubject(subject: unknown): DemoRequestSubject | null {
  if (typeof subject !== 'object' || subject === null) return null;
  const { startedAt } = subject as { startedAt?: unknown };
  return startedAt instanceof Date ? { startedAt } : null;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * **Hard guard.** A demo request may not be decided after its expiry window has
 * passed — the window being `startedAt + config:…demo.expiry_hours`, resolved
 * as-at this transition, so lengthening the window in the admin UI immediately
 * un-blocks requests that were about to lapse.
 *
 * Deliberately *not* applied to the `expire` transition itself: the timer that
 * fires at exactly this instant would otherwise be blocked by the condition it
 * exists to act on.
 */
export const demoNotExpired: GuardFn = (ctx: GuardContext): GuardOutcome => {
  const subject = asDemoSubject(ctx.subject);
  if (!subject) {
    return { outcome: 'block', detail: 'the demo request subject could not be loaded' };
  }

  const hours = ctx.config[DEMO_EXPIRY_HOURS_KEY];
  if (typeof hours !== 'number' || !Number.isFinite(hours)) {
    // A missing or malformed decision point fails **closed**. Falling back to a
    // built-in number here would be a hardcoded business threshold — exactly
    // what WF-2 forbids — and would hide the misconfiguration (ADR-0016).
    return {
      outcome: 'block',
      detail: `'${DEMO_EXPIRY_HOURS_KEY}' did not resolve to a number, so the expiry window is unknown`,
    };
  }

  const expiresAt = new Date(subject.startedAt.getTime() + hours * HOUR_MS);
  if (ctx.now.getTime() >= expiresAt.getTime()) {
    return {
      outcome: 'block',
      detail: `this request expired at ${expiresAt.toISOString()} (${hours}h after it was raised)`,
    };
  }
  return { outcome: 'pass' };
};

/** Monday–Friday, 09:00–17:00 UTC. UTC keeps the guard deterministic. */
const WORKING_HOURS = { startHour: 9, endHour: 17 } as const;

/**
 * **Soft guard.** Decisions taken outside working hours are allowed but flagged
 * — the transition proceeds, the warning is returned to the caller and recorded
 * in `workflow_transition.guard_results`, and nothing is blocked.
 *
 * This is the shape of every "warn, don't stop" rule in the SoW (a leave clash
 * within a team, a booking over a soft threshold): the system informs the
 * decision-maker and records that it did, rather than substituting its judgement
 * for theirs.
 */
export const demoOutOfHoursWarning: GuardFn = (ctx: GuardContext): GuardOutcome => {
  const day = ctx.now.getUTCDay(); // 0 = Sunday
  const hour = ctx.now.getUTCHours();
  const isWeekend = day === 0 || day === 6;
  const isOutOfHours = hour < WORKING_HOURS.startHour || hour >= WORKING_HOURS.endHour;

  if (!isWeekend && !isOutOfHours) return { outcome: 'pass' };
  return {
    outcome: 'warn',
    detail: isWeekend
      ? `decided at the weekend (${ctx.now.toISOString()})`
      : `decided outside working hours ${WORKING_HOURS.startHour}:00–${WORKING_HOURS.endHour}:00 UTC (${ctx.now.toISOString()})`,
  };
};

/** The demo guards, by the names the definition cites. */
export const demoGuards = {
  'demo.notExpired': demoNotExpired,
  'demo.outOfHoursWarning': demoOutOfHoursWarning,
} as const;
