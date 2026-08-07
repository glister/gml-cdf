import * as React from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import { z } from 'zod';
import { ArrowLeft, History } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/forms/Field';
import { Input } from '~/components/forms/Input';
import { Select } from '~/components/forms/Select';
import { LookupSelect } from '~/components/forms/LookupSelect';
import { Checkbox } from '~/components/forms/Checkbox';
import { StatusPill } from '~/components/data-display/StatusPill';
import { IssueModeBadge } from '~/components/documents/IssueModeBadge';
import { TemplateEditor } from '~/components/documents/TemplateEditor';
import { formatStamp, ISSUE_MODES, ISSUE_MODE_LABELS, TEMPLATE_STATUS } from '~/lib/documents';

export const Route = createFileRoute('/_authenticated/admin/templates/$templateId')({
  component: TemplateDetail,
});

const draftSchema = z.object({
  name: z.string().trim().min(1, 'Give the template a name').max(200),
  categoryId: z.string().uuid('Pick a category'),
  bodyHtml: z.string().min(1),
  defaultIssueMode: z.enum(ISSUE_MODES),
  captureSchemaKey: z.string(),
  mergeContexts: z.array(z.string()),
});

/**
 * The template editor (core plan 11 §9.4, PL-009).
 *
 * **A published version is read-only here, and the screen says so rather than
 * quietly disabling things.** The database refuses the edit either way
 * (`template_guard`), so a form that merely greyed out its inputs would be
 * describing a rule it does not enforce. "Create a new version" is the action
 * that exists instead, and it is the action the model actually supports.
 *
 * The merge-field palette offers only fields of the contexts this template
 * declares, so an author cannot insert a token that will be rejected on save —
 * and saving re-derives the declared field list server-side regardless, because
 * the palette is a convenience and the contract is the contract (§4.5).
 */
export function TemplateDetail() {
  const { templateId } = Route.useParams();
  const navigate = useNavigate();
  const utils = trpcReact.useUtils();
  const [showVersions, setShowVersions] = React.useState(false);

  const query = trpcReact.platform.templates.get.useQuery({ id: templateId });
  const contexts = trpcReact.platform.templates.mergeContexts.useQuery();
  const captureSchemas = trpcReact.platform.templates.captureSchemas.useQuery();
  const versions = trpcReact.platform.templates.listVersions.useQuery(
    { templateKey: query.data?.templateKey ?? '' },
    { enabled: Boolean(query.data?.templateKey) },
  );

  const template = query.data;
  const isDraft = template?.status === 'draft';

  const updateMutation = trpcReact.platform.templates.update.useMutation({
    onSuccess: async () => {
      await utils.platform.templates.get.invalidate({ id: templateId });
    },
  });
  const publishMutation = trpcReact.platform.templates.publish.useMutation({
    onSuccess: async () => {
      await utils.platform.templates.get.invalidate({ id: templateId });
      await utils.platform.templates.list.invalidate();
    },
  });
  const archiveMutation = trpcReact.platform.templates.archive.useMutation({
    onSuccess: async () => {
      await utils.platform.templates.get.invalidate({ id: templateId });
      await utils.platform.templates.list.invalidate();
    },
  });
  const createMutation = trpcReact.platform.templates.create.useMutation({
    onSuccess: async (created) => {
      await utils.platform.templates.list.invalidate();
      await navigate({ to: '/admin/templates/$templateId', params: { templateId: created.id } });
    },
  });

  const form = useForm({
    defaultValues: {
      name: template?.name ?? '',
      categoryId: template?.categoryId ?? '',
      bodyHtml: template?.bodyHtml ?? '',
      defaultIssueMode: template?.defaultIssueMode ?? 'read_and_sign',
      captureSchemaKey: template?.captureSchemaKey ?? '',
      mergeContexts: template?.mergeContexts ?? [],
    },
    validators: { onChange: draftSchema },
    onSubmit: async ({ value }) => {
      await updateMutation.mutateAsync({
        id: templateId,
        name: value.name,
        categoryId: value.categoryId,
        bodyHtml: value.bodyHtml,
        defaultIssueMode: value.defaultIssueMode,
        captureSchemaKey: value.captureSchemaKey || null,
        mergeContexts: value.mergeContexts,
      });
    },
  });

  // Reset when the loaded version changes — navigating between versions must
  // not leave the previous body in the editor.
  React.useEffect(() => {
    if (template) {
      form.reset({
        name: template.name,
        categoryId: template.categoryId,
        bodyHtml: template.bodyHtml,
        defaultIssueMode: template.defaultIssueMode,
        captureSchemaKey: template.captureSchemaKey ?? '',
        mergeContexts: template.mergeContexts,
      });
    }
    // Keyed on the id alone: `form` is stable, and depending on the whole
    // template object would reset the editor on every refetch.
  }, [template?.id]);

  if (query.isPending) {
    return (
      <div className="mx-auto h-[520px] max-w-[1160px] animate-pulse rounded-lg bg-surface-sunken" />
    );
  }
  if (query.error || !template) {
    return (
      <div className="mx-auto max-w-[1160px]">
        <Callout tone="danger" title="Couldn’t load this template">
          {query.error?.message ?? 'No such template.'}
        </Callout>
      </div>
    );
  }

  const statusMeta = TEMPLATE_STATUS[template.status];
  const saveError =
    updateMutation.error?.message ??
    publishMutation.error?.message ??
    archiveMutation.error?.message;

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <Link
        to="/admin/templates"
        className="inline-flex w-fit items-center gap-1.5 font-sans text-xs text-muted hover:text-strong"
      >
        <ArrowLeft size={14} aria-hidden="true" /> All templates
      </Link>

      <PageHeader
        title={template.name}
        description={
          isDraft
            ? 'A draft. Edit freely — nothing here can reach anybody until it is published.'
            : 'This version is published and frozen. Documents generated from it keep it exactly as it is; to change the wording, create a new version.'
        }
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={statusMeta.tone}>{statusMeta.label}</StatusPill>
            <span className="font-mono text-2xs text-muted">
              {template.templateKey} · v{template.version}
            </span>
            <IssueModeBadge mode={template.defaultIssueMode} />
            {template.publishedAt && (
              <span className="font-sans text-2xs text-muted">
                published {formatStamp(template.publishedAt)}
              </span>
            )}
          </div>
        }
        primaryAction={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              startIcon={<History size={16} />}
              onClick={() => setShowVersions((v) => !v)}
            >
              Versions
            </Button>
            {isDraft ? (
              <Button
                disabled={publishMutation.isPending}
                onClick={() => publishMutation.mutate({ id: templateId })}
              >
                {publishMutation.isPending ? 'Publishing…' : 'Publish'}
              </Button>
            ) : (
              <Button
                variant="secondary"
                disabled={createMutation.isPending}
                onClick={() =>
                  createMutation.mutate({
                    templateKey: template.templateKey,
                    name: template.name,
                    categoryId: template.categoryId,
                    bodyHtml: template.bodyHtml,
                    mergeContexts: template.mergeContexts,
                    defaultIssueMode: template.defaultIssueMode,
                    captureSchemaKey: template.captureSchemaKey ?? undefined,
                  })
                }
              >
                {createMutation.isPending ? 'Creating…' : 'Create new version'}
              </Button>
            )}
            {template.status === 'published' && (
              <Button
                variant="ghost"
                disabled={archiveMutation.isPending}
                onClick={() => archiveMutation.mutate({ id: templateId })}
              >
                Archive
              </Button>
            )}
          </div>
        }
      />

      {saveError && (
        <Callout tone="danger" title="Couldn’t save">
          {saveError}
        </Callout>
      )}

      {showVersions && (
        <div className="rounded-lg border border-border-default bg-surface-card p-4">
          <h2 className="mb-2 font-sans text-sm font-semibold text-strong">Version history</h2>
          <ul className="flex flex-col divide-y divide-border-subtle">
            {(versions.data ?? []).map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-3 py-2">
                <Link
                  to="/admin/templates/$templateId"
                  params={{ templateId: v.id }}
                  className="flex items-center gap-2"
                >
                  <span className="font-mono text-xs text-strong">v{v.version}</span>
                  <span className="font-sans text-sm text-body">{v.name}</span>
                </Link>
                <div className="flex items-center gap-2">
                  {v.isCurrent && <span className="font-sans text-2xs text-muted">current</span>}
                  <StatusPill tone={TEMPLATE_STATUS[v.status].tone} size="sm">
                    {TEMPLATE_STATUS[v.status].label}
                  </StatusPill>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
        className="flex flex-col gap-4"
      >
        <div className="grid gap-4 md:grid-cols-3">
          <form.Field name="name">
            {(field) => (
              <Field label="Name" error={field.state.meta.errors[0]?.message}>
                <Input
                  value={field.state.value}
                  disabled={!isDraft}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
              </Field>
            )}
          </form.Field>

          <form.Field name="categoryId">
            {(field) => (
              <Field label="Category" error={field.state.meta.errors[0]?.message}>
                <LookupSelect
                  listType="document_category"
                  value={field.state.value}
                  disabled={!isDraft}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </form.Field>

          <form.Field name="defaultIssueMode">
            {(field) => (
              <Field
                label="Default required action"
                hint={ISSUE_MODE_LABELS[field.state.value].asks}
              >
                <Select
                  value={field.state.value}
                  disabled={!isDraft}
                  onChange={(e) =>
                    field.handleChange(e.target.value as (typeof ISSUE_MODES)[number])
                  }
                >
                  {ISSUE_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {ISSUE_MODE_LABELS[mode].long}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </form.Field>
        </div>

        <form.Field name="mergeContexts">
          {(field) => (
            <Field
              label="Merge contexts"
              hint="What this template is allowed to draw data from. A token from a context that is not ticked is rejected when the template is saved."
            >
              <div className="flex flex-wrap gap-3">
                {(contexts.data ?? []).map((context) => (
                  <Checkbox
                    key={context.name}
                    className="rounded-md border border-border-default bg-surface-card px-3 py-2"
                    label={context.name}
                    disabled={!isDraft}
                    checked={field.state.value.includes(context.name)}
                    onChange={(e) =>
                      field.handleChange(
                        e.target.checked
                          ? [...field.state.value, context.name]
                          : field.state.value.filter((n) => n !== context.name),
                      )
                    }
                  />
                ))}
              </div>
            </Field>
          )}
        </form.Field>

        <form.Subscribe selector={(s) => s.values.defaultIssueMode}>
          {(mode) =>
            mode === 'qa_response' && (
              <form.Field name="captureSchemaKey">
                {(field) => (
                  <Field
                    label="Response set"
                    hint="The registered set of questions the subject answers. Response sets are registered in code, not built here — a new question is a new column of personal data about everyone who answers it."
                  >
                    <Select
                      value={field.state.value}
                      disabled={!isDraft}
                      onChange={(e) => field.handleChange(e.target.value)}
                    >
                      <option value="">Choose a response set…</option>
                      {(captureSchemas.data ?? []).map((schema) => (
                        <option key={schema.key} value={schema.key}>
                          {schema.key} — {schema.questions.length} questions
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </form.Field>
            )
          }
        </form.Subscribe>

        {/* Subscribed, not read from `form.state` in render: TanStack Form does
            not re-render on a bare state read, so ticking a context would leave
            the field palette disabled until something else happened to
            re-render the page. */}
        <form.Subscribe selector={(s) => s.values.mergeContexts}>
          {(declaredContexts) => (
            <form.Field name="bodyHtml">
              {(field) => (
                <Field
                  label="Body"
                  hint="Insert merge fields from the palette. They render as the subject's own details when a document is generated."
                >
                  <TemplateEditor
                    value={field.state.value}
                    onChange={field.handleChange}
                    contexts={(contexts.data ?? []).filter((c) =>
                      declaredContexts.includes(c.name),
                    )}
                    disabled={!isDraft}
                  />
                </Field>
              )}
            </form.Field>
          )}
        </form.Subscribe>

        {template.mergeFields.length > 0 && (
          <div className="rounded-lg border border-border-default bg-surface-sunken p-4">
            <h2 className="mb-2 font-sans text-xs font-semibold uppercase tracking-wide text-muted">
              Fields this template needs
            </h2>
            <ul className="flex flex-wrap gap-2">
              {template.mergeFields.map((f) => (
                <li
                  key={f.path}
                  className="rounded-full border border-border-default bg-surface-card px-2.5 py-1 font-mono text-2xs text-strong"
                >
                  {f.path}
                  {!f.required && <span className="ml-1.5 text-muted">optional</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {isDraft && (
          <form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
            {([canSubmit, isSubmitting]) => (
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={!canSubmit || isSubmitting}>
                  {isSubmitting ? 'Saving…' : 'Save draft'}
                </Button>
                {updateMutation.isSuccess && !updateMutation.isPending && (
                  <span className="font-sans text-2xs text-muted">Saved</span>
                )}
              </div>
            )}
          </form.Subscribe>
        )}
      </form>
    </div>
  );
}
