import type { Kysely } from 'kysely';
import type { DB } from '@repo/db';

/**
 * The reminder-kind registry (core plan 10 §5.5) — and the half of the
 * cancel-on-complete contract that makes the other half optional.
 *
 * A reminder kind binds two things to a chase: **a satisfaction check** (is the
 * thing being chased still outstanding?) and **a description** (what the chase
 * should say, and where it links). The handler runs the check before *every*
 * send, which is what turns §4.5's contract from a rule consumers must remember
 * into a property the platform holds:
 *
 * > A consumer that forgets to call `cancelReminders` costs one redundant
 * > chase. It can never cause a chase after completion.
 *
 * That asymmetry is deliberate. Eager cancellation is an optimisation — it stops
 * a pointless queue message — but if it were load-bearing, every future HR
 * module would have to remember it on every path that satisfies a source, and
 * one of them would not. The failure would be a manager chased daily about
 * something they finished last week, discovered by the manager.
 *
 * ## Why this is not in `@repo/domain`
 *
 * A satisfaction check reads a live row. That is I/O, and ADR-0009 keeps I/O out
 * of the pure package. §5.5 proposed `apps/worker/src/handlers/reminder-kinds.ts`
 * for that reason; it lives here instead because the two shipped checks read
 * `platform.task` and `platform.approval_request` — tables whose services are in
 * this package — and the set overview's 2026-08-05 reconciliation already puts
 * engine services in `@repo/trpc` with the worker loading them for their
 * side effects. Splitting the check from the service it interrogates would have
 * put a second reader of those tables in a second package.
 *
 * ## What a chase may say
 *
 * `describe` returns a short, non-sensitive label and a link — never detail.
 * Everything it produces is fed to the `reminder.chase` notification kind, whose
 * strict schema is what actually enforces that (§4.6). A future `fit_note.due`
 * reminder therefore says "a document is outstanding" and links to the record;
 * there is no parameter it could put a diagnosis in (SA-023).
 */

export interface ReminderSourceRef {
  sourceType: string;
  sourceId: string;
}

/** What a chase says. All of it PII-minimal, all of it optional but the label. */
export interface ReminderDescription {
  /** A noun phrase for the class of thing: 'task', 'approval request'. */
  sourceLabel: string;
  /** A short, non-sensitive title for the item, or `null`. Never a detail line. */
  label: string | null;
  /** ISO date it was or is due, or `null`. */
  dueDate: string | null;
  /** App-relative deep link, or `null`. */
  actionUrl: string | null;
}

export interface ReminderKindDef {
  readonly reminderKind: string;
  /**
   * Is the source satisfied — completed, decided, uploaded, cancelled?
   *
   * A source that no longer exists (deleted, or never did) counts as satisfied:
   * chasing someone about a record they cannot open is worse than not chasing.
   */
  readonly isSatisfied: (db: Kysely<DB>, ref: ReminderSourceRef & { at: Date }) => Promise<boolean>;
  /** What the chase should say. `null` when the source has gone. */
  readonly describe: (
    db: Kysely<DB>,
    ref: ReminderSourceRef & { at: Date },
  ) => Promise<ReminderDescription | null>;
  readonly registeredBy: string;
}

const registry = new Map<string, ReminderKindDef>();

/** Thrown for a reminder kind nobody registered. */
export class ReminderKindUnknownError extends Error {
  constructor(readonly reminderKind: string) {
    super(
      `no reminder kind registered for '${reminderKind}' — register one with registerReminderKind() where the chase is scheduled`,
    );
    this.name = 'ReminderKindUnknownError';
  }
}

/**
 * Register a reminder kind. Duplicate registration throws: two satisfaction
 * checks for one kind would make "should this chase go out?" depend on import
 * order, and the losing one would fail silently — which for a chase means either
 * an absent reminder or one after completion.
 */
export function registerReminderKind(def: ReminderKindDef): void {
  if (registry.has(def.reminderKind)) {
    throw new Error(
      `duplicate reminder kind registration: '${def.reminderKind}' is already registered`,
    );
  }
  registry.set(def.reminderKind, def);
}

/** Look up a kind, or throw {@link ReminderKindUnknownError}. */
export function requireReminderKind(reminderKind: string): ReminderKindDef {
  const def = registry.get(reminderKind);
  if (!def) throw new ReminderKindUnknownError(reminderKind);
  return def;
}

/** Every registered reminder kind — used by the conformance test. */
export function reminderKindNames(): string[] {
  return [...registry.keys()];
}

/** Test-only: drop a registration so a suite can substitute a stub. */
export function unregisterReminderKindForTests(reminderKind: string): void {
  registry.delete(reminderKind);
}

// --- The two kinds already writing occurrences (§9.6) ------------------------
//
// Core plans 08 and 09 have been scheduling `notification.reminder` rows on this
// plan's payload shape since before it existed, through plan 07's
// `scheduleAction`, and cancelling them eagerly (set overview, 2026-08-05 and
// 2026-08-06). This plan inherits **live rows on day one** — so these two
// registrations are not preparation for a future consumer, they are what stops
// existing rows dead-lettering the moment the handler ships.

/** `task.incomplete` — core plan 08's chase (PL-020, ON-047/OF-008 drivers). */
export const taskIncompleteReminder: ReminderKindDef = {
  reminderKind: 'task.incomplete',
  registeredBy: '10',
  async isSatisfied(db, { sourceId }) {
    const task = await db
      .selectFrom('platform.task')
      .select(['status'])
      .where('id', '=', sourceId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    // Gone, done or cancelled — all three mean "stop". A cancelled task is not
    // outstanding work, and chasing it would be the platform arguing with a
    // decision someone already made.
    return !task || task.status === 'done' || task.status === 'cancelled';
  },
  async describe(db, { sourceId }) {
    const task = await db
      .selectFrom('platform.task')
      .select(['id', 'title', 'due_at'])
      .where('id', '=', sourceId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!task) return null;
    return {
      sourceLabel: 'task',
      // A task title is a short operational string ("Collect PPE"), which is
      // what the chase kind's bounded parameter admits. It is not a place a
      // sensitive detail could survive a review.
      label: task.title,
      dueDate: task.due_at ? task.due_at.toISOString().slice(0, 10) : null,
      actionUrl: `/tasks?taskId=${task.id}`,
    };
  },
};

/** `approval.pending` — core plan 09's chase (PL-016, HL-054 driver). */
export const approvalPendingReminder: ReminderKindDef = {
  reminderKind: 'approval.pending',
  registeredBy: '10',
  async isSatisfied(db, { sourceId }) {
    const request = await db
      .selectFrom('platform.approval_request')
      .select(['status'])
      .where('id', '=', sourceId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    // Anything but `pending` is decided or withdrawn — nobody is waiting.
    return !request || request.status !== 'pending';
  },
  async describe(db, { sourceId }) {
    const request = await db
      .selectFrom('platform.approval_request')
      .select(['id', 'subject_type', 'created_at'])
      .where('id', '=', sourceId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!request) return null;
    return {
      sourceLabel: 'approval request',
      // The subject **type**, never the subject's content: "a leave booking is
      // waiting for you", not whose or when. The detail is behind the screen.
      label: request.subject_type,
      dueDate: null,
      actionUrl: `/approvals?requestId=${request.id}`,
    };
  },
};

registerReminderKind(taskIncompleteReminder);
registerReminderKind(approvalPendingReminder);
