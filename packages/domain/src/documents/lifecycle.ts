/**
 * The document lifecycle engine (core plan 11 §4.3, PL-009/011; ON-016/023
 * drivers) — completion semantics per issue mode, the sequence-lock predicate
 * and the sign/complete guards. Pure (ADR-0009): every instant is passed in, and
 * the SQL-computed facts a guard needs (how many earlier documents in the group
 * are still incomplete, whether the capture data validated) arrive as arguments
 * rather than being looked up here.
 *
 * ## Why "completed" is not the same column as "signed"
 *
 * `platform.document.status` reaches `signed` for a `read_and_sign` document and
 * `completed` for the response modes, but `completed_at`/`completed_by` are
 * stamped in **both** cases — PL-009 asks for the required action, the
 * completion status, the date and the user, in every case. So "is this done?" is
 * one question with one answer (`completed_at IS NOT NULL`), while "how was it
 * done?" is `issue_mode` plus, where one exists, a signature-evidence row. A
 * design that answered the first question by enumerating statuses would need
 * updating every time a mode was added.
 *
 * ## Why the sequence lock is a predicate over a count
 *
 * "Document 2 is locked until document 1 completes" is a fact about *other rows*,
 * so it cannot be computed from the document in hand. The engine takes
 * `precedingIncomplete` — a number the list query produces in SQL — and turns it
 * into a decision. That split is what keeps the lock correct on a keyset-paginated
 * list: the count is computed by the database over the whole group, never by
 * counting what happened to be on the loaded page (ADR-0004).
 */

/** The eight required actions a document can be issued with (PL-009). */
export const ISSUE_MODES = [
  'read_only',
  'read_and_sign',
  'no_action',
  'receipt_only',
  'read_and_understood',
  'qa_response',
  'text_response',
  'file_upload',
] as const;

export type IssueMode = (typeof ISSUE_MODES)[number];

/** The document content lifecycle (§4.3). */
export const DOCUMENT_STATUSES = [
  'draft',
  'issued',
  'viewed',
  'signed',
  'completed',
  'cancelled',
] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** The asynchronous SharePoint half (§4.3). */
export type FilingState = 'none' | 'pending' | 'filed' | 'failed';

/**
 * The explicit action a subject takes on a non-signature document
 * (`platform.documents.complete`). One value per response mode plus the two
 * acknowledgement forms — deliberately *not* a single "complete" verb, so a
 * client cannot satisfy a `qa_response` document by pressing the receipt button.
 */
export const COMPLETION_ACTIONS = ['receipt', 'acknowledge', 'qa', 'text', 'upload'] as const;

export type CompletionAction = (typeof COMPLETION_ACTIONS)[number];

/** What makes a document of each mode complete (§4.3's table, as code). */
export type CompletionTrigger =
  /** Complete the moment it is issued — nothing is asked of the subject. */
  | { readonly kind: 'issue' }
  /** Complete on the subject's first view. */
  | { readonly kind: 'view' }
  /** Complete on a signature-evidence row. */
  | { readonly kind: 'sign' }
  /** Complete on an explicit action of the named kind. */
  | { readonly kind: 'action'; readonly action: CompletionAction };

const COMPLETION_TRIGGERS: Record<IssueMode, CompletionTrigger> = {
  no_action: { kind: 'issue' },
  read_only: { kind: 'view' },
  read_and_sign: { kind: 'sign' },
  receipt_only: { kind: 'action', action: 'receipt' },
  read_and_understood: { kind: 'action', action: 'acknowledge' },
  qa_response: { kind: 'action', action: 'qa' },
  text_response: { kind: 'action', action: 'text' },
  file_upload: { kind: 'action', action: 'upload' },
};

/** What completes a document issued in this mode. */
export function completionTrigger(mode: IssueMode): CompletionTrigger {
  return COMPLETION_TRIGGERS[mode];
}

/** Whether issuing alone completes it (`no_action`). */
export function completesOnIssue(mode: IssueMode): boolean {
  return COMPLETION_TRIGGERS[mode].kind === 'issue';
}

/** Whether the subject's first view completes it (`read_only`). */
export function completesOnView(mode: IssueMode): boolean {
  return COMPLETION_TRIGGERS[mode].kind === 'view';
}

/** Whether a signature is what completes it (`read_and_sign`). */
export function completesOnSignature(mode: IssueMode): boolean {
  return COMPLETION_TRIGGERS[mode].kind === 'sign';
}

/** Whether this mode requires the subject to scroll before completing. */
export function requiresScrollAck(mode: IssueMode): boolean {
  // `read_and_understood` is the mode whose entire meaning is "they read it", so
  // the acknowledgement is unconditional here rather than configurable. Signing
  // also requires it, but there it is a configurable control
  // (`platform.documents.sign.require_scroll_ack`), because a countersignature
  // on a document someone has already read is a legitimate flow to enable.
  return mode === 'read_and_understood';
}

/** Whether this mode's completion carries structured capture data. */
export function capturesStructuredResponse(mode: IssueMode): boolean {
  return mode === 'qa_response';
}

// --- The sequence lock (ON-023 driver) ---------------------------------------

export interface SequenceLockInput {
  /** Whether the document belongs to an ordered issue group at all. */
  readonly inGroup: boolean;
  /**
   * How many documents earlier in the same group are not yet complete — an
   * `EXISTS`/`count` the list query computes in SQL over the whole group, never
   * over a loaded page (§4.3, ADR-0004).
   */
  readonly precedingIncomplete: number;
}

/**
 * Whether a document is locked behind an earlier one in its ordered group.
 *
 * An ungrouped document is never locked, which is the case that would otherwise
 * be written as `precedingIncomplete === 0` at a dozen call sites and get one of
 * them wrong.
 */
export function isSequenceLocked(input: SequenceLockInput): boolean {
  return input.inGroup && input.precedingIncomplete > 0;
}

// --- Guards ------------------------------------------------------------------

/** Why an action was refused. The router maps these onto tRPC error codes. */
export type DocumentGuardFailure =
  | 'not_issued'
  | 'already_terminal'
  | 'cancelled'
  | 'sequence_locked'
  | 'wrong_mode'
  | 'not_rendered'
  | 'hash_mismatch'
  | 'scroll_ack_required'
  | 'capture_invalid'
  | 'capture_missing';

export type DocumentGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: DocumentGuardFailure; readonly message: string };

const OK: DocumentGuardResult = { ok: true };

function fail(failure: DocumentGuardFailure, message: string): DocumentGuardResult {
  return { ok: false, failure, message };
}

/** The states from which a subject may still act on a document. */
function isActionable(status: DocumentStatus): DocumentGuardResult {
  if (status === 'cancelled') {
    return fail('cancelled', 'this document has been withdrawn');
  }
  if (status === 'draft') {
    return fail('not_issued', 'this document has not been issued yet');
  }
  if (status === 'signed' || status === 'completed') {
    return fail('already_terminal', 'this document has already been completed');
  }
  return OK;
}

export interface SignGuardInput {
  readonly status: DocumentStatus;
  readonly issueMode: IssueMode;
  /** `sha256:<hex>` once the render step has run; `null` until then. */
  readonly contentHash: string | null;
  /** The hash the client displayed — proof they saw the bytes being signed. */
  readonly expectedHash: string;
  readonly ackScrolled: boolean;
  /** `platform.documents.sign.require_scroll_ack`, resolved as-at by the caller. */
  readonly requireScrollAck: boolean;
  readonly sequence: SequenceLockInput;
}

/**
 * Every condition that must hold before a signature is recorded (§4.3).
 *
 * The `expectedHash` check is the one that matters most and the one most easily
 * argued away. It is not a cache-freshness check: it is the difference between
 * "this person signed a document" and "this person signed **these bytes**". A
 * client that displayed an older render and posts a stale hash is refused, which
 * is precisely the case an SES evidence pack has to be able to rule out.
 */
export function evaluateSignGuards(input: SignGuardInput): DocumentGuardResult {
  const actionable = isActionable(input.status);
  if (!actionable.ok) return actionable;

  if (!completesOnSignature(input.issueMode)) {
    return fail(
      'wrong_mode',
      `this document was issued as '${input.issueMode}', which is not completed by signing`,
    );
  }
  if (isSequenceLocked(input.sequence)) {
    return fail('sequence_locked', 'an earlier document in this group is still outstanding');
  }
  if (input.contentHash === null) {
    return fail('not_rendered', 'this document is still being prepared and cannot be signed yet');
  }
  if (input.expectedHash !== input.contentHash) {
    return fail(
      'hash_mismatch',
      'the document has been re-rendered since it was displayed — reload it and read it again before signing',
    );
  }
  if (input.requireScrollAck && !input.ackScrolled) {
    return fail('scroll_ack_required', 'read to the end of the document before signing');
  }
  return OK;
}

export interface CompleteGuardInput {
  readonly status: DocumentStatus;
  readonly issueMode: IssueMode;
  /** The action the subject took. Must match what the mode is completed by. */
  readonly action: CompletionAction;
  readonly ackScrolled: boolean;
  readonly sequence: SequenceLockInput;
  /**
   * For `qa_response`: whether the submitted answers validated against the
   * document's registered capture schema. `null` when no answers were supplied
   * at all — a distinct failure from answers that were supplied and rejected.
   */
  readonly captureValid?: boolean | null;
  /** For `text_response`: whether a non-empty response was supplied. */
  readonly textSupplied?: boolean;
}

/**
 * Every condition that must hold before a non-signature completion is recorded.
 *
 * The action/mode match is the guard that stops a client completing anything by
 * pressing the cheapest button. Without it, a `qa_response` document would be
 * satisfiable by the receipt endpoint — the response schema would be enforced
 * only for callers that chose to send one.
 */
export function evaluateCompleteGuards(input: CompleteGuardInput): DocumentGuardResult {
  const actionable = isActionable(input.status);
  if (!actionable.ok) return actionable;

  const trigger = completionTrigger(input.issueMode);
  if (trigger.kind !== 'action' || trigger.action !== input.action) {
    return fail(
      'wrong_mode',
      `this document was issued as '${input.issueMode}', which is not completed by a '${input.action}' action`,
    );
  }
  if (isSequenceLocked(input.sequence)) {
    return fail('sequence_locked', 'an earlier document in this group is still outstanding');
  }
  if (requiresScrollAck(input.issueMode) && !input.ackScrolled) {
    return fail('scroll_ack_required', 'read to the end of the document before acknowledging it');
  }
  if (input.issueMode === 'qa_response') {
    if (input.captureValid === null || input.captureValid === undefined) {
      return fail('capture_missing', 'answer the questions before submitting');
    }
    if (!input.captureValid) {
      return fail('capture_invalid', 'some answers are missing or invalid');
    }
  }
  if (input.issueMode === 'text_response' && !input.textSupplied) {
    return fail('capture_missing', 'enter a response before submitting');
  }
  return OK;
}

// --- Transitions -------------------------------------------------------------

export interface CompletionStamp {
  readonly status: DocumentStatus;
  readonly completedAt: Date | null;
  /** Whether this transition is the one that completes the document. */
  readonly completes: boolean;
}

/**
 * The status a document reaches when it is issued, and whether that completes it.
 *
 * `no_action` completes at issue — a payslip notice nobody has to do anything
 * about is done the moment it is sent, and pretending otherwise would leave it
 * outstanding on every list and reminder sweep forever.
 */
export function stampOnIssue(mode: IssueMode, now: Date): CompletionStamp {
  return completesOnIssue(mode)
    ? { status: 'issued', completedAt: now, completes: true }
    : { status: 'issued', completedAt: null, completes: false };
}

/**
 * The status a document reaches on the subject's first view.
 *
 * Only the **first** view transitions (ON-016): `viewed_at` records when the
 * subject first opened it, and a document re-read a year later has not become
 * newly viewed. The caller decides whether this is the first view — it holds the
 * row — and this function decides what that means.
 */
export function stampOnFirstView(
  mode: IssueMode,
  status: DocumentStatus,
  now: Date,
): CompletionStamp {
  // A document already past `issued` keeps whatever it reached: viewing a signed
  // document again must not walk its status backwards.
  if (status !== 'issued') {
    return { status, completedAt: null, completes: false };
  }
  return completesOnView(mode)
    ? { status: 'completed', completedAt: now, completes: true }
    : { status: 'viewed', completedAt: null, completes: false };
}

/** Signing always both signs and completes (PL-009's "in every case"). */
export function stampOnSign(now: Date): CompletionStamp {
  return { status: 'signed', completedAt: now, completes: true };
}

/** A non-signature completion. */
export function stampOnComplete(now: Date): CompletionStamp {
  return { status: 'completed', completedAt: now, completes: true };
}

/**
 * Whether a document is still outstanding — the reminder rule's satisfaction
 * check (§9.5) and the sequence lock's definition of "incomplete", expressed
 * once so the two cannot disagree about what "done" means.
 */
export function isOutstanding(status: DocumentStatus, completedAt: Date | null): boolean {
  if (status === 'cancelled' || status === 'draft') return false;
  return completedAt === null;
}
