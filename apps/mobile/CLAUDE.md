# @repo/mobile — React Native (Expo) app

Expo SDK 57 (React Native 0.86, React 19.2) app using **expo-router** (file-based
routing) and **NativeWind v4** for styling. Part of the Turborepo/pnpm monorepo.

**Delivery decisions & plans:** ADR-0023 (native Expo/RN app), ADR-0024 (Expo
Push). Scope and ownership map: `docs/plan/phase-01/mobile/00-feature-suggestions.md`;
the app-wide rails (shell, auth, shared components, push client) are planned in
`docs/plan/phase-01/mobile/01-mobile-app-foundations.md` — its conventions land
in this file as they are built. Feature screens are owned by the core/HR plans'
"Mobile surface" backlog items, not built ad hoc.

## Run it

```
pnpm --filter @repo/mobile dev      # expo start (dev server + QR)
pnpm --filter @repo/mobile ios      # open iOS simulator
pnpm --filter @repo/mobile android  # open Android emulator
pnpm --filter @repo/mobile web      # run in the browser (react-native-web)
```

The app talks to the `@repo/api` server at `EXPO_PUBLIC_API_URL` (see `.env`).
Start the API first (`pnpm --filter @repo/api dev`). On a physical device, set
`EXPO_PUBLIC_API_URL` to your machine's LAN IP; the Android emulator uses
`http://10.0.2.2:3001`.

## Conventions & deviations

- **No `"type": "module"`.** Unlike the rest of the monorepo, this app is not ESM
  at the `package.json` level: Metro and Babel config (`metro.config.js`,
  `babel.config.js`, `tailwind.config.js`) are CommonJS. App source is still
  TypeScript with normal ES `import`/`export`; Metro/Babel transpile it.
- **Path alias:** `@/*` → `./src/*` (expo-router convention; not the web app's
  `~/*`). Also `@/assets/*` → `./assets/*`, which asset `require()`s use.
  **Parent traversal (`../*`) is an ESLint error** in `src/**`: import app source
  through the alias (`@/components/themed-text`), never `../../components/…`.
  expo-router derives routes from file position under `src/app/`, so moving a
  screen silently changes the correct depth of every `../` in it — the alias is
  invariant under that move. Sibling imports (`./Foo`) are unaffected by depth
  and stay relative. The web app has the same rule against its own `~/` alias.
- **Metro monorepo config** (`metro.config.js`) watches the repo root and resolves
  workspace packages' TS source via package `exports`.

## Shared stack (wired in)

- **Data:** TanStack Query + tRPC. `src/lib/trpc.ts` builds the client typed
  against `@repo/trpc`'s `AppRouter`; `src/lib/query-client.ts` + the `Providers`
  component (`src/components/providers.tsx`) supply the context. Use the
  `trpcReact` hooks in components — same rule as the web app (all server state
  goes through TanStack Query).
  - **`@repo/trpc` is imported type-only.** Never import runtime values from the
    barrel on the client — it re-exports the server router and would drag server
    code (Kysely/DB) into the bundle. Import specific schema modules if you need a
    shared Zod schema at runtime.
- **Auth:** Better Auth via `src/lib/auth-client.ts` (`@better-auth/expo` +
  admin/email-OTP plugins, mirroring web). The session cookie is stored in
  SecureStore and attached to tRPC requests via the `Cookie` header (RN fetch does
  not persist cookies).
- **Forms:** TanStack Form (`@tanstack/react-form`), validated with shared Zod
  schemas — same pattern as web.
- **Env:** `src/env.ts` is the single sanctioned `process.env` touch-point. Vars
  must be `EXPO_PUBLIC_`-prefixed (Expo inlines them at build) and validated with a
  local Zod schema via `@repo/env`.

TanStack Table is intentionally **not** included — data tables are a web UI
pattern; add it only if a genuinely tabular screen appears.

## Styling — NativeWind v4

Use Tailwind classes via `className`. NativeWind uses Tailwind CSS **v3.4**
(independent of the web app's Tailwind v4). Global stylesheet: `src/global.css`
(imported once in `src/app/_layout.tsx`); config: `tailwind.config.js`. Plain
`StyleSheet` also works and coexists (the template screens use it).

**Design system (mandatory):** every screen follows the **CD Fencing Design
System** (root `CLAUDE.md`; Claude Design project read via DesignSync). The
native visual spec is the `components/mobile/` group (PhoneFrame conventions,
AppTabBar, NativeHeader, BottomCTA, SheetModal, capture flow, home
launcher/sections) and the `ui_kits/hr-app-mobile` kit — reference designs
authored as prompts 27–33 of `docs/design/component-library-prompts.md`, whose
tokens, spacing, states and copy are translated to NativeWind here. Stock
NativeWind defaults are not the design, and the web kits' mobile-width cards
are responsive-web reference only. Never improvise styling the system already
defines; flag genuine gaps.

## Testing

`pnpm --filter @repo/mobile test` runs Vitest in a Node environment for logic
tests (`passWithNoTests` is on). React Native **component** testing is not wired
yet — it needs a dedicated RN test preset; add it when the first component test
lands.
