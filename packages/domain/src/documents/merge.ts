import { z } from 'zod';
import {
  contextHasField,
  isFieldRequired,
  mergeContextRegistry,
  requireMergeContext,
  type MergeValue,
} from './merge-contexts.js';

/**
 * The merge engine (core plan 11 §4.5, PL-009; ON-012 driver) — token parsing,
 * contract validation and rendering, all pure (ADR-0009). No I/O, no clock: the
 * data bag is passed in, and the same input always produces the same HTML.
 *
 * ## The one-pass rule
 *
 * `renderMerge` walks the template **once**, replacing each `{{context.field}}`
 * with the HTML-escaped value. It never re-scans its own output, and that is a
 * security property rather than an optimisation: a merged value containing
 * `{{person.email}}` must appear on the page as those literal characters, not
 * become a second token. A naive loop-until-stable implementation would let a
 * person's own display name pull other people's fields into a letter — and the
 * data that reaches this engine is user-supplied by definition (R6).
 *
 * Escaping runs on the value, never on the template. The template is HTML on
 * purpose (§4.1); the values injected into it are text.
 *
 * ## Two validations, at two different moments
 *
 * **At template save**, `deriveMergeFields` re-derives the declared field list
 * from the body and rejects any token whose context is not declared on the
 * template or whose field is not in that context's registered schema. This is
 * what stops a template being *published* with a field nothing will ever supply
 * — the failure is caught by the author, not by the first person to be sent one.
 *
 * **At generation**, `validateMergeData` checks the supplied bag against the
 * union of the declared contexts' strict schemas. Strictness is doing real work:
 * the validated bag is snapshotted onto the document (`merge_data`, ADR-0012)
 * and outlives the render, so an unknown key would be a column of personal data
 * nobody chose to keep.
 */

/** `{{context.field}}` — dot path, no whitespace tolerance beyond the braces. */
const TOKEN_PATTERN = /\{\{\s*([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\s*\}\}/g;

/** One occurrence of a merge token in a template body. */
export interface MergeToken {
  /** The literal text matched, e.g. `{{ person.full_name }}`. */
  readonly raw: string;
  readonly context: string;
  readonly field: string;
  /** `context.field` — the canonical form used in declarations and errors. */
  readonly path: string;
}

/** A field the template declares it needs — the row shape of `merge_fields`. */
export interface MergeFieldDeclaration {
  readonly path: string;
  readonly context: string;
  readonly field: string;
  /** Whether the bag must carry it (the schema rejects `undefined`). */
  readonly required: boolean;
}

/** The data bag: context name → field name → scalar. */
export type MergeData = Record<string, Record<string, MergeValue>>;

/** One reason a template's tokens do not satisfy the contract. */
export interface MergeProblem {
  readonly path: string;
  readonly kind: 'undeclared_context' | 'unknown_context' | 'unknown_field';
  readonly message: string;
}

/** Thrown when a template's tokens do not satisfy the registered contexts. */
export class MergeContractError extends Error {
  constructor(readonly problems: readonly MergeProblem[]) {
    super(
      `template merge contract violated:\n${problems.map((p) => `  - ${p.message}`).join('\n')}`,
    );
    this.name = 'MergeContractError';
  }
}

/** Thrown when the supplied data bag does not satisfy the declared contexts. */
export class MergeDataError extends Error {
  constructor(readonly cause: unknown) {
    super(
      'merge data does not satisfy the declared contexts — the bag is snapshotted onto the document, so it may hold exactly the declared fields and nothing else (§4.5)',
    );
    this.name = 'MergeDataError';
  }
}

/**
 * Every token occurrence in a body, in document order (duplicates included).
 *
 * Duplicates are kept rather than deduplicated because callers want different
 * things: the editor highlights occurrences, `deriveMergeFields` wants the
 * distinct set. Collapsing here would take the choice away from both.
 */
export function parseMergeTokens(bodyHtml: string): MergeToken[] {
  const tokens: MergeToken[] = [];
  // A fresh regex per call: a module-level /g regex carries `lastIndex` between
  // calls, which makes the second call on the same string return nothing. The
  // classic way a pure-looking function stops being one.
  const pattern = new RegExp(TOKEN_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(bodyHtml)) !== null) {
    const [raw, context, field] = match as unknown as [string, string, string];
    tokens.push({ raw, context, field, path: `${context}.${field}` });
  }
  return tokens;
}

/**
 * Derive the declared field list from a body, validated against the contexts the
 * template says it draws on — the template-save contract (§4.5).
 *
 * `declaredContexts` is the template's own `merge_contexts` column, and checking
 * against it as well as against the registry is deliberate. A token could name a
 * perfectly real registered context the template never declared, and rendering
 * it would mean the generate call had to supply a bag the template's own
 * metadata never asked for. Declaring the contexts is how a template says what
 * data it is entitled to see.
 *
 * @throws {MergeContractError} listing **every** problem, not just the first —
 * an author fixing a template wants the whole list.
 */
export function deriveMergeFields(
  bodyHtml: string,
  declaredContexts: readonly string[],
): MergeFieldDeclaration[] {
  const declared = new Set(declaredContexts);
  const problems: MergeProblem[] = [];
  const seen = new Map<string, MergeFieldDeclaration>();

  for (const token of parseMergeTokens(bodyHtml)) {
    if (seen.has(token.path)) continue;

    if (!mergeContextRegistry.has(token.context)) {
      problems.push({
        path: token.path,
        kind: 'unknown_context',
        message: `{{${token.path}}} names the context '${token.context}', which is not registered — no module can supply it`,
      });
      continue;
    }
    if (!declared.has(token.context)) {
      problems.push({
        path: token.path,
        kind: 'undeclared_context',
        message: `{{${token.path}}} draws on '${token.context}', which this template does not declare in its merge contexts`,
      });
      continue;
    }
    if (!contextHasField(token.context, token.field)) {
      const available = requireMergeContext(token.context).fields.join(', ');
      problems.push({
        path: token.path,
        kind: 'unknown_field',
        message: `{{${token.path}}} names no field of '${token.context}' — available fields are: ${available}`,
      });
      continue;
    }

    seen.set(token.path, {
      path: token.path,
      context: token.context,
      field: token.field,
      required: isFieldRequired(token.context, token.field),
    });
  }

  if (problems.length > 0) throw new MergeContractError(problems);
  return [...seen.values()];
}

/**
 * Validate a data bag against the declared contexts' strict schemas.
 *
 * Returns the parsed bag — use *that*, not the input, as the value snapshotted
 * into `merge_data`, so what is frozen onto the document is what the schemas
 * accepted rather than what the caller happened to pass.
 *
 * @throws {MergeDataError}
 */
export function validateMergeData(data: unknown, declaredContexts: readonly string[]): MergeData {
  const shape: Record<string, z.ZodType> = {};
  for (const name of declaredContexts) {
    shape[name] = requireMergeContext(name).schema;
  }
  // Strict at the outer level too: a bag carrying a context the template never
  // declared is a bag someone assembled from the wrong place.
  const parsed = z.strictObject(shape).safeParse(data ?? {});
  if (!parsed.success) throw new MergeDataError(parsed.error);
  return parsed.data as MergeData;
}

/**
 * Escape a merged value for insertion into HTML.
 *
 * All five of the standard entities, including the two quote forms: the merge
 * engine does not know whether a token sits in element text or in an attribute
 * (`<a title="{{person.full_name}}">` is a legitimate template), so it escapes
 * for the stricter of the two contexts every time.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** How a scalar becomes text. `null` is blank; booleans are Yes/No. */
function stringify(value: MergeValue): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

export interface RenderMergeResult {
  /** The merged body. */
  readonly html: string;
  /**
   * Paths whose value was absent from the bag. Empty on a validated bag — a
   * required field cannot be missing after `validateMergeData`, so a non-empty
   * list here means the template names optional fields the caller left out.
   */
  readonly blanks: readonly string[];
}

/**
 * Render a template body against a data bag — one pass, escaping every value.
 *
 * A token whose context or field the bag does not carry renders **blank** and is
 * reported in `blanks`, rather than leaving the raw `{{…}}` on the page. A
 * letter that reaches someone with `{{person.last_name}}` printed on it is worse
 * than one with a gap, and the caller has the list either way.
 */
export function renderMerge(bodyHtml: string, data: MergeData): RenderMergeResult {
  const blanks: string[] = [];
  const pattern = new RegExp(TOKEN_PATTERN.source, 'g');

  const html = bodyHtml.replace(pattern, (_raw, context: string, field: string) => {
    const value = data[context]?.[field];
    if (value === undefined) {
      blanks.push(`${context}.${field}`);
      return '';
    }
    // Escaped, and never re-scanned: `String.replace` with a function evaluates
    // over the ORIGINAL string, so a value containing `{{other.field}}` lands as
    // literal text. That is the whole of R6's mitigation.
    return escapeHtml(stringify(value));
  });

  return { html, blanks };
}

/**
 * The full generate path: validate the bag, then render.
 *
 * Kept as one function because the two steps must not be separable at a call
 * site — rendering an unvalidated bag is how an unknown key reaches the
 * snapshot, and validating without rendering is how a caller ends up with two
 * versions of "the data that was merged".
 */
export function mergeTemplate(
  bodyHtml: string,
  declaredContexts: readonly string[],
  data: unknown,
): { html: string; mergeData: MergeData; blanks: readonly string[] } {
  const mergeData = validateMergeData(data, declaredContexts);
  const { html, blanks } = renderMerge(bodyHtml, mergeData);
  return { html, mergeData, blanks };
}
