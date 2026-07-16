import { parse, z } from '@repo/env';

// Server env. Parsed lazily so this module can be imported into isomorphic code
// (e.g. trpc.ts) without throwing in the browser — it only reads process.env
// when actually called on the server.
const schema = z.object({
  API_INTERNAL_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
});

let cached: z.infer<typeof schema> | undefined;

export function getServerEnv(): z.infer<typeof schema> {
  return (cached ??= parse(schema));
}

export function getServerApiUrl(): string {
  return getServerEnv().API_INTERNAL_URL;
}
