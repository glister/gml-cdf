import { z } from 'zod';

/**
 * The response-capture registry (core plan 11 §1, §4.3, PL-009; ON-026 driver) —
 * **and the reason this plan ships controlled response actions rather than a form
 * builder.**
 *
 * A `qa_response` document points at a `capture_schema_key`; that key resolves to
 * a registered strict Zod schema; answers that do not satisfy it do not complete
 * the document. The set of schemas is fixed **in code**, which is the whole
 * distinction §1's anti-scope draws:
 *
 * > response schemas are config-registered, never user-built (no open-ended form
 * > builder)
 *
 * An HR administrator can choose which registered response set a template asks
 * for. They cannot invent a new question — because a new question is a new
 * column of personal data about every person who answers it, with a retention
 * period, an erasure obligation and a lawful basis nobody assessed. A form
 * builder makes that a Tuesday afternoon's work; a registry makes it a code
 * change with a reviewer.
 *
 * ## Where these are registered
 *
 * Here, by the plan that owns the process asking the question — the same
 * ownership rule `defineNotificationKind` and `defineConfigKey` follow. Core
 * plan 11 registers one demonstration schema; the HR onboarding plan registers
 * its enrolment capture against this mechanism without touching the engine.
 *
 * ## Scalars only, and the reason is retention rather than rendering
 *
 * Answers are snapshotted into `document.capture_data` and live as long as the
 * document. A nested object is how an entire sub-record — a next-of-kin block, a
 * medical questionnaire — arrives in one field, and the shape-not-schema rule is
 * what stops a schema being registered permissive enough to accept one.
 */

/** Keys are lowercase identifiers, matching `document.capture_schema_key`. */
const CAPTURE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Field name → Zod type. Scalars only (see above). */
export type CaptureShape = Record<string, z.ZodType>;

/** One question in a registered response set, for rendering the form. */
export interface CaptureQuestion {
  readonly name: string;
  /** The question as the subject reads it. */
  readonly label: string;
  /** How to render it. Derived from the Zod type at registration. */
  readonly kind: 'text' | 'long_text' | 'boolean' | 'choice' | 'number' | 'date';
  /** For `choice`. */
  readonly options?: readonly string[];
  readonly required: boolean;
}

export interface CaptureSchemaDef<S extends CaptureShape = CaptureShape> {
  readonly key: string;
  /** Built here as `z.strictObject` — never accepted from the caller. */
  readonly schema: z.ZodObject<S>;
  /** The rendering contract for the subject's form. */
  readonly questions: readonly CaptureQuestion[];
  readonly description: string;
  readonly registeredBy: string;
}

/** Thrown when a document names a capture schema nobody registered. */
export class CaptureSchemaUnknownError extends Error {
  constructor(readonly key: string) {
    super(
      `unknown capture schema '${key}': register it with defineCaptureSchema() before a template can ask for it`,
    );
    this.name = 'CaptureSchemaUnknownError';
  }
}

const registry = new Map<string, CaptureSchemaDef>();

export interface DefineCaptureSchemaInput<S extends CaptureShape> {
  key: string;
  fields: S;
  /** One entry per field, in the order the subject should answer them. */
  questions: readonly CaptureQuestion[];
  description: string;
  registeredBy: string;
}

/**
 * Register one response-capture schema. Validated at module load: the key
 * grammar, and that the questions and the fields describe the same set. That
 * last check is not pedantry — a question with no field silently discards an
 * answer, and a field with no question is a required value the form never asks
 * for, so the subject can never complete the document.
 */
export function defineCaptureSchema<S extends CaptureShape>(
  input: DefineCaptureSchemaInput<S>,
): CaptureSchemaDef<S> {
  if (!CAPTURE_KEY_PATTERN.test(input.key)) {
    throw new Error(
      `invalid capture schema key '${input.key}': must be a lowercase identifier (e.g. 'induction_qa')`,
    );
  }
  if (registry.has(input.key)) {
    throw new Error(`duplicate capture schema registration: '${input.key}' is already registered`);
  }

  const fieldNames = Object.keys(input.fields).sort();
  const questionNames = input.questions.map((q) => q.name).sort();
  if (fieldNames.join(',') !== questionNames.join(',')) {
    throw new Error(
      `capture schema '${input.key}': fields [${fieldNames.join(', ')}] and questions [${questionNames.join(', ')}] must describe the same set — a field with no question can never be answered, and a question with no field discards the answer`,
    );
  }

  const def: CaptureSchemaDef<S> = Object.freeze({
    key: input.key,
    schema: z.strictObject(input.fields),
    questions: Object.freeze([...input.questions]),
    description: input.description,
    registeredBy: input.registeredBy,
  });

  registry.set(input.key, def as unknown as CaptureSchemaDef);
  return def;
}

/** Every registered capture schema, by key. */
export const captureSchemaRegistry: ReadonlyMap<string, CaptureSchemaDef> = registry;

/** Look up a schema, or throw {@link CaptureSchemaUnknownError}. */
export function requireCaptureSchema(key: string): CaptureSchemaDef {
  const def = registry.get(key);
  if (!def) throw new CaptureSchemaUnknownError(key);
  return def;
}

/**
 * Validate submitted answers against a registered schema.
 *
 * Returns the **parsed** data — store that, not the input, so what is frozen
 * into `capture_data` is what the schema accepted. Returns `null` on failure
 * rather than throwing, because the caller turns it into a guard result
 * (`evaluateCompleteGuards`'s `captureValid`) rather than an exception.
 */
export function validateCaptureData(key: string, data: unknown): Record<string, unknown> | null {
  const parsed = requireCaptureSchema(key).schema.safeParse(data ?? {});
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}

/** Test-only: drop a registration so a suite can exercise the load-time rules. */
export function unregisterCaptureSchemaForTests(key: string): void {
  registry.delete(key);
}

// --- The demonstration schema (§9.7) -----------------------------------------

/**
 * `induction_qa` — the pilot's response set, and the proof that `qa_response`
 * completes only on answers that validate (AC-D7).
 *
 * Three deliberately mundane questions. Nothing here is special-category, and
 * that is the example this registry should set for the HR plans that follow:
 * the mechanism is capable of holding a medical questionnaire, and the reason it
 * will not is that someone has to register one and justify it in review.
 */
export const inductionQaCaptureSchema = defineCaptureSchema({
  key: 'induction_qa',
  fields: {
    preferred_name: z.string().min(1).max(100),
    read_handbook: z.literal(true),
    ppe_size: z.enum(['s', 'm', 'l', 'xl', 'xxl']),
  },
  questions: [
    {
      name: 'preferred_name',
      label: 'What name would you like us to use day to day?',
      kind: 'text',
      required: true,
    },
    {
      name: 'read_handbook',
      // `z.literal(true)` rather than `z.boolean()`: a confirmation that accepts
      // "no" is not a confirmation, and the schema is where that belongs — not
      // in a client-side `disabled` attribute.
      label: 'I confirm I have read the site handbook',
      kind: 'boolean',
      required: true,
    },
    {
      name: 'ppe_size',
      label: 'What size PPE do you need?',
      kind: 'choice',
      options: ['s', 'm', 'l', 'xl', 'xxl'],
      required: true,
    },
  ],
  description:
    'Induction questions asked when an induction pack is completed: preferred name, handbook confirmation and PPE size. Demonstration schema for the response-capture mechanism.',
  registeredBy: '11',
});
