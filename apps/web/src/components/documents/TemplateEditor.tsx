import * as React from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Heading2, Italic, List, ListOrdered, Plus, Undo2 } from 'lucide-react';
import { cn } from '~/lib/utils';

/**
 * The template body editor (core plan 11 §9.4; §12.2 Q2 — Tiptap, resolved
 * 2026-08-07).
 *
 * ## Constrained on purpose
 *
 * StarterKit is cut down to exactly the subset the renderer and the merge engine
 * agree on: paragraphs, two heading levels, bold, italic, both list kinds and a
 * rule. Tables, images, code blocks and links are **off**. That is not
 * minimalism for its own sake — every construct an author can produce is one the
 * PDF renderer has to reproduce faithfully, and R4 (what was previewed ≠ what
 * was signed) is a fidelity risk that grows with the size of the subset.
 * Narrowing the editor is the cheapest way to keep it small.
 *
 * ## The palette inserts text, not a node
 *
 * A merge field is inserted as the literal string `{{person.full_name}}`, which
 * is exactly what `deriveMergeFields` parses server-side. A custom Tiptap node
 * would render prettier chips, but it would also mean two representations of a
 * token — one in the editor's document model and one in the HTML — and the
 * moment those diverge a template validates in the browser and fails on save.
 * One representation, parsed by one parser.
 *
 * The palette lists only **registered** fields for the contexts this template
 * declares, so an author cannot insert a token that will be rejected on save.
 */

export interface MergeContextOption {
  name: string;
  description: string;
  fields: { path: string; field: string; required: boolean }[];
}

export interface TemplateEditorProps {
  value: string;
  onChange: (html: string) => void;
  /** Registered contexts, filtered to those this template declares. */
  contexts: MergeContextOption[];
  disabled?: boolean;
}

/** The one extension set an author may produce (see above). */
const EXTENSIONS = [
  StarterKit.configure({
    heading: { levels: [2, 3] },
    codeBlock: false,
    code: false,
    blockquote: false,
    link: false,
  }),
];

function ToolbarButton({
  active,
  disabled,
  onClick,
  label,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-md border font-sans text-sm transition-colors',
        active
          ? 'border-brand bg-brand/10 text-brand'
          : 'border-transparent text-muted hover:bg-surface-sunken hover:text-strong',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      {children}
    </button>
  );
}

export function TemplateEditor({ value, onChange, contexts, disabled }: TemplateEditorProps) {
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: value,
    editable: !disabled,
    editorProps: {
      attributes: {
        class:
          'prose-cdf min-h-[320px] max-w-none px-4 py-3 font-sans text-sm text-body outline-none',
        'aria-label': 'Template body',
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
  });

  // Keep the editor in step when the body is replaced from outside (loading a
  // different version). Guarded on equality: writing the same HTML back would
  // reset the caret on every keystroke.
  React.useEffect(() => {
    if (editor && value !== editor.getHTML())
      editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

  React.useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  if (!editor) return <div className="h-[380px] animate-pulse rounded-lg bg-surface-sunken" />;

  return (
    <div className="flex flex-col rounded-lg border border-border-default bg-surface-card">
      <div className="flex flex-wrap items-center gap-1 border-b border-border-default px-2 py-1.5">
        <ToolbarButton
          label="Heading"
          disabled={disabled}
          active={editor.isActive('heading', { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 size={15} />
        </ToolbarButton>
        <ToolbarButton
          label="Bold"
          disabled={disabled}
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold size={15} />
        </ToolbarButton>
        <ToolbarButton
          label="Italic"
          disabled={disabled}
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic size={15} />
        </ToolbarButton>
        <ToolbarButton
          label="Bulleted list"
          disabled={disabled}
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List size={15} />
        </ToolbarButton>
        <ToolbarButton
          label="Numbered list"
          disabled={disabled}
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered size={15} />
        </ToolbarButton>
        <ToolbarButton
          label="Undo"
          disabled={disabled}
          onClick={() => editor.chain().focus().undo().run()}
        >
          <Undo2 size={15} />
        </ToolbarButton>

        <div className="ml-auto">
          <MergeFieldPalette
            editor={editor}
            contexts={contexts}
            disabled={disabled}
            open={paletteOpen}
            setOpen={setPaletteOpen}
          />
        </div>
      </div>

      <EditorContent editor={editor} />
    </div>
  );
}

function MergeFieldPalette({
  editor,
  contexts,
  disabled,
  open,
  setOpen,
}: {
  editor: Editor;
  contexts: MergeContextOption[];
  disabled?: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, setOpen]);

  const insert = (path: string) => {
    // The literal token, which is what the server's parser reads. See the file
    // header for why this is not a custom node.
    editor.chain().focus().insertContent(`{{${path}}}`).run();
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled || contexts.length === 0}
        onClick={() => setOpen(!open)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-default bg-surface-card px-2.5 font-sans text-xs font-semibold text-body hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Plus size={13} aria-hidden="true" />
        Insert field
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-1 max-h-[300px] w-[290px] overflow-y-auto rounded-lg border border-border-default bg-surface-card p-1.5 shadow-lg">
          {contexts.length === 0 ? (
            <p className="p-3 font-sans text-xs text-muted">
              Declare a merge context on this template before inserting fields.
            </p>
          ) : (
            contexts.map((context) => (
              <div key={context.name} className="mb-1 last:mb-0">
                <p className="px-2 py-1 font-sans text-2xs font-semibold uppercase tracking-wide text-muted">
                  {context.name}
                </p>
                {context.fields.map((field) => (
                  <button
                    key={field.path}
                    type="button"
                    onClick={() => insert(field.path)}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-sunken"
                  >
                    <span className="font-mono text-xs text-strong">{field.field}</span>
                    {!field.required && (
                      <span className="font-sans text-2xs text-muted">may be blank</span>
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
