import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/trpc';
import type { StatusTone } from '~/components/data-display/StatusPill';

/**
 * Document display vocabulary (core plan 11 §5.3).
 *
 * Labels and tones only. **Nothing here decides anything**: whether a document
 * is locked, rendered, outstanding or signable is computed server-side and
 * arrives on the row (`isLocked`, `isRendered`, `completedAt`). A screen that
 * re-derived any of those from the fields around them would be a second
 * implementation of the lifecycle engine, and the two would eventually disagree
 * — with the browser's answer winning, because it is the one a person sees.
 */

type Outputs = inferRouterOutputs<AppRouter>;
export type DocumentRow = Outputs['platform']['documents']['listForSubject']['items'][number];
export type DocumentDetail = Outputs['platform']['documents']['get'];
export type TemplateRow = Outputs['platform']['templates']['list']['items'][number];
export type IssueMode = DocumentRow['issueMode'];
export type DocumentStatus = DocumentRow['status'];
export type FilingState = DocumentRow['filingState'];

/**
 * The eight required actions (PL-009).
 *
 * The design system's `IssueModeBadge` covers three (read-only, read-and-sign,
 * no-action) — it predates the SoW v1.0 expansion to the controlled response
 * set. The five new ones follow its pattern: a short label for dense rows, a
 * long one for the viewer, and a plain-English description of what the person
 * is being asked to do. Flagged as a design-system gap in the run report.
 */
export const ISSUE_MODES = [
  'read_only',
  'read_and_sign',
  'no_action',
  'receipt_only',
  'read_and_understood',
  'qa_response',
  'text_response',
  'file_upload',
] as const satisfies readonly IssueMode[];

export const ISSUE_MODE_LABELS: Record<IssueMode, { short: string; long: string; asks: string }> = {
  read_only: { short: 'Read', long: 'Read only', asks: 'Read this document.' },
  read_and_sign: { short: 'Sign', long: 'Read and sign', asks: 'Read this document and sign it.' },
  no_action: { short: 'FYI', long: 'No action', asks: 'For your information. Nothing to do.' },
  receipt_only: {
    short: 'Receipt',
    long: 'Confirm receipt',
    asks: 'Confirm you have received this document.',
  },
  read_and_understood: {
    short: 'Understood',
    long: 'Read and understood',
    asks: 'Read to the end, then confirm you have understood it.',
  },
  qa_response: {
    short: 'Answer',
    long: 'Answer questions',
    asks: 'Read this document and answer the questions below.',
  },
  text_response: {
    short: 'Respond',
    long: 'Written response',
    asks: 'Read this document and write a response.',
  },
  file_upload: {
    short: 'Upload',
    long: 'Upload a file',
    asks: 'Read this document and upload the file or photograph it asks for.',
  },
};

/** Which of the five completion actions a mode is completed by, or `null`. */
export const COMPLETION_ACTION: Record<
  IssueMode,
  'receipt' | 'acknowledge' | 'qa' | 'text' | 'upload' | null
> = {
  read_only: null,
  read_and_sign: null,
  no_action: null,
  receipt_only: 'receipt',
  read_and_understood: 'acknowledge',
  qa_response: 'qa',
  text_response: 'text',
  file_upload: 'upload',
};

/** Status label + tone, on the document taxonomy (`--state-doc-*`). */
export const DOCUMENT_STATUS: Record<DocumentStatus, { label: string; tone: StatusTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  issued: { label: 'Issued', tone: 'info' },
  viewed: { label: 'Viewed', tone: 'info' },
  // Signed reads as success; so does a completed response action, because from
  // the subject's point of view they are the same outcome.
  signed: { label: 'Signed', tone: 'success' },
  completed: { label: 'Completed', tone: 'success' },
  cancelled: { label: 'Withdrawn', tone: 'neutral' },
};

/**
 * The filing badge, shown to HR and administrators only.
 *
 * `none` and `filed` render nothing: a document that filed correctly is not
 * news, and a badge on every row would make the two that matter invisible.
 */
export const FILING_BADGE: Partial<Record<FilingState, { label: string; tone: StatusTone }>> = {
  pending: { label: 'Filing', tone: 'pending' },
  failed: { label: 'Filing failed', tone: 'danger' },
};

export const TEMPLATE_STATUS: Record<TemplateRow['status'], { label: string; tone: StatusTone }> = {
  draft: { label: 'Draft', tone: 'pending' },
  published: { label: 'Published', tone: 'success' },
  archived: { label: 'Archived', tone: 'neutral' },
};

/** `2026-08-07 14:32` — the same fixed form the rest of the app uses. */
export function formatStamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The single sentence a document's row shows about where it has got to.
 *
 * Reads the server's own fields in the order the lifecycle defines, so the list
 * and the viewer never disagree about what "done" means.
 */
export function progressLine(doc: DocumentRow): string {
  if (doc.status === 'cancelled') return 'Withdrawn';
  if (doc.completedAt) {
    return doc.signedAt
      ? `Signed ${formatStamp(doc.signedAt)}`
      : `Completed ${formatStamp(doc.completedAt)}`;
  }
  if (doc.isLocked) return 'Waiting on an earlier document';
  if (!doc.isRendered && doc.status !== 'draft') return 'Preparing document…';
  if (doc.viewedAt) return `Opened ${formatStamp(doc.viewedAt)}`;
  if (doc.issuedAt) return `Issued ${formatStamp(doc.issuedAt)}`;
  return 'Not issued';
}
