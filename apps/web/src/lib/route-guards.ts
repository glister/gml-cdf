import { redirect } from '@tanstack/react-router';
import type { SessionData } from './resolve-session.js';

/**
 * UX-only route guards — they improve the experience by redirecting, but real
 * enforcement lives in `@repo/trpc` procedures. Never rely on these for security.
 */
export function requireSession(session: SessionData | null): SessionData {
  if (!session) {
    throw redirect({ to: '/login' });
  }
  return session;
}

export function requireAdmin(session: SessionData | null): SessionData {
  const authed = requireSession(session);
  if (authed.role !== 'admin') {
    throw redirect({ to: '/dashboard' });
  }
  return authed;
}
