import { defineWorkflow } from '../define.js';

/**
 * `platform.pilot.signoff` v1 — the workflow half of the approval engine's pilot
 * slice (core plan 09 §9.8).
 *
 * It exists to prove the **workflow-bound** entry point (§5.5, AC-D7) with no HR
 * content: a transition into `awaiting_approval` raises a sign-off through the
 * `approval.open` effect, and the decisive decision fires the transition *out* of
 * that state in the same transaction as the decision itself. Standalone
 * sign-offs — the other entry point — need no definition at all, which is the
 * point of having two.
 *
 *   draft ---submit-----> awaiting_approval   (opens the approval request)
 *   awaiting_approval --approve--> approved   (fired BY the decision, terminal)
 *   awaiting_approval --reject---> rejected   (fired BY the decision, terminal)
 *   awaiting_approval --withdraw-> withdrawn  (terminal; cancels the request)
 *
 * **`approve` and `reject` are `by: { system: true }`,** and that is the design
 * rather than a shortcut. The engine's live policy resolution is the authorising
 * gate (§5.5): it has already checked, inside the decision's transaction,
 * against live role membership and delegations — which is strictly more than a
 * `by: { role }` check could do, because it also honours delegation and the
 * per-subject `designated` sources. Letting the runtime re-check against a role
 * would either duplicate that or, worse, disagree with it. The deciding person
 * is recorded on the `approval_decision` row and tied to the transition by
 * `correlation_id`.
 *
 * The threshold that decides whether the sign-off is sought at all lives in
 * configuration (`platform.approvals.threshold.platform.pilot_signoff`), not
 * here — so below it, `approval.open` auto-approves and journals the fact, and
 * the case waits for someone to take `approve` explicitly.
 *
 * It retires with the pilot slice, exactly as plan 07's `platform.demo.request`
 * and plan 08's `platform.pilot.checklist` will.
 */
export const PILOT_SIGNOFF_KEY = 'platform.pilot.signoff';

/** The subject type its approvals are configured under (`@repo/config` §6). */
export const PILOT_SIGNOFF_SUBJECT = 'platform.pilot_signoff';

export const pilotSignoffWorkflowV1 = defineWorkflow({
  key: PILOT_SIGNOFF_KEY,
  version: 1,
  module: 'platform',
  states: ['draft', 'awaiting_approval', 'approved', 'rejected', 'withdrawn'],
  initial: 'draft',
  terminal: ['approved', 'rejected', 'withdrawn'],

  transitions: [
    {
      from: 'draft',
      to: 'awaiting_approval',
      action: 'submit',
      by: { role: 'administrator' },
      effects: [
        {
          name: 'approval.open',
          params: {
            // The action the decisive approval fires. Naming it here is what
            // makes the engine's half of the loop possible without the engine
            // knowing anything about this shape.
            action: 'approve',
            // A PII-minimal fact for the threshold rule to evaluate. A real
            // module passes its subject's own figures; the pilot carries a
            // number large enough to clear the seeded £500 threshold, so the
            // demonstration opens a request rather than auto-approving.
            context: { amount: 1500 },
          },
        },
      ],
    },
    {
      from: 'awaiting_approval',
      to: 'approved',
      action: 'approve',
      by: { system: true },
    },
    {
      from: 'awaiting_approval',
      to: 'rejected',
      action: 'reject',
      by: { system: true },
    },
    {
      // The requester changing their mind. Cancelling the instance cancels the
      // pending request through `cancelApprovalsForInstance`, so a sign-off
      // never outlives the case that sought it.
      from: 'awaiting_approval',
      to: 'withdrawn',
      action: 'withdraw',
      by: { role: 'administrator' },
      effects: [{ name: 'approval.cancel' }],
    },
  ],
});
