/* Presentation helpers for the configuration store (core plan 06 §5.3). The
   browser, the key editor and the history panel describe a value the same way,
   so the formatting lives here rather than being restated per screen. */

// Type-only, so it erases at build: importing `@repo/trpc`'s schema module for
// its *values* would pull `@repo/db` (and the Postgres driver) into the browser
// bundle, which is why the forms below restate their shapes instead.
import type { ConfigEditorKind } from '@repo/trpc';

/**
 * Render a config value for display.
 *
 * Scalars render bare — `90`, `true`, `P1D` — because that is how an
 * administrator thinks about a threshold, and quoting a string would suggest
 * the quotes were part of it. Structured values render as compact JSON, which
 * is what they are.
 */
export function formatConfigValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * The value as the editor holds it — always a string, because that is what a
 * controlled input holds. `json` values are pretty-printed so a multi-line
 * textarea is legible.
 */
export function toEditorText(value: unknown, kind: ConfigEditorKind): string {
  if (value === undefined || value === null) return kind === 'json' ? '' : '';
  if (kind === 'json') return JSON.stringify(value, null, 2);
  if (typeof value === 'string') return value;
  return String(value);
}

/**
 * Parse the editor's text back into the JSON value the procedure expects.
 *
 * Returns `{ ok: false }` rather than throwing, so a half-typed JSON object is
 * a field-level validation message rather than a crash. The server validates
 * against the key's registered Zod schema regardless — this only stops an
 * obviously-malformed value being sent.
 */
export function fromEditorText(
  text: string,
  kind: ConfigEditorKind,
): { ok: true; value: unknown } | { ok: false; message: string } {
  switch (kind) {
    case 'integer':
    case 'number': {
      const trimmed = text.trim();
      if (trimmed === '') return { ok: false, message: 'Enter a number' };
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return { ok: false, message: 'Enter a number' };
      if (kind === 'integer' && !Number.isInteger(n)) {
        return { ok: false, message: 'Enter a whole number' };
      }
      return { ok: true, value: n };
    }
    case 'boolean':
      return { ok: true, value: text === 'true' };
    case 'enum':
    case 'string':
      return { ok: true, value: text };
    case 'json': {
      if (text.trim() === '') return { ok: false, message: 'Enter a JSON value' };
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, message: 'That is not valid JSON' };
      }
    }
  }
}

/** A namespace rendered for people: `platform.identity` → `Platform · identity`. */
export function formatNamespace(namespace: string): string {
  const [head, ...rest] = namespace.split('.');
  const module = (head ?? '').replace(/^./, (c) => c.toUpperCase());
  return rest.length > 0 ? `${module} · ${rest.join(' · ')}` : module;
}

/** An ISO instant as a date and time — config changes happen at an instant. */
export function formatInstant(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * `YYYY-MM-DDTHH:mm` for a datetime-local input, in the **viewer's** calendar.
 *
 * Built from local components rather than `toISOString().slice(0, 16)`, which
 * would shift the displayed time by the viewer's UTC offset — the same defect
 * plan 05's visual pass found in its date helper.
 */
export function toLocalDateTimeInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
