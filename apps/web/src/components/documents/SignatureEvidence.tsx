/**
 * The evidentiary record shown after signing and on the audit view
 * (core plan 11 §4.1, PL-011).
 *
 * Ported from the CD Fencing Design System
 * (`components/documents/SignatureEvidence`). Every value is IBM Plex Mono so
 * the block reads as a tamper-evident log rather than as prose — and, as that
 * component's notes insist, **values are rendered verbatim**. The hash is not
 * abbreviated, the user agent is not tidied, the IP is not geo-resolved. A
 * prettified evidence pack is one someone can argue was edited, which is exactly
 * the argument it exists to close (R2).
 */

export interface SignatureEvidenceProps {
  signatoryName: string;
  method: string;
  typedName: string | null;
  signedAt: string;
  ip: string;
  userAgent: string;
  ackScrolled: boolean;
  documentHash: string;
}

export function SignatureEvidence(props: SignatureEvidenceProps) {
  const rows: [string, string][] = [
    ['Signatory', props.signatoryName],
    ['Method', props.method],
    ['Name as entered', props.typedName ?? '—'],
    ['Signed at', props.signedAt],
    ['IP address', props.ip],
    ['Device / user agent', props.userAgent],
    ['Read to end acknowledged', props.ackScrolled ? 'Yes' : 'No'],
    ['Document hash', props.documentHash],
  ];

  return (
    <section
      aria-labelledby="evidence-heading"
      className="flex flex-col gap-3 rounded-lg border border-border-default bg-surface-sunken p-5"
    >
      <h2 id="evidence-heading" className="font-sans text-sm font-semibold text-strong">
        Signature evidence
      </h2>
      {/* Scrolls inside itself: a user agent string is long, and a page that
          scrolls sideways because of one is worse than a scrollbar here. */}
      <div className="overflow-x-auto">
        <dl className="grid grid-cols-[minmax(150px,auto)_1fr] gap-x-6 gap-y-2">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="font-sans text-xs text-muted">{label}</dt>
              <dd className="break-all font-mono text-xs text-strong">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
