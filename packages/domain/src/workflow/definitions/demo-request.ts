import { defineWorkflow } from '../define.js';
import { DEMO_APPROVER_ROLE_REF, DEMO_EXPIRY_HOURS_REF } from '../demo-config-keys.js';

/**
 * `platform.demo.request` v1 — the pilot shape (core plan 07 §4.3).
 *
 * Three states and three transitions, chosen not because anyone needs a demo
 * request but because this is the smallest shape that exercises **every**
 * runtime feature at once: a config-resolved `by` policy, a hard guard, a soft
 * warning, effects fanned onto the queue, a timer that fires a transition, and
 * the auto-cancellation of that timer when a human gets there first.
 *
 * It is the proof that the runtime works end to end with no HR module in
 * existence — which matters, because plans 08/09/10 and every HR workflow shape
 * are built against this runtime before any of them can demonstrate it.
 *
 *   pending --approve--> approved   (terminal)
 *   pending --reject---> rejected   (terminal)
 *   pending --expire---> rejected   (terminal, by the timer)
 *
 * Note `expire` deliberately carries no `demo.notExpired` guard: the timer fires
 * at precisely the instant that guard starts blocking, so guarding it would make
 * the shape unable to expire.
 */
export const demoRequestV1 = defineWorkflow({
  key: 'platform.demo.request',
  version: 1,
  states: ['pending', 'approved', 'rejected'],
  initial: 'pending',
  terminal: ['approved', 'rejected'],

  // Raised the moment the instance starts: if nobody decides within the
  // configured window, the request expires itself. Lengthening the window in the
  // admin UI changes the lead time for every request started afterwards, with no
  // release (WF-2).
  initialSchedule: [
    {
      actionType: 'workflow.transition',
      params: { action: 'expire' },
      delay: { unit: 'hours', configRef: DEMO_EXPIRY_HOURS_REF },
    },
  ],

  transitions: [
    {
      from: 'pending',
      to: 'approved',
      action: 'approve',
      // The decision point: who approves is configuration, not code, and it
      // resolves to a *role* whose membership is evaluated at execution time.
      by: { configRef: DEMO_APPROVER_ROLE_REF },
      guards: ['demo.notExpired', 'demo.outOfHoursWarning'],
      config: [DEMO_EXPIRY_HOURS_REF],
      effects: [{ name: 'demo.recordOutcome', params: { outcome: 'approved' } }],
    },
    {
      from: 'pending',
      to: 'rejected',
      action: 'reject',
      by: { configRef: DEMO_APPROVER_ROLE_REF },
      guards: ['demo.notExpired'],
      config: [DEMO_EXPIRY_HOURS_REF],
      effects: [{ name: 'demo.recordOutcome', params: { outcome: 'rejected' } }],
    },
    {
      from: 'pending',
      to: 'rejected',
      action: 'expire',
      // Only the runtime may take this: it is what the timer fires.
      by: { system: true },
      effects: [{ name: 'demo.recordOutcome', params: { outcome: 'expired' } }],
    },
  ],
} as const);
