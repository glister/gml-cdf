# @repo/logging

Winston + OpenTelemetry. **Built** package (tsup → dist) with a `development`
export condition (raw TS in dev, `dist` in prod).

## Exports

- `.` → `createLogger`, `initObservability`, `Logger` type.
- `./init` → `initObservability` (OTel bootstrap; imported via
  `--import ./instrument.ts` at process start).

## Usage

- `createLogger({ service, level })` — the ONLY logger factory. JSON in prod,
  pretty/colorized in dev. **Never `console.log`.**
- `initObservability({ serviceName })` — starts the OTel NodeSDK. The exporter is
  conditional: HyperDX if `HYPERDX_API_KEY`, else `OTEL_EXPORTER_OTLP_ENDPOINT`,
  else no exporter (no-op locally). The wiring always exists so prod just needs
  the env var.

Env is read via `@repo/env` `parse()` with a local schema — never `process.env`.
