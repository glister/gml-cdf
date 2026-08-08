import {
  Eye,
  FileCheck,
  FileUp,
  Info,
  ListChecks,
  MessageSquareText,
  PenLine,
  Receipt,
} from 'lucide-react';
import { cn } from '~/lib/utils';
import { ISSUE_MODE_LABELS, type IssueMode } from '~/lib/documents';

/**
 * The required action a document was issued with (PL-009).
 *
 * Ported from the CD Fencing Design System (`components/documents/IssueModeBadge`)
 * and **extended from three modes to eight**. The system's badge covers
 * read-only, read-and-sign and no-action; it predates the SoW v1.0 expansion to
 * the controlled response set (receipt, read-and-understood, Q&A, text, file
 * upload). The five additions follow its established pattern exactly — a
 * distinct icon, a long label, and a `short` form for dense rows — rather than
 * inventing a new visual language. Raised as a design-system gap.
 *
 * Quiet by design: this is a statement of what is being asked, not a status. The
 * status pill beside it carries the colour, and two coloured chips on one row
 * would compete for the same glance.
 */

const ICONS: Record<IssueMode, typeof Eye> = {
  read_only: Eye,
  read_and_sign: PenLine,
  no_action: Info,
  receipt_only: Receipt,
  read_and_understood: FileCheck,
  qa_response: ListChecks,
  text_response: MessageSquareText,
  file_upload: FileUp,
};

export interface IssueModeBadgeProps {
  mode: IssueMode;
  /** Condensed label for dense rows (Read / Sign / FYI …). */
  short?: boolean;
  className?: string;
}

export function IssueModeBadge({ mode, short = false, className }: IssueModeBadgeProps) {
  const Icon = ICONS[mode];
  const labels = ISSUE_MODE_LABELS[mode];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border-default bg-surface-sunken px-2 py-[3px] font-sans text-2xs font-semibold text-muted',
        className,
      )}
      title={labels.asks}
    >
      <Icon size={12} aria-hidden="true" className="shrink-0" />
      {short ? labels.short : labels.long}
    </span>
  );
}
