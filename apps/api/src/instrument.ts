import { initObservability } from '@repo/logging/init';

// Imported via `--import ./src/instrument.ts` before any app code so OTel
// instrumentation is registered first.
initObservability({ serviceName: 'api' });
