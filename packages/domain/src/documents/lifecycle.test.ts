import { describe, expect, it } from 'vitest';
import {
  capturesStructuredResponse,
  completesOnIssue,
  completesOnSignature,
  completesOnView,
  completionTrigger,
  evaluateCompleteGuards,
  evaluateSignGuards,
  isOutstanding,
  isSequenceLocked,
  requiresScrollAck,
  stampOnFirstView,
  stampOnIssue,
  ISSUE_MODES,
  type CompletionAction,
  type IssueMode,
  type SignGuardInput,
} from './lifecycle.js';

/**
 * The lifecycle engine's unit tests (core plan 11 §10 row 2) — all eight issue
 * modes, the sequence lock, and both guard sets including their adversarial
 * paths.
 *
 * The guard tests are written from the attacker's side on purpose: a client that
 * posts a stale hash, one that presses the receipt button on a Q&A document, one
 * that submits without scrolling. Each of those is a real request shape a
 * hand-written client can produce, and each is refused by a named failure rather
 * than by a `disabled` attribute somewhere in the UI.
 */

const HASH = `sha256:${'a'.repeat(64)}`;
const OTHER_HASH = `sha256:${'b'.repeat(64)}`;
const NOW = new Date('2026-08-07T09:00:00.000Z');

const unlocked = { inGroup: false, precedingIncomplete: 0 } as const;
const locked = { inGroup: true, precedingIncomplete: 1 } as const;

function signInput(overrides: Partial<SignGuardInput> = {}): SignGuardInput {
  return {
    status: 'viewed',
    issueMode: 'read_and_sign',
    contentHash: HASH,
    expectedHash: HASH,
    ackScrolled: true,
    requireScrollAck: true,
    sequence: unlocked,
    ...overrides,
  };
}

describe('completion semantics — all eight modes (§4.3)', () => {
  const expected: Record<IssueMode, string> = {
    no_action: 'issue',
    read_only: 'view',
    read_and_sign: 'sign',
    receipt_only: 'action:receipt',
    read_and_understood: 'action:acknowledge',
    qa_response: 'action:qa',
    text_response: 'action:text',
    file_upload: 'action:upload',
  };

  it.each(ISSUE_MODES)('%s completes on the documented trigger', (mode) => {
    const trigger = completionTrigger(mode);
    const rendered = trigger.kind === 'action' ? `action:${trigger.action}` : trigger.kind;
    expect(rendered).toBe(expected[mode]);
  });

  it('every mode has exactly one trigger — the table is total', () => {
    // A mode added to the union without a trigger would be `undefined` here, and
    // would silently complete nothing.
    expect(ISSUE_MODES.every((m) => completionTrigger(m) !== undefined)).toBe(true);
  });

  it('classifies the three special cases without enumerating statuses', () => {
    expect(completesOnIssue('no_action')).toBe(true);
    expect(completesOnView('read_only')).toBe(true);
    expect(completesOnSignature('read_and_sign')).toBe(true);
    expect(completesOnIssue('read_and_sign')).toBe(false);
  });

  it('makes read_and_understood the mode with an unconditional scroll gate', () => {
    // Signing also gates on scroll, but there it is configurable — a
    // countersignature on something already read is a legitimate flow. A mode
    // whose entire meaning is "they read it" cannot have that switched off.
    expect(requiresScrollAck('read_and_understood')).toBe(true);
    expect(requiresScrollAck('read_and_sign')).toBe(false);
  });

  it('makes qa_response the only mode carrying structured capture', () => {
    expect(capturesStructuredResponse('qa_response')).toBe(true);
    expect(ISSUE_MODES.filter(capturesStructuredResponse)).toEqual(['qa_response']);
  });
});

describe('stamps', () => {
  it('completes a no_action document the moment it is issued', () => {
    // Otherwise it sits outstanding on every list and reminder sweep forever.
    expect(stampOnIssue('no_action', NOW)).toEqual({
      status: 'issued',
      completedAt: NOW,
      completes: true,
    });
  });

  it('leaves every other mode outstanding at issue', () => {
    expect(stampOnIssue('read_and_sign', NOW).completes).toBe(false);
  });

  it('completes a read_only document on first view', () => {
    expect(stampOnFirstView('read_only', 'issued', NOW)).toEqual({
      status: 'completed',
      completedAt: NOW,
      completes: true,
    });
  });

  it('moves a read_and_sign document to viewed without completing it', () => {
    expect(stampOnFirstView('read_and_sign', 'issued', NOW)).toEqual({
      status: 'viewed',
      completedAt: null,
      completes: false,
    });
  });

  it('never walks a status backwards when a completed document is re-opened', () => {
    // Re-reading a signed document a year later has not made it newly viewed.
    expect(stampOnFirstView('read_and_sign', 'signed', NOW)).toEqual({
      status: 'signed',
      completedAt: null,
      completes: false,
    });
  });
});

describe('isSequenceLocked (ON-023 driver)', () => {
  it('never locks a document that is not in a group', () => {
    // The case that would otherwise be written as `precedingIncomplete === 0` at
    // a dozen call sites and got wrong at one of them.
    expect(isSequenceLocked({ inGroup: false, precedingIncomplete: 3 })).toBe(false);
  });

  it('locks while an earlier document in the group is incomplete', () => {
    expect(isSequenceLocked(locked)).toBe(true);
  });

  it('unlocks the moment the count reaches zero, with no further action', () => {
    expect(isSequenceLocked({ inGroup: true, precedingIncomplete: 0 })).toBe(false);
  });
});

describe('evaluateSignGuards (§4.3, PL-011)', () => {
  it('permits a signature when every condition holds', () => {
    expect(evaluateSignGuards(signInput())).toEqual({ ok: true });
  });

  it('refuses a document that is not issued yet', () => {
    expect(evaluateSignGuards(signInput({ status: 'draft' }))).toMatchObject({
      failure: 'not_issued',
    });
  });

  it('refuses a document already signed', () => {
    expect(evaluateSignGuards(signInput({ status: 'signed' }))).toMatchObject({
      failure: 'already_terminal',
    });
  });

  it('refuses a withdrawn document', () => {
    expect(evaluateSignGuards(signInput({ status: 'cancelled' }))).toMatchObject({
      failure: 'cancelled',
    });
  });

  it('refuses to sign a document issued in a non-signature mode', () => {
    expect(evaluateSignGuards(signInput({ issueMode: 'receipt_only' }))).toMatchObject({
      failure: 'wrong_mode',
    });
  });

  it('refuses while an earlier document in the group is outstanding', () => {
    expect(evaluateSignGuards(signInput({ sequence: locked }))).toMatchObject({
      failure: 'sequence_locked',
    });
  });

  it('refuses before the render step has produced a hash', () => {
    // "Preparing document…" is a real state, and signing during it would bind a
    // signature to bytes that do not exist yet.
    expect(evaluateSignGuards(signInput({ contentHash: null }))).toMatchObject({
      failure: 'not_rendered',
    });
  });

  it('refuses a stale expectedHash — the difference between signing a document and signing these bytes', () => {
    expect(evaluateSignGuards(signInput({ expectedHash: OTHER_HASH }))).toMatchObject({
      failure: 'hash_mismatch',
    });
  });

  it('refuses an unscrolled signature when the control is on, and permits it when off', () => {
    expect(evaluateSignGuards(signInput({ ackScrolled: false }))).toMatchObject({
      failure: 'scroll_ack_required',
    });
    // The control is configuration (§6), so turning it off must actually work.
    expect(evaluateSignGuards(signInput({ ackScrolled: false, requireScrollAck: false }))).toEqual({
      ok: true,
    });
  });

  it('checks the sequence lock before the hash, so a locked document says why', () => {
    // Ordering matters for the message the subject sees: "an earlier document is
    // outstanding" is actionable; "reload and read it again" is not.
    expect(
      evaluateSignGuards(signInput({ sequence: locked, expectedHash: OTHER_HASH })),
    ).toMatchObject({ failure: 'sequence_locked' });
  });
});

describe('evaluateCompleteGuards (§4.3, PL-009)', () => {
  const base = {
    status: 'issued',
    ackScrolled: true,
    sequence: unlocked,
  } as const;

  it('permits a receipt on a receipt_only document', () => {
    expect(
      evaluateCompleteGuards({ ...base, issueMode: 'receipt_only', action: 'receipt' }),
    ).toEqual({ ok: true });
  });

  it.each([
    ['qa_response', 'receipt'],
    ['file_upload', 'text'],
    ['read_and_understood', 'receipt'],
    ['read_and_sign', 'receipt'],
  ] as const)(
    'refuses a %s document completed by a %s action',
    (issueMode, action: CompletionAction) => {
      // Without this, a qa_response document is satisfiable by the cheapest
      // endpoint, and the response schema is enforced only for clients that
      // choose to send one.
      expect(evaluateCompleteGuards({ ...base, issueMode, action })).toMatchObject({
        failure: 'wrong_mode',
      });
    },
  );

  it('refuses an unscrolled acknowledgement, unconditionally', () => {
    expect(
      evaluateCompleteGuards({
        ...base,
        issueMode: 'read_and_understood',
        action: 'acknowledge',
        ackScrolled: false,
      }),
    ).toMatchObject({ failure: 'scroll_ack_required' });
  });

  it('distinguishes answers that were not supplied from answers that were rejected', () => {
    // Two different messages for the subject, and two different diagnoses for
    // whoever investigates a stuck document.
    expect(
      evaluateCompleteGuards({
        ...base,
        issueMode: 'qa_response',
        action: 'qa',
        captureValid: null,
      }),
    ).toMatchObject({ failure: 'capture_missing' });
    expect(
      evaluateCompleteGuards({
        ...base,
        issueMode: 'qa_response',
        action: 'qa',
        captureValid: false,
      }),
    ).toMatchObject({ failure: 'capture_invalid' });
  });

  it('permits a qa_response completion when the answers validated', () => {
    expect(
      evaluateCompleteGuards({
        ...base,
        issueMode: 'qa_response',
        action: 'qa',
        captureValid: true,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses an empty text response', () => {
    expect(
      evaluateCompleteGuards({
        ...base,
        issueMode: 'text_response',
        action: 'text',
        textSupplied: false,
      }),
    ).toMatchObject({ failure: 'capture_missing' });
  });

  it('refuses while an earlier document in the group is outstanding', () => {
    expect(
      evaluateCompleteGuards({
        ...base,
        issueMode: 'receipt_only',
        action: 'receipt',
        sequence: locked,
      }),
    ).toMatchObject({ failure: 'sequence_locked' });
  });
});

describe('isOutstanding — one definition of "done" (§9.5)', () => {
  it('treats an issued, uncompleted document as outstanding', () => {
    expect(isOutstanding('issued', null)).toBe(true);
    expect(isOutstanding('viewed', null)).toBe(true);
  });

  it('treats a completed document as done regardless of which status it reached', () => {
    // `signed` and `completed` are both terminal; `completed_at` is what both
    // have in common, which is why the reminder check reads that and not a list
    // of statuses that would need updating with every new mode.
    expect(isOutstanding('signed', NOW)).toBe(false);
    expect(isOutstanding('completed', NOW)).toBe(false);
  });

  it('never chases a draft or a withdrawn document', () => {
    expect(isOutstanding('draft', null)).toBe(false);
    expect(isOutstanding('cancelled', null)).toBe(false);
  });
});
