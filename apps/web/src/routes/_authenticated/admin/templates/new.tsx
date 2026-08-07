import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import { z } from 'zod';
import { ArrowLeft } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Callout } from '~/components/feedback/Callout';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/forms/Field';
import { Input } from '~/components/forms/Input';
import { Select } from '~/components/forms/Select';
import { LookupSelect } from '~/components/forms/LookupSelect';
import { ISSUE_MODES, ISSUE_MODE_LABELS } from '~/lib/documents';

export const Route = createFileRoute('/_authenticated/admin/templates/new')({
  component: NewTemplate,
});

/**
 * A template key is the family name, and it is permanent.
 *
 * Lowercase with underscores, because it is the identifier every later version
 * shares and the one an HR plan writes into a task list definition — a key
 * someone can type with a capital letter today is a key that fails to match
 * tomorrow.
 */
const newTemplateSchema = z.object({
  templateKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/, 'Lowercase letters, numbers and underscores'),
  name: z.string().trim().min(1, 'Give the template a name').max(200),
  categoryId: z.string().uuid('Pick a category'),
  defaultIssueMode: z.enum(ISSUE_MODES),
});

/**
 * Create a new template family (core plan 11 §9.4, PL-009).
 *
 * Deliberately small: a key, a name, a category and a default action. The body
 * is written in the editor on the next screen, because an empty rich-text field
 * on a creation form invites somebody to paste a whole letter into a modal and
 * lose it to a validation error on a different field.
 *
 * The **next version** of an existing family is not created here — it is created
 * from that family's own page, where the current wording is in front of the
 * author to copy from.
 */
export function NewTemplate() {
  const navigate = useNavigate();
  const utils = trpcReact.useUtils();

  const createMutation = trpcReact.platform.templates.create.useMutation({
    onSuccess: async (created) => {
      await utils.platform.templates.list.invalidate();
      await navigate({ to: '/admin/templates/$templateId', params: { templateId: created.id } });
    },
  });

  const form = useForm({
    defaultValues: {
      templateKey: '',
      name: '',
      categoryId: '',
      defaultIssueMode: 'read_and_sign' as (typeof ISSUE_MODES)[number],
    },
    validators: { onChange: newTemplateSchema },
    onSubmit: async ({ value }) => {
      await createMutation.mutateAsync({
        templateKey: value.templateKey,
        name: value.name,
        categoryId: value.categoryId,
        defaultIssueMode: value.defaultIssueMode,
        bodyHtml: '<p></p>',
        mergeContexts: [],
      });
    },
  });

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-4">
      <Link
        to="/admin/templates"
        className="inline-flex w-fit items-center gap-1.5 font-sans text-xs text-muted hover:text-strong"
      >
        <ArrowLeft size={14} aria-hidden="true" /> All templates
      </Link>

      <PageHeader
        title="New template"
        description="Creates version 1 as a draft. Write the body on the next screen, then publish when it is ready — publishing freezes the version."
      />

      {createMutation.error && (
        <Callout tone="danger" title="Couldn’t create the template">
          {createMutation.error.message}
        </Callout>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
        className="flex flex-col gap-4"
      >
        <form.Field name="name">
          {(field) => (
            <Field label="Name" required error={field.state.meta.errors[0]?.message}>
              <Input
                value={field.state.value}
                placeholder="Welcome letter"
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
              />
            </Field>
          )}
        </form.Field>

        <form.Field name="templateKey">
          {(field) => (
            <Field
              label="Template key"
              required
              hint="The permanent identifier this template family is known by. Every future version shares it, and it cannot be changed."
              error={field.state.meta.errors[0]?.message}
            >
              <Input
                value={field.state.value}
                placeholder="welcome_letter"
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                className="font-mono"
              />
            </Field>
          )}
        </form.Field>

        <form.Field name="categoryId">
          {(field) => (
            <Field
              label="Category"
              required
              hint="Categories govern who can see documents of this kind."
              error={field.state.meta.errors[0]?.message}
            >
              <LookupSelect
                listType="document_category"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>

        <form.Field name="defaultIssueMode">
          {(field) => (
            <Field label="Default required action" hint={ISSUE_MODE_LABELS[field.state.value].asks}>
              <Select
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value as (typeof ISSUE_MODES)[number])}
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

        <form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <Button type="submit" className="w-fit" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create draft'}
            </Button>
          )}
        </form.Subscribe>
      </form>
    </div>
  );
}
