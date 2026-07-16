import { parse, z } from '@repo/env';

// Client env: read from Vite's import.meta.env (not process.env). Client vars
// must be VITE_-prefixed.
const schema = z.object({
  VITE_API_URL: z.string().min(1),
});

export const clientEnv = parse(schema, import.meta.env);
