import { defineWorkflow } from '../define.js';
import {
  PILOT_CHECKLIST_KEY,
  PILOT_START_ANCHOR,
  PILOT_VERIFICATION_GATE,
} from '../../tasks/pilot-checklist.js';

/**
 * `platform.pilot.checklist` v1 — the workflow half of the task engine's pilot
 * slice (core plan 08 §9.6).
 *
 * It exists to prove the whole loop with **no HR content**: a transition raises
 * a task list through the `tasks.raiseList` effect, another opens a gate through
 * `tasks.openGate`, and a third moves the case's anchor and re-resolves the due
 * dates hanging off it through `tasks.recomputeDueDates`. That is every seam
 * plans 08 and 07 share, exercised by one shape.
 *
 *   new ---begin------> in_progress   (raises the three-task list)
 *   in_progress --verify--> verified  (opens the `verification` gate)
 *   in_progress --reschedule--> in_progress  (moves the start anchor)
 *   verified ----close-----> closed   (terminal)
 *   in_progress --abandon--> closed   (terminal)
 *
 * The anchor travels in the effect's parameters as **days from the moment the
 * effect runs**, not as a date. A date written into a definition would be a
 * business fact frozen in code and would age out; a module with a real subject
 * (an onboarding case with a start date on it) passes real anchors instead — see
 * the `tasks.raiseList` handler.
 */
export const pilotChecklistWorkflowV1 = defineWorkflow({
  key: 'platform.pilot.checklist',
  version: 1,
  module: 'platform',
  states: ['new', 'in_progress', 'verified', 'closed'],
  initial: 'new',
  terminal: ['closed'],

  transitions: [
    {
      from: 'new',
      to: 'in_progress',
      action: 'begin',
      by: { role: 'administrator' },
      effects: [
        {
          name: 'tasks.raiseList',
          params: {
            listKey: PILOT_CHECKLIST_KEY,
            // "The case starts in a fortnight" — so the anchor-relative task
            // lands three days before that, and the pilot has a live due date
            // whatever day it is run.
            anchorDaysFromNow: { [PILOT_START_ANCHOR]: 14 },
          },
        },
      ],
    },
    {
      from: 'in_progress',
      to: 'verified',
      action: 'verify',
      by: { role: 'administrator' },
      // ON-035's "bypass" is the same transition taken early: the gate model has
      // no notion of *why* it opened, only that it did.
      effects: [{ name: 'tasks.openGate', params: { gateKey: PILOT_VERIFICATION_GATE } }],
    },
    {
      // A self-transition: the case has not moved on, its dates have. This is
      // what "the start date slipped a week" looks like to the engine (AC-D1).
      from: 'in_progress',
      to: 'in_progress',
      action: 'reschedule',
      by: { role: 'administrator' },
      effects: [
        {
          name: 'tasks.recomputeDueDates',
          params: { anchorDaysFromNow: { [PILOT_START_ANCHOR]: 21 } },
        },
      ],
    },
    { from: 'verified', to: 'closed', action: 'close', by: { role: 'administrator' } },
    { from: 'in_progress', to: 'closed', action: 'abandon', by: { role: 'administrator' } },
  ],
});
