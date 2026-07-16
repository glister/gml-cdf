import { z } from 'zod';

/**
 * The env boundary for the whole monorepo.
 *
 * Every package/app defines its OWN local Zod schema describing exactly the env
 * vars it needs, then calls `parse()` (fail-fast) or `safeParse()` (non-throwing)
 * here. Nothing else in the codebase touches `process.env` directly — the
 * `@repo/no-process-env` ESLint rule enforces this.
 *
 * Client code (Vite) passes `import.meta.env` as the `source`.
 */

// The default source. Isolated here so this is the single sanctioned
// `process.env` read in the repo.
// eslint-disable-next-line @repo/no-process-env -- @repo/env is the env boundary
const defaultSource: unknown = process.env;

function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const name = issue.path.length ? issue.path.join('.') : '(root)';
    // A missing required var shows up as an invalid_type with input `undefined`.
    const received = 'received' in issue ? (issue as { received?: unknown }).received : undefined;
    if (issue.code === 'invalid_type' && received === 'undefined') {
      return `  - ${name}: missing (required)`;
    }
    if (issue.code === 'invalid_type') {
      const expected = (issue as { expected?: unknown }).expected;
      return `  - ${name}: expected ${String(expected)} got ${String(received)}`;
    }
    return `  - ${name}: ${issue.message}`;
  });
  return lines.join('\n');
}

/**
 * Validate `source` against `schema`. On failure, throw an Error with a readable
 * multi-line report. On success, return the typed, parsed data.
 */
export function parse<T extends z.ZodType>(schema: T, source: unknown = defaultSource): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${formatIssues(result.error)}`);
  }
  return result.data;
}

/**
 * Non-throwing passthrough. Returns Zod's discriminated union
 * (`{ success: true, data } | { success: false, error }`) so callers can decide
 * how to react.
 */
export function safeParse<T extends z.ZodType>(
  schema: T,
  source: unknown = defaultSource,
): z.ZodSafeParseResult<z.infer<T>> {
  return schema.safeParse(source);
}

export { z };
