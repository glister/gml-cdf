# @repo/trpc

The API contract **and the security boundary**. Source-only, exports
`./src/index.ts`. The `appRouter` is defined HERE, not in `apps/api` — the API
only mounts it.

## Layout

- `src/trpc.ts` — init hub. `initTRPC.context<TRPCContext>()`; exports `router`
  and the procedure builders: `publicProcedure`, `protectedProcedure`,
  `adminProcedure`. `TRPCContext` carries injected `db`,
  `user`, `session`, `logger`, `email`, `sms`, `rateLimit`.
  Services are passed in as structural interfaces — never imported here (keeps
  the package decoupled).
- `src/schemas.ts` — flat module of Zod input/output schemas + inferred types.
  Enums derive from constant tuples in `./lib/constants.ts`.
- `src/router.ts` — composition root; merges `./routers/*` into `appRouter`.
- `src/routers/*` — one file per domain; validators from `../schemas.js`, queries
  via `ctx.db`, helpers from `./lib`.
- `src/lib/keyset.ts` — cursor/keyset pagination helpers.

## Hard rule — module boundaries (ADR-0008)

Routers are grouped by module under `src/routers/<module>/` (`platform`, `hr`).
**A module never reads another module's tables.** Every table key is
schema-qualified (`ctx.db.selectFrom('platform.person')`); cross-module access
goes through the other module's exported service surface, and cross-module
notification goes through domain events — never a direct cross-schema join.
ESLint blocks cross-module _imports_, but it cannot see SQL strings: **a
`'platform.'`/`'hr.'` table key used in a router outside its own module's
directory is a review-blocking violation.** `ctx.db.withSchema(...)` is banned
(it hides the boundary behind implicit resolution).

## Hard rule — server-side tables

All filtering/sorting/searching happens in SQL via keyset/cursor pagination —
never client-side over a loaded page. The SAME sort-key expression drives both
`ORDER BY` and the cursor boundary, coalesced non-null. Timestamp sort keys are
rendered as fixed-width text (`timestampSortKey`) to avoid ms truncation at page
edges. Push every facet into the input schema and apply as `where`/`order by`.

## Auth (core plan 04, ADR-0015)

Enforcement lives in the procedures, not in the app. Web-side route guards are
UX-only. There are **three granularities**, and a feature uses all three that
apply to it — never a hand-rolled substitute.

### 1. Procedure level — `roleProcedure`

```ts
const hrAdmin = roleProcedure(['administrator', 'hr_user'], { module: 'hr.core' });
export const someRouter = router({ list: hrAdmin.input(...).query(...) });
```

- **`{ module }` is mandatory and matched exactly.** There is no wildcard: a
  grant in `platform` does not satisfy `hr.er`, and a grant in
  `hr.holiday_leave` does not satisfy `platform`. Pick the module the surface
  belongs to; `platform.*` routers are `{ module: 'platform' }` unless their plan
  says otherwise.
- The time window is checked **per call**, so an expiring grant stops working
  without a re-login. Never pre-filter grants by time when building a context.
- `administrator` has **no** hardcoded bypass — it holds a grant per module like
  any role.

**`adminProcedure` is for Better Auth framework operations only** (user bans,
impersonation, Better Auth role assignment — `users.*`). Guarding a product
surface with it is a **review-blocking violation**: it resurrects a second,
parallel authorisation system. This was decided as core plan 04 Q1.

### 2. Record level — `lib/scope.ts`

```ts
const scope = scopeFor(ctx.grants, 'platform', new Date());
query = query.where(scopePersons('p.id', ctx.actorPersonId, scope));
```

Scoping is a **SQL predicate inside the query**, never a `.filter()` over a
fetched page — with keyset pagination, post-filtering also corrupts the page
boundary. The ladder is `all | team | allocated | self`; `scopeFor` takes the
widest scope among the caller's active grants **in that module**.

For single-record reads, apply the same predicate and return **`NOT_FOUND`** when
it misses — `FORBIDDEN` would confirm the record exists.

`managedPersonIds` (the `team` scope) is currently **fail-closed** — it returns
the empty set until plan 05 lands `platform.team`. Do not "temporarily" widen it.

### 3. Field level — `lib/field-classification.ts`

```ts
export const fooClassification = defineFieldClassification('hr.foo', fooFields, {
  id: 'internal',
  pay_rate: 'sensitive',
  medical_note: 'special-category' /* every key */,
});
export const fooOutputFull = schemaUpTo(fooClassification, 'special-category');
export const fooOutputRestricted = schemaUpTo(fooClassification, 'internal');
```

- Every exposed column must be classified — an omission is a **compile error**.
- **Select only the columns of the variant you will return.** The restricted path
  must never read a sensitive value out of Postgres, so field security holds
  before serialisation, not just at it.
- **Special-category columns never live on a main record table** (ADR-0015/0019)
  — they go in a dedicated table, so a `select *` cannot leak them.
  `platform.person_flag` is the pilot.
- Returning special-category fields **must** call `journalSpecialCategoryRead`:
  one event per (request, entity, record), field **names** only, never values.

### The worked example

`routers/platform/identity.ts` `listPersons` / `getPerson` apply all three
together, and `routers/platform/authz.ts` administers the grants themselves
(guarding itself with its own machinery). Copy those.

### Mutations

Grant/revoke and every authorisation state change journals a `kind='security'`
event in the **same transaction** as the write. Revocation goes through the
shared `revokeGrant`/`revokeAllGrantsForPerson` write path in `@repo/db` — the
API and the worker's expiry sweep must not have two implementations (ADR-0022).
