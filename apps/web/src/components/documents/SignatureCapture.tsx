import * as React from 'react';
import { Button } from '~/components/ui/button';
import { Callout } from '~/components/feedback/Callout';
import { Checkbox } from '~/components/forms/Checkbox';

/**
 * The signing block — UK Simple Electronic Signature, typed-name method
 * (core plan 11 §4.7, PL-011).
 *
 * Ported from the CD Fencing Design System (`components/documents/SignatureCapture`),
 * type method only: the draw method lands with the Expo app (ADR-0023), and the
 * schema already carries `method`/`signature_image` for it.
 *
 * ## Three gates, and none of them is the real one
 *
 * The typed name, the consent checkbox and the scroll acknowledgement all gate
 * the button here — and every one of them is **also** enforced server-side, in
 * `evaluateSignGuards`. This component is a courtesy to the person signing, not
 * a control: a `disabled` attribute is one devtools keystroke from gone, and the
 * evidence pack has to survive being argued with. If this file were deleted the
 * rules would still hold.
 *
 * The consent checkbox is never pre-ticked. A consent statement someone did not
 * actively agree to is not consent, and pre-ticking it is the single change that
 * would turn this whole flow into theatre.
 */

export interface SignatureCaptureProps {
  /** Pre-fills the typed name. The signatory may change it — see below. */
  defaultName: string;
  /**
   * Whether the read confirmation is required at all
   * (`platform.documents.sign.require_scroll_ack`, §6).
   */
  requireReadConfirmation: boolean;
  /** False until the render step has produced bytes to bind the signature to. */
  ready: boolean;
  pending: boolean;
  error?: string | null;
  /** `readConfirmed` becomes `ack_scrolled` on the evidence row. */
  onSign: (input: { typedName: string; readConfirmed: boolean }) => void;
}

export function SignatureCapture({
  defaultName,
  requireReadConfirmation,
  ready,
  pending,
  error,
  onSign,
}: SignatureCaptureProps) {
  const [typedName, setTypedName] = React.useState(defaultName);
  const [consented, setConsented] = React.useState(false);
  const [readConfirmed, setReadConfirmed] = React.useState(false);

  const name = typedName.trim();
  const readSatisfied = !requireReadConfirmation || readConfirmed;
  const canSign = ready && name.length > 0 && consented && readSatisfied && !pending;

  return (
    <section
      aria-labelledby="sign-heading"
      className="flex flex-col gap-4 rounded-lg border border-border-default bg-surface-card p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id="sign-heading" className="font-sans text-base font-semibold text-strong">
          Sign this document
        </h2>
        <p className="font-sans text-sm text-muted">
          Type your full name below. This is a simple electronic signature and has the same legal
          effect as signing on paper.
        </p>
      </div>

      {!ready && (
        <Callout tone="info" title="Preparing document">
          This document is still being prepared. The signing controls become available once it is
          ready — usually a few seconds.
        </Callout>
      )}

      <div className="flex flex-col gap-2">
        <label htmlFor="typed-name" className="font-sans text-sm font-semibold text-strong">
          Your full name
        </label>
        <input
          id="typed-name"
          type="text"
          value={typedName}
          onChange={(e) => setTypedName(e.target.value)}
          autoComplete="name"
          className="h-11 rounded-md border border-border-default bg-surface-card px-3 font-sans text-base text-strong outline-none focus-visible:border-border-focus focus-visible:ring-2 focus-visible:ring-brand/40"
        />
        {/* The live preview. Recorded verbatim as `typed_name`, so what they see
            here is exactly what the evidence row will say. */}
        <div
          aria-hidden="true"
          className="flex min-h-[68px] items-center rounded-md border border-dashed border-border-default bg-surface-sunken px-4"
        >
          <span className="font-sans text-2xl italic text-strong">{name || ' '}</span>
        </div>
      </div>

      {/* The read confirmation, recorded verbatim as `ack_scrolled` on the
          evidence row. It is an **explicit statement**, not an inferred one: a
          PDF renders inside the browser's own viewer, which scrolls
          independently and reports nothing to the page, so any "they scrolled to
          the end" signal we synthesised would be a guess written into an
          evidence pack as a fact. Asking is the honest version, and it is what
          the design system's own signing block specifies. */}
      {requireReadConfirmation && (
        <Checkbox
          align="start"
          checked={readConfirmed}
          onChange={(e) => setReadConfirmed(e.target.checked)}
          label="I have read this document in full."
        />
      )}

      <Checkbox
        align="start"
        checked={consented}
        onChange={(e) => setConsented(e.target.checked)}
        label="I agree that typing my name above counts as my signature on this document, and I confirm the details recorded with it are correct."
      />

      {error && (
        <Callout tone="danger" title="Couldn’t record your signature">
          {error}
        </Callout>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {/* Touch-capable: 44px minimum, because this is the screen the candidate
            portal reuses on a phone (NFR-007, §5.3). */}
        <Button
          type="button"
          disabled={!canSign}
          onClick={() => onSign({ typedName: name, readConfirmed })}
          className="min-h-11 px-6"
        >
          {pending ? 'Signing…' : 'Adopt and sign'}
        </Button>
        <span className="font-sans text-2xs text-muted">
          Your name, the time, your IP address and your device are recorded with the signature.
        </span>
      </div>
    </section>
  );
}
