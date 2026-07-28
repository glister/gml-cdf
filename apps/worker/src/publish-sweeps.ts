import { createServiceBus } from '@repo/service-bus';
import { parse, z } from '@repo/env';
import { ACCESS_EXPIRY_SWEEP_SUBJECT } from './handlers/identity-access-expiry.js';
import { DUPLICATE_SCAN_SUBJECT } from './handlers/identity-duplicate-scan.js';

/**
 * Enqueue the daily identity sweep commands onto the `effects` queue (core plan
 * 03 §5.2). Built as its own entrypoint (`dist/publish-sweeps.js`) and invoked by
 * the ACA cron Job (Terraform) on a schedule; runnable locally via
 * `pnpm --filter @repo/worker sweeps`. The worker's effects handler dispatches
 * each by `subject`. Standalone CLI — console output. When plan 07's
 * scheduled_action mechanism lands, this enqueue side migrates onto it.
 */
const env = parse(z.object({ SERVICE_BUS_CONNECTION_STRING: z.string().min(1) }));

const sb = createServiceBus({ connectionString: env.SERVICE_BUS_CONNECTION_STRING });
const at = new Date().toISOString();
for (const subject of [ACCESS_EXPIRY_SWEEP_SUBJECT, DUPLICATE_SCAN_SUBJECT]) {
  await sb.send('effects', { at }, { subject });
  // eslint-disable-next-line no-console
  console.log(`✔ enqueued "${subject}" on "effects"`);
}
await sb.close();
