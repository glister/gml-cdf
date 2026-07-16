---
description: Implement a phase-1 plan document end-to-end, keeping the plan as the source of truth
argument-hint: <plan-path> [scope, e.g. §9.1 or "next milestone"]
---

You are implementing a phase-1 plan document. The plan to work is: **$1**
Scope for this run (optional; if empty, work the whole remaining backlog): **$2**

The plan documents in `docs/plan/phase-01/` are not loose guidance — they are the
contract you build to, and the record you maintain. Working a plan means two
parallel obligations: land the code, and keep the plan document truthful about
what was landed. A run that writes code but leaves the plan stale has failed,
even if the code is good.

This command is resumable: always start from the first unchecked item in the
plan's §9 backlog (within the requested scope). Re-invoking after an
interruption continues where the last run stopped.

## 1. Orientation — read before any code

Read these in order. Do not skim; later steps depend on details in each.

1. **The plan itself, in full** — frontmatter (`depends_on`, `status`), §1
   scope and anti-scope, §2 requirements, §4 data model (the DDL you will
   implement), §5 interfaces, §9 backlog, §12 assumptions/open questions/risks.
2. **The plan set's `00-overview.md`** (same directory) — conventions shared by
   every plan, the build order, and for HR plans the "Obligations inherited
   from the core plan set" table and the reconciliation log.
3. **`docs/plan/phase-01/core/phase-1-implementation-notes.md`** — especially
   §6 (the canonical table inventory) and §7 (open decisions).
4. **ADRs** (`docs/adr/`): every ADR the plan cites, plus the always-binding
   set — ADR-0010 (event journal), ADR-0011 (table/row conventions), ADR-0012
   (history strategy), ADR-0019 (GDPR / PII-minimal payloads), ADR-0021 (event
   grammar & supersession), ADR-0022 (single write paths).
5. **The §5 interface sections of every plan in `depends_on`** — you consume
   those surfaces exactly as ratified; do not re-derive or rename them.
6. **If the run touches mobile** — the plan has a "Mobile surface" backlog
   group in scope, or the plan _is_ `mobile/01-mobile-app-foundations.md` —
   additionally read:
   - `docs/plan/phase-01/mobile/01-mobile-app-foundations.md` in full — the
     rails every mobile screen consumes (shell/navigation, both sign-in
     doors, binary client, shared native components, push client, home-screen
     tile registry) and the conventions that are review gates;
   - `docs/plan/phase-01/mobile/00-feature-suggestions.md` — the scope
     record and M-item ownership map (§2–3), the explicit mobile exclusions
     (§5), and the cross-cutting constraints (§6);
   - ADR-0023 (Expo/React Native delivery) and ADR-0024 (Expo Push);
   - `apps/mobile/CLAUDE.md`.
     Skip this step entirely for web-only scope — mobile items never block a
     plan's web work.
7. **If the run builds UI (web routes or mobile screens):** the design source
   of truth is the **CD Fencing Design System** Claude Design project (id
   `23b5e330-deb3-4365-8d26-171f9fcd95b1` — see root `CLAUDE.md`). Via the
   DesignSync tool, read its `SKILL.md` first, then the component groups
   matching the plan's surfaces (`components/<domain>/…` — `.d.ts` prop
   contracts + `.prompt.md` usage notes) and any matching screen kit
   (`ui_kits/hr-app-*`; desktop **and** mobile card variants). Screens are
   built to match the system; a component it lacks is flagged in the run
   report, never silently improvised.
8. **Root `CLAUDE.md`** and the `CLAUDE.md` of every package you will touch.

## 2. Preflight gate — verify before starting

- Every `depends_on` plan's frontmatter `status` is far enough along for what
  this plan consumes, and the tables/procedures it relies on actually exist —
  check the dev database with `psql`, not just the docs. A missing dependency
  is a **stop**: report it, do not build around it or stub it.
- **"Mobile surface" items have an extra gate that is deliberately not in
  `depends_on`:** they require `mobile/01-mobile-app-foundations.md` to be far
  enough along for the rails they consume (verify in `apps/mobile`, not just
  the doc). If it isn't, the mobile items are blocked — report that and
  proceed with the plan's web scope; never scaffold app-wide rails (auth,
  navigation, upload client, shared components) inside a feature plan's run.
- The working tree is clean and you are on `main` (or an agreed base).
- Create a branch: `plan/<set>-<nn>-<slug>`, e.g. `plan/core-03-identity` or
  `plan/hr-04-entitlement`. All work happens on this branch.

## 3. The plan is the source of truth — write-back rules

- **§4 DDL is the spec.** Implement it as written. When building reveals a
  necessary deviation (column type, constraint, index, rename), make the change
  **in the plan document in the same commit as the code**, with a dated Change
  log entry saying what changed and why. The plan and the migrations must never
  disagree at any commit.
- **A table not in the plan is a stop-and-ask.** If approved, add it to the
  plan's §4 **and** to the canonical inventory in
  `phase-1-implementation-notes.md` §6, following the attribution pattern
  already used there (`table_name — reason, plan NN`).
- **Cross-plan contract changes ripple.** If you must change an interface,
  event name, or table another plan consumes, update the consuming plan's
  reference too and add a line to the set overview's reconciliation log. Never
  leave two plans describing different versions of the same seam.
- **ADR conflicts are a stop.** If the plan or the code you must write
  contradicts an ADR, stop and flag it — revising an ADR is the user's call,
  never a silent divergence.
- **Open questions (§12.2) are never silently resolved.** If one blocks the
  current task, stop and ask; when the user decides, record the resolution in
  the question's row. Non-blocking questions stay open.

## 4. Progress tracking in the plan document

- **Tick checkboxes the moment an item is done — and only with evidence**
  (a passing test, a demonstrated AC, committed code). Never tick
  speculatively or in batch at the end. This applies to §2 traceability rows
  (fill "Implemented by" with the commit/PR ref), §9 backlog items, §7
  principle boxes, and §10 test items.
- **§11 acceptance criteria** are ticked only when demonstrated against a
  running build — not when the code "should" satisfy them.
- Maintain frontmatter as you go: `status`
  (`not-started → in-build → in-test → done`) and `last_updated`.
- §13 (definition of done) is the exit checklist — walk it explicitly before
  declaring the plan complete.

## 5. Build conventions

**Database & migrations**

- ADR-0011 throughout: UUIDv7 app-side PKs, `timestamptz`, actor columns,
  `created_at`/`updated_at`/`deleted_at` soft delete; history mechanism per
  table class per ADR-0012.
- String-literal-union columns (CHECK-constrained or Zod-enum-matched) get an
  entry in `packages/db/.kysely-codegenrc.json` (literals inlined, never
  imported from `@repo/trpc`), then regenerate with
  `pnpm --filter @repo/db migrate:generate`.
- `platform.lookup` list-type CHECK alterations must re-state the **full
  accumulated set as it stands in the applied migrations** — never the set as
  your own plan first wrote it. Check the latest migration before writing yours.

**Events & write paths**

- Journal events are emitted in the same transaction via core plan 02's
  helper; names follow the `<schema>.<entity>.<verb>` grammar and
  amendment-as-supersession rules (ADR-0021); payloads are PII-minimal
  (ADR-0019 / core 16 R1) — special-category facts never appear in payloads.
- History and ledger tables are mutated only through their single write path
  (ADR-0022). Ledger invariant: balance = SUM of entries; never store a
  mutable total.

**Platform capabilities are consumed, never re-implemented**

- Bespoke task tables, a second approval path, ad-hoc notification sends,
  client-side filtering — all defective by definition. Express the need
  through the generic engine (task/checklist, approvals, notifications,
  calendar fragments, config store, reference-data tiers).
- Work-readiness is **consumed** from core plan 17's derived status — no plan
  stores a readiness value or infers it from document completion.

**Web**

- Screens match the CD Fencing Design System (orientation step 7) — its
  tokens, component contracts and screen kits are the visual spec; stock
  shadcn/Tailwind defaults are not.
- TanStack Query for all server state, TanStack Table (manual mode,
  server-side filter/sort/keyset pagination in SQL) for all lists, TanStack
  Form + shared Zod schemas for all forms. Never edit `routeTree.gen.ts`.
- Keyset/sort/filter correctness is validated against real Postgres (page the
  whole set; assert global order, no duplicates, no gaps) — mock-DB tests
  don't count for this.

**Mobile (`apps/mobile` — only when mobile items are in scope)**

- Screens match the CD Fencing Design System (orientation step 7) — the
  `ui_kits/hr-app-*` mobile card variants and `components/navigation`
  mobile pieces (`MobileTabBar`, `appshell-mobile`) are the visual spec.
- Consume `mobile/01`'s rails; never rebuild them per-feature. Bespoke
  navigation, a second auth flow, a hand-rolled upload path, or a local
  variant of view-and-sign / signature pad / camera capture in a feature
  screen is defective by definition — if a needed rail doesn't exist, that's
  a stop-and-ask (foundations-plan gap), not a local workaround.
- Same server-state rules as web: TanStack Query + `trpcReact` hooks, keyset
  pagination with **server-side** facets (never filter/sort a fetched page),
  TanStack Form + shared Zod schemas. Render server state machines honestly
  (upload ≠ satisfied, supersession, first-decision-wins) — no local
  done/undone approximations, no business logic re-implemented client-side.
- `@repo/trpc` is imported **type-only** on the client (specific schema
  modules for runtime Zod); env via `src/env.ts` with `EXPO_PUBLIC_`-prefixed
  vars only.
- No document bytes cached to device storage beyond the viewer session; no
  admin/HR surfaces; push payloads and screens respect the PII-minimal rules
  exactly as the server enforces them.

**Environment**

- A new env var lands in the same change as: `turbo.json` `globalEnv`, a
  test-safe default in root `.env.test`, and (non-secret dev values) `.env` /
  `compose.yml`. Secrets never go in `.env` or compose — name the required
  variable in your final report so the user can add it to `.env.secrets`.

## 6. Commits & hooks

- **One commit per completed §9 milestone** (9.1 foundations, 9.2 domain
  logic, …). Message format: `plan(<set>-<nn>): <milestone> — <summary>`.
- Plan-document updates (ticked boxes, change log, inventory) ride **in the
  same commit** as the code they describe.
- Pre-commit runs lint-staged, typecheck, and the test suite. Failures are
  fixed at the root cause — including pre-existing failures your change
  surfaces. **Never** `--no-verify`, never skip hooks, never weaken or delete
  a test to make it pass.

## 7. Completion

When the backlog (or the requested scope) is done:

1. Run the full gate: `pnpm build`, `pnpm typecheck`, `pnpm test`,
   `pnpm lint`.
2. Walk §13; tick what genuinely holds, leave the rest unchecked with a note.
3. Push the branch and open a PR with `gh`. The PR body lists: requirements
   satisfied (by ref), plan deviations written back (with change-log dates),
   migrations added, new secrets the user must provide, and open questions
   raised or resolved during the run.
4. Report the same summary to the user, plus anything left unchecked and why.

## 8. Stop-and-ask triggers (any of these halts work for user input)

- A `depends_on` capability is missing or unbuilt.
- A "Mobile surface" item needs a rail `mobile/01-mobile-app-foundations.md`
  doesn't provide (or mobile/01 itself is not built far enough) — the fix
  belongs in the foundations plan, not inline.
- A table is needed that is in neither the plan nor the §6 inventory.
- The plan conflicts with an ADR, or two plans disagree about a shared seam.
- A §12.2 open question blocks the current task.
- The work drifts beyond §1's scope, or into §1's anti-scope.
- Anything requires a real secret (`.env.secrets` value) you don't have.
- A pre-commit/test failure whose correct fix would change behaviour outside
  this plan's ownership.
