import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '@repo/db';
import { defineNotificationKind } from './notify-kinds.js';
import { registerReminderKind, type ReminderKindDef } from './notify-reminders.js';
import { registerSubjectContext } from './notify-resolve.js';
import { DOCUMENT_REMINDER_KIND, DOCUMENT_STREAM_TYPE } from './documents.js';

/**
 * How the document engine tells people things (core plan 11 §9.5, PL-010/011;
 * ON-024 and ON AC-6 drivers).
 *
 * Three notification kinds, one reminder kind, and one subject context — all
 * registered through core plan 10's registries rather than composed at a call
 * site (its 2026-08-07 reconciliation row). Nothing here sends anything: it
 * declares what *can* be said, and the strict schemas are what make the saying
 * safe.
 *
 * ## Every parameter here is deliberately incapable of carrying detail
 *
 * A document notification names **the document's title, category and mode** and
 * links to it. It cannot carry the body, the merge data, a response, or the
 * subject's name — because `defineNotificationKind` builds `z.strictObject` from
 * the parameter shape, so there is no field to put them in (SA-023, §4.6).
 *
 * That matters more here than almost anywhere else in the platform. When the HR
 * plans start issuing fit notes and occupational-health letters through this same
 * engine, the notification that goes out will say *"a document is waiting for
 * you"* — not because someone remembered to be careful, but because the kind
 * that renders it has no parameter capable of saying anything else. A title is
 * the one borderline field, and it is bounded and chosen by the template author,
 * who is an Administrator.
 */

// --- The subject context (§5.1) ---------------------------------------------

/**
 * "Who are the people around this document?" — so a notification can address
 * `subject_person` without the caller resolving anyone (PL-021).
 *
 * The subject is the person the document is about. There is deliberately no
 * `requester`: the *issuer* is a person, but a notification addressed to
 * "whoever issued this" would name an individual frozen at issue time, which is
 * exactly the coupling plan 10's recipient model exists to avoid. The issuer is
 * reached through their **role** instead.
 */
registerSubjectContext(DOCUMENT_STREAM_TYPE, async (db, { streamId }) => {
  const doc = await db
    .selectFrom('platform.document')
    .select(['subject_person_id'])
    .where('id', '=', streamId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return { subjectPersonId: doc?.subject_person_id ?? null, requesterPersonId: null };
});

// --- Notification kinds (§9.5) ----------------------------------------------

/**
 * `document.issued` — the subject has something to do.
 *
 * `requiredAction` is the plain-English ask, not the raw mode: "Read this
 * document and sign it" tells someone what is wanted; `read_and_sign` tells them
 * what column it is stored in.
 */
export const documentIssuedKind = defineNotificationKind({
  kind: 'document.issued',
  params: {
    /** The document's title. Bounded, and authored by an Administrator. */
    title: z.string().max(200),
    /** The category **code** — never a label that might be enriched later. */
    category: z.string().max(64),
    /** What the subject is being asked to do, in plain English. */
    requiredAction: z.string().max(120),
    actionUrl: z.string().max(300),
  },
  defaultChannels: ['in_app', 'email'],
  description:
    'A document has been issued to you and needs your attention. Names the document and what is being asked; carries no content from it.',
  registeredBy: '11',
  render: ({ title, requiredAction, actionUrl }) => ({
    title: 'A document needs your attention',
    body: `“${title}” has been issued to you. ${requiredAction}`,
    actionUrl,
  }),
});

/**
 * `document.completed` — the issuer's side of the loop (ON-024 driver).
 *
 * Addressed to a **role**, not to the person who issued it. Someone who has left
 * HR should not still be getting told that documents they issued last year have
 * been signed, and the role is what makes that true without anybody
 * reconfiguring anything (PL-021).
 */
export const documentCompletedKind = defineNotificationKind({
  kind: 'document.completed',
  params: {
    title: z.string().max(200),
    category: z.string().max(64),
    /** How it was completed — 'signed', 'confirmed receipt', 'answered'. */
    outcome: z.string().max(60),
    actionUrl: z.string().max(300),
  },
  defaultChannels: ['in_app'],
  description:
    'A document issued to somebody has been completed. Names the document and the outcome; never who signed it — the record does that, behind its own access controls.',
  registeredBy: '11',
  render: ({ title, outcome, actionUrl }) => ({
    title: 'A document has been completed',
    // Deliberately no name. Whoever needs to know *which person* opens the
    // document, where the record's own RBAC applies (§8).
    body: `“${title}” has been ${outcome}.`,
    actionUrl,
  }),
});

/**
 * `document.filing_failed` — the administrator alert (§4.6).
 *
 * The one kind that carries an error string, and it is the adapter's message
 * rather than anything about a person: "the SharePoint site is not configured"
 * or a Graph status. Bounded, and it goes to Administrators.
 */
export const documentFilingFailedKind = defineNotificationKind({
  kind: 'document.filing_failed',
  params: {
    title: z.string().max(200),
    attempts: z.number().int().min(1),
    /** The adapter's own diagnostic. Never document content. */
    reason: z.string().max(300),
    actionUrl: z.string().max(300),
  },
  defaultChannels: ['in_app', 'email'],
  description:
    'A document could not be filed to SharePoint after the configured number of attempts. Carries the adapter’s diagnostic so an administrator can act without opening the document.',
  registeredBy: '11',
  render: ({ title, attempts, reason, actionUrl }) => ({
    title: 'A document could not be filed',
    body: `“${title}” failed to file to SharePoint after ${attempts} attempts. ${reason} It can be retried from the document’s record.`,
    actionUrl,
  }),
});

// --- The reminder kind (ON AC-6 driver) --------------------------------------

/**
 * `document.outstanding` — chase an issued document nobody has completed.
 *
 * The satisfaction check reads `completed_at`, which is the **one** definition of
 * done this engine has: it is what `isOutstanding` uses in `@repo/domain`, what
 * the list's "outstanding only" filter uses in SQL, and what the sequence lock
 * counts. A chase that decided for itself by enumerating statuses would need
 * editing every time a ninth issue mode was added, and would be the thing that
 * got forgotten.
 *
 * A withdrawn document is satisfied, and so is one that no longer exists.
 * Chasing somebody about a document that has been withdrawn is the platform
 * arguing with a decision someone already made.
 */
export const documentOutstandingReminder: ReminderKindDef = {
  reminderKind: DOCUMENT_REMINDER_KIND,
  registeredBy: '11',
  async isSatisfied(db: Kysely<DB>, { sourceId }) {
    const doc = await db
      .selectFrom('platform.document')
      .select(['status', 'completed_at'])
      .where('id', '=', sourceId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!doc) return true;
    return doc.completed_at !== null || doc.status === 'cancelled' || doc.status === 'draft';
  },
  async describe(db: Kysely<DB>, { sourceId }) {
    const doc = await db
      .selectFrom('platform.document')
      .select(['id', 'title'])
      .where('id', '=', sourceId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!doc) return null;
    return {
      sourceLabel: 'document',
      // The title only — the same bounded, Administrator-authored string the
      // issue notification carries. A fit note chased through this path says
      // "a document is outstanding" and nothing more.
      label: doc.title,
      dueDate: null,
      actionUrl: `/documents/${doc.id}`,
    };
  },
};

registerReminderKind(documentOutstandingReminder);
