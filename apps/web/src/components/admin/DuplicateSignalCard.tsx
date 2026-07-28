import * as React from 'react';
import { Users } from 'lucide-react';
import { cn } from '~/lib/utils';
import { Button } from '~/components/ui/button';
import { PersonCell } from '~/components/data-display/PersonCell';

/* Ported from the CD Fencing Design System (components/admin/DuplicateSignalCard),
   translated to Tailwind. Advisory possible-duplicate card: two person summaries
   side by side with matching attributes highlighted, an explicitly advisory
   (soft-warning amber) tone stating NO automatic merge occurs, and Review /
   Dismiss actions. The design system's "advisory" severity maps to the amber
   `state-pending` taxonomy tone in the web token bridge. */

export interface DuplicateParty {
  name: string;
  secondary?: React.ReactNode;
  attrs: Record<string, React.ReactNode>;
}

export interface DuplicateSignalCardProps {
  left: DuplicateParty;
  right: DuplicateParty;
  matchLabel?: string;
  /** Attribute keys that match across the two records → highlighted. */
  matches?: string[];
  onReview?: () => void;
  onDismiss?: () => void;
  className?: string;
}

const MONO_KEY = /email|dob|ni|phone|nino|ref/i;

export function DuplicateSignalCard({
  left,
  right,
  matchLabel = 'Possible duplicate',
  matches = [],
  onReview,
  onDismiss,
  className,
}: DuplicateSignalCardProps) {
  const attrKeys = Array.from(new Set([...Object.keys(left.attrs), ...Object.keys(right.attrs)]));

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-state-pending-border border-t-[3px] border-t-state-pending bg-surface-card font-sans shadow-sm',
        className,
      )}
    >
      {/* advisory header */}
      <div className="flex items-center gap-2.5 border-b border-state-pending-border bg-state-pending-bg px-4 py-2.5">
        <Users size={17} aria-hidden="true" className="text-state-pending-text" />
        <span className="text-sm font-bold text-state-pending-text">{matchLabel}</span>
        <span className="ml-auto text-2xs text-state-pending-text/90">
          Advisory · no automatic merge occurs
        </span>
      </div>

      {/* two summaries */}
      <div className="grid grid-cols-1 sm:grid-cols-2">
        {[left, right].map((p, ci) => (
          <div
            key={ci}
            className={cn(
              'p-4',
              ci === 0 && 'border-b border-border-subtle sm:border-b-0 sm:border-r',
            )}
          >
            <PersonCell name={p.name} secondary={p.secondary} />
            <dl className="mt-3.5 flex flex-col gap-0">
              {attrKeys.map((k) => {
                const isMatch = matches.includes(k);
                return (
                  <div
                    key={k}
                    className={cn(
                      'flex items-baseline justify-between gap-3 rounded-sm px-2 py-1.5',
                      isMatch && 'bg-state-pending-bg',
                    )}
                  >
                    <dt className="text-2xs font-semibold uppercase tracking-caps text-muted">
                      {k}
                    </dt>
                    <dd
                      className={cn(
                        'm-0 text-right text-sm',
                        MONO_KEY.test(k) ? 'font-mono' : 'font-sans',
                        isMatch ? 'font-semibold text-state-pending-text' : 'text-body',
                      )}
                    >
                      {p.attrs[k] || '—'}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ))}
      </div>

      {/* actions */}
      <div className="flex items-center gap-2.5 border-t border-border-subtle bg-gray-50 px-4 py-3">
        <span className="text-xs text-muted">
          {matches.length} matching attribute{matches.length === 1 ? '' : 's'}
        </span>
        <div className="ml-auto flex gap-2.5">
          {onDismiss && (
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
          )}
          {onReview && (
            <Button variant="secondary" size="sm" onClick={onReview}>
              Review
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
