import { render } from '@react-email/render';
import { NotificationEmail } from './layout.js';

/**
 * `renderNotificationEmail(kind, …)` — the §5.4 seam, and the one decision worth
 * explaining is what it does **not** do.
 *
 * It does not re-render content. Title and body were produced once, by the
 * notification kind's registered renderer in `@repo/trpc`, from parameters that
 * passed that kind's strict Zod schema. This function frames them: subject line,
 * shared layout, one link. Re-rendering here would mean a second place capable
 * of interpolating data into a message, and the second place is where SA-023
 * gets lost — an email that says more than the in-app entry is precisely the
 * failure §4.6 exists to prevent.
 *
 * That also means **a new notification kind needs no work here.** Its email is
 * correct the day it is registered. A kind that later wants a bespoke layout
 * adds a branch behind this same signature, which is why the seam is a function
 * of `kind` rather than a lookup the caller has to satisfy first.
 *
 * Plan 11's document templates (offer letters and the like) are a separate
 * capability and are deliberately not reused here — different lifecycle,
 * different authorship, different storage (§5.4).
 */

export interface NotificationEmailInput {
  /** The registered notification kind, e.g. `reminder.chase`. */
  kind: string;
  /** Already rendered and SA-023-clean — used verbatim. */
  title: string;
  body: string;
  /** Absolute URL, or `null` when there is nothing to open. */
  actionUrl?: string | null;
}

export interface RenderedNotificationEmail {
  subject: string;
  html: string;
  text: string;
}

/** The button label for a kind, where a more specific verb helps. */
function actionLabelFor(kind: string): string {
  if (kind.startsWith('reminder.')) return 'Open the outstanding item';
  if (kind.startsWith('task.')) return 'Open the task';
  if (kind.startsWith('approval')) return 'Review the request';
  return 'Open in CD Fencing';
}

export async function renderNotificationEmail(
  input: NotificationEmailInput,
): Promise<RenderedNotificationEmail> {
  const element = NotificationEmail({
    title: input.title,
    body: input.body,
    actionUrl: input.actionUrl ?? null,
    actionLabel: actionLabelFor(input.kind),
  });

  const [html, text] = await Promise.all([
    render(element),
    // A plain-text alternative is not decoration: a mail client that renders
    // only text would otherwise show an empty message, and some corporate
    // gateways score HTML-only mail as spam.
    render(element, { plainText: true }),
  ]);

  return { subject: input.title, html, text };
}

export { NotificationEmail, type NotificationEmailProps } from './layout.js';
