import { graphError, type GraphClient } from './graph-client.js';

/**
 * The SharePoint adapter (core plan 11 §5.1, PL-010, ADR-0017) — the byte store
 * of record, reached only from the worker.
 *
 * Postgres owns every piece of metadata, status and evidence; this file owns
 * exactly one thing, which is moving bytes in and out of a document library.
 * That split is what keeps document queries, filtering and RBAC running over
 * SQL and enforceable in the API (ADR-0017's first consequence) — nothing here
 * is ever consulted to answer "may this person see that document?".
 *
 * ## Permissions are app-mediated, by decision
 *
 * Files are readable only by the app's service principal (impl notes open
 * decision #3, adopted in §12.1). PL-010's "permissions mirroring the role
 * model" is satisfied by the API enforcing RBAC and streaming content, not by
 * per-user SharePoint ACLs — which would need a Graph write per person per
 * document and would drift the moment a role changed. There is deliberately no
 * `setPermissions` function here: adding one is how that decision gets reversed
 * by accident.
 *
 * ## Uploads are idempotent by path
 *
 * Effect delivery is at-least-once, so a filing handler *will* run twice. Both
 * upload functions target a **path** and `replace` on conflict, so the second
 * run overwrites the first with identical bytes and returns the same item id.
 * The alternative — create-with-unique-name — would leave a duplicate personnel
 * file behind every redelivery, discovered by an auditor rather than by a test.
 */

/** The 4 MB boundary above which Graph requires an upload session. */
export const SIMPLE_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;

/** Chunk size for upload sessions. A multiple of 320 KiB, as Graph requires. */
const UPLOAD_CHUNK_BYTES = 320 * 1024 * 10; // 3.2 MiB

export interface SharePointTarget {
  siteId: string;
  driveId: string;
}

export interface UploadFileInput extends SharePointTarget {
  /** Drive-relative path including the file name, e.g. `people/abc/contract.pdf`. */
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface UploadedItem {
  itemId: string;
  webUrl: string;
  eTag: string | null;
}

/** Percent-encode each path segment; `/` stays a separator. */
function encodePath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join('/');
}

function itemFrom(json: unknown): UploadedItem {
  const item = json as { id?: string; webUrl?: string; eTag?: string };
  if (!item?.id) {
    throw new Error('SharePoint upload returned no item id — the back-reference would be unusable');
  }
  return { itemId: item.id, webUrl: item.webUrl ?? '', eTag: item.eTag ?? null };
}

/**
 * Upload bytes to a drive path, replacing anything already there.
 *
 * Routes by size: a simple PUT under 4 MB, an upload session above it. The
 * threshold is Graph's, not ours, and exceeding it with a simple PUT fails with
 * a message that does not mention size.
 */
export async function uploadFile(
  client: GraphClient,
  input: UploadFileInput,
): Promise<UploadedItem> {
  return input.bytes.byteLength <= SIMPLE_UPLOAD_LIMIT_BYTES
    ? uploadSimple(client, input)
    : uploadSession(client, input);
}

async function uploadSimple(
  client: GraphClient,
  { siteId, driveId, path, bytes, contentType }: UploadFileInput,
): Promise<UploadedItem> {
  const response = await client.request(
    `/sites/${siteId}/drives/${driveId}/root:/${encodePath(path)}:/content`,
    {
      method: 'PUT',
      headers: { 'content-type': contentType },
      // A fresh copy: passing a view over a pooled buffer would let a later
      // write mutate bytes already in flight.
      body: new Uint8Array(bytes) as unknown as RequestInit['body'],
    },
  );
  if (!response.ok) throw await graphError(response);
  return itemFrom(await response.json());
}

async function uploadSession(
  client: GraphClient,
  { siteId, driveId, path, bytes }: UploadFileInput,
): Promise<UploadedItem> {
  const created = await client.request(
    `/sites/${siteId}/drives/${driveId}/root:/${encodePath(path)}:/createUploadSession`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        item: { '@microsoft.graph.conflictBehavior': 'replace' },
      }),
    },
  );
  if (!created.ok) throw await graphError(created);

  const { uploadUrl } = (await created.json()) as { uploadUrl?: string };
  if (!uploadUrl) throw new Error('SharePoint did not return an upload session URL');

  const total = bytes.byteLength;
  let offset = 0;
  let last: Response | null = null;

  while (offset < total) {
    const end = Math.min(offset + UPLOAD_CHUNK_BYTES, total);
    const chunk = bytes.subarray(offset, end);
    last = await client.requestAbsolute(uploadUrl, {
      method: 'PUT',
      headers: {
        'content-length': String(chunk.byteLength),
        // Inclusive on both ends, which is why `end - 1`. Off-by-one here
        // produces a corrupt file that uploads successfully.
        'content-range': `bytes ${offset}-${end - 1}/${total}`,
      },
      body: new Uint8Array(chunk) as unknown as RequestInit['body'],
    });
    if (!last.ok) throw await graphError(last);
    offset = end;
  }

  // The final chunk's response carries the created item.
  return itemFrom(await last!.json());
}

/**
 * Stream a filed document's bytes back.
 *
 * Returns the body as a stream rather than a buffer: the API relays this
 * straight to the browser, and buffering a 25 MB PDF in the worker's heap to
 * hand it on a byte at a time would be pure cost.
 */
export async function downloadFile(
  client: GraphClient,
  input: SharePointTarget & { itemId: string },
): Promise<ReadableStream<Uint8Array>> {
  const response = await client.request(
    `/sites/${input.siteId}/drives/${input.driveId}/items/${input.itemId}/content`,
  );
  if (!response.ok) throw await graphError(response);
  if (!response.body) throw new Error('SharePoint returned no content stream');
  return response.body as ReadableStream<Uint8Array>;
}

/** The same content, buffered — for the evidence export's hash recomputation. */
export async function downloadFileBytes(
  client: GraphClient,
  input: SharePointTarget & { itemId: string },
): Promise<Uint8Array> {
  const response = await client.request(
    `/sites/${input.siteId}/drives/${input.driveId}/items/${input.itemId}/content`,
  );
  if (!response.ok) throw await graphError(response);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Write the back-reference columns onto the SharePoint item (PL-010).
 *
 * The document id, its category and its subject, stamped on the library item so
 * a file found by browsing SharePoint can be traced back to the record that
 * governs it. **Surrogate ids only** — no names (ADR-0019): the library is
 * outside this application's access controls, and a filename or a column there
 * is readable by anyone with site access.
 */
export async function updateMetadata(
  client: GraphClient,
  input: SharePointTarget & { itemId: string; fields: Record<string, string> },
): Promise<void> {
  const response = await client.request(
    `/sites/${input.siteId}/drives/${input.driveId}/items/${input.itemId}/listItem/fields`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input.fields),
    },
  );
  // A library with no matching custom columns rejects the PATCH, and that must
  // not fail the filing: the bytes are stored and the back-reference in Postgres
  // is the authoritative one. The caller logs and moves on.
  if (!response.ok) throw await graphError(response);
}

/**
 * Delete a filed item.
 *
 * **Used only by the erasure process** (plan 16, ADR-0019). It exists here
 * because all Graph knowledge concentrates in this package, not because
 * document withdrawal deletes anything — cancelling a document supersedes it and
 * leaves the bytes in place (§7, "never overwrite history").
 */
export async function deleteFile(
  client: GraphClient,
  input: SharePointTarget & { itemId: string },
): Promise<void> {
  const response = await client.request(
    `/sites/${input.siteId}/drives/${input.driveId}/items/${input.itemId}`,
    { method: 'DELETE' },
  );
  // Already gone is the outcome erasure wanted.
  if (response.status === 404) return;
  if (!response.ok) throw await graphError(response);
}

/**
 * Expand a configured filing path pattern (§6).
 *
 * `people/{person_id}/{category_code}/` → `people/abc-123/contract/`. An unknown
 * placeholder is left **verbatim** rather than blanked: a path silently missing
 * a segment files documents into the wrong folder and nobody notices, whereas
 * `people/{persn_id}/` in a folder listing is a typo somebody fixes.
 */
export function expandPathPattern(
  pattern: string,
  values: Readonly<Record<string, string>>,
): string {
  return pattern.replace(/\{([a-z_]+)\}/g, (raw, key: string) => values[key] ?? raw);
}
