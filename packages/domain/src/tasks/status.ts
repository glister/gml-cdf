/**
 * The task status machine (core plan 08 §4.3, SoW §6 principle 7) — pure.
 *
 * ```
 *   blocked ──(all dependencies satisfied, automatic)──► open ──(complete)──► done
 *      │                                                  │
 *      └──────────────(cancel)──────────► cancelled ◄──────┘
 * ```
 *
 * Three properties this encodes, each of which would otherwise live as a
 * scattered `if`:
 *
 *  - **`blocked → open` has no user-facing action.** It is a consequence of a
 *    dependency being satisfied, never something a person does, which is why
 *    `unblock` is not in the action vocabulary.
 *  - **A blocked task cannot be completed.** Not "should not" — the guard is the
 *    only door, and both the procedure and the effect handler go through it.
 *  - **`done` and `cancelled` are terminal.** Re-opening is out of scope; the
 *    answer to "it needs doing again" is a new task, so the trail keeps both.
 */

export type TaskStatus = 'blocked' | 'open' | 'done' | 'cancelled';

/** The transitions the engine performs, named by what causes them. */
export type TaskAction = 'unblock' | 'complete' | 'cancel';

const ALLOWED: Record<TaskAction, { from: readonly TaskStatus[]; to: TaskStatus }> = {
  unblock: { from: ['blocked'], to: 'open' },
  complete: { from: ['open'], to: 'done' },
  cancel: { from: ['blocked', 'open'], to: 'cancelled' },
};

/** Statuses from which no transition leaves. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['done', 'cancelled'];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/** An action attempted from a status that does not permit it. */
export class TaskTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly action: TaskAction,
  ) {
    super(TaskTransitionError.explain(from, action));
    this.name = 'TaskTransitionError';
  }

  /**
   * The message a user reads, so it says what happened rather than naming
   * states: "this task is already done" beats "illegal transition done→done".
   */
  private static explain(from: TaskStatus, action: TaskAction): string {
    if (action === 'complete' && from === 'blocked') {
      return 'this task is blocked — something it depends on has not finished yet';
    }
    if (from === 'done') return 'this task is already complete';
    if (from === 'cancelled') return 'this task was cancelled';
    return `a task cannot be ${action}d from '${from}'`;
  }
}

/** Can `action` be taken from `from`? */
export function canTransitionTask(from: TaskStatus, action: TaskAction): boolean {
  return ALLOWED[action].from.includes(from);
}

/**
 * The status `action` moves a task to, or a throw naming why it cannot. The
 * single guard both the tRPC procedures and the workflow effects call — one
 * door, so the rules cannot diverge between the two entry points (ADR-0022 in
 * spirit).
 */
export function nextTaskStatus(from: TaskStatus, action: TaskAction): TaskStatus {
  if (!canTransitionTask(from, action)) throw new TaskTransitionError(from, action);
  return ALLOWED[action].to;
}

/**
 * Does completing or cancelling this task satisfy the edges that wait on it?
 *
 * Both do. A cancelled prerequisite that kept blocking would strand its
 * dependents for good, so cancellation satisfies its reverse edges as
 * completion does (§4.1; the cancelling actor's decision is journalled either
 * way). §12.2 Q3 records that CDF may yet want cancellation to *propagate*
 * instead — that is a policy on top of this, not a change to it.
 */
export function satisfiesDependents(status: TaskStatus): boolean {
  return status === 'done' || status === 'cancelled';
}
