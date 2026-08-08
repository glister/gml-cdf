import { graphError, GraphPermanentError, type GraphClient } from './graph-client.js';

/**
 * Outlook calendar operations over Microsoft Graph (core plan 12 §5.2, PL-024).
 *
 * **Added here rather than in a new package**, exactly as this package's own
 * docblock anticipated when core plan 11 shipped the SharePoint half: Entra
 * provisioning, deprovisioning and calendar sync are all Graph, and splitting
 * them across packages would mean three credential selections and three retry
 * policies. Core plan 12 §12.1 assumed plan 11 had already delivered these; it
 * delivered the client and the retry policy they stand on, which is the half
 * that is genuinely shared.
 *
 * **Worker-only** (ADR-0017), like everything else here.
 *
 * ## Application permission, not delegated
 *
 * These write into *another* person's calendar, so they need the
 * `Calendars.ReadWrite` **application** permission and CDF IT's admin consent
 * (§12.2 Q1). Until that is granted the whole rail stays dark behind
 * `platform.calendar.outlook_sync_enabled = false`, and nothing here is reached.
 */

/** Graph's `dateTimeTimeZone`. */
export interface GraphDateTime {
  dateTime: string;
  timeZone: string;
}

/** The event body we push. Deliberately small — see {@link createCalendarEvent}. */
export interface CalendarEventBody {
  subject: string;
  isAllDay: boolean;
  start: GraphDateTime;
  /** **Exclusive** for an all-day event — Graph's contract. */
  end: GraphDateTime;
  showAs: string;
  categories: string[];
}

/** Whose calendar, addressed by Entra object id (stable) or UPN. */
export interface CalendarTarget {
  /** `account.account_id` for the `microsoft` provider — the directory object id. */
  userId: string;
}

function eventsPath(target: CalendarTarget): string {
  return `/users/${encodeURIComponent(target.userId)}/events`;
}

/**
 * Create an event in someone's calendar.
 *
 * `transactionId` is the whole idempotency story and it is not optional here.
 * Service Bus delivers at least once, and the window between Graph accepting a
 * POST and our own row recording the returned id is a real window a crash can
 * land in. Graph remembers a `transactionId` it has already seen (for several
 * days) and returns the **same** event rather than a second one — so a
 * redelivered create is a no-op even when we have no local record of the first.
 * The caller passes the sync-state row's own id, which exists before the call.
 *
 * Returns the Graph event id: the handle for every later amend and cancel.
 */
export async function createCalendarEvent(
  client: GraphClient,
  target: CalendarTarget,
  body: CalendarEventBody,
  transactionId: string,
): Promise<string> {
  const response = await client.request(eventsPath(target), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, transactionId }),
  });

  if (!response.ok) throw await graphError(response);

  const created = (await response.json()) as { id?: string };
  if (!created.id) {
    // A 2xx with no id means Graph changed its contract under us. Permanent:
    // retrying cannot produce an id that was not in the response.
    throw new GraphPermanentError(response.status, 'Graph created an event but returned no id');
  }
  return created.id;
}

/**
 * Patch an existing event.
 *
 * Only the fields in `body` are sent, so anything the person has changed in
 * their own calendar that we do not manage — a reminder, a note, an attendee —
 * survives. The rail owns the dates and the subject; it does not own their
 * calendar.
 */
export async function updateCalendarEvent(
  client: GraphClient,
  target: CalendarTarget,
  graphEventId: string,
  body: CalendarEventBody,
): Promise<void> {
  const response = await client.request(
    `${eventsPath(target)}/${encodeURIComponent(graphEventId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) throw await graphError(response);
}

/**
 * Delete an event.
 *
 * **A 404 is success**, and reports itself as such. The desired end state is
 * "this is not in the calendar"; somebody having deleted it by hand satisfies
 * that, and treating it as a failure would leave a permanently `failed` sync row
 * for an outcome that is already correct. The boolean says which happened, so
 * the journal event can record it rather than pretend the two are identical.
 */
export async function deleteCalendarEvent(
  client: GraphClient,
  target: CalendarTarget,
  graphEventId: string,
): Promise<{ alreadyGone: boolean }> {
  const response = await client.request(
    `${eventsPath(target)}/${encodeURIComponent(graphEventId)}`,
    { method: 'DELETE' },
  );

  if (response.status === 404) return { alreadyGone: true };
  if (!response.ok) throw await graphError(response);
  return { alreadyGone: false };
}
