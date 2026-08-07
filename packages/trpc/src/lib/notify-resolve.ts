import { sql, type Kysely } from 'kysely';
import type { DB, NotificationRecord } from '@repo/db';
import { parseConfigRef, qualifiedName } from '@repo/config';
import { resolveApprovalPolicy } from './approvals.js';
import type { NotificationRecipientKind } from './constants.js';

/**
 * Recipient resolution (core plan 10 §5.1) — **the heart of PL-021.**
 *
 * A notification row names a role, an approver policy, or a relationship to its
 * own subject. This module turns that into people, **at send time**, against
 * live grants and live configuration. Nothing is cached onto the notification
 * and nothing was resolved when it was requested.
 *
 * That is the whole requirement, and it is worth being precise about why it is a
 * property rather than a feature:
 *
 * > "Changing a role's membership redirects future notifications **without
 * > further configuration**" (PL-021, ON-048, ON AC-5).
 *
 * There is nothing to update because there is nothing that stores a person. No
 * notification, no reminder occurrence, no workflow definition and no
 * configuration value holds a person id — so a membership change redirects every
 * subsequent send with **zero writes anywhere**. A reviewer's shortcut: any code
 * here that reads a person id off a row *other than* by resolving it now is a
 * bug, however reasonable it looks.
 *
 * ## Zero recipients is an answer, not a failure
 *
 * An empty role or a policy resolving to nobody returns an empty array and the
 * caller journals `platform.notification.unresolved` (§4.4). It does not throw,
 * and it does not retry: no amount of redelivery populates an empty role, and a
 * dispatch that failed would sit in the dead-letter queue looking like an outage
 * when it is a configuration mistake. Loud and correct beats retried and wrong —
 * but **loud** is the part that matters, because a silent drop is how a critical
 * notification goes to nobody and nobody notices (§12.3).
 *
 * ## Module-boundary note (ADR-0008)
 *
 * This file names `platform.*` tables from `lib/` rather than from
 * `routers/platform/`, the same exception `lib/scope.ts` documents: these
 * helpers **are** the platform module's service surface for notification
 * resolution. An HR module consumes `requestNotification`; it never reaches into
 * `platform.notification_delivery` itself.
 */

export interface ResolvedRecipient {
  personId: string;
  /** Which half of the spec matched — stamped on the delivery row for audit. */
  resolvedVia: NotificationRecipientKind;
}

/**
 * What a subject stream can tell us about the people around it.
 *
 * Every field is optional because most subjects answer only one of these
 * questions. A resolver returning `null` for a relationship is saying "this kind
 * of record has no such person", which is a different and more useful answer
 * than an empty recipient list with no explanation.
 */
export interface SubjectContext {
  /** The person the record is *about* — the employee, the candidate. */
  subjectPersonId?: string | null;
  /** Who raised it. */
  requesterPersonId?: string | null;
  /**
   * The team whose manager (or deputy) counts as the subject's line manager.
   *
   * A team rather than a person, deliberately: `platform.team.manager_person_id`
   * is the source core plan 04's record scope already uses, and resolving
   * through it means "who manages this person" has one answer here and there
   * rather than two that agree by convention (set overview, 2026-08-06).
   */
  teamId?: string | null;
}

export type SubjectContextResolver = (
  db: Kysely<DB>,
  ctx: { streamId: string; at: Date },
) => Promise<SubjectContext>;

const subjectContexts = new Map<string, SubjectContextResolver>();

/**
 * Register how to read the people around a subject stream.
 *
 * The engine defines the questions and owns none of the answers — the same shape
 * as core plan 07's subject loaders and core plan 09's designated resolvers. An
 * `hr.*` stream's resolver reads `hr.*` tables and is registered by the HR
 * module's own code; this module never learns another module's schema.
 */
export function registerSubjectContext(streamType: string, resolver: SubjectContextResolver): void {
  if (subjectContexts.has(streamType)) {
    throw new Error(
      `duplicate subject-context resolver for stream type '${streamType}' — two would make contextual recipients depend on import order`,
    );
  }
  subjectContexts.set(streamType, resolver);
}

/** Every registered stream type — used by the conformance test. */
export function subjectContextStreamTypes(): string[] {
  return [...subjectContexts.keys()];
}

/** Test-only: drop a registration so a suite can exercise the missing path. */
export function unregisterSubjectContextForTests(streamType: string): void {
  subjectContexts.delete(streamType);
}

/** Who currently holds this role, evaluated at `at`, optionally scoped to a team. */
async function roleHoldersAt(
  db: Kysely<DB>,
  roleId: string,
  teamId: string | null,
  at: Date,
): Promise<string[]> {
  // Any module: a notification names a role, not a role-in-a-module, because the
  // module a notification belongs to is a property of its subject rather than of
  // who should hear about it. The same call core plans 08 and 09 made.
  let query = db
    .selectFrom('platform.role_grant as g')
    .select('g.person_id')
    .distinct()
    .where('g.role_id', '=', roleId)
    .where('g.revoked_at', 'is', null)
    .where('g.deleted_at', 'is', null)
    .where('g.valid_from', '<=', at)
    .where((eb) => eb.or([eb('g.valid_until', 'is', null), eb('g.valid_until', '>', at)]));

  if (teamId !== null) {
    // "Line managers *of this team*", not every line manager in the company —
    // the distinction core plan 09 learned the hard way about approver policies
    // (set overview, 2026-08-06).
    //
    // As a sub-select rather than a join, for the reason `lib/scope.ts` gives:
    // membership is effective-dated on `date` columns (half-open
    // `[valid_from, valid_to)`, ADR-0012), so the comparison is against the
    // send's calendar day, and keeping it inside a scalar subquery leaves the
    // outer query's row shape alone.
    const on = calendarDay(at);
    query = query.where((eb) =>
      eb(
        'g.person_id',
        'in',
        sql<string>`(
          SELECT m.person_id FROM platform.team_membership m
          JOIN platform.team t ON t.id = m.team_id
          WHERE m.team_id = ${teamId}
            AND t.deleted_at IS NULL
            AND m.valid_from <= ${on}::date
            AND (m.valid_to IS NULL OR m.valid_to > ${on}::date)
        )`,
      ),
    );
  }

  const rows = await query.execute();
  return rows.map((row) => row.person_id);
}

/** `at` as the `YYYY-MM-DD` a `date` column compares against. */
function calendarDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The manager and deputy of a team, at `at`. Both, because a deputy is cover. */
async function teamManagersAt(db: Kysely<DB>, teamId: string): Promise<string[]> {
  const team = await db
    .selectFrom('platform.team')
    .select(['manager_person_id', 'deputy_person_id'])
    .where('id', '=', teamId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!team) return [];
  // A deputy exists to cover the manager, and cover that is not told is not
  // cover — the same reasoning `managedPersonIds` applies to visibility.
  return [team.manager_person_id, team.deputy_person_id].filter(
    (id): id is string => id !== null && id !== undefined,
  );
}

/**
 * The people a notification's recipient spec resolves to, **now**.
 *
 * Returns an empty array rather than throwing for every "nobody matched" case —
 * an empty role, an unregistered subject type, a policy for a subject type
 * nobody registered, a contextual relationship this kind of record does not
 * have. Each of those is a real state the administrator can see and fix, and the
 * caller turns all of them into one loud `unresolved` event.
 */
export async function resolveRecipients(
  db: Kysely<DB>,
  notification: Pick<
    NotificationRecord,
    | 'recipient_kind'
    | 'recipient_role_id'
    | 'recipient_team_id'
    | 'recipient_policy_ref'
    | 'recipient_contextual'
    | 'subject_stream_type'
    | 'subject_stream_id'
  >,
  at: Date,
): Promise<ResolvedRecipient[]> {
  const dedupe = (personIds: readonly string[], via: NotificationRecipientKind) => {
    // One row per person per channel is a unique constraint, so a person
    // reached twice by one spec (a manager who is also a deputy) must collapse
    // here rather than produce a conflict the dispatcher has to absorb.
    const seen = new Set<string>();
    const out: ResolvedRecipient[] = [];
    for (const personId of personIds) {
      if (seen.has(personId)) continue;
      seen.add(personId);
      out.push({ personId, resolvedVia: via });
    }
    return out;
  };

  switch (notification.recipient_kind) {
    case 'role': {
      if (!notification.recipient_role_id) return [];
      const holders = await roleHoldersAt(
        db,
        notification.recipient_role_id,
        notification.recipient_team_id,
        at,
      );
      return dedupe(holders, 'role');
    }

    case 'policy': {
      // Resolved through core plan 09's `resolveApprovalPolicy` — deliberately
      // the very same function that decides who may *act*, so who is notified
      // and who is authorised can never be computed two ways and disagree
      // (plan 09 §9.6, plan 10 §5.1).
      if (!notification.subject_stream_type || !notification.subject_stream_id) return [];
      try {
        const resolved = await resolveApprovalPolicy(db, {
          subjectType: notification.subject_stream_type,
          subjectId: notification.subject_stream_id,
          at,
        });
        // The stored ref is the audit record of *which* policy was intended. If
        // the subject type's policy key has since moved, resolving anyway would
        // notify the right people for the wrong reason — better to report it
        // unresolved and let the diagnostics screen say so.
        const expected = notification.recipient_policy_ref;
        if (
          expected &&
          qualifiedName(parseConfigRef(expected)) !== qualifiedName(resolved.subject.policy)
        ) {
          return [];
        }
        return dedupe(
          resolved.expanded.notify.map((approver) => approver.personId),
          'policy',
        );
      } catch {
        // An unregistered subject type, or a policy naming a resolver nobody
        // implemented. Both are configuration faults that redelivery cannot fix.
        return [];
      }
    }

    case 'contextual': {
      if (!notification.subject_stream_type || !notification.subject_stream_id) return [];
      const resolver = subjectContexts.get(notification.subject_stream_type);
      if (!resolver) return [];

      const context = await resolver(db, { streamId: notification.subject_stream_id, at });
      switch (notification.recipient_contextual) {
        case 'subject_person':
          return dedupe(context.subjectPersonId ? [context.subjectPersonId] : [], 'contextual');
        case 'requester':
          return dedupe(context.requesterPersonId ? [context.requesterPersonId] : [], 'contextual');
        case 'subject_line_manager':
          return dedupe(
            context.teamId ? await teamManagersAt(db, context.teamId) : [],
            'contextual',
          );
        default:
          return [];
      }
    }
  }
}

/**
 * What went unresolved, in one string, for the `unresolved` event and the admin
 * diagnostics screen.
 *
 * Without it the event says something is misconfigured but not what, which is
 * the difference between an alert someone can act on and one they learn to
 * ignore (§12.3).
 */
export function recipientRefOf(
  notification: Pick<
    NotificationRecord,
    'recipient_kind' | 'recipient_role_id' | 'recipient_policy_ref' | 'recipient_contextual'
  >,
): string | null {
  switch (notification.recipient_kind) {
    case 'role':
      return notification.recipient_role_id;
    case 'policy':
      return notification.recipient_policy_ref;
    case 'contextual':
      return notification.recipient_contextual;
  }
}
