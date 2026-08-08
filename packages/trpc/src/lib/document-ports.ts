/**
 * The two ports the document engine's effects need, and the registry the worker
 * fills them from (core plan 11 §4.6).
 *
 * **Why this indirection exists, and why it is the same shape as plan 10's
 * channel adapters.** Rendering needs an HTTP call to Gotenberg; filing needs
 * `@repo/m365`, which is worker-only by ADR-0017. The effect *handlers* have to
 * live in `@repo/trpc`, because they wrap the engine services in `lib/documents.ts`
 * (the same constraint core plan 08 resolved in its §12.2 Q1) — and `@repo/trpc`
 * is imported by `apps/web`, so a static import of either would drag a Graph SDK
 * and a PDF renderer into the browser bundle.
 *
 * So the dependency is inverted exactly as the email adapter's is: this package
 * owns the contracts and the registry, `apps/worker` owns the concrete services
 * and registers them at boot, and the handler never learns which process it is
 * running in.
 *
 * The practical consequence is worth stating, because it looks like a bug the
 * first time someone sees it: **the API process has no renderer and no document
 * store, and that is correct.** Nothing is ever rendered or filed inline in a
 * request (§4.6). An effect dispatched in a process with no registration records
 * a filing failure naming the missing port rather than silently doing nothing,
 * so a misassembled deployment looks like one.
 */

/** Turn a document's HTML into PDF bytes. */
export type DocumentRenderer = (input: {
  html: string;
  /** Shown in the PDF's metadata. Never a person's name (ADR-0019). */
  title: string;
}) => Promise<Uint8Array>;

/** Where rendered bytes are stored, and how they come back. */
export interface DocumentStore {
  /** Whether the store is configured at all (§12.2 Q4 — Graph consent). */
  isConfigured(): boolean;
  upload(input: {
    siteId: string;
    driveId: string;
    path: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<{ itemId: string; webUrl: string }>;
  /** Back-reference columns on the stored item. Surrogate ids only. */
  setMetadata?(input: {
    siteId: string;
    driveId: string;
    itemId: string;
    fields: Record<string, string>;
  }): Promise<void>;
  download(input: {
    siteId: string;
    driveId: string;
    itemId: string;
  }): Promise<ReadableStream<Uint8Array>>;
}

let renderer: DocumentRenderer | null = null;
let store: DocumentStore | null = null;

/** Thrown when an effect runs in a process that registered no port. */
export class DocumentPortMissingError extends Error {
  constructor(readonly port: 'renderer' | 'store') {
    super(
      `no document ${port} is registered in this process — rendering and filing happen in the worker (ADR-0017), and an effect reaching here means the handler was dispatched somewhere it should not have been`,
    );
    this.name = 'DocumentPortMissingError';
  }
}

export function registerDocumentRenderer(fn: DocumentRenderer): void {
  renderer = fn;
}

export function registerDocumentStore(adapter: DocumentStore): void {
  store = adapter;
}

export function requireDocumentRenderer(): DocumentRenderer {
  if (!renderer) throw new DocumentPortMissingError('renderer');
  return renderer;
}

export function requireDocumentStore(): DocumentStore {
  if (!store) throw new DocumentPortMissingError('store');
  return store;
}

/** Whether this process can file at all — asked before an upload is attempted. */
export function hasDocumentStore(): boolean {
  return store !== null;
}

/** Test-only: substitute a fake renderer/store, or clear one. */
export function setDocumentPortsForTests(ports: {
  renderer?: DocumentRenderer | null;
  store?: DocumentStore | null;
}): void {
  if (ports.renderer !== undefined) renderer = ports.renderer;
  if (ports.store !== undefined) store = ports.store;
}
