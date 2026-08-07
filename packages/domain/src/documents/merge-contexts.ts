import { z } from 'zod';

/**
 * The merge-context registry (core plan 11 §4.5) — the contract a template's
 * `{{context.field}}` tokens are validated against, and the reason a template
 * cannot be published with a field nothing will ever supply.
 *
 * A **context** is a named bag of scalars a consuming module can offer to the
 * merge engine: `person` here, `employee` when the HR employee plan registers
 * one, `case` when onboarding does. Registration binds three things — the name,
 * a **strict** Zod schema for the bag, and prose describing where the data comes
 * from — and `deriveMergeFields` refuses any token whose context is not declared
 * on the template or whose field is not in that context's schema.
 *
 * ## Why a shape rather than a schema, again
 *
 * `defineMergeContext` takes a **shape** and builds `z.strictObject` itself, the
 * same discipline `defineNotificationKind` applies to notification parameters
 * (core plan 10 §5.5). Here it does a job that matters more, because the merged
 * bag is **snapshotted onto the document row** (`merge_data`, ADR-0012) and
 * therefore lives as long as the document does:
 *
 * > A strict schema cannot have a profile row spread into it.
 *
 * A permissive context would let `generate` be called with the whole of
 * `platform.person` — date of birth, agency reference, contact email — and every
 * one of those columns would be frozen into a jsonb blob on a document, widening
 * plan 16's erasure surface by an amount nobody chose. Registering the four
 * fields a letter actually needs is what keeps that from happening, and building
 * the schema here is what stops someone registering `z.object` in a hurry.
 *
 * ## Scalars only
 *
 * Values are strings, numbers, booleans or null. Not because nesting is hard to
 * render — `{{person.address.line1}}` would be easy enough — but because a
 * nested object is the shape a database row arrives in, and accepting one is how
 * a context stops being a declared list of fields.
 */

/** Context names are lowercase identifiers: `person`, `employee`, `case`. */
const CONTEXT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Field names within a context follow the same grammar. */
const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** What a merged value may be. A `null` renders as the empty string. */
export type MergeValue = string | number | boolean | null;

/** Field name → Zod type. Scalars only (see above). */
export type MergeContextShape = Record<string, z.ZodType>;

export interface MergeContextDef<S extends MergeContextShape = MergeContextShape> {
  /** e.g. `person`. */
  readonly name: string;
  /** Built here as `z.strictObject` — never accepted from the caller. */
  readonly schema: z.ZodObject<S>;
  /** The declared field names, in registration order. */
  readonly fields: readonly string[];
  /** Where the data comes from, for the template author's field palette. */
  readonly description: string;
  /** The owning plan, e.g. `'11'`, `'hr-01'` — for the review trail. */
  readonly registeredBy: string;
}

/** Thrown when a template or a data bag names a context nobody registered. */
export class MergeContextUnknownError extends Error {
  constructor(readonly context: string) {
    super(
      `unknown merge context '${context}': register it with defineMergeContext() before a template can draw on it`,
    );
    this.name = 'MergeContextUnknownError';
  }
}

const registry = new Map<string, MergeContextDef>();

export interface DefineMergeContextInput<S extends MergeContextShape> {
  name: string;
  /** Field name → Zod type. **Scalars only.** */
  fields: S;
  description: string;
  registeredBy: string;
}

/**
 * Register one merge context. Validates the name grammar and every field name
 * **at module load**, so a malformed registration fails on boot rather than at
 * the first template save — the same fail-fast discipline `defineEvent`,
 * `defineConfigKey` and `defineNotificationKind` apply.
 */
export function defineMergeContext<S extends MergeContextShape>(
  input: DefineMergeContextInput<S>,
): MergeContextDef<S> {
  if (!CONTEXT_NAME_PATTERN.test(input.name)) {
    throw new Error(
      `invalid merge context name '${input.name}': must be a lowercase identifier (e.g. 'person')`,
    );
  }
  const fields = Object.keys(input.fields);
  if (fields.length === 0) {
    throw new Error(
      `merge context '${input.name}' declares no fields: a context nothing can be drawn from is not a context`,
    );
  }
  for (const field of fields) {
    if (!FIELD_NAME_PATTERN.test(field)) {
      throw new Error(
        `invalid field '${input.name}.${field}': field names are lowercase identifiers, because they appear verbatim in {{context.field}} tokens`,
      );
    }
  }
  if (registry.has(input.name)) {
    throw new Error(`duplicate merge context registration: '${input.name}' is already registered`);
  }

  const def: MergeContextDef<S> = Object.freeze({
    name: input.name,
    // Strict, always, built here — the line that makes "no unknown keys"
    // impossible to opt out of, and with it the guarantee that a profile row
    // cannot be spread into a document's frozen merge snapshot.
    schema: z.strictObject(input.fields),
    fields: Object.freeze([...fields]),
    description: input.description,
    registeredBy: input.registeredBy,
  });

  registry.set(input.name, def as unknown as MergeContextDef);
  return def;
}

/** Every registered context, by name. */
export const mergeContextRegistry: ReadonlyMap<string, MergeContextDef> = registry;

/** Look up a context, or throw {@link MergeContextUnknownError}. */
export function requireMergeContext(name: string): MergeContextDef {
  const def = registry.get(name);
  if (!def) throw new MergeContextUnknownError(name);
  return def;
}

/** Whether a context declares a field. Used by token validation (§4.5). */
export function contextHasField(name: string, field: string): boolean {
  return requireMergeContext(name).fields.includes(field);
}

/**
 * Whether a field must be supplied at generation.
 *
 * "Required" means *the schema rejects `undefined`* — not that the value must be
 * non-empty. `email: z.string().nullable()` is required-and-may-be-null: the
 * caller has to say something about it, and "we do not hold one" is a valid
 * thing to say. That distinction is what lets a template author see which
 * tokens will reliably have content and which may render blank.
 */
export function isFieldRequired(name: string, field: string): boolean {
  const def = requireMergeContext(name);
  const fieldSchema = def.schema.shape[field];
  if (!fieldSchema) throw new Error(`merge context '${name}' has no field '${field}'`);
  return !fieldSchema.safeParse(undefined).success;
}

/** Test-only: drop a registration so a suite can exercise the load-time rules. */
export function unregisterMergeContextForTests(name: string): void {
  registry.delete(name);
}

// --- The pilot context (§4.5) ------------------------------------------------

/**
 * `person` — the platform's own merge context, and the only one Phase 1's core
 * set registers.
 *
 * Four fields drawn from `platform.person` (core plan 03). Deliberately not
 * five: `date_of_birth`, `agency_worker_reference` and `contact_email` all exist
 * on that table and none of them belongs in a letter's merge bag by default. A
 * template that genuinely needs one is a reason to widen this context *on
 * purpose*, with the erasure consequence visible in the diff.
 *
 * The HR employee plan registers an `employee` context against this same
 * mechanism (ON-012 driver) without touching the merge engine — which is the
 * property the registry exists to provide.
 */
export const personMergeContext = defineMergeContext({
  name: 'person',
  fields: {
    /** `platform.person.display_name` — the name the person is known by. */
    full_name: z.string().min(1).max(200),
    /** `given_name`. Nullable: not every record carries a split name. */
    first_name: z.string().max(100).nullable(),
    /** `family_name`. */
    last_name: z.string().max(100).nullable(),
    /** `contact_email`. Nullable: an employee may sign in by SSO alone. */
    email: z.string().max(320).nullable(),
  },
  description:
    'The subject of the document, drawn from platform.person: the name they are known by, the split name where one is held, and a contact email.',
  registeredBy: '11',
});
