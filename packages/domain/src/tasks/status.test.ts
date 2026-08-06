import { describe, expect, it } from 'vitest';
import {
  canTransitionTask,
  isTerminalTaskStatus,
  nextTaskStatus,
  satisfiesDependents,
  TaskTransitionError,
  type TaskAction,
  type TaskStatus,
} from './status.js';

/** Core plan 08 §10, §4.3 — the guard both the procedures and the effects use. */

const ALL_STATUSES: TaskStatus[] = ['blocked', 'open', 'done', 'cancelled'];
const ALL_ACTIONS: TaskAction[] = ['unblock', 'complete', 'cancel'];

describe('nextTaskStatus', () => {
  it('moves a blocked task to open when its dependencies clear', () => {
    expect(nextTaskStatus('blocked', 'unblock')).toBe('open');
  });

  it('completes an open task', () => {
    expect(nextTaskStatus('open', 'complete')).toBe('done');
  });

  it('cancels from either non-terminal status', () => {
    expect(nextTaskStatus('open', 'cancel')).toBe('cancelled');
    expect(nextTaskStatus('blocked', 'cancel')).toBe('cancelled');
  });

  it('refuses to complete a blocked task, and says why in plain words', () => {
    expect(() => nextTaskStatus('blocked', 'complete')).toThrow(TaskTransitionError);
    expect(() => nextTaskStatus('blocked', 'complete')).toThrow(/depends on/);
  });

  it('refuses to complete an already-complete task', () => {
    expect(() => nextTaskStatus('done', 'complete')).toThrow(/already complete/);
  });

  it('refuses to act on a cancelled task', () => {
    for (const action of ALL_ACTIONS) {
      expect(() => nextTaskStatus('cancelled', action)).toThrow(/cancelled/);
    }
  });

  it('refuses to cancel or unblock a completed task', () => {
    expect(() => nextTaskStatus('done', 'cancel')).toThrow(TaskTransitionError);
    expect(() => nextTaskStatus('done', 'unblock')).toThrow(TaskTransitionError);
  });

  it('refuses to unblock an already-open task', () => {
    // Not merely tidiness: this is what stops a second dependency satisfaction
    // emitting a second `platform.task.unblocked` for one fact.
    expect(() => nextTaskStatus('open', 'unblock')).toThrow(TaskTransitionError);
  });

  it('permits exactly four transitions in the whole machine', () => {
    const permitted = ALL_STATUSES.flatMap((from) =>
      ALL_ACTIONS.filter((action) => canTransitionTask(from, action)).map(
        (action) => `${from}:${action}`,
      ),
    );
    expect(permitted.sort()).toEqual([
      'blocked:cancel',
      'blocked:unblock',
      'open:cancel',
      'open:complete',
    ]);
  });
});

describe('terminal statuses', () => {
  it('names done and cancelled, and nothing else', () => {
    expect(ALL_STATUSES.filter(isTerminalTaskStatus)).toEqual(['done', 'cancelled']);
  });

  it('has both terminal statuses satisfy the edges waiting on the task', () => {
    // A cancelled prerequisite that kept blocking would strand its dependents
    // for good (§4.1).
    expect(ALL_STATUSES.filter(satisfiesDependents)).toEqual(['done', 'cancelled']);
  });
});
