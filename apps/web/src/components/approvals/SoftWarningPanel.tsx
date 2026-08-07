import * as React from 'react';
import { TriangleAlert } from 'lucide-react';
import type { ApprovalWarning, WarningAck } from '@repo/trpc/schemas';
import { cn } from '~/lib/utils';

/* Ported from the CD Fencing Design System (components/approvals/SoftWarningBlock),
   translated to Tailwind, plus the per-warning acknowledgement the plan requires.

   The design system's note on this component is a rule rather than a style:
   "It **must never disable the Approve action** — that guarantee is the whole
   point of the soft-warning language." PL-017 and HL-038 say the same thing from
   the requirements side. So this panel informs and collects acknowledgements; it
   returns no validity, and nothing downstream can ask it whether approval is
   allowed, because it does not know.

   A blocking rule is not a warning. It is a workflow guard (core plan 07), and
   it belongs on the transition rather than on this screen. */

export interface SoftWarningPanelProps {
  warnings: readonly ApprovalWarning[];
  /** Which warnings the viewer has ticked. Controlled by the caller. */
  acknowledged?: readonly WarningAck[];
  /** Omit to render read-only — the requester's preview, or a decided request. */
  onAcknowledgeChange?: (next: WarningAck[]) => void;
  title?: string;
  /** Shown under the list. The default states the non-blocking guarantee. */
  note?: string;
  className?: string;
}

function sameWarning(a: WarningAck, b: { provider: string; code: string }): boolean {
  return a.provider === b.provider && a.code === b.code;
}

export function SoftWarningPanel({
  warnings,
  acknowledged = [],
  onAcknowledgeChange,
  title = 'Before you decide',
  note = 'These are advisory. You can still approve.',
  className,
}: SoftWarningPanelProps) {
  if (warnings.length === 0) return null;
  const interactive = Boolean(onAcknowledgeChange);

  function toggle(warning: ApprovalWarning): void {
    if (!onAcknowledgeChange) return;
    const isOn = acknowledged.some((a) => sameWarning(a, warning));
    onAcknowledgeChange(
      isOn
        ? acknowledged.filter((a) => !sameWarning(a, warning))
        : [...acknowledged, { provider: warning.provider, code: warning.code }],
    );
  }

  return (
    <div
      role="note"
      className={cn(
        'rounded-md border border-severity-advisory-border bg-severity-advisory-bg px-4 py-3.5 font-sans',
        className,
      )}
    >
      <div className="mb-2.5 flex items-center gap-2">
        <TriangleAlert size={16} aria-hidden="true" className="text-severity-advisory-text" />
        <span className="text-2xs font-bold uppercase tracking-caps text-severity-advisory-text">
          {title}
        </span>
      </div>

      <ul className="flex list-none flex-col gap-2.5 p-0">
        {warnings.map((warning) => {
          const id = `warn-${warning.provider}-${warning.code}`;
          const checked = acknowledged.some((a) => sameWarning(a, warning));
          return (
            <li key={id} className="flex items-start gap-2.5">
              {interactive ? (
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(warning)}
                  className="mt-0.5 size-4 shrink-0 rounded border-border-strong accent-brand focus-visible:ring-2 focus-visible:ring-brand/40"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="mt-1.5 size-1.5 shrink-0 rounded-full bg-severity-advisory"
                />
              )}
              <label
                htmlFor={interactive ? id : undefined}
                className={cn(
                  'min-w-0 flex-1 text-sm font-medium leading-normal text-body',
                  interactive && 'cursor-pointer',
                )}
              >
                {warning.message}
              </label>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 border-t border-severity-advisory-border pt-3 text-2xs leading-normal text-severity-advisory-text">
        {note}
        {interactive && ' Ticking each one records that you saw it.'}
      </div>
    </div>
  );
}
