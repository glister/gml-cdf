import { createServiceBus } from '@repo/service-bus';
import { parse, z } from '@repo/env';

/**
 * Local trigger: send a test message to the `hello-world` queue.
 * Run via `pnpm --filter @repo/worker trigger`. Standalone CLI — console output.
 */
const env = parse(z.object({ SERVICE_BUS_CONNECTION_STRING: z.string().min(1) }));

const sb = createServiceBus({ connectionString: env.SERVICE_BUS_CONNECTION_STRING });
await sb.send('hello-world', { greeting: 'hello', at: new Date().toISOString() });
// eslint-disable-next-line no-console
console.log('✔ published test message to "hello-world"');
await sb.close();
