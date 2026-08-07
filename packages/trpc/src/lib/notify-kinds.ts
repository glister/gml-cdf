import { z } from 'zod';
import type { NotificationChannel } from './constants.js';

/**
 * The notification-kind registry (core plan 10 §5.5) — **and the place SA-023
 * stops being a promise and becomes a type.**
 *
 * Every notification has a registered `kind`, and a kind binds three things: a
 * **strict** Zod schema for its parameters, the channels it wants by default,
 * and a renderer turning those parameters into the title and body a person
 * reads. `requestNotification` refuses an unregistered kind and refuses a
 * payload its schema does not accept, so there is no path from a caller's data
 * to a notification body that does not pass through a schema someone wrote on
 * purpose.
 *
 * That is what makes the content rule enforceable rather than aspirational
 * (§4.6, ADR-0019):
 *
 * > Special-category detail — medical and sickness types, fit-note content,
 * > disability context, Bradford figures, pay — **never appears in notification
 * > content on any channel.**
 *
 * A sickness notification says "an absence has been recorded for <name>; open
 * the record for detail" because the kind that renders it *has no parameter*
 * capable of carrying the diagnosis. Detail stays behind the RBAC-guarded
 * screen, exactly as the shared calendar shows "absence" only.
 *
 * ## Why a shape rather than a schema
 *
 * `defineNotificationKind` takes a **shape** (`{ taskTitle: z.string()… }`) and
 * builds `z.strictObject` itself, so a kind cannot be registered with a
 * permissive schema — not by mistake, and not by someone in a hurry reaching for
 * `z.object`. Strictness is the structural half of the PII rule: a schema that
 * rejects unknown keys cannot have a profile row spread into it.
 *
 * ## Why the renderer is pure and lives here
 *
 * It is a total function from validated parameters to two strings, so it is
 * testable without a database and cannot reach for anything the schema did not
 * expose. It is not in `@repo/domain` because it is not business logic — it is
 * presentation, it changes with copy rather than with policy, and every other
 * shared-schema concern already lives in this package.
 */

/** Registered kinds are `<area>.<verb>` — the notification vocabulary. */
const KIND_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * What a kind's renderer produces. Three fields, all of them safe to put in
 * front of anyone the recipient spec resolves to.
 */
export interface RenderedNotification {
  /** One line. Shown as the in-app heading and the email subject. */
  title: string;
  /** A sentence or two. Never the detail — the link is how detail is reached. */
  body: string;
  /** App-relative deep link (`/tasks/<id>`), or `null` for nothing to open. */
  actionUrl: string | null;
}

/** A parameter shape: field name → Zod type. Values must be scalars (§4.6). */
export type NotificationParamShape = Record<string, z.ZodType>;

export interface NotificationKindDef<S extends NotificationParamShape = NotificationParamShape> {
  /** e.g. `admin.test`, `reminder.chase`. */
  readonly kind: string;
  /** Built from the shape as `z.strictObject` — never supplied directly. */
  readonly payloadSchema: z.ZodObject<S>;
  /**
   * The channels this kind asks for. Overridable per kind without a release
   * through `platform.notifications.kind_channel_overrides` (§6), which is the
   * volume relief valve for a kind that turns out to be chatty.
   */
  readonly defaultChannels: readonly NotificationChannel[];
  readonly render: (params: z.infer<z.ZodObject<S>>) => RenderedNotification;
  /** Plain English, for the administrator reading the diagnostics screen. */
  readonly description: string;
  /** The owning plan, e.g. `'10'`, `'hr-sickness'` — for the review trail. */
  readonly registeredBy: string;
}

/** Thrown when a kind that is not in the registry is requested or rendered. */
export class NotificationKindUnknownError extends Error {
  constructor(readonly kind: string) {
    super(
      `unknown notification kind '${kind}': register it with defineNotificationKind() before requesting a notification of it`,
    );
    this.name = 'NotificationKindUnknownError';
  }
}

/** Thrown when a payload fails its kind's strict schema. */
export class NotificationPayloadInvalidError extends Error {
  constructor(
    readonly kind: string,
    readonly cause: unknown,
  ) {
    super(
      `notification payload for '${kind}' does not satisfy its registered schema — a kind's parameters are the whole of what its content may contain (§4.6)`,
    );
    this.name = 'NotificationPayloadInvalidError';
  }
}

const registry = new Map<string, NotificationKindDef>();

export interface DefineNotificationKindInput<S extends NotificationParamShape> {
  kind: string;
  /**
   * Field name → Zod type. **Scalars only.** A nested object or an array of
   * objects is the shape a profile row arrives in, and no notification has ever
   * needed one — if a kind seems to, it wants an id and a link.
   */
  params: S;
  defaultChannels: readonly NotificationChannel[];
  render: (params: z.infer<z.ZodObject<S>>) => RenderedNotification;
  description: string;
  registeredBy: string;
}

/**
 * Register one notification kind. Validates the name grammar and the channel
 * list **at module load**, so a malformed registration fails on boot rather
 * than at the first send — the same fail-fast discipline `defineEvent` applies
 * to the journal and `defineConfigKey` to configuration.
 *
 * Duplicate registration throws: two definitions of one kind would make the
 * content of a stored notification depend on import order.
 */
export function defineNotificationKind<S extends NotificationParamShape>(
  input: DefineNotificationKindInput<S>,
): NotificationKindDef<S> {
  if (!KIND_PATTERN.test(input.kind)) {
    throw new Error(
      `invalid notification kind '${input.kind}': must be a lowercase, dotted name (e.g. 'task.assigned')`,
    );
  }
  if (input.defaultChannels.length === 0) {
    throw new Error(
      `notification kind '${input.kind}' lists no default channels: a kind nobody can receive is a table row, not a notification`,
    );
  }
  if (registry.has(input.kind)) {
    throw new Error(
      `duplicate notification kind registration: '${input.kind}' is already registered`,
    );
  }

  const def: NotificationKindDef<S> = Object.freeze({
    kind: input.kind,
    // Strict, always, built here rather than accepted from the caller — this is
    // the line that makes "no unknown keys" impossible to opt out of.
    payloadSchema: z.strictObject(input.params),
    defaultChannels: Object.freeze([...input.defaultChannels]),
    render: input.render,
    description: input.description,
    registeredBy: input.registeredBy,
  });

  registry.set(input.kind, def as unknown as NotificationKindDef);
  return def;
}

/** Every registered kind, by name. */
export const notificationKindRegistry: ReadonlyMap<string, NotificationKindDef> = registry;

/** Look up a kind, or throw {@link NotificationKindUnknownError}. */
export function requireNotificationKind(kind: string): NotificationKindDef {
  const def = registry.get(kind);
  if (!def) throw new NotificationKindUnknownError(kind);
  return def;
}

/**
 * Validate a payload against its kind and render it.
 *
 * The single door every notification's content comes through — used by
 * `requestNotification` on the way in, so a row that reaches the table has
 * already been rendered from parameters that passed a strict schema. Nothing
 * later re-renders it, which is why the in-app entry, the email and the
 * diagnostics screen can never show three different things.
 */
export function renderNotification(
  kind: string,
  payload: unknown,
): { def: NotificationKindDef; params: Record<string, unknown>; rendered: RenderedNotification } {
  const def = requireNotificationKind(kind);
  const parsed = def.payloadSchema.safeParse(payload ?? {});
  if (!parsed.success) {
    throw new NotificationPayloadInvalidError(kind, parsed.error);
  }
  const params = parsed.data as Record<string, unknown>;
  const rendered = def.render(params);
  assertAppRelative(rendered.actionUrl, kind);
  return { def, params, rendered };
}

/**
 * A deep link must be **app-relative** — `/tasks/<id>`, never `https://…`.
 *
 * Two reasons, and the second is the one that matters. A stored absolute URL is
 * an open-redirect target: the inbox renders `action_url` straight into an
 * anchor, and a kind that let a caller supply the host would let a caller supply
 * `https://evil.example`. And the same row is read by the web app and by the
 * mobile app, which resolve the path against different bases — an absolute URL
 * would send a phone to the desktop site.
 *
 * `//host` is rejected alongside `http(s)://`: a protocol-relative URL is an
 * absolute one wearing a path's clothes, and it is the case a naive
 * `startsWith('/')` check waves through.
 */
export function assertAppRelative(actionUrl: string | null, kind: string): void {
  if (actionUrl === null) return;
  if (!actionUrl.startsWith('/') || actionUrl.startsWith('//')) {
    throw new Error(
      `notification kind '${kind}' produced a non-relative action_url '${actionUrl}': deep links are app-relative paths so the web and mobile apps can each resolve them against their own base`,
    );
  }
}

/** Test-only: drop a registration so a suite can exercise the load-time rules. */
export function unregisterNotificationKindForTests(kind: string): void {
  registry.delete(kind);
}

// --- The seed kinds (§9.2) ---------------------------------------------------
//
// Two, and between them they carry the whole capability: one proves resolution
// and dispatch end to end with no HR module in existence, and one is what every
// reminder in the platform actually sends.

/**
 * `admin.test` — the pilot slice's message (§9.7).
 *
 * The one kind whose body carries free text, and the one case where that is
 * safe: an administrator is writing a test message to prove a role resolves,
 * and the author and the audience are the same person's problem. Bounded at 200
 * characters, and no other kind may follow this precedent.
 */
export const adminTestKind = defineNotificationKind({
  kind: 'admin.test',
  params: {
    /** What the administrator typed, if anything. */
    note: z.string().max(200).nullable(),
    /** How the recipient came to be resolved — the thing the test is proving. */
    resolvedVia: z.enum(['role', 'policy', 'contextual']),
  },
  defaultChannels: ['in_app', 'email'],
  description:
    'A test notification an administrator sends to prove recipient resolution and delivery end to end. Governs no business process.',
  registeredBy: '10',
  render: ({ note, resolvedVia }) => ({
    title: 'Test notification',
    body: note
      ? `${note} (you received this because you were resolved by ${resolvedVia}.)`
      : `This is a test notification from CD Fencing. You received it because you were resolved by ${resolvedVia}.`,
    actionUrl: '/notifications',
  }),
});

/**
 * `reminder.chase` — what every reminder kind sends (§4.5).
 *
 * One kind for every chase in the platform, rather than one per source, and the
 * reason is SA-023. A chase names **what class of thing** is outstanding
 * ("a task", "an approval request") and links to it; it does not name what the
 * thing is about. That keeps a fit-note chase and an onboarding-document chase
 * structurally identical, so there is no per-source template anyone could
 * quietly enrich with detail.
 *
 * `label` is a short, non-sensitive display string the reminder kind supplies —
 * a task's title, never a person's condition. `occurrence` is on the payload so
 * the body can say "still outstanding" rather than repeating itself verbatim.
 */
export const reminderChaseKind = defineNotificationKind({
  kind: 'reminder.chase',
  params: {
    /** What is being chased, as a noun phrase: 'task', 'approval request'. */
    sourceLabel: z.string().max(60),
    /** A short, non-sensitive title for the item — never a detail line. */
    label: z.string().max(200).nullable(),
    /** Which chase this is, from 1. */
    occurrence: z.number().int().min(1),
    /** ISO date the item was or is due, if it has a deadline. */
    dueDate: z.string().max(30).nullable(),
    /** Where to open it. App-relative — validated by {@link assertAppRelative}. */
    actionUrl: z.string().max(300).nullable(),
  },
  defaultChannels: ['in_app', 'email'],
  description:
    'A reminder that something assigned to you is still outstanding. Names the class of item and links to it; never carries detail about the item’s subject.',
  registeredBy: '10',
  render: ({ sourceLabel, label, occurrence, dueDate, actionUrl }) => {
    const what = label ? `${sourceLabel} “${label}”` : `a ${sourceLabel}`;
    const due = dueDate ? ` It was due on ${dueDate}.` : '';
    return {
      title:
        occurrence === 1
          ? `Reminder: ${sourceLabel} outstanding`
          : `Still outstanding: ${sourceLabel}`,
      body: `${capitalise(what)} assigned to you is still outstanding.${due} Open it to see what is needed.`,
      actionUrl,
    };
  },
});

function capitalise(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}
