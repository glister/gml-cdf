import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { FileText, RotateCw } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { Modal } from '~/components/feedback/Modal';
import { Button } from '~/components/ui/button';
import { Switch } from '~/components/forms/Switch';
import { Field } from '~/components/forms/Field';
import { Select } from '~/components/forms/Select';
import { Checkbox } from '~/components/forms/Checkbox';
import { StatusPill } from '~/components/data-display/StatusPill';
import { IssueModeBadge } from '~/components/documents/IssueModeBadge';
import {
  DOCUMENT_STATUS,
  FILING_BADGE,
  formatStamp,
  progressLine,
  type DocumentRow,
} from '~/lib/documents';

export const Route = createFileRoute('/_authenticated/people/$personId/documents')({
  component: PersonDocuments,
});

/**
 * A person's documents (core plan 11 §9.4, PL-009/010/012).
 *
 * Generate → edit the draft → issue → watch it complete. Four steps, and the
 * only one that is irreversible is the third: from `issued` onwards the content
 * is frozen at the database level, because somebody may already be reading it.
 * The screen says so before the button rather than after.
 *
 * **Ordered issue is a choice made once, at issue.** Ticking it makes the
 * selected drafts a sequence in the order they are listed; the second cannot be
 * opened until the first is complete. There is no way to re-order afterwards,
 * and that is deliberate — a sequence somebody could shuffle while people are
 * working through it is not a sequence.
 *
 * The filing badge shows only `pending` and `failed`. A document that filed
 * correctly is not news, and a badge on every row would make the two that matter
 * invisible.
 */
export function PersonDocuments() {
  const { personId } = Route.useParams();
  const utils = trpcReact.useUtils();
  const [generateOpen, setGenerateOpen] = React.useState(false);
  const [issueOpen, setIssueOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [ordered, setOrdered] = React.useState(false);
  const [templateId, setTemplateId] = React.useState('');
  const [outstandingOnly, setOutstandingOnly] = React.useState(false);
  const [cursorStack, setCursorStack] = React.useState<string[]>([]);
  const cursor = cursorStack[cursorStack.length - 1];

  React.useEffect(() => setCursorStack([]), [outstandingOnly]);

  const query = trpcReact.platform.documents.listForSubject.useQuery({
    subjectPersonId: personId,
    limit: 25,
    cursor,
    outstandingOnly,
    sort: 'created_at',
    sortDir: 'desc',
  });
  const templates = trpcReact.platform.templates.list.useQuery({
    limit: 100,
    status: ['published'],
  });

  const refresh = async () => {
    await utils.platform.documents.listForSubject.invalidate();
  };

  const generateMutation = trpcReact.platform.documents.generate.useMutation({
    onSuccess: async () => {
      setGenerateOpen(false);
      setTemplateId('');
      await refresh();
    },
  });
  const issueMutation = trpcReact.platform.documents.issue.useMutation({
    onSuccess: async () => {
      setIssueOpen(false);
      setSelected([]);
      setOrdered(false);
      await refresh();
    },
  });
  const retryMutation = trpcReact.platform.documents.retryFiling.useMutation({
    onSuccess: refresh,
  });
  const cancelMutation = trpcReact.platform.documents.cancel.useMutation({ onSuccess: refresh });

  const rows = query.data?.items ?? [];
  const drafts = rows.filter((d) => d.status === 'draft');
  const selectedDrafts = drafts.filter((d) => selected.includes(d.id));

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <PageHeader
        title="Documents"
        description="Everything issued to this person, and the drafts waiting to go out. A document keeps the exact template version it was generated from."
        primaryAction={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={selectedDrafts.length === 0}
              onClick={() => setIssueOpen(true)}
            >
              Issue {selectedDrafts.length > 0 ? `(${selectedDrafts.length})` : ''}
            </Button>
            <Button startIcon={<FileText size={16} />} onClick={() => setGenerateOpen(true)}>
              Generate from template
            </Button>
          </div>
        }
      />

      {query.error && (
        <Callout tone="danger" title="Couldn’t load documents">
          {query.error.message}
        </Callout>
      )}
      {cancelMutation.error && (
        <Callout tone="danger" title="Couldn’t withdraw">
          {cancelMutation.error.message}
        </Callout>
      )}

      <div className="flex h-9 w-fit items-center rounded-md border border-border-default bg-surface-card px-3">
        <Switch
          label="Outstanding only"
          checked={outstandingOnly}
          onChange={(e) => setOutstandingOnly(e.target.checked)}
        />
      </div>

      <ul className="flex flex-col gap-2">
        {rows.map((doc) => (
          <DocumentListRow
            key={doc.id}
            doc={doc}
            selected={selected.includes(doc.id)}
            onToggle={() => toggle(doc.id)}
            onRetry={() => retryMutation.mutate({ id: doc.id })}
            onCancel={(reason) => cancelMutation.mutate({ documentId: doc.id, reason })}
          />
        ))}
        {rows.length === 0 && !query.isPending && (
          <li className="rounded-lg border border-dashed border-border-default px-4 py-10 text-center">
            <p className="font-sans text-sm text-muted">
              {outstandingOnly
                ? 'Nothing outstanding for this person.'
                : 'No documents yet. Generate one from a published template.'}
            </p>
          </li>
        )}
      </ul>

      <div className="flex items-center justify-between">
        <span className="font-sans text-2xs text-muted">{rows.length} on this page</span>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            disabled={cursorStack.length === 0}
            onClick={() => setCursorStack((s) => s.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            disabled={!query.data?.nextCursor}
            onClick={() =>
              setCursorStack((s) => (query.data?.nextCursor ? [...s, query.data.nextCursor] : s))
            }
          >
            Next
          </Button>
        </div>
      </div>

      <Modal
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        title="Generate a document"
        description="Creates a draft, pre-filled from this person's record. Nothing is sent until you issue it."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setGenerateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!templateId || generateMutation.isPending}
              onClick={() =>
                generateMutation.mutate({
                  subjectPersonId: personId,
                  // The server fills the bag from the person's own record; the
                  // screen never assembles profile data and posts it back.
                  items: [{ templateId, mergeData: {} }],
                })
              }
            >
              {generateMutation.isPending ? 'Generating…' : 'Generate draft'}
            </Button>
          </div>
        }
      >
        {generateMutation.error && (
          <Callout tone="danger" title="Couldn’t generate">
            {generateMutation.error.message}
          </Callout>
        )}
        <Field label="Template">
          <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">Choose a published template…</option>
            {(templates.data?.items ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} (v{t.version}) — {t.categoryLabel}
              </option>
            ))}
          </Select>
        </Field>
      </Modal>

      <Modal
        open={issueOpen}
        onClose={() => setIssueOpen(false)}
        title={`Issue ${selectedDrafts.length} document${selectedDrafts.length === 1 ? '' : 's'}`}
        description="Once issued, the content is frozen and the person can open it. To change the wording after that, withdraw it and issue a new one."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setIssueOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={issueMutation.isPending}
              onClick={() =>
                issueMutation.mutate({ documentIds: selectedDrafts.map((d) => d.id), ordered })
              }
            >
              {issueMutation.isPending ? 'Issuing…' : 'Issue'}
            </Button>
          </div>
        }
      >
        {issueMutation.error && (
          <Callout tone="danger" title="Couldn’t issue">
            {issueMutation.error.message}
          </Callout>
        )}
        <ol className="mb-4 flex flex-col gap-1">
          {selectedDrafts.map((d, i) => (
            <li key={d.id} className="flex items-center gap-2 font-sans text-sm text-body">
              {ordered && <span className="font-mono text-2xs text-muted">{i + 1}.</span>}
              {d.title}
              <IssueModeBadge mode={d.issueMode} short />
            </li>
          ))}
        </ol>
        <Checkbox
          align="start"
          checked={ordered}
          onChange={(e) => setOrdered(e.target.checked)}
          label="Issue as an ordered sequence — each document stays locked until the one before it is complete. The order above is the order they will be worked through, and it cannot be changed afterwards."
        />
      </Modal>
    </div>
  );
}

function DocumentListRow({
  doc,
  selected,
  onToggle,
  onRetry,
  onCancel,
}: {
  doc: DocumentRow;
  selected: boolean;
  onToggle: () => void;
  onRetry: () => void;
  onCancel: (reason: string) => void;
}) {
  const status = DOCUMENT_STATUS[doc.status];
  const filing = FILING_BADGE[doc.filingState];
  const isDraft = doc.status === 'draft';

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-border-default bg-surface-card px-4 py-3">
      {isDraft && (
        <Checkbox aria-label={`Select ${doc.title}`} checked={selected} onChange={onToggle} />
      )}

      <div className="min-w-[200px] flex-1">
        <Link
          to="/documents/$documentId"
          params={{ documentId: doc.id }}
          className="font-sans text-sm font-semibold text-strong hover:underline"
        >
          {doc.title}
        </Link>
        <p className="font-sans text-2xs text-muted">
          {doc.categoryLabel}
          {doc.templateKey && (
            <span className="font-mono">
              {' '}
              · {doc.templateKey} v{doc.templateVersion}
            </span>
          )}
          {doc.sequenceNo && <span> · step {doc.sequenceNo}</span>}
        </p>
      </div>

      <IssueModeBadge mode={doc.issueMode} short />
      <StatusPill tone={status.tone}>{status.label}</StatusPill>
      {filing && (
        <StatusPill tone={filing.tone} size="sm">
          {filing.label}
        </StatusPill>
      )}

      <span className="min-w-[150px] font-sans text-2xs text-muted">{progressLine(doc)}</span>

      <div className="flex gap-1.5">
        {doc.filingState === 'failed' && (
          <Button variant="ghost" size="sm" startIcon={<RotateCw size={14} />} onClick={onRetry}>
            Retry filing
          </Button>
        )}
        {!doc.completedAt && doc.status !== 'cancelled' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const reason = window.prompt('Why is this being withdrawn?');
              if (reason?.trim()) onCancel(reason.trim());
            }}
          >
            Withdraw
          </Button>
        )}
      </div>
    </li>
  );
}

/** Kept alongside the row so the list and the detail agree on the stamp form. */
export { formatStamp };
