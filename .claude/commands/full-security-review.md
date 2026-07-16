---
description: Thorough whole-app security review of the cdf-platform, with prioritised findings and fixes
argument-hint: [optional scope, e.g. "apps/api" or "auth + file upload only"]
---

You are running `/full-security-review` — a **security review of the whole
cdf-platform application** (or the scope named here: **$1** — if empty, review
the entire app).

This is an adversarial audit, not a style pass. Assume a motivated attacker with
a normal user account and the ability to craft arbitrary HTTP requests. Your job
is to find where the app fails to defend itself and to report each hole with a
clear problem statement, an evidence trail, and a concrete fix. Do not report
style nits, and do not pad the list — a real High finding buried under twenty
speculative Lows is a worse review.

## How to work

1. **Map the attack surface first.** Read before you grep:
   - `packages/trpc/src/trpc.ts` (the procedure builders — `publicProcedure`,
     `protectedProcedure`, `adminProcedure`, `serviceProcedure` — this is the
     security boundary), `packages/trpc/src/router.ts`,
     `packages/trpc/src/routers/*`, `packages/trpc/src/schemas.ts`,
     `packages/trpc/src/lib/keyset.ts`.
   - `apps/api/src/index.ts` (Hono wiring, CORS, session middleware, service
     token, rate limiter) and `apps/api/src/lib/auth.ts` (Better Auth config).
   - `apps/web` (TanStack Start server functions, loaders, SSR, any
     `dangerouslySetInnerHTML`), `apps/worker` (Service Bus consumer).
   - `packages/{email,sms,cloud-storage,service-bus,logging,db,env}`.
   - `docker/*`, `compose.yml`, `.dockerignore`, `pnpm-lock.yaml`,
     `pnpm-workspace.yaml`, `.github/workflows/*`, and package versions in the
     relevant `package.json` files.
2. **Trace real request paths.** For each tRPC procedure and server function,
   follow input → validation → DB query → output, and ask: who can call this,
   what can they reference, what comes back.
3. **Verify against the running code, not assumptions.** A rule in `CLAUDE.md`
   ("all authz lives in procedures") is a claim to check, not a guarantee. Grep
   the codebase; open the file; confirm the predicate is actually there.
4. **Confirm version-gated CVEs by reading the lockfile / package.json**, not
   from memory — report the installed version vs the fixed version.

## What to check — vulnerability classes for THIS stack

Node 24 · tRPC v11 on Hono · TanStack Start/Router/React 19 · Vite 7 · Better
Auth (email/password + email OTP + admin, session cookies) · PostgreSQL via
Kysely · Azure Service Bus worker · Capacitor mobile wrapper · Azure Container
Apps. Work through every class below; each names the concrete mechanism, what to
grep/verify, and where in this repo it lives.

### Authentication & sessions (Better Auth)

- **Version-gated CVEs** — check `better-auth` version against: CVE-2025-61928
  (unauthenticated API-key creation for any user, fixed 1.3.26 — only if the
  api-keys plugin is enabled), CVE-2025-53535 / CVE-2025-27143 (open redirect
  via scheme-less `//host` `callbackURL`, fixed 1.2.10 / 1.1.21).
- **Cookie flags & CSRF posture** — `httpOnly`, `secure` (requires HTTPS
  `baseURL` in prod), `sameSite`; grep for `disableCSRFCheck` /
  `disableOriginCheck` (either present = finding). `trustedOrigins` must be an
  explicit allowlist (it is loaded from `BETTER_AUTH_TRUSTED_ORIGINS`).
- **Open redirect** — any `callbackURL` / `redirectTo` validated against
  `trustedOrigins` or a relative-path allowlist, never passed through.
- **OTP brute force / replay** — email OTP is a 6-digit/300s secret. Confirm
  `allowedAttempts` caps wrong tries, OTP is single-use (invalidated on first
  success), and rate limiting is effective in production (memory-backed limiters
  don't work across multiple instances — check for shared storage).
- **Enumeration** — login / OTP-request / password-reset must return uniform
  responses and similar timing regardless of whether the account exists;
  `requireEmailVerification` or `autoSignIn:false` set. Grep for any custom
  procedure returning "email already exists" / "no such user".
- **Session lifecycle** — revocation on password/role change; if `cookieCache`
  is on, a demoted admin keeps admin until cache expiry (authz-bypass window).

### CSRF on tRPC & server functions

- tRPC mutations are plain POSTs to `/trpc/*` with cookie auth. The Hono/Fetch
  adapter's JSON Content-Type requirement blocks form-based CSRF — **verify it
  is actually enforced** and no `contentTypeHandler`/method-override loosens it.
  Better Auth's origin check only guards `/api/auth/*`, **not** tRPC — confirm an
  `Origin`/`Referer` (or `Sec-Fetch-*`) allowlist guards `/trpc` too.
- **CORS** — `apps/api/src/index.ts` currently reflects the request origin with
  `credentials: true`. A credentialed reflect-any-origin CORS policy is a
  finding: it should be an allowlist tied to `trustedOrigins`.
- Every TanStack Start `createServerFn` must do its **own** session + authz
  check — route-level guards do not protect it. Grep `createServerFn` for a body
  auth check.

### Authorization — IDOR/BOLA, role checks, field-level

- **The core question the user asked: does every query and mutation enforce
  authorization?** For every procedure, verify: (a) the right builder is used
  (`protectedProcedure`/`adminProcedure`/`serviceProcedure`, not
  `publicProcedure` by accident); (b) `adminProcedure` guards **read/list**
  admin endpoints too, not only writes.
- **IDOR/BOLA** — any procedure taking an `id`/foreign key in input must scope
  the query by the caller's identity/tenant (from `ctx.user`/`ctx.session`),
  not just `where('id','=', input.id)`. Check **queries as hard as mutations** —
  read-side IDOR is easy to miss. Trust identity from `ctx.session`, never from
  `input.userId`/`input.id` (this is the CVE-2025-61928 bug pattern generalised).
- **Keyset pagination** (`lib/keyset.ts`) — the cursor encodes a sort boundary,
  not identity; confirm the owner/tenant `where` is always re-applied on the
  paged query so a cursor can never widen scope. Grep `decodeCursor` call sites.
- **Field-level / special-category data** — medical and pay data are UK-GDPR
  special category. Procedures returning them must restrict **columns** by role
  (explicit `.select([...])`, output Zod schema that omits sensitive fields for
  non-privileged callers), not just rows. Grep `selectAll()` / `select('*')` on
  sensitive tables.

### Injection

- **SQL** — Kysely parameterises `${}` but the raw escape hatches do not. Grep
  `sql.raw(`, `sql.lit(`, `sql.id(`, `sql.ref(`, `.dynamic`, `Kysely<any>`,
  `as any` on query builders, `@ts-expect-error` near query compilation. The
  highest-risk slot is **ORDER BY / sort params**: a `sortBy`/`sortDir` from
  input reaching a raw `orderBy` is injectable — confirm sort columns are mapped
  through an allowlist (compare to `packages/trpc/src/routers/users.ts`). Note
  Kysely CVE-2026-32763 (JSON-path key injection) is MySQL/SQLite only — Postgres
  is unaffected — but the raw APIs still carry the escaping burden.
- **Command** — grep `exec(`, `execSync(`, `{ shell: true }` with template
  strings/user input; prefer `execFile`/`spawn` with an args array.
- **Log injection** — grep `logger.*(` calls interpolating raw user input into a
  message string (CRLF forging); prefer structured metadata objects.
- **Email header / template injection** — in `@repo/email`, recipient/subject/
  reply-to from user input must be CRLF-validated; templates take user input as
  data, never as template content (SSTI → RCE).
- **Prototype pollution** — Zod `.strict()` on object inputs; grep for deep-merge
  / `lodash.merge` over request data.

### Data exposure

- **Soft-delete leakage** — every read on a `deleted_at` table (incl. joins,
  uniqueness checks) filters `deleted_at IS NULL`. Grep `selectFrom(` and check.
- **SSR/hydration over-fetch** — TanStack Start serialises loader/query data into
  the HTML. Inspect an authenticated page's hydration payload for password
  hashes, tokens, other-user fields, internal IDs. Output schemas must be
  allowlists applied as `.output()`.
- **SSR cache poisoning** — grep authenticated loaders/responses for
  `Cache-Control: public`/`s-maxage` (must be `private, no-store`).
- **Server/client import bleed** — server-only modules (`@repo/db`, secrets,
  service tokens) must not be reachable from client components (TanStack Import
  Protection); grep client code for such imports.
- **Client bundle secret leak** — anything secret prefixed `VITE_`, or read via
  `import.meta.env` in client code, ships to the browser. This repo's rule is
  `@repo/env` server-side + `VITE_` only for non-secret client vars — verify it
  holds. Confirm prod builds ship no source maps.

### SSRF (Azure managed-identity token theft — Critical)

- Any server-side fetch of a client-supplied URL/host (file proxy to
  SharePoint/blob, webhooks, link preview, avatar-by-URL) can be pointed at
  `http://169.254.169.254/metadata/identity/...` to steal a subscription-wide
  managed-identity token. Grep `fetch(`, `undici`, `axios`, `got` for a
  request target built from request data; require an https-only host allowlist,
  DNS resolution with link-local/private-range blocking
  (`169.254/16`, `127/8`, `10/8`, `172.16/12`, `192.168/16`, `::1`, `fd00::/8`),
  and no following redirects into those ranges.

### File proxy (SharePoint / blob via `@repo/cloud-storage`)

- **Path traversal** — reject `..`/absolute/encoded paths in blob keys and
  filenames; canonicalize before use.
- **Signed-URL leakage** — SAS/pre-signed URLs must be short-TTL, least-privilege
  (single read-only blob), never logged (grep Winston calls for URL/token
  interpolation), never embedded in SSR payloads.
- **Content sniffing** — user content served with `Content-Type` from a trusted
  source, `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment`;
  ideally a separate origin. Enforce upload size/type limits **server-side**.

### Service Bus worker (`apps/worker`)

- **Poison messages** — handler errors route to the **dead-letter queue** after a
  max delivery count (transient vs permanent distinguished); grep
  `completeMessage`/`abandonMessage`/`deadLetterMessage`.
- **Replay / idempotency** — Service Bus is at-least-once; side-effecting handlers
  must dedupe on `MessageId`/a business key (idempotent, e.g.
  `INSERT ... ON CONFLICT DO NOTHING`) so redelivery is safe.
- **Message validation** — bodies Zod-validated before use; reject oversized /
  unknown-shape messages.
- **Auth** — prefer Entra managed identity over a long-lived SAS connection
  string; if a connection string is used it must be least-privilege
  (receive-only) and in `.env.secrets`, never `compose.yml` or code.

### Event journal / outbox (ADR-0010, ADR-0019)

- Payloads carry identifiers + changed fields, **not** full entity snapshots; no
  special-category (medical/pay) facts in payloads (this is an ADR-0019 rule —
  a violation is both a security and a compliance finding). Dead-lettered
  messages must not expose PII in the DLQ reason.

### Rate limiting & DoS (Hono layer)

- The in-memory fixed-window limiter in `apps/api/src/index.ts` is per-instance
  and only used where a procedure calls `ctx.rateLimit.check` — verify auth, OTP,
  and file endpoints actually invoke it, and that it works across multiple ACA
  replicas (it does not, as written — flag if relied on for security).
- Confirm a `bodyLimit` is set for uploads/POSTs. ReDoS: grep for
  `RegExp(`/complex regexes over user input.

### Version-gated framework CVEs (confirm installed versions)

- `hono` ≥ 4.9.7 (CVE-2025-58362 path confusion / ACL bypass; CVE-2025-59139
  bodyLimit bypass; CVE-2024-48913 CSRF-middleware bypass on missing
  Content-Type; CVE-2025-62610 JWT `aud` if JWT middleware used).
- `vite` past the KEV-listed CVE-2025-31125 and the `server.fs.deny` bypass
  family (CVE-2025-30208/32395/46565/62522) — latest 7.x. Also confirm the dev
  server is **not** bound to `0.0.0.0`/published externally in `compose.yml`.
- `@trpc/server` ≥ 11.1.1 (CVE-2025-43855 unauthenticated WS crash) **if** the
  WebSocket transport is used.
- Node pinned to a patched 24.x (Jan 2026 release line); base image in `docker/`
  current.

### Supply chain

- `pnpm-lock.yaml` committed; CI installs `--frozen-lockfile`; pnpm ≥ 11.4.0
  (lockfile-integrity hard failure) and ≥ 11.1.3 (`minimumReleaseAge` bypass
  fix). Check for `minimumReleaseAge` / `onlyBuiltDependencies` /
  `ignore-scripts` hardening in `pnpm-workspace.yaml`. Internal packages use the
  `@repo/` scope + `workspace:*` (no dependency-confusion exposure). GitHub
  Actions SHA-pinned (repo already enforces via `pnpm lint:pins` — confirm no
  tag refs slipped in). Audit the lockfile against the 2025–2026 npm incidents
  (chalk/debug, Shai-Hulud worm, `@tanstack/*` compromise CVE-2026-45321).

### Mobile wrapper (Capacitor, if present)

- `capacitor.config.*`: `allowNavigation` a tight allowlist (external links open
  in the system browser), `server.url` not a dev/remote origin in prod. Auth
  tokens in native secure storage (Keychain/Keystore), not `localStorage`.
  Verified App/Universal Links for auth callbacks; no secrets in the bundle;
  SSL pinning for sensitive flows.

### Docker & security headers

- No secrets in `ENV`/`ARG` (persist in image layers) — grep Dockerfiles for
  `ARG.*KEY|TOKEN|SECRET|PASSWORD`; `.dockerignore` excludes `.env.secrets`/
  `.env`/`.git`; production image runs as a non-root `USER`; multi-stage so build
  tooling/source aren't shipped; `compose.yml` holds no secrets.
- SSR response sets a strong CSP (per-request **nonce**, no `unsafe-inline`/
  `unsafe-eval`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors
'none'`), HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `Permissions-Policy`. Confirm Azure ingress doesn't strip them or add a
  permissive `Access-Control-Allow-Origin: *` on credentialed endpoints.

## Output — a prioritised findings report

Produce a single markdown report. Do not modify any code. Structure:

1. **Summary** — one paragraph: overall posture, count by severity, the single
   most urgent item.
2. **Findings**, ordered by severity (**Critical → High → Medium → Low**), then
   by exploitability. Each finding is a section:
   - **Title** — one line naming the issue and location.
   - **Severity** — Critical / High / Medium / Low, with a one-line rationale
     (impact × exploitability; note if it needs authentication or a specific
     role).
   - **Location** — `file:line` (clickable), and the exact code/config.
   - **Problem** — the concrete attack: what an attacker sends, what they get.
     Not "this could be insecure" — the actual exploitation path.
   - **Evidence** — what you checked that confirms it (the missing predicate,
     the reflected origin, the installed version vs the fixed version).
   - **Fix** — a specific, actionable remedy: the code change, config value, or
     version bump. Show the corrected snippet where it helps. If there's a
     canonical safe pattern in the repo (e.g. `routers/users.ts` for keyset),
     point to it.
   - **Confidence** — Confirmed (you saw the vulnerable code path) vs Needs
     verification (plausible but you couldn't fully trace it, e.g. runtime-only
     behaviour) — and what to run to confirm the latter.
3. **Version/CVE table** — package · installed · fixed-in · advisory, for every
   version-gated item you checked (including the ones that were already patched —
   record the negative result so the review is auditable).
4. **What was reviewed** — the surfaces/files you covered and anything you
   deliberately or unavoidably did **not** review (so no gap reads as "clean").

Prioritise ruthlessly. If nothing meets a severity band, say so rather than
inventing findings. A finding you cannot tie to a concrete file and attack path
belongs in a final "areas to investigate further" note, not in the ranked list.
