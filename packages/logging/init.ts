import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { parse, z } from '@repo/env';

/**
 * OpenTelemetry bootstrap. Imported via `--import ./instrument.ts` at process
 * start (before any app code) so instrumentation is registered early.
 *
 * The OTel wiring always exists; the *exporter* is conditional:
 *   - HYPERDX_API_KEY set  → export to HyperDX.
 *   - OTEL_EXPORTER_OTLP_ENDPOINT set → export there.
 *   - neither (local dev)  → no exporter, so this is a no-op.
 */
const otelEnvSchema = z.object({
  OTEL_SERVICE_NAME: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  HYPERDX_API_KEY: z.string().optional(),
});

let sdk: NodeSDK | undefined;

export function initObservability(opts: { serviceName?: string } = {}): void {
  if (sdk) return;

  const env = parse(otelEnvSchema);
  const serviceName = opts.serviceName ?? env.OTEL_SERVICE_NAME ?? 'cdf-connect-service';

  let traceExporter: OTLPTraceExporter | undefined;
  if (env.HYPERDX_API_KEY) {
    traceExporter = new OTLPTraceExporter({
      url: 'https://in-otel.hyperdx.io/v1/traces',
      headers: { authorization: env.HYPERDX_API_KEY },
    });
  } else if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    traceExporter = new OTLPTraceExporter({
      url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces`,
    });
  }

  sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    ...(traceExporter ? { traceExporter } : {}),
  });

  sdk.start();

  const shutdown = (): void => {
    void sdk?.shutdown().catch(() => {
      /* best-effort */
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
