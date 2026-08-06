import { appendEvent, type DB } from '@repo/db';
import type { Kysely } from 'kysely';

/**
 * Journalling a special-category read (ADR-0015; semantics fixed by plan 13
 * §4.2).
 *
 * Split out of `./field-classification.ts` so that module can stay free of
 * `@repo/db`: it is imported by `../schemas.ts`, which clients pull runtime Zod
 * from via the `@repo/trpc/schemas` subpath. Classification is a pure shape
 * concern; journalling a read is server work. They were only ever together
 * because both are about field sensitivity.
 */

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
