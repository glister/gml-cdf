import { createServerFn } from '@tanstack/react-start';
import { getRequestHeaders } from '@tanstack/react-start/server';
import { authClient } from '../auth-client.js';

export interface SessionData {
  userId: string;
  email: string;
  role: 'admin' | 'agent';
}

/**
 * Resolve the current session on the server (from the request cookies) via a
 * TanStack server function. Used in `__root`'s `beforeLoad` so every route has
 * `session` in its router context.
 */
export const resolveSession = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SessionData | null> => {
    const headers = getRequestHeaders();
    const result = await authClient.getSession({
      fetchOptions: { headers: headers as unknown as HeadersInit },
    });
    const session = result.data;
    if (!session) return null;
    const role = (session.user as { role?: string | null }).role === 'admin' ? 'admin' : 'agent';
    return { userId: session.user.id, email: session.user.email, role };
  },
);
