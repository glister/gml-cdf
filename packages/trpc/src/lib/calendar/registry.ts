import { sql, type Expression, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import type { DB } from '@repo/db';
import type { CalendarKind, CalendarVisibilityClass, PersonScope } from '../constants.js';

/**
 * The calendar-source registry and feed composer (core plan 12 §4.1.2/§5.1,
 * PL-022/PL-023/PL-023a).
 *
 * **The calendar is a read model, not a table.** There is no `calendar_event`
 * row anywhere, and there is no materialisation job. Each module contributes a
 * SQL *fragment* projecting its own rows into one canonical shape; the composer
 * `UNION ALL`s them, joins team membership and the person's name once for all
 * of them, applies the viewer's scope, applies the requested facets, resolves a
 * colour, and orders deterministically. Persisting the result would create a
 * second source of truth that drifts from the first (ADR-0010).
 *
 * **The registry is code, not rows.** A source appears when a module ships one;
 * that is a deploy, not an administrative act. A database-backed
 * pluggable-source table would let someone register a fragment that no reviewer
 * ever read.
 *
 * ## Module boundaries (ADR-0008)
 *
 * The composed statement crosses schemas at execution time — one SQL query
 * unions `platform.*` and later `hr.*` — but **the calendar runtime never
 * writes SQL against another module's tables**. Each fragment is authored inside
 * the owning module's own code and handed to this registry. That is the same
 * exception `lib/scope.ts` documents: these helpers *are* the platform module's
 * exported service surface.
 *
 * ## Restricted sources are structural, not filtered (SA-023)
 *
 * A source declared `visibilityClass: 'restricted'` cannot express per-row
 * detail. The type makes its label a **constant** rather than an expression,
 * and {@link canonicalFragment} discards whatever the fragment supplied for
 * `type_ref`, `type_label` and `type_colour`, substituting the kind. Leaking a
 * sickness type onto the shared calendar would therefore require changing this
 * file — not just registering a careless source.
 *
 * ---
 *
 * ## The HR consumption contract (core plan 12 §9.5)
 *
 * Four sources are specified and unbuilt. They are listed here rather than only
 * in the plan document because this is the file whoever builds them will read,
 * and two of the four have a rule that is not obvious from the types.
 *
 * ### `hr.leave` — HR Holiday & Leave plan (HL-043…046)
 *
 * Approved **and** requested bookings, `kind: 'leave'`, `visibilityClass:
 * 'normal'`. `typeRef`/`typeLabel`/`typeColour` project `hr.leave_type`'s id,
 * name and `colour` — **from the HR fragment**, because the calendar may not
 * join an `hr` table itself (ADR-0008); that is the entire reason those two
 * columns are in the canonical shape. `outlookSync` binds
 * `hr.leave_booking.approved` → create and `hr.leave_booking.cancelled` →
 * cancel, and **no `onAmended`**: ADR-0021 models amendment as supersession, so
 * an amended booking arrives as a cancel plus a create of the successor
 * (§12.2 Q3). `sourceRefFor` can be omitted — those events stream on the
 * booking row, so `streamId` is already the ref.
 *
 * ### `hr.absence` — HR Sickness & Absence plan (SA-023/024)
 *
 * **MUST register as `visibilityClass: 'restricted'` with `restrictedLabel:
 * 'Absence'`.** This is the one registration in the system where getting the
 * class wrong is a data-protection incident rather than a bug: `normal` would
 * put a sickness type on every teammate's screen. The composer's substitution
 * makes the *fragment* harmless either way, so the class is the only thing
 * standing between the two outcomes — review it, and note that
 * `routers/platform/calendar.test.ts` drives a deliberately hostile restricted
 * fragment to prove the substitution holds. No `outlookSync`: an absence is a
 * fact recorded after the event, not something to book into a calendar.
 *
 * ### `hr.bank_holiday` — HR Holiday & Leave plan (PL-023, §4.1.2)
 *
 * A fragment over `hr.bank_holiday_calendar` + `hr.bank_holiday_date` (Tier-3
 * reference data, effective-dated per year — core plan 05 defers both tables to
 * that plan). `kind: 'bank_holiday'`, `personId: NULL` (organisation-wide, so it
 * passes every viewer's scope), `label` = the holiday name, `status`
 * `'approved'`, `visibilityClass: 'normal'`, **no `outlookSync`** — a bank
 * holiday is in everyone's calendar already. Authored in the HR module's own
 * code and exported to this registry, like every other fragment.
 *
 * ### `hr_event` sources — ER, Sickness & Absence, Wellbeing, D&A, Offboarding
 *
 * Probation reviews, return-to-work meetings, OH/wellbeing reviews, D&A
 * appointments and exit interviews (PL-023a). All `kind: 'hr_event'`,
 * `visibilityClass: 'restricted'` with a generic label, **and an `audience`
 * predicate** — typically HR, the subject, and the subject's line manager. The
 * predicate *replaces* the uniform team scoping for that source rather than
 * intersecting with it, because the right audience is narrower in one direction
 * (a teammate must not see it) and wider in another (HR always does). It must
 * reference {@link SRC_PERSON_ID}, since it is applied to the composed union
 * rather than to the source's own table.
 */

// --- The canonical event shape (§4.1.1) --------------------------------------

/**
 * The columns every fragment yields, in the order the `UNION ALL` requires.
 *
 * Exported as data rather than left implicit so a fragment cannot silently
 * project them in a different order — the union would still typecheck in SQL
 * (all-text columns) and quietly transpose `label` and `status`.
 */
export const CANONICAL_COLUMNS = [
  'source_key',
  'source_ref',
  'person_id',
  'starts_on',
  'ends_on',
  'day_part',
  'kind',
  'type_ref',
  'type_label',
  'type_colour',
  'label',
  'status',
  'visibility_class',
] as const;

/** How the composer refers to a fragment's person column. Audience predicates use it. */
export const SRC_PERSON_ID = sql.ref('src.person_id');

/** A SQL expression a fragment supplies for one canonical column. */
type Frag = RawBuilder<unknown> | Expression<unknown>;

/**
 * The per-row expressions a fragment supplies.
 *
 * `sourceKey` and `visibilityClass` are **not** here: the registry supplies both
 * from the source's own registration, so a fragment cannot claim to be a
 * different source or quietly downgrade itself to `normal`.
 */
export interface CanonicalProjection {
  /** Stable identity within the source — its row PK, or a synthetic key. */
  sourceRef: Frag;
  /** `NULL` ⇒ an organisation-wide item (bank holiday, blackout, shut-down). */
  personId: Frag;
  /** Inclusive `date`. */
  startsOn: Frag;
  /** Inclusive `date`, `>= startsOn`. */
  endsOn: Frag;
  /** `'am' | 'pm' | NULL`. */
  dayPart?: Frag;
  kind: Frag;
  /** Colour/filter key — the owning module's type row id or lookup code. */
  typeRef?: Frag;
  /** Human label for that type, for the legend. */
  typeLabel?: Frag;
  /** The type's own colour, as hex. Projected by the owning module (ADR-0008). */
  typeColour?: Frag;
  /** Display text. Ignored for a restricted source — the constant wins. */
  label?: Frag;
  /** `'approved' | 'requested'`. */
  status: Frag;
}

const NULL_TEXT = sql`NULL::text`;

/**
 * Build one fragment's `SELECT` list in canonical order, then append its `FROM`.
 *
 * The `from` clause is the fragment's own — `sql\`FROM hr.leave_booking b WHERE
 * …\`` — and **must already be constrained to the window** with the
 * range-overlap predicate `starts_on <= :to AND ends_on >= :from`. Pushing the
 * window into each fragment is what lets each source's own indexes do the work;
 * filtering after the union would make every source scan its whole table.
 */
export function canonicalFragment(
  source: Pick<CalendarSource, 'key' | 'visibilityClass' | 'restrictedLabel'>,
  projection: CanonicalProjection,
  from: RawBuilder<unknown>,
): RawBuilder<unknown> {
  const restricted = source.visibilityClass === 'restricted';

  // The four columns a restricted source does not get to choose. Substituting
  // them here — rather than filtering them out later — is what makes SA-023 a
  // property of the platform instead of a promise each source makes.
  const label = restricted
    ? sql.lit(source.restrictedLabel ?? '')
    : (projection.label ?? NULL_TEXT);
  const typeRef = restricted ? projection.kind : (projection.typeRef ?? NULL_TEXT);
  const typeLabel = restricted ? NULL_TEXT : (projection.typeLabel ?? NULL_TEXT);
  const typeColour = restricted ? NULL_TEXT : (projection.typeColour ?? NULL_TEXT);

  return sql`SELECT
      ${sql.lit(source.key)}::text                       AS source_key,
      (${projection.sourceRef})::text                    AS source_ref,
      (${projection.personId})::uuid                     AS person_id,
      (${projection.startsOn})::date                     AS starts_on,
      (${projection.endsOn})::date                       AS ends_on,
      (${projection.dayPart ?? NULL_TEXT})::text         AS day_part,
      (${projection.kind})::text                         AS kind,
      (${typeRef})::text                                 AS type_ref,
      (${typeLabel})::text                               AS type_label,
      (${typeColour})::text                              AS type_colour,
      (${label})::text                                   AS label,
      (${projection.status})::text                       AS status,
      ${sql.lit(source.visibilityClass)}::text           AS visibility_class
    ${from}`;
}

// --- The source contract -----------------------------------------------------

/** What a fragment builder is told about the request it is being built for. */
export interface CalendarWindow {
  /** Inclusive `YYYY-MM-DD`. */
  from: string;
  /** Inclusive `YYYY-MM-DD`. */
  to: string;
}

/** Who is asking — everything an audience predicate is allowed to know. */
export interface CalendarViewer {
  personId: string;
  /** The viewer's widest record scope in the `platform` module (plan 04). */
  scope: PersonScope;
  /** Role keys held in `platform`, active now. */
  roleKeys: readonly string[];
}

/**
 * How a source's items reach Outlook (§5.2).
 *
 * There is deliberately **no `onCreated`**: only an *approved* item is ever
 * pushed (PL-024), so the binding names the event that marks approval. A
 * `requested` item has no event bound to it at all, which is a stronger
 * guarantee than a status check at push time — though `load()` re-checks anyway,
 * because redelivery can arrive after the item stopped being approved.
 */
export interface OutlookSyncBinding {
  /** Event type ⇒ create the Outlook event. */
  onApproved: string;
  /**
   * Event type ⇒ PATCH the same Outlook event.
   *
   * Optional, and most sources will not have one. ADR-0021 models amendment of a
   * business record as **supersession** — cancel plus create — so a leave
   * booking never takes this path (§12.2 Q3). It exists for items that
   * legitimately move *in place*, such as a rescheduled HR event.
   */
  onAmended?: string;
  /** Event type ⇒ DELETE the Outlook event. */
  onCancelled: string;
  /**
   * Read the current syncable item by `sourceRef`, or `null` when it no longer
   * exists or is no longer approved. Called at execution time, so a redelivery
   * that arrives after a cancellation cannot resurrect an event.
   */
  load: (db: Kysely<DB>, sourceRef: string) => Promise<SyncableItem | null>;
  /**
   * Derive the item's `sourceRef` from a delivered event.
   *
   * Optional, because the common case needs no derivation: a leave booking's
   * events stream on the booking row, so `streamId` **is** the ref. The demo
   * source overrides it, because its events stream on the administrator and the
   * item is identified by a payload field.
   *
   * The owning module supplies this so the worker's handler never learns any
   * source's key format — which is what keeps the rail generic.
   */
  sourceRefFor?: (event: { streamId: string; payload: unknown }) => string | null;
}

/** One approved item, as the Outlook rail needs to see it (§5.2). */
export interface SyncableItem {
  sourceKey: string;
  sourceRef: string;
  /** Whose calendar it belongs in. Never null — org-wide items are not synced. */
  personId: string;
  label: string;
  startsOn: string;
  endsOn: string;
  dayPart: 'am' | 'pm' | null;
  kind: CalendarKind;
}

/** A registered calendar source. */
export interface CalendarSource {
  /** `'platform.config_period'`, `'hr.leave'`, … — the read model's namespace. */
  key: string;
  /** The kinds this source may emit. Validated against what it projects. */
  kinds: readonly CalendarKind[];
  visibilityClass: CalendarVisibilityClass;
  /**
   * The constant label every row of a restricted source renders as.
   *
   * Required for `restricted`, meaningless otherwise — a **constant**, never an
   * expression, because an expression is exactly the thing that could carry a
   * sickness type onto a teammate's screen (SA-023).
   */
  restrictedLabel?: string;
  /** The fragment, already constrained to the window (see {@link canonicalFragment}). */
  fragment: (window: CalendarWindow) => RawBuilder<unknown>;
  /**
   * PL-023a person/department/role-based visibility.
   *
   * When present, this predicate replaces the uniform team scoping **for this
   * source's rows only** — typically "HR, the subject, and the subject's line
   * manager" for an occupational-health review or a D&A appointment. It must
   * reference {@link SRC_PERSON_ID} rather than a table of its own, because it
   * is applied to the composed union, not to the source's table.
   *
   * Absent ⇒ the uniform scoping every other source gets.
   */
  audience?: (viewer: CalendarViewer) => Expression<SqlBool>;
  /** Only sources with syncable personal items (§5.2). */
  outlookSync?: OutlookSyncBinding;
}

/** Thrown when a registration is self-inconsistent — at module load, not at query time. */
export class CalendarSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarSourceError';
  }
}

/**
 * Validate one registration. Called by {@link registerCalendarSource} at import
 * time so a malformed source is a boot failure rather than a runtime surprise
 * halfway down a union (§12.3: "composer validates fragment column set at
 * registration — startup failure, not runtime").
 */
export function validateCalendarSource(source: CalendarSource): void {
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(source.key)) {
    throw new CalendarSourceError(
      `invalid calendar source key '${source.key}': expected '<module>.<name>', e.g. 'platform.config_period'`,
    );
  }
  if (source.kinds.length === 0) {
    throw new CalendarSourceError(`calendar source '${source.key}' declares no kinds`);
  }
  if (source.visibilityClass === 'restricted' && !source.restrictedLabel) {
    throw new CalendarSourceError(
      `restricted calendar source '${source.key}' must declare a constant restrictedLabel (SA-023): its rows may not carry per-row text`,
    );
  }
  if (source.visibilityClass !== 'restricted' && source.restrictedLabel !== undefined) {
    throw new CalendarSourceError(
      `calendar source '${source.key}' declares a restrictedLabel but is not restricted — the label would be ignored, which is worse than an error`,
    );
  }
  if (source.outlookSync) {
    const { onApproved, onCancelled, onAmended } = source.outlookSync;
    if (onApproved === onCancelled || onAmended === onApproved || onAmended === onCancelled) {
      throw new CalendarSourceError(
        `calendar source '${source.key}' binds the same event type to two sync operations`,
      );
    }
  }
}

const sources = new Map<string, CalendarSource>();

/**
 * Register a source. Idempotent registration is **not** allowed: two
 * registrations of one key would make the feed depend on import order.
 */
export function registerCalendarSource(source: CalendarSource): CalendarSource {
  validateCalendarSource(source);
  if (sources.has(source.key)) {
    throw new CalendarSourceError(`duplicate calendar source registration: '${source.key}'`);
  }
  sources.set(source.key, source);
  return source;
}

/** Every registered source, in registration order. */
export function calendarSources(): readonly CalendarSource[] {
  return [...sources.values()];
}

/** Look up a source by key. */
export function calendarSource(key: string): CalendarSource | undefined {
  return sources.get(key);
}

/** Test-only: drop a registration so a suite can register its own stub. */
export function unregisterCalendarSourceForTests(key: string): void {
  sources.delete(key);
}

/**
 * The Outlook binding whose `onApproved`/`onAmended`/`onCancelled` names an
 * event type, plus which operation it names. The worker's handler resolves a
 * delivered event this way rather than switching on a hardcoded list — which is
 * what lets an HR plan add leave sync with no change to the handler.
 */
export function bindingForEventType(
  eventType: string,
): { source: CalendarSource; operation: 'create' | 'update' | 'cancel' } | undefined {
  for (const source of sources.values()) {
    const binding = source.outlookSync;
    if (!binding) continue;
    if (binding.onApproved === eventType) return { source, operation: 'create' };
    if (binding.onAmended === eventType) return { source, operation: 'update' };
    if (binding.onCancelled === eventType) return { source, operation: 'cancel' };
  }
  return undefined;
}

/** Every event type any registered source binds — the subscription's rule set. */
export function syncEventTypes(): string[] {
  const types: string[] = [];
  for (const source of sources.values()) {
    const binding = source.outlookSync;
    if (!binding) continue;
    types.push(binding.onApproved, binding.onCancelled);
    if (binding.onAmended) types.push(binding.onAmended);
  }
  return types;
}
