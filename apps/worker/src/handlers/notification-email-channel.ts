import { createEmailClient, renderNotificationEmail } from '@repo/email';
import { parse, z } from '@repo/env';
import { registerChannelAdapter, type ChannelAdapter } from '@repo/trpc';
import { logger } from '../logger.js';

/**
 * The email channel adapter (core plan 10 §5.3).
 *
 * **Why it lives in the worker rather than in `@repo/trpc` beside the in-app
 * adapter.** That package is imported by `apps/web`, and a static import of
 * `@repo/email` from it would pull `nodemailer` and `resend` — a mail transport
 * and an HTTP client — into the browser bundle. Registration inverts the
 * dependency: `@repo/trpc` owns the `ChannelAdapter` contract and the registry,
 * this app owns the concrete service, and the dispatcher never learns which
 * process it is running in. The same rule the tRPC context already follows for
 * email, SMS and logging.
 *
 * The practical consequence is worth knowing: **the API process has no email
 * adapter**, and that is correct. Notifications are never sent inline from a
 * request — they are journalled, relayed and dispatched here (§5.2). A dispatch
 * attempted in a process without this registration records a delivery failure
 * naming the missing adapter rather than skipping the channel, so a
 * misassembled deployment looks like one.
 *
 * ## What it does not do
 *
 * It renders **nothing new**. The title and body were produced once, by the
 * notification kind's registered renderer, from parameters that passed that
 * kind's strict schema. This adapter frames them and posts them. An adapter that
 * interpolated anything else would be a second place capable of putting
 * something on one channel that SA-023 keeps off the others (§4.6).
 */

const env = parse(
  z.object({
    /** The web app's public base, for turning `action_url` into a real link. */
    APP_URL: z.string().optional(),
  }),
);

const email = createEmailClient({ logger });

/**
 * Turn a stored app-relative `action_url` into an absolute one.
 *
 * The row holds a path (`/tasks/9d3`) — the kind registry refuses anything else,
 * because an absolute URL in a row is an open-redirect target and because the
 * mobile app resolves the same path against a different base. The absolute form
 * is built here, at the last possible moment, by the process that knows which
 * deployment it belongs to.
 */
function absoluteUrl(actionUrl: string | null): string | null {
  if (!actionUrl) return null;
  if (!env.APP_URL) return null;
  return `${env.APP_URL.replace(/\/+$/, '')}${actionUrl}`;
}

export const emailChannelAdapter: ChannelAdapter = {
  channel: 'email',
  async send({ notification, recipient }) {
    if (!recipient.email) {
      // Recorded on the row rather than thrown: a person with no email address
      // is a data problem someone can fix, not a transient failure to retry.
      return { ok: false, error: 'the recipient has no email address on their person record' };
    }

    try {
      const rendered = await renderNotificationEmail({
        kind: notification.kind,
        title: notification.title,
        body: notification.body,
        actionUrl: absoluteUrl(notification.action_url),
      });
      const result = await email.send({
        to: recipient.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      // The provider's own message id, so "I never got it" is answerable from
      // the provider's dashboard rather than from a log line saying we tried.
      return { ok: true, providerRef: result.providerRef ?? null };
    } catch (error) {
      // Returned, never thrown: throwing would abandon the whole effect message
      // and re-attempt every delivery in it, including the ones that landed.
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};

registerChannelAdapter(emailChannelAdapter);
