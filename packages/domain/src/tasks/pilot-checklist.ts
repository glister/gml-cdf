import { defineTaskList } from './lists.js';

/**
 * `platform.pilot.checklist` — the pilot task list (core plan 08 §9.6).
 *
 * Three tasks, chosen not because anyone needs them but because this is the
 * smallest shape that exercises **every** engine feature at once: a task that is
 * actionable immediately, a task blocked on another task, a task blocked on a
 * named gate, an anchor-relative due date and an absolute one, and two lanes to
 * group them by on a dashboard.
 *
 * It carries **no HR content**. Onboarding lanes, offboarding leaver lists,
 * probation and return-to-work checklists are the HR plan set's work; this list
 * exists so PL-013…015 can be demonstrated end to end before any of that lands
 * — exactly as plan 07's `platform.demo.request` demonstrates the runtime.
 *
 *   set_up_kit   (it,        open,    due start_date − 3d)
 *   hand_over    (it,        blocked on set_up_kit)
 *   assign_van   (transport, blocked on the `verification` gate)
 */
export const PILOT_CHECKLIST_KEY = 'platform.pilot.checklist';

/** The gate the pilot's `verify` transition opens (ON-033's shape, no content). */
export const PILOT_VERIFICATION_GATE = 'verification';

/** The anchor the pilot's due date hangs off. Supplied by the raising effect. */
export const PILOT_START_ANCHOR = 'start_date';

export const pilotChecklist = defineTaskList({
  key: PILOT_CHECKLIST_KEY,
  version: 1,
  tasks: [
    {
      ref: 'set_up_kit',
      title: 'Prepare the equipment',
      description: 'Pilot task. Nothing is actually ordered.',
      lane: 'it',
      assigneeRoleKey: 'it',
      // Three days before the anchor, at the configured local time — the shape
      // ON-044/049 need, with no onboarding vocabulary.
      due: { mode: 'anchor_relative', anchorName: PILOT_START_ANCHOR, offsetDays: -3 },
    },
    {
      ref: 'hand_over',
      title: 'Hand the equipment over',
      lane: 'it',
      assigneeRoleKey: 'it',
      dependsOn: ['set_up_kit'],
    },
    {
      ref: 'assign_van',
      title: 'Allocate a vehicle',
      lane: 'transport',
      assigneeRoleKey: 'transport',
      // The gated step: blocked while the parallel IT lane runs, freed only when
      // the case's `verification` gate opens (ON-033's licence check, generically).
      gates: [PILOT_VERIFICATION_GATE],
    },
  ],
});
