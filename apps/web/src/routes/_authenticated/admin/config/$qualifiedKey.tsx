import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter, ConfigEditorKind } from '@repo/trpc';
import { CalendarClock, ChevronLeft, ChevronRight, History, Lock, RotateCcw } from 'lucide-react';
import { trpcReact } from '~/trpc';
import { PageHeader } from '~/components/nav/PageHeader';
import { Button } from '~/components/ui/button';
import { Callout } from '~/components/feedback/Callout';
import { Modal } from '~/components/feedback/Modal';
import { Field } from '~/components/forms/Field';
import { Input } from '~/components/forms/Input';
import { Select } from '~/components/forms/Select';
import { Switch } from '~/components/forms/Switch';
import { Textarea } from '~/components/forms/Textarea';
import { cn } from '~/lib/utils';
import {
  formatConfigValue,
  formatInstant,
  formatNamespace,
  fromEditorText,
  toEditorText,
  toLocalDateTimeInput,
} from '~/lib/config-store';

export const Route = createFileRoute('/_authenticated/admin/config/$qualifiedKey')({
  component: ConfigKeyDetail,
});

type HistoryRow = inferRouterOutputs<AppRouter>['platform']['config']['history']['items'][number];

const columnHelper = createColumnHelper<HistoryRow>();

/**
 * Split `platform.identity.external_access_default_days` into its namespace and
 * key. The last segment is always the key — the registry guarantees that shape,
 * and both halves are CHECK-constrained in `platform.config_entry`.
 */
function splitQualifiedKey(qualified: string): { namespace: string; key: string } {
  const lastDot = qualified.lastIndexOf('.');
  if (lastDot <= 0) return { namespace: '', key: qualified };
  return { namespace: qualified.slice(0, lastDot), key: qualified.slice(lastDot + 1) };
}

/**
 * One configuration key: what it is, what it is set to, how to change it, and
 * everything it has ever been (core plan 06 §5.3, PL-029/030).
 *
 * The editor is **rendered from the key's registered Zod schema**, not from the
 * current value — a bounded integer gets a bounded number input whether or not
 * anyone has ever set it, and a value the schema shape cannot describe falls
 * back to a JSON textarea rather than a control that lies about what is
 * allowed. Client-side validation is a courtesy; the same schema rejects the
 * value server-side on write, which is the actual guarantee.
 *
 * The history panel below is this plan's half of PL-030 — the fine-grained,
 * per-key companion to plan 13's cross-system audit view, which shows the same
 * facts through the journal.
 */
function ConfigKeyDetail() {
  const { qualifiedKey } = Route.useParams();
  const { namespace, key } = splitQualifiedKey(qualifiedKey);
  const utils = trpcReact.useUtils();

  const [resetOpen, setResetOpen] = React.useState(false);
  const [historyCursors, setHistoryCursors] = React.useState<string[]>([]);

  const query = trpcReact.platform.config.get.useQuery({ namespace, key });
  const historyQuery = trpcReact.platform.config.history.useQuery({
    namespace,
    key,
    limit: 10,
    cursor: historyCursors[historyCursors.length - 1],
  });

  const refresh = async () => {
    await Promise.all([
      utils.platform.config.get.invalidate(),
      utils.platform.config.list.invalidate(),
      utils.platform.config.history.invalidate(),
    ]);
    setHistoryCursors([]);
  };

  const resetMutation = trpcReact.platform.config.reset.useMutation({
    onSuccess: async () => {
      setResetOpen(false);
      await refresh();
    },
  });

  const entry = query.data;

  const columns = React.useMemo(
    () => [
      columnHelper.accessor('version', {
        header: 'Version',
        cell: (info) => (
          <span className="font-mono text-sm font-semibold tabular-nums text-strong">
            v{info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor('value', {
        header: 'Value',
        cell: (info) => (
          <span className="rounded-sm border border-border-subtle bg-gray-100 px-2 py-1 font-mono text-sm tracking-wide text-body">
            {formatConfigValue(info.getValue())}
          </span>
        ),
      }),
      columnHelper.display({
        id: 'window',
        header: 'In force',
        cell: (info) => {
          const row = info.row.original;
          const staged = new Date(row.validFrom).getTime() > Date.now();
          return (
            <div className="flex flex-col">
              <span className="font-mono text-sm text-muted">
                {formatInstant(row.validFrom)} →{' '}
                {row.validTo ? formatInstant(row.validTo) : 'present'}
              </span>
              {staged && (
                <span className="font-sans text-2xs font-semibold uppercase tracking-wide text-status-warning">
                  Scheduled
                </span>
              )}
            </div>
          );
        },
      }),
      columnHelper.accessor('createdByName', {
        header: 'Changed by',
        cell: (info) => (
          <div className="flex flex-col">
            <span className="font-sans text-sm text-body">{info.getValue() ?? 'System'}</span>
            <span className="font-mono text-2xs text-muted">
              {formatInstant(info.row.original.createdAt)}
            </span>
          </div>
        ),
      }),
    ],
    [],
  );

  const historyRows = historyQuery.data?.items ?? [];
  const table = useReactTable({
    data: historyRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
  });

  if (query.error) {
    return (
      <div className="mx-auto flex max-w-[900px] flex-col gap-4">
        <PageHeader title={qualifiedKey} description="Configuration" />
        <Callout tone="danger" title="Couldn’t load this decision point">
          {query.error.message}
        </Callout>
      </div>
    );
  }

  const canEdit = entry?.canEdit ?? false;

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-4">
      <PageHeader
        title={entry ? entry.key : qualifiedKey}
        description={entry?.description ?? 'Loading…'}
        meta={
          <Link
            to="/admin/config"
            className="inline-flex items-center gap-1 font-sans text-sm text-muted transition-colors hover:text-body"
          >
            <ChevronLeft size={15} /> All configuration
          </Link>
        }
      />

      {entry && (
        <>
          {/* --- The value in force ------------------------------------- */}
          <section className="flex flex-col gap-4 rounded-lg border border-border-subtle bg-surface-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="font-mono text-2xs uppercase tracking-wide text-muted">
                  {formatNamespace(entry.namespace)} · registered by plan {entry.registeredBy}
                </span>
                <div className="flex items-center gap-2">
                  <span className="rounded-sm border border-border-subtle bg-gray-100 px-2.5 py-1 font-mono text-base font-semibold tracking-wide text-strong">
                    {formatConfigValue(entry.value)}
                  </span>
                  {entry.isDefault && (
                    <span className="rounded-full border border-border-subtle bg-gray-100 px-2 py-px font-mono text-2xs font-semibold uppercase tracking-wide text-muted">
                      Default
                    </span>
                  )}
                </div>
              </div>
              {canEdit ? (
                <Button
                  variant="secondary"
                  size="sm"
                  startIcon={<RotateCcw size={15} />}
                  disabled={entry.isDefault}
                  onClick={() => {
                    resetMutation.reset();
                    setResetOpen(true);
                  }}
                >
                  Reset to default
                </Button>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-gray-50 px-2.5 py-1.5 font-sans text-xs text-muted">
                  <Lock size={13} /> Editable by {entry.editableBy.join(' or ')}
                </span>
              )}
            </div>

            {/* The audit footer from the design system: who changed it, when. */}
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-gray-50 px-3.5 py-2.5">
              <History size={15} className="shrink-0 text-muted" />
              <span className="font-sans text-xs text-muted">
                {entry.isDefault ? (
                  <>
                    No value has been set — the shipped default of{' '}
                    <span className="font-mono text-body">
                      {formatConfigValue(entry.defaultValue)}
                    </span>{' '}
                    is in force
                  </>
                ) : (
                  <>
                    Version {entry.version}, set by{' '}
                    <span className="font-semibold text-body">
                      {entry.updatedByName ?? 'System'}
                    </span>{' '}
                    · <span className="font-mono">{formatInstant(entry.validFrom)}</span> · default{' '}
                    <span className="font-mono">{formatConfigValue(entry.defaultValue)}</span>
                  </>
                )}
              </span>
            </div>

            {entry.pendingChange && (
              <Callout tone="warning" title="A change is scheduled">
                From <strong>{formatInstant(entry.pendingChange.validFrom)}</strong> this becomes{' '}
                <span className="font-mono">{formatConfigValue(entry.pendingChange.value)}</span>{' '}
                (version {entry.pendingChange.version}). Until then the value above stays in force.
                A scheduled change cannot be reset — set a value effective after it to supersede it.
              </Callout>
            )}
          </section>

          {canEdit && (
            <ValueEditor
              // Remounting on every landed change is what keeps the editor
              // honest: the field's initial value IS the value in force, with no
              // effect racing a refetch to reset it. A version bump, a reset, or
              // a newly staged change all give a clean form.
              key={`${entry.version ?? 'default'}-${String(entry.isDefault)}-${entry.pendingChange?.version ?? 'none'}`}
              namespace={namespace}
              configKey={key}
              entry={entry}
              onSaved={refresh}
            />
          )}

          {/* --- History (PL-030) ---------------------------------------- */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <History size={17} className="text-muted" />
              <h2 className="font-sans text-sm font-bold tracking-tight text-strong">
                History of this value
              </h2>
            </div>

            <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface-card">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    {table.getHeaderGroups().map((hg) => (
                      <tr key={hg.id} className="border-b border-border-subtle">
                        {hg.headers.map((header) => (
                          <th
                            key={header.id}
                            className="whitespace-nowrap px-4 py-3 text-left font-sans text-xs font-semibold uppercase tracking-wide text-muted"
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </th>
                        ))}
                      </tr>
                    ))}
                  </thead>
                  <tbody>
                    {historyQuery.isLoading ? (
                      <tr>
                        <td
                          colSpan={columns.length}
                          className="px-4 py-8 text-center font-sans text-sm text-muted"
                        >
                          Loading history…
                        </td>
                      </tr>
                    ) : historyRows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={columns.length}
                          className="px-4 py-8 text-center font-sans text-sm text-muted"
                        >
                          This value has never been changed — the shipped default has been in force
                          throughout.
                        </td>
                      </tr>
                    ) : (
                      table.getRowModel().rows.map((row) => (
                        <tr
                          key={row.id}
                          className="border-b border-border-subtle transition-colors last:border-0 hover:bg-gray-50"
                        >
                          {row.getVisibleCells().map((cell) => (
                            <td key={cell.id} className="px-4 py-3 align-middle">
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </td>
                          ))}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-border-subtle px-4 py-3">
                <span className="font-sans text-xs text-muted">
                  Before the first version, the shipped default{' '}
                  <span className="font-mono">
                    {formatConfigValue(historyQuery.data?.defaultValue)}
                  </span>{' '}
                  applied.
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setHistoryCursors((s) => s.slice(0, -1))}
                    disabled={historyCursors.length === 0}
                    className={cn(
                      'inline-flex h-8 items-center gap-1 rounded-md border border-border-default bg-surface-card px-2.5 font-sans text-sm font-medium text-body transition-colors hover:bg-gray-50',
                      historyCursors.length === 0 && 'pointer-events-none opacity-45',
                    )}
                  >
                    <ChevronLeft size={16} /> Newer
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const next = historyQuery.data?.nextCursor;
                      if (next) setHistoryCursors((s) => [...s, next]);
                    }}
                    disabled={!historyQuery.data?.nextCursor}
                    className={cn(
                      'inline-flex h-8 items-center gap-1 rounded-md border border-border-default bg-surface-card px-2.5 font-sans text-sm font-medium text-body transition-colors hover:bg-gray-50',
                      !historyQuery.data?.nextCursor && 'pointer-events-none opacity-45',
                    )}
                  >
                    Older <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            </div>
          </section>
        </>
      )}

      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset to the shipped default?"
        description={
          entry
            ? `The value returns to ${formatConfigValue(entry.defaultValue)} from now on. Nothing is deleted — the versions below stay exactly as they are, and any past decision still resolves to the value that was in force at the time.`
            : ''
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={resetMutation.isPending}
              onClick={() => resetMutation.mutate({ namespace, key })}
            >
              {resetMutation.isPending ? 'Resetting…' : 'Reset to default'}
            </Button>
          </div>
        }
      >
        {resetMutation.error && (
          <Callout tone="danger" title="Couldn’t reset this value">
            {resetMutation.error.message}
          </Callout>
        )}
      </Modal>
    </div>
  );
}

type ConfigEntry = inferRouterOutputs<AppRouter>['platform']['config']['get'];

/**
 * The change-this-value form.
 *
 * Its own component so the parent can **remount it by key** when a change
 * lands: the field's initial value is then simply the value in force, with no
 * effect racing the refetch to reset it — the defect that first showed as an
 * empty Value box immediately after saving.
 *
 * Staging is a two-part control on purpose. With the toggle on, an instant is
 * **required**: a button that says "Schedule change" and then applies the value
 * immediately because the date box was left empty would be the worst kind of
 * lie for a screen whose whole subject is when a value takes effect.
 */
function ValueEditor({
  namespace,
  configKey,
  entry,
  onSaved,
}: {
  namespace: string;
  configKey: string;
  entry: ConfigEntry;
  onSaved: () => Promise<void>;
}) {
  const [stage, setStage] = React.useState(false);
  const editorKind = entry.schema.editorKind;
  const initialValue = toEditorText(entry.value, editorKind);
  const minEffectiveFrom = toLocalDateTimeInput(new Date(Date.now() + 60_000));

  const setMutation = trpcReact.platform.config.set.useMutation({ onSuccess: onSaved });

  const form = useForm({
    defaultValues: { value: initialValue, effectiveFrom: '' },
    onSubmit: async ({ value }) => {
      const parsed = fromEditorText(value.value, editorKind);
      if (!parsed.ok) throw new Error(parsed.message);
      await setMutation.mutateAsync({
        namespace,
        key: configKey,
        value: parsed.value,
        // A local datetime from the picker, sent as an instant. The server
        // compares it against its own clock and rejects anything in the past.
        effectiveFrom:
          stage && value.effectiveFrom ? new Date(value.effectiveFrom).toISOString() : undefined,
      });
    },
  });

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border-subtle bg-surface-card p-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-sans text-sm font-bold tracking-tight text-strong">
          Change this value
        </h2>
        <p className="font-sans text-sm leading-normal text-muted">
          The new value governs the very next decision — no release, no deployment. The change is
          recorded against your name and the old value is kept, so any past decision can still be
          explained by the value in force when it was made.
        </p>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field
          name="value"
          validators={{
            onChange: ({ value }) => {
              const parsed = fromEditorText(value, editorKind);
              return parsed.ok ? undefined : parsed.message;
            },
          }}
        >
          {(field) => (
            <Field
              label="Value"
              htmlFor="config-value"
              error={field.state.meta.errors.join(', ') || undefined}
              hint={describeConstraint(entry.schema)}
            >
              <ValueControl
                id="config-value"
                kind={editorKind}
                options={entry.schema.options}
                minimum={entry.schema.minimum}
                maximum={entry.schema.maximum}
                value={field.state.value}
                invalid={field.state.meta.errors.length > 0}
                onChange={field.handleChange}
              />
            </Field>
          )}
        </form.Field>

        <div className="flex flex-col gap-3 rounded-md border border-border-subtle bg-gray-50 p-3.5">
          <Switch
            checked={stage}
            label="Schedule this change for later"
            onChange={(e) => setStage(e.target.checked)}
          />
          {stage && (
            <form.Field
              name="effectiveFrom"
              validators={{
                onChange: ({ value }) =>
                  value ? undefined : 'Pick when this change should take effect',
              }}
            >
              {(field) => (
                <Field
                  label="Takes effect"
                  htmlFor="config-effective-from"
                  error={field.state.meta.errors.join(', ') || undefined}
                  hint="Until this instant the current value stays in force. A past instant is rejected — a change never rewrites a decision already made."
                >
                  <Input
                    id="config-effective-from"
                    type="datetime-local"
                    min={minEffectiveFrom}
                    invalid={field.state.meta.errors.length > 0}
                    startIcon={<CalendarClock size={16} />}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </Field>
              )}
            </form.Field>
          )}
        </div>

        {setMutation.error && (
          <Callout tone="danger" title="Couldn’t save that value">
            {setMutation.error.message}
          </Callout>
        )}

        <form.Subscribe
          selector={(s) => [s.canSubmit, s.isSubmitting, s.values.effectiveFrom] as const}
        >
          {([canSubmit, isSubmitting, effectiveFrom]) => {
            // Staging with no instant is not a change anyone asked for, so the
            // button stays disabled rather than quietly falling back to "now".
            const stagedWithoutInstant = stage && !effectiveFrom;
            return (
              <div className="flex items-center gap-2">
                <Button type="submit" disabled={!canSubmit || isSubmitting || stagedWithoutInstant}>
                  {isSubmitting ? 'Saving…' : stage ? 'Schedule change' : 'Save change'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={isSubmitting}
                  onClick={() => {
                    setStage(false);
                    form.reset({ value: initialValue, effectiveFrom: '' });
                  }}
                >
                  Discard
                </Button>
              </div>
            );
          }}
        </form.Subscribe>
      </form>
    </section>
  );
}

/** A one-line statement of what the key's schema will accept. */
function describeConstraint(schema: {
  editorKind: ConfigEditorKind;
  options: string[] | null;
  minimum: number | null;
  maximum: number | null;
}): string {
  switch (schema.editorKind) {
    case 'integer':
    case 'number': {
      const whole = schema.editorKind === 'integer' ? 'A whole number' : 'A number';
      if (schema.minimum != null && schema.maximum != null) {
        return `${whole} between ${schema.minimum} and ${schema.maximum}.`;
      }
      if (schema.minimum != null) return `${whole}, ${schema.minimum} or more.`;
      if (schema.maximum != null) return `${whole}, ${schema.maximum} or less.`;
      return `${whole}.`;
    }
    case 'enum':
      return `One of: ${(schema.options ?? []).join(', ')}.`;
    case 'boolean':
      return 'On or off.';
    case 'string':
      return 'Text.';
    case 'json':
      return 'A JSON value, validated against this key’s registered schema when you save.';
  }
}

/**
 * The control for one editor kind. Driven by the schema descriptor the server
 * derives from the registered Zod schema, so a key that has never been set
 * still gets the right control — inferring it from the current value would give
 * a bounded integer a free-text box the moment it was unset.
 */
function ValueControl({
  id,
  kind,
  options,
  minimum,
  maximum,
  value,
  invalid,
  onChange,
}: {
  id: string;
  kind: ConfigEditorKind;
  options: string[] | null;
  minimum: number | null;
  maximum: number | null;
  value: string;
  invalid: boolean;
  onChange: (next: string) => void;
}) {
  if (kind === 'boolean') {
    return (
      <Switch
        checked={value === 'true'}
        label={value === 'true' ? 'On' : 'Off'}
        onChange={(e) => onChange(String(e.target.checked))}
      />
    );
  }
  if (kind === 'enum') {
    return (
      <Select id={id} invalid={invalid} value={value} onChange={(e) => onChange(e.target.value)}>
        {(options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    );
  }
  if (kind === 'json') {
    return (
      <Textarea
        id={id}
        rows={8}
        invalid={invalid}
        className="font-mono text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (kind === 'integer' || kind === 'number') {
    return (
      <Input
        id={id}
        type="number"
        inputMode={kind === 'integer' ? 'numeric' : 'decimal'}
        step={kind === 'integer' ? 1 : 'any'}
        min={minimum ?? undefined}
        max={maximum ?? undefined}
        invalid={invalid}
        className="max-w-[220px] font-mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <Input
      id={id}
      invalid={invalid}
      className="font-mono"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
