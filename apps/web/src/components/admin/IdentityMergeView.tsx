import * as React from 'react';
import { ArrowRight, ShieldAlert } from 'lucide-react';
import { cn } from '~/lib/utils';
import { Avatar } from '~/components/data-display/Avatar';
import { Callout } from '~/components/feedback/Callout';

/* Ported from the CD Fencing Design System (components/admin/IdentityMergeView),
   translated to Tailwind and adapted to the platform.identity.merge contract.

   The design shows a per-FIELD keep-left/keep-right merge with a synthesised
   result column. The backend merge is record-level: the surviving person keeps
   its own attributes, the superseded person's sign-in accounts are repointed and
   its flags are unioned onto the survivor (packages/trpc … identity.ts `merge`).
   There is no field-level attribute merge to drive. So this view keeps the
   side-by-side comparison, difference highlighting and the always-on
   safeguarding-flags-survive guarantee, but the choice it collects is which
   record SURVIVES — the honest unit the API accepts. (Genuine design/API gap,
   flagged in the plan change log rather than faking a field merge.) */

export interface MergeParty {
  id: string;
  name: string;
  ref?: React.ReactNode;
}

export interface MergeField {
  label: string;
  a: React.ReactNode;
  b: React.ReactNode;
  mono?: boolean;
}

export interface SafeguardingFlagRef {
  label: string;
  source?: string;
}

export interface IdentityMergeViewProps {
  a: MergeParty;
  b: MergeParty;
  fields: MergeField[];
  survivorId: string;
  onSurvivorChange: (id: string) => void;
  safeguardingFlags?: SafeguardingFlagRef[];
  className?: string;
}

export function IdentityMergeView({
  a,
  b,
  fields,
  survivorId,
  onSurvivorChange,
  safeguardingFlags = [],
  className,
}: IdentityMergeViewProps) {
  const parties = [a, b] as const;

  return (
    <div className={cn('flex flex-col gap-4 font-sans', className)}>
      {/* safeguarding guarantee — always on */}
      <Callout
        tone="danger"
        icon={<ShieldAlert size={16} />}
        title="Safeguarding flags always survive the merge"
      >
        {safeguardingFlags.length > 0 ? (
          <>
            {safeguardingFlags.map((f, i) => (
              <span key={i} className="mr-3 inline-flex items-center gap-1.5">
                <b className="text-state-danger-text">{f.label}</b>
                {f.source && <span className="text-2xs text-muted">({f.source})</span>}
              </span>
            ))}
            <span> are preserved on the surviving record regardless of which you keep.</span>
          </>
        ) : (
          'Any do-not-rehire or safeguarding flag on either record is preserved on the surviving record regardless of which you keep.'
        )}
      </Callout>

      {/* survivor chooser */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {parties.map((p) => {
          const survives = survivorId === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSurvivorChange(p.id)}
              className={cn(
                'flex items-center gap-3 rounded-lg border-[1.5px] p-3 text-left transition-colors',
                survives
                  ? 'border-brand bg-brand-subtle'
                  : 'border-border-subtle bg-surface-card hover:border-border-strong',
              )}
            >
              <Avatar name={p.name} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold text-strong">{p.name}</span>
                {p.ref && <span className="block font-mono text-2xs text-muted">{p.ref}</span>}
              </span>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-bold',
                  survives ? 'bg-brand text-on-brand' : 'bg-gray-100 text-muted',
                )}
              >
                {survives ? (
                  <>
                    <ArrowRight size={12} /> Survives
                  </>
                ) : (
                  'Merged in'
                )}
              </span>
            </button>
          );
        })}
      </div>

      {/* comparison grid */}
      <div className="overflow-hidden rounded-md border border-border-subtle">
        <div className="grid grid-cols-[minmax(120px,1fr)_1.4fr_1.4fr] bg-gray-50 text-2xs font-bold uppercase tracking-caps text-muted">
          <div className="px-3 py-2">Field</div>
          <div
            className={cn(
              'border-l border-border-subtle px-3 py-2',
              survivorId === a.id && 'bg-brand-subtle text-brand-press',
            )}
          >
            {a.name}
          </div>
          <div
            className={cn(
              'border-l border-border-subtle px-3 py-2',
              survivorId === b.id && 'bg-brand-subtle text-brand-press',
            )}
          >
            {b.name}
          </div>
        </div>
        {fields.map((f, i) => {
          const differs = String(f.a ?? '') !== String(f.b ?? '');
          const valueCell = (val: React.ReactNode, isSurvivor: boolean) => (
            <div
              className={cn(
                'border-l border-border-subtle px-3 py-2.5 text-sm',
                f.mono ? 'font-mono' : 'font-sans',
                isSurvivor ? 'bg-brand-subtle font-semibold text-brand-press' : 'text-body',
              )}
            >
              {val || '—'}
            </div>
          );
          return (
            <div
              key={f.label}
              className={cn(
                'grid grid-cols-[minmax(120px,1fr)_1.4fr_1.4fr] items-stretch',
                i < fields.length - 1 && 'border-b border-border-subtle',
              )}
            >
              <div className="flex items-center gap-1.5 px-3 py-2.5 text-xs font-semibold text-strong">
                {f.label}
                {differs && (
                  <span
                    title="Values differ"
                    aria-label="Values differ"
                    className="size-1.5 rounded-full bg-state-pending"
                  />
                )}
              </div>
              {valueCell(f.a, survivorId === a.id)}
              {valueCell(f.b, survivorId === b.id)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
