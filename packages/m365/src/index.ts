/**
 * `@repo/m365` — the one place Microsoft Graph knowledge lives (ADR-0017).
 *
 * **Worker-only.** Graph calls are queued, retried and idempotent; they never
 * run inline in a request, so an M365 outage delays a consequence rather than
 * failing a user's action. `apps/api` and `apps/web` must not import this.
 *
 * Core plan 11 uses the SharePoint half. Later plans add to the same package
 * rather than starting another: Entra user provisioning on onboarding completion
 * (ON-027/028), deprovisioning on offboarding (OF-003) and Outlook calendar sync
 * (PL-024, core plan 12) are all Graph, and splitting them across packages would
 * mean three credential selections and three retry policies.
 */
export {
  createGraphClient,
  graphError,
  isGraphConfigured,
  retryDelayMs,
  selectCredential,
  GraphPermanentError,
  GraphTransientError,
  type FetchLike,
  type GraphClient,
  type GraphClientOptions,
} from './graph-client.js';
export {
  deleteFile,
  downloadFile,
  downloadFileBytes,
  expandPathPattern,
  updateMetadata,
  uploadFile,
  SIMPLE_UPLOAD_LIMIT_BYTES,
  type SharePointTarget,
  type UploadedItem,
  type UploadFileInput,
} from './sharepoint.js';
