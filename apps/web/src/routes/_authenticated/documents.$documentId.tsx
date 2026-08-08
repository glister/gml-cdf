import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Download, Lock } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/forms/Field';
import { Select } from '~/components/forms/Select';
import { Textarea } from '~/components/forms/Textarea';
import { StatusPill } from '~/components/data-display/StatusPill';
import { IssueModeBadge } from '~/components/documents/IssueModeBadge';
import { SignatureCapture } from '~/components/documents/SignatureCapture';
import { Checkbox } from '~/components/forms/Checkbox';
import {
  COMPLETION_ACTION,
  DOCUMENT_STATUS,
  ISSUE_MODE_LABELS,
  formatStamp,
  type DocumentDetail,
} from '~/lib/documents';
import { clientEnv } from '~/env';

export const Route = createFileRoute('/_authenticated/documents/$documentId')({
  component: DocumentView,
});

/**
 * View and complete a document (core plan 11 §9.4, PL-009/011).
 *
 * **This is the screen the candidate portal reuses on a phone** (NFR-007), so it
 * is a single column, its controls are 44px, and nothing depends on hover.
 *
 * ## What this screen does not decide
 *
 * Whether it is locked, whether it is rendered, whether the scroll gate applies,
 * and what action completes it all arrive from the server on the document row.
 * The screen renders them. Every one of them is *also* enforced in the procedure
 * — so the buttons below are a courtesy, not a control, and deleting this file
 * would change no rule.
 *
 * The scroll acknowledgement is the one piece of state the browser genuinely
 * owns, because only the browser knows whether the person reached the bottom. It
 * is sent as `ackScrolled` and recorded on the evidence row verbatim; the server
 * refuses the signature without it when the control is on.
 */
export function DocumentView() {
  const { documentId } = Route.useParams();
  const utils = trpcReact.useUtils();

  const query = trpcReact.platform.documents.get.useQuery({ id: documentId });
  const doc = query.data;

  const refresh = async () => {
    await utils.platform.documents.get.invalidate({ id: documentId });
  };

  const viewMutation = trpcReact.platform.documents.recordView.useMutation({ onSuccess: refresh });
  const signMutation = trpcReact.platform.documents.sign.useMutation({ onSuccess: refresh });
  const completeMutation = trpcReact.platform.documents.complete.useMutation({
    onSuccess: refresh,
  });

  // Record the first view once, when the document is open and actionable. The
  // server is idempotent about it (`stampOnFirstView` returns unchanged past
  // `issued`), so a re-render or a refresh cannot re-stamp `viewed_at`.
  const recordedRef = React.useRef(false);
  React.useEffect(() => {
    if (!doc || recordedRef.current) return;
    if (doc.status === 'issued' && !doc.isLocked) {
      recordedRef.current = true;
      viewMutation.mutate({ id: documentId });
    }
    // Keyed on the two fields that decide whether a first view is due; the
    // ref makes it once-per-mount regardless.
  }, [doc?.status, doc?.isLocked]);

  if (query.isPending) {
    return (
      <div className="mx-auto h-[600px] max-w-[840px] animate-pulse rounded-lg bg-surface-sunken" />
    );
  }
  if (query.error || !doc) {
    return (
      <div className="mx-auto max-w-[840px]">
        <Callout tone="danger" title="Couldn’t open this document">
          {query.error?.message ?? 'No such document.'}
        </Callout>
      </div>
    );
  }

  const status = DOCUMENT_STATUS[doc.status];
  const mode = ISSUE_MODE_LABELS[doc.issueMode];
  const contentUrl = `${clientEnv.VITE_API_URL}/documents/${doc.id}/content`;
  const done = Boolean(doc.completedAt);

  return (
    <div className="mx-auto flex max-w-[840px] flex-col gap-4">
      <PageHeader
        title={doc.title}
        description={done ? undefined : mode.asks}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
            <IssueModeBadge mode={doc.issueMode} />
            <span className="font-sans text-2xs text-muted">{doc.categoryLabel}</span>
            {doc.templateKey && (
              <span className="font-mono text-2xs text-muted">
                {doc.templateKey} v{doc.templateVersion}
              </span>
            )}
            {doc.sequenceNo && (
              <span className="font-sans text-2xs text-muted">step {doc.sequenceNo}</span>
            )}
          </div>
        }
      />

      {doc.isLocked && (
        <Callout tone="warning" title="Not yet available" icon={<Lock size={16} />}>
          An earlier document in this group is still outstanding. Complete that one first — this
          document unlocks on its own, with nothing further to do.
        </Callout>
      )}

      {doc.status === 'cancelled' && (
        <Callout tone="info" title="This document was withdrawn">
          {doc.cancelReason ?? 'No reason was recorded.'}
        </Callout>
      )}

      {done && (
        <Callout tone="success" title="Completed">
          {doc.signedAt
            ? `Signed on ${formatStamp(doc.signedAt)}.`
            : `Completed on ${formatStamp(doc.completedAt)}.`}
        </Callout>
      )}

      {/* --- The document well ---------------------------------------------- */}
      {!doc.isLocked && (
        <section className="flex flex-col rounded-lg border border-border-default bg-surface-card">
          <div className="flex items-center justify-between gap-3 border-b border-border-default px-4 py-2.5">
            <span className="font-sans text-xs font-semibold text-strong">Document</span>
            {doc.isRendered && (
              <a
                href={contentUrl}
                download
                className="inline-flex items-center gap-1.5 font-sans text-xs text-muted hover:text-strong"
              >
                <Download size={14} aria-hidden="true" /> Download
              </a>
            )}
          </div>

          {doc.isRendered ? (
            /* The rendered artefact itself, not a re-render of the HTML — so what
               is read here is the file that was hashed and signed (R4). */
            <iframe
              title={doc.title}
              src={contentUrl}
              className="h-[560px] w-full border-0 bg-surface-sunken"
            />
          ) : (
            <div className="flex h-[240px] flex-col items-center justify-center gap-2 bg-surface-sunken">
              <p className="font-sans text-sm font-semibold text-strong">Preparing document…</p>
              <p className="max-w-[380px] text-center font-sans text-xs text-muted">
                It is being rendered now. This usually takes a few seconds — refresh the page to
                check.
              </p>
            </div>
          )}
        </section>
      )}

      {/* --- The completion controls ---------------------------------------- */}
      {!done && !doc.isLocked && doc.status !== 'cancelled' && doc.status !== 'draft' && (
        <CompletionControls
          doc={doc}
          signPending={signMutation.isPending}
          completePending={completeMutation.isPending}
          error={signMutation.error?.message ?? completeMutation.error?.message ?? null}
          onSign={({ typedName, readConfirmed }) =>
            signMutation.mutate({
              documentId: doc.id,
              method: 'typed_name',
              typedName,
              // Bound to the exact bytes served above. The server refuses a
              // mismatch, which is what makes this a signature on *these* bytes
              // rather than on a document (§4.3).
              expectedHash: doc.contentHash!,
              ackScrolled: readConfirmed,
            })
          }
          onComplete={({ ackScrolled = true, ...input }) =>
            completeMutation.mutate({ documentId: doc.id, ackScrolled, ...input })
          }
        />
      )}
    </div>
  );
}

type CompleteInput = Parameters<
  ReturnType<typeof trpcReact.platform.documents.complete.useMutation>['mutate']
>[0];

function CompletionControls({
  doc,
  signPending,
  completePending,
  error,
  onSign,
  onComplete,
}: {
  doc: DocumentDetail;
  signPending: boolean;
  completePending: boolean;
  error: string | null;
  onSign: (input: { typedName: string; readConfirmed: boolean }) => void;
  onComplete: (input: Omit<CompleteInput, 'documentId'>) => void;
}) {
  const action = COMPLETION_ACTION[doc.issueMode];

  if (doc.issueMode === 'read_and_sign') {
    return (
      <SignatureCapture
        defaultName=""
        requireReadConfirmation={doc.requireScrollAck}
        ready={doc.isRendered}
        pending={signPending}
        error={error}
        onSign={onSign}
      />
    );
  }

  if (action === null) {
    // `read_only` and `no_action` complete without the subject pressing anything
    // — reading it, or issuing it, was the whole ask.
    return null;
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border-default bg-surface-card p-5">
      <h2 className="font-sans text-base font-semibold text-strong">
        {ISSUE_MODE_LABELS[doc.issueMode].long}
      </h2>
      {error && (
        <Callout tone="danger" title="Couldn’t record that">
          {error}
        </Callout>
      )}

      {action === 'receipt' && (
        <Button
          className="min-h-11 w-fit px-6"
          disabled={completePending}
          onClick={() => onComplete({ action: 'receipt' })}
        >
          {completePending ? 'Recording…' : 'Confirm receipt'}
        </Button>
      )}

      {action === 'acknowledge' && (
        /* The button's own words are the acknowledgement — pressing something
           that says "I have read and understood this" IS the act, so it carries
           `ackScrolled` rather than gating on a separate control. */
        <Button
          className="min-h-11 w-fit px-6"
          disabled={completePending}
          onClick={() => onComplete({ action: 'acknowledge', ackScrolled: true })}
        >
          {completePending ? 'Recording…' : 'I have read and understood this'}
        </Button>
      )}

      {action === 'text' && <TextResponse pending={completePending} onSubmit={onComplete} />}
      {action === 'qa' && (
        <QaResponse
          captureSchemaKey={doc.captureSchemaKey}
          pending={completePending}
          onSubmit={onComplete}
        />
      )}
      {action === 'upload' && <ResponseUpload documentId={doc.id} />}
    </section>
  );
}

function TextResponse({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (input: { action: 'text'; textResponse: string }) => void;
}) {
  const [text, setText] = React.useState('');
  return (
    <div className="flex flex-col gap-3">
      <Field label="Your response">
        <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Button
        className="min-h-11 w-fit px-6"
        disabled={pending || text.trim().length === 0}
        onClick={() => onSubmit({ action: 'text', textResponse: text.trim() })}
      >
        {pending ? 'Submitting…' : 'Submit response'}
      </Button>
    </div>
  );
}

/**
 * The Q&A form, rendered from the **registered** capture schema.
 *
 * The questions come from the server's registry rather than from anything on
 * this screen, and the same registry validates the answers on submit — so a form
 * that renders and a form that will be accepted are the same form by
 * construction, not by two developers agreeing.
 */
function QaResponse({
  captureSchemaKey,
  pending,
  onSubmit,
}: {
  captureSchemaKey: string | null;
  pending: boolean;
  onSubmit: (input: { action: 'qa'; captureData: Record<string, unknown> }) => void;
}) {
  const schemas = trpcReact.platform.templates.captureSchemas.useQuery(undefined, {
    // The subject is not HR, so this may 403. The document itself carries the
    // key; the questions are the part that needs the catalogue.
    retry: false,
  });
  const [answers, setAnswers] = React.useState<Record<string, unknown>>({});
  const schema = (schemas.data ?? []).find((s) => s.key === captureSchemaKey);

  if (!schema) {
    return (
      <Callout tone="info" title="Questions unavailable">
        The questions for this document could not be loaded. Refresh the page, or ask HR to check
        the template’s response set.
      </Callout>
    );
  }

  const answered = schema.questions.every((q) => !q.required || answers[q.name] !== undefined);

  return (
    <div className="flex flex-col gap-4">
      {schema.questions.map((q) => (
        <Field key={q.name} label={q.label} required={q.required}>
          {q.kind === 'boolean' ? (
            <Checkbox
              label="Yes"
              checked={answers[q.name] === true}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.name]: e.target.checked }))}
            />
          ) : q.kind === 'choice' ? (
            <Select
              value={String(answers[q.name] ?? '')}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.name]: e.target.value || undefined }))}
            >
              <option value="">Choose…</option>
              {(q.options ?? []).map((option) => (
                <option key={option} value={option}>
                  {option.toUpperCase()}
                </option>
              ))}
            </Select>
          ) : (
            <input
              type="text"
              value={String(answers[q.name] ?? '')}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.name]: e.target.value || undefined }))}
              className="h-11 w-full rounded-md border border-border-default bg-surface-card px-3 font-sans text-base text-strong outline-none focus-visible:border-border-focus focus-visible:ring-2 focus-visible:ring-brand/40"
            />
          )}
        </Field>
      ))}
      <Button
        className="min-h-11 w-fit px-6"
        disabled={pending || !answered}
        onClick={() => onSubmit({ action: 'qa', captureData: answers })}
      >
        {pending ? 'Submitting…' : 'Submit answers'}
      </Button>
    </div>
  );
}

/**
 * The file/photograph response (`file_upload`).
 *
 * Posts to the Hono multipart route rather than through tRPC, for the same
 * reason the content route exists: a file is not JSON. The route completes the
 * document itself, so there is no second call to keep in step.
 */
function ResponseUpload({ documentId }: { documentId: string }) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const upload = async (file: File) => {
    setPending(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch(
        `${clientEnv.VITE_API_URL}/documents/${documentId}/response-file`,
        {
          method: 'POST',
          credentials: 'include',
          body,
        },
      );
      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))) as { detail?: string };
        throw new Error(detail.detail ?? `Upload failed (${response.status})`);
      }
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <Callout tone="danger" title="Couldn’t upload">
          {error}
        </Callout>
      )}
      <input
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/heic"
        disabled={pending}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
        className="font-sans text-sm text-body file:mr-3 file:min-h-11 file:rounded-full file:border-0 file:bg-brand file:px-5 file:font-sans file:text-sm file:font-semibold file:text-white"
      />
      <p className="font-sans text-2xs text-muted">
        A PDF or a photograph. The file type is checked from the file itself, not its name.
      </p>
    </div>
  );
}
