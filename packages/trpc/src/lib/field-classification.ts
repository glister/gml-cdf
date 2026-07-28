import { z } from 'zod';
import { appendEvent, type DB } from '@repo/db';
import type { Kysely } from 'kysely';
import { FIELD_CLASSES, type FieldClass } from './constants.js';

/**
 * Field-level authorisation (core plan 04 §5.1, PL-003, ADR-0015/0019).
 *
 * Two mechanisms, deliberately overlapping:
 *
 * 1. **Classification maps + role-variant output schemas.** Every exposed
 *    column of an entity carries a class; a role's variant keeps only the
 *    fields at or below its ceiling. A procedure then selects *only the columns
 *    of the variant it will return*, so the restricted path never pulls a
 *    sensitive value out of Postgres in the first place — field security holds
 *    before serialisation, not just at it.
 * 2. **Table segregation.** Special-category columns never live on a main
 *    record table (ADR-0015/0019). `platform.person_flag` is the pilot: an
 *    accidental `select *` on `platform.person` cannot leak a safeguarding
 *    flag, because the flag is not there to leak.
 *
 * The classification map is *code*, not runtime configuration: changing a
 * field's class changes the API contract and belongs in review, not in an admin
 * screen (§6, "not configurable by design").
 */

const CLASS_RANK: Record<FieldClass, number> = {
  public: 0,
  internal: 1,
  sensitive: 2,
  'special-category': 3,
};

export interface FieldClassification<S extends z.ZodRawShape> {
  readonly entity: string;
  readonly schema: z.ZodObject<S>;
  readonly map: Readonly<Record<keyof S, FieldClass>>;
}

/**
 * Declare an entity's field classification.
 *
 * `map` is typed `Record<keyof S, FieldClass>` — **every** key of the schema
 * must appear, so adding a column without classifying it is a compile error
 * rather than a silently-visible field (§12.3, the classification-drift risk).
 * The runtime check catches the same mistake in JS callers and in tests.
 */
export function defineFieldClassification<S extends z.ZodRawShape>(
  entity: string,
  schema: z.ZodObject<S>,
  map: Record<keyof S, FieldClass>,
): FieldClassification<S> {
  const schemaKeys = Object.keys(schema.shape);
  const mapped = new Set(Object.keys(map));

  const unclassified = schemaKeys.filter((k) => !mapped.has(k));
  if (unclassified.length > 0) {
    throw new Error(
      `field classification for '${entity}' is incomplete: ${unclassified.join(', ')} — every exposed column must carry a class (PL-003, ADR-0015)`,
    );
  }
  const unknown = [...mapped].filter((k) => !schemaKeys.includes(k));
  if (unknown.length > 0) {
    throw new Error(
      `field classification for '${entity}' classifies fields that are not in the schema: ${unknown.join(', ')}`,
    );
  }
  for (const [field, cls] of Object.entries(map)) {
    if (!FIELD_CLASSES.includes(cls as FieldClass)) {
      throw new Error(`field classification for '${entity}.${field}' has unknown class '${cls}'`);
    }
  }

  return Object.freeze({ entity, schema, map: Object.freeze({ ...map }) });
}

/** The field names of `fc` at or below `maxClass`. */
export function fieldsUpTo<S extends z.ZodRawShape>(
  fc: FieldClassification<S>,
  maxClass: FieldClass,
): string[] {
  const ceiling = CLASS_RANK[maxClass];
  return Object.entries(fc.map)
    .filter(([, cls]) => CLASS_RANK[cls as FieldClass] <= ceiling)
    .map(([field]) => field);
}

/** The field names of `fc` in exactly `cls` — used to decide read journalling. */
export function fieldsOfClass<S extends z.ZodRawShape>(
  fc: FieldClassification<S>,
  cls: FieldClass,
): string[] {
  return Object.entries(fc.map)
    .filter(([, c]) => c === cls)
    .map(([field]) => field);
}

/**
 * Derive a role-variant output schema keeping only fields at or below
 * `maxClass`. The result is a real Zod object, so the procedure's declared
 * output and the columns it selects stay in step.
 */
export function schemaUpTo<S extends z.ZodRawShape>(
  fc: FieldClassification<S>,
  maxClass: FieldClass,
): z.ZodObject<z.ZodRawShape> {
  const keep = new Set(fieldsUpTo(fc, maxClass));
  const shape: z.ZodRawShape = Object.fromEntries(
    Object.entries(fc.schema.shape).filter(([field]) => keep.has(field)),
  ) as z.ZodRawShape;
  return z.object(shape);
}

/**
 * The classification ceiling a viewer's roles confer for an entity. Anything
 * above it is neither selected nor returned.
 *
 * Deliberately coarse in Phase 1 and keyed on role, not on a per-entity policy
 * table: three granularities implemented as code + data, no ABAC DSL (§1
 * anti-scope).
 */
export function ceilingForRoles(roleKeys: readonly string[]): FieldClass {
  if (roleKeys.includes('administrator') || roleKeys.includes('hr_user')) return 'special-category';
  // Everyone else — including director, line_manager, external and the
  // operational roles — sees at most internal-class fields (PL-043).
  return 'internal';
}

export interface SpecialCategoryReadInput {
  /** The entity whose special-category fields were returned, e.g. `platform.person_flag`. */
  entity: string;
  /** The subject record's stream type — the *subject*, never the reader. */
  streamType: string;
  /** The subject record's id (the stream the event lands on). */
  streamId: string;
  /** Field NAMES only. A value here would defeat the purpose (ADR-0019). */
  fields: string[];
  /** The person who read it. */
  readerPersonId: string;
  /** The procedure path, for the audit trail. */
  procedure: string;
  correlationId: string;
}

/**
 * Journal a special-category read (ADR-0015; semantics fixed by plan 13 §4.2).
 *
 * Wrapped in one helper so it cannot be forgotten piecemeal on a new surface.
 * Three binding rules from plan 13:
 *
 *  - **one event per (request, entity, record)** — callers pass the whole field
 *    set for a record once, not one event per field;
 *  - **field names only**, never values;
 *  - **a recursion guard**: reading the security log must not itself emit read
 *    events, or browsing the audit trail would grow it without bound. That is
 *    why this refuses to journal a read of `platform.domain_event`.
 *
 * Reads are not transactional, so this is an ordinary append immediately after
 * the select, in the same request — it opens its own short transaction rather
 * than taking one, which is the one legitimate exception to "append in the
 * caller's transaction" (there is no state change to be atomic with).
 */
export async function journalSpecialCategoryRead(
  db: Kysely<DB>,
  input: SpecialCategoryReadInput,
): Promise<void> {
  if (input.fields.length === 0) return;
  // Recursion guard (plan 13 §4.2): never journal reads of the journal itself.
  if (input.streamType === 'platform.domain_event' || input.entity === 'platform.domain_event') {
    return;
  }
  await db.transaction().execute((trx) =>
    appendEvent(trx, {
      kind: 'security',
      streamType: input.streamType,
      streamId: input.streamId,
      eventType: 'platform.data.special_category.accessed',
      payload: {
        entity: input.entity,
        fields: [...input.fields].sort(),
        readerPersonId: input.readerPersonId,
        procedure: input.procedure,
      },
      actorPersonId: input.readerPersonId,
      correlationId: input.correlationId,
    }),
  );
}
