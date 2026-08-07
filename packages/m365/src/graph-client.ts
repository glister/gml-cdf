import {
  ClientSecretCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { parse, z } from '@repo/env';

/**
 * The Microsoft Graph client (core plan 11 §5.1, ADR-0017) — credential
 * selection, token caching, and the retry policy every Graph call in this
 * platform shares.
 *
 * **This package is worker-only** (ADR-0017). Graph calls never run inline in a
 * request: they are queued, retried and idempotent, so an M365 outage degrades
 * to a delayed effect rather than a user-facing failure. Nothing in `apps/api`
 * or `apps/web` may import it, and the reason is not layering neatness — a
 * synchronous Graph call inside a tRPC procedure would put a third party's
 * availability inside a database transaction.
 *
 * ## The client ships inert, and that is a feature
 *
 * `GRAPH_CLIENT_SECRET` is a real secret CDF IT has not yet issued (§12.2 Q4:
 * the app registration and its `Sites.Selected` consent). Rather than failing at
 * boot, `createGraphClient` returns `null` when the credentials are absent, and
 * every caller treats that as "filing is not configured" — the document is
 * issued, viewable and signable from staged bytes, and `filing_state` stays
 * `pending` until the secret arrives. That is exactly the degradation the
 * two-phase issue design exists to provide (§4.6, R1), and it is the same shape
 * core plan 03 used for the Entra provider.
 *
 * ## Why `fetch` is injected
 *
 * The adapter takes its transport as a parameter with the global as the default.
 * Its whole surface is HTTP semantics — 429 and `Retry-After`, upload sessions
 * over 4 MB, ETags — and none of that is testable against a real tenant in CI.
 * A test drives it with a scripted `fetch` and asserts the behaviour that
 * matters: that a throttled call backs off rather than hammering, and that a
 * large upload chunks.
 */

const env = parse(
  z.object({
    GRAPH_TENANT_ID: z.string().optional(),
    GRAPH_CLIENT_ID: z.string().optional(),
    /** Local dev only. Azure federates a managed identity and needs no secret. */
    GRAPH_CLIENT_SECRET: z.string().optional(),
    /** Set by Azure Container Apps when a user-assigned identity is attached. */
    AZURE_CLIENT_ID: z.string().optional(),
  }),
);

/** Graph's application-permission scope. Site access is granted per-site. */
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** The transport. Narrower than `typeof fetch` so a test stub stays small. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GraphClientOptions {
  /** Defaults to the global `fetch`. Injected in tests (see above). */
  fetch?: FetchLike;
  /** Max attempts for a throttled or transient call. */
  maxAttempts?: number;
  /** Sleep hook, so a test does not actually wait out a backoff. */
  sleep?: (ms: number) => Promise<void>;
}

/** A Graph call that failed in a way retrying will not fix. */
export class GraphPermanentError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Microsoft Graph refused the request (${status}): ${detail}`);
    this.name = 'GraphPermanentError';
  }
}

/** A Graph call that failed transiently. Throwing this asks for redelivery. */
export class GraphTransientError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Microsoft Graph is unavailable (${status}): ${detail}`);
    this.name = 'GraphTransientError';
  }
}

export interface GraphClient {
  /** An authenticated request against `https://graph.microsoft.com/v1.0`. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** An authenticated request against an absolute URL (an upload session). */
  requestAbsolute(url: string, init?: RequestInit): Promise<Response>;
}

/**
 * Which credential to use, or `null` when Graph is not configured.
 *
 * **Client secret in local dev; managed identity in Azure.** The federation is
 * what keeps `GRAPH_CLIENT_SECRET` out of every deployed environment — a secret
 * that only exists on a developer's machine cannot leak from production.
 */
export function selectCredential(): TokenCredential | null {
  if (!env.GRAPH_TENANT_ID || !env.GRAPH_CLIENT_ID) return null;
  if (env.GRAPH_CLIENT_SECRET) {
    return new ClientSecretCredential(
      env.GRAPH_TENANT_ID,
      env.GRAPH_CLIENT_ID,
      env.GRAPH_CLIENT_SECRET,
    );
  }
  // No secret: in Azure this is the intended path. On a developer's machine with
  // no secret set it will simply fail to acquire a token, which surfaces as a
  // filing failure on the document rather than a crash at boot.
  if (env.AZURE_CLIENT_ID) {
    return new ManagedIdentityCredential({ clientId: env.AZURE_CLIENT_ID });
  }
  return null;
}

/** Whether Graph is configured at all — the "filing is available" question. */
export function isGraphConfigured(): boolean {
  return selectCredential() !== null;
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait before retrying, honouring Graph's own `Retry-After`.
 *
 * Graph tells you how long to wait when it throttles; ignoring that header and
 * backing off on a schedule of our own is how a throttled tenant gets throttled
 * harder (R5). The exponential fallback covers the responses that carry no
 * header, and the cap stops a `Retry-After: 3600` from pinning a worker for an
 * hour — the effect queue will redeliver.
 */
export function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  }
  return Math.min(2 ** attempt * 500, 30_000);
}

/** Statuses worth retrying: throttling and the transient server-side family. */
function isRetryable(status: number): boolean {
  return status === 429 || status === 503 || status === 504 || status === 509;
}

/**
 * Build a Graph client, or `null` when the credentials are absent.
 *
 * Tokens are cached by `@azure/identity`'s own credential objects, so this holds
 * one credential for the process rather than re-authenticating per call.
 */
export function createGraphClient(opts: GraphClientOptions = {}): GraphClient | null {
  const credential = selectCredential();
  if (!credential) return null;

  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = opts.maxAttempts ?? 5;

  async function authorised(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await credential!.getToken(GRAPH_SCOPE);
    if (!token) {
      throw new GraphTransientError(
        401,
        'no access token was issued for the configured credential',
      );
    }

    let lastResponse: Response | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token.token}`);
      const response = await doFetch(url, { ...init, headers });

      if (response.ok || !isRetryable(response.status)) return response;

      lastResponse = response;
      // Not on the final attempt: sleeping after the last one delays the
      // handler's throw for no benefit.
      if (attempt < maxAttempts - 1) await sleep(retryDelayMs(response, attempt));
    }

    // Retries exhausted. Transient rather than permanent: the effect queue
    // should redeliver this later, when the throttling window has moved.
    throw new GraphTransientError(
      lastResponse?.status ?? 503,
      `gave up after ${maxAttempts} attempts`,
    );
  }

  return {
    request: (path, init) => authorised(`${GRAPH_BASE}${path}`, init),
    requestAbsolute: (url, init) => authorised(url, init),
  };
}

/** Turn a non-OK Graph response into the right error class for the caller. */
export async function graphError(response: Response): Promise<Error> {
  const detail = await response.text().catch(() => '');
  return isRetryable(response.status) || response.status >= 500
    ? new GraphTransientError(response.status, detail.slice(0, 500))
    : new GraphPermanentError(response.status, detail.slice(0, 500));
}
