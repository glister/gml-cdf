export { appRouter } from './router.js';
export type { AppRouter } from './router.js';

export {
  router,
  middleware,
  mergeRouters,
  publicProcedure,
  protectedProcedure,
  adminProcedure,
  roleProcedure,
} from './trpc.js';
export type {
  TRPCContext,
  ContextGrant,
  ContextUser,
  ContextSession,
  ContextLogger,
  EmailSender,
  SmsSender,
  RateLimiter,
} from './trpc.js';

/**
 * The task engine's workflow effects (core plan 08 §9.6).
 *
 * Exported for its **module-load side effects** as much as for the names: the
 * `tasks.*` handlers and the pilot subject loader register when this module is
 * loaded, so any consumer of `@repo/trpc` — the API, which executes transitions,
 * and the worker, which also dispatches their effects — sees one registry.
 */
export {
  openGateEffect,
  raiseTaskListEffect,
  recomputeDueDatesEffect,
  TASK_EFFECTS,
} from './lib/task-effects.js';

/** The task engine's transactional services (core plan 08 §5.1). */
export {
  cancelTask,
  claimTask,
  completeTask,
  openGate,
  raiseTaskList,
  recomputeDueDates,
  releaseTask,
  TaskForbiddenError,
  TaskNotFoundError,
  TaskSpecError,
  type TaskListItem,
} from './lib/tasks.js';

/**
 * The approval engine's workflow effect (core plan 09 §5.5).
 *
 * Exported for its **module-load side effect** as much as for the names: the
 * `approval.open` handler registers when this module is loaded, so the API
 * (which executes transitions) and the worker (which dispatches their effects)
 * see one registry. The decisive decision's transition is deliberately *not* an
 * effect — it fires inside the decide transaction; see that module's header.
 */
export {
  cancelApprovalEffect,
  openApprovalEffect,
  APPROVAL_EFFECTS,
} from './lib/approval-effects.js';

/**
 * The pilot slice's warning provider and subject loader (core plan 09 §9.8),
 * exported for their module-load side effects. Retires with the pilot.
 */
export { PILOT_LARGE_AMOUNT_CODE, PILOT_WARNING_PROVIDER } from './lib/approval-pilot.js';

/** The approval engine's transactional services (core plan 09 §5.1). */
export {
  assertDesignatedResolversRegistered,
  cancelApprovalRequest,
  cancelApprovalsForInstance,
  createDelegation,
  decideApproval,
  openApprovalRequest,
  registerDesignatedResolver,
  resolveApprovalPolicy,
  revokeDelegation,
  unregisterDesignatedResolverForTests,
  ApprovalConflictError,
  ApprovalForbiddenError,
  ApprovalNotFoundError,
  ApprovalRequestError,
  ApprovalTransitionError,
  APPROVAL_REMINDER_KIND,
  APPROVAL_STREAM_TYPE,
  REMINDER_ACTION_TYPE as APPROVAL_REMINDER_ACTION_TYPE,
  type DesignatedResolver,
  type OpenApprovalResult,
  type ResolvedApprovalPolicy,
} from './lib/approvals.js';

/** The warning-provider contract consuming modules register against (PL-017). */
export {
  collectWarnings,
  registerWarningProvider,
  unregisterWarningProviderForTests,
  warningProviderNames,
  WARNINGS_UNAVAILABLE_CODE,
  type ApprovalWarningContext,
  type ApprovalWarningProvider,
} from './lib/approval-warnings.js';

/**
 * The notification-kind registry (core plan 10 §5.5) — where a kind binds its
 * **strict** parameter schema, its channels and the renderer that turns those
 * parameters into what a person reads. Exported for its module-load side effect
 * as well as its names: the seed kinds register when this module loads, so the
 * API and the worker validate against one registry.
 *
 * A consuming module registering its own kinds gets the SA-023 guarantee for
 * free — a schema built as `z.strictObject` cannot have a profile row spread
 * into it, and a body can only say what its parameters expose (§4.6).
 */
export {
  adminTestKind,
  assertAppRelative,
  defineNotificationKind,
  notificationKindRegistry,
  reminderChaseKind,
  renderNotification,
  requireNotificationKind,
  unregisterNotificationKindForTests,
  NotificationKindUnknownError,
  NotificationPayloadInvalidError,
  type NotificationKindDef,
  type RenderedNotification,
} from './lib/notify-kinds.js';

/**
 * The notification service's transactional API (core plan 10 §5.2) and its
 * effect handlers. Exported for the **module-load side effect** as much as for
 * the names: `notification.dispatch` / `.retry` / `.reminder` register in
 * `@repo/workflow`'s effect registry when this module loads, as do the in-app
 * channel adapter and the two reminder kinds core plans 08 and 09 are already
 * writing occurrences for. Without it the worker would dead-letter every
 * reminder that came due.
 */
export {
  cancelReminders,
  requestNotification,
  scheduleReminder,
  NOTIFICATION_DISPATCH_EFFECT,
  NOTIFICATION_RETRY_EFFECT,
  NOTIFICATION_STREAM_TYPE,
  REMINDER_ACTION_TYPE,
  type RequestNotificationInput,
  type ScheduleReminderInput,
} from './lib/notify.js';

export {
  dispatchNotificationEffect,
  reminderEffect,
  retryNotificationEffect,
  MAX_DELIVERY_ATTEMPTS,
  NOTIFICATION_EFFECTS,
} from './lib/notify-effects.js';

/** Recipient resolution — the heart of PL-021 (core plan 10 §5.1). */
export {
  recipientRefOf,
  registerSubjectContext,
  resolveRecipients,
  subjectContextStreamTypes,
  unregisterSubjectContextForTests,
  type ResolvedRecipient,
  type SubjectContext,
  type SubjectContextResolver,
} from './lib/notify-resolve.js';

/** The channel-adapter seam push slots into later (core plan 10 §5.3). */
export {
  channelAdapter,
  inAppAdapter,
  registerChannelAdapter,
  registeredChannels,
  unregisterChannelAdapterForTests,
  type ChannelAdapter,
  type ChannelSendContext,
  type ChannelSendResult,
} from './lib/notify-channels.js';

/** The reminder-kind registry — satisfaction checks (core plan 10 §5.5). */
export {
  registerReminderKind,
  reminderKindNames,
  requireReminderKind,
  unregisterReminderKindForTests,
  ReminderKindUnknownError,
  type ReminderDescription,
  type ReminderKindDef,
} from './lib/notify-reminders.js';

/** Grant resolution for the API context factory (core plan 04 §9.3). */
export { loadGrantsForPerson } from './lib/grants-context.js';

/**
 * The configuration store (core plan 06): the key registry and the as-at
 * resolution API. It now lives in its own source-only `@repo/config` — core plan
 * 07's runtime needs it and `@repo/trpc` imports that runtime, so keeping it
 * here made the two packages mutually dependent (core 07 §5.2 write-back,
 * 2026-08-05).
 *
 * Re-exported unchanged from the package root, so `apps/api`, `apps/worker` and
 * later plans' service code still resolve `config:` values from one place, the
 * web editor still validates against the very same Zod schemas, and no call site
 * had to move.
 */
export * from '@repo/config';

export * from './schemas.js';
export * from './lib/keyset.js';
export * from './lib/constants.js';
export * from './lib/scope.js';
export * from './lib/field-classification.js';
export * from './lib/special-category-journal.js';
