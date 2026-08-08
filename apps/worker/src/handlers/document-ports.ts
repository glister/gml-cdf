import { parse, z } from '@repo/env';
import {
  createGraphClient,
  isGraphConfigured,
  updateMetadata,
  uploadFile,
  downloadFile,
  type GraphClient,
} from '@repo/m365';
import { registerDocumentRenderer, registerDocumentStore } from '@repo/trpc';
import { logger } from '../logger.js';

/**
 * The concrete renderer and document store (core plan 11 §4.6).
 *
 * **Why they are registered here rather than defined in `@repo/trpc`.** That
 * package is imported by `apps/web`; a static import of `@repo/m365` would put a
 * Graph SDK and its credential chain into the browser bundle, and Gotenberg's
 * client would bring an HTTP call with it. Registration inverts the dependency
 * exactly as core plan 10's email adapter does: `@repo/trpc` owns the
 * `DocumentRenderer`/`DocumentStore` contracts and the effect handlers, this app
 * owns the services, and the handler never learns which process it is in.
 *
 * ADR-0017 makes the same point from the other direction: Graph calls are
 * worker-only, queued, retried and idempotent, so an M365 outage delays a filing
 * rather than failing somebody's signature.
 */

const env = parse(
  z.object({
    /**
     * The Gotenberg service (§12.2 Q1, resolved 2026-08-07). The **internal**
     * address — `http://gotenberg:3000` in compose — because only this process
     * calls it. Nothing browser-side ever sees it.
     */
    GOTENBERG_URL: z.string().min(1),
  }),
);

/** Gotenberg's Chromium HTML route. */
const CONVERT_PATH = '/forms/chromium/convert/html';

/**
 * HTML → PDF via Gotenberg.
 *
 * The file **must** be called `index.html` — that is Gotenberg's contract for
 * the entry point, and a differently-named part is accepted and then rendered as
 * a blank page, which is a failure that looks like a success.
 *
 * `title` is passed as the PDF's document name and is deliberately the
 * document's **id**, not its title: a PDF's metadata travels with the file into
 * SharePoint, outside this application's RBAC (ADR-0019).
 */
registerDocumentRenderer(async ({ html, title }) => {
  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  form.append('metadata', JSON.stringify({ Title: title }));
  // A4 with sane margins: the template CSS should not have to know the paper.
  form.append('paperWidth', '8.27');
  form.append('paperHeight', '11.7');
  form.append('marginTop', '0.6');
  form.append('marginBottom', '0.6');
  form.append('marginLeft', '0.6');
  form.append('marginRight', '0.6');
  form.append('printBackground', 'true');

  const response = await fetch(`${env.GOTENBERG_URL}${CONVERT_PATH}`, {
    method: 'POST',
    body: form,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // Thrown, not swallowed: the effect queue retries, and a renderer that is
    // down is exactly the transient failure retrying is for.
    throw new Error(`Gotenberg refused the render (${response.status}): ${detail.slice(0, 300)}`);
  }

  return new Uint8Array(await response.arrayBuffer());
});

/**
 * SharePoint, through `@repo/m365`.
 *
 * The client is built lazily and cached: `createGraphClient` returns `null` when
 * the credentials are absent (§12.2 Q4), and building it at module load would
 * mean a worker that boots before CDF IT issues the secret never picks it up.
 */
let cachedClient: GraphClient | null = null;
function graph(): GraphClient | null {
  cachedClient ??= createGraphClient();
  return cachedClient;
}

registerDocumentStore({
  /**
   * Whether filing can run at all.
   *
   * `false` is a **state**, not an error: the document is issued, rendered,
   * viewable and signable from staged bytes, and `filing_state` stays `pending`
   * until the credential arrives. That degradation is the entire reason issue is
   * two-phase (§4.6, R1).
   */
  isConfigured: () => isGraphConfigured(),

  async upload(input) {
    const client = graph();
    if (!client) throw new Error('Microsoft Graph is not configured');
    const item = await uploadFile(client, input);
    logger.info('document filed to SharePoint', { itemId: item.itemId, path: input.path });
    return { itemId: item.itemId, webUrl: item.webUrl };
  },

  async setMetadata(input) {
    const client = graph();
    if (!client) throw new Error('Microsoft Graph is not configured');
    await updateMetadata(client, input);
  },

  async download(input) {
    const client = graph();
    if (!client) throw new Error('Microsoft Graph is not configured');
    return downloadFile(client, input);
  },
});
