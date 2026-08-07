import { describe, expect, it, vi } from 'vitest';
import { expandPathPattern, uploadFile, SIMPLE_UPLOAD_LIMIT_BYTES } from './sharepoint.js';
import { retryDelayMs, type GraphClient } from './graph-client.js';

/**
 * The SharePoint adapter's tests (core plan 11 §10, filing row).
 *
 * Everything here is HTTP semantics — the 4 MB routing boundary, chunk ranges,
 * `Retry-After` — and none of it is testable against a real tenant in CI, which
 * is precisely why the client takes its transport as a parameter. These drive it
 * with a scripted `fetch` and assert the behaviours whose failure modes are
 * silent: a corrupt-but-successful upload, and a throttled tenant being
 * throttled harder.
 */

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** A client that records every call rather than reaching the network. */
function recordingClient(responses: Response[]): {
  client: GraphClient;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  let index = 0;
  const next = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const response = responses[index++];
    if (!response) throw new Error(`unexpected call ${index} to ${url}`);
    return Promise.resolve(response);
  };
  return {
    calls,
    client: { request: next, requestAbsolute: next },
  };
}

describe('uploadFile — routing by size', () => {
  it('uses a simple PUT below the 4 MB boundary', async () => {
    const { client, calls } = recordingClient([
      jsonResponse({ id: 'item-1', webUrl: 'https://sp/x', eTag: '"1"' }),
    ]);

    const result = await uploadFile(client, {
      siteId: 'site',
      driveId: 'drive',
      path: 'people/abc/welcome.pdf',
      bytes: new Uint8Array(1024),
      contentType: 'application/pdf',
    });

    expect(result).toEqual({ itemId: 'item-1', webUrl: 'https://sp/x', eTag: '"1"' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(calls[0]?.url).toContain('/root:/people/abc/welcome.pdf:/content');
  });

  it('percent-encodes each path segment but keeps the separators', async () => {
    const { client, calls } = recordingClient([jsonResponse({ id: 'i', webUrl: 'u' })]);
    await uploadFile(client, {
      siteId: 'site',
      driveId: 'drive',
      path: 'people/a b/Offer Letter #2.pdf',
      bytes: new Uint8Array(8),
      contentType: 'application/pdf',
    });
    expect(calls[0]?.url).toContain('people/a%20b/Offer%20Letter%20%232.pdf');
  });

  it('opens an upload session above the boundary and chunks with inclusive ranges', async () => {
    const size = SIMPLE_UPLOAD_LIMIT_BYTES + 1;
    const { client, calls } = recordingClient([
      jsonResponse({ uploadUrl: 'https://upload/session' }),
      new Response(null, { status: 202 }),
      jsonResponse({ id: 'item-big', webUrl: 'https://sp/big' }),
    ]);

    const result = await uploadFile(client, {
      siteId: 'site',
      driveId: 'drive',
      path: 'big.pdf',
      bytes: new Uint8Array(size),
      contentType: 'application/pdf',
    });

    expect(result.itemId).toBe('item-big');
    expect(calls[0]?.url).toContain('createUploadSession');

    // Ranges are inclusive on both ends. An off-by-one here produces a corrupt
    // file that uploads *successfully*, which is the reason this is asserted
    // rather than reviewed.
    const ranges = calls.slice(1).map((c) => new Headers(c.init?.headers).get('content-range'));
    expect(ranges[0]).toBe(`bytes 0-3276799/${size}`);
    expect(ranges.at(-1)).toBe(`bytes 3276800-${size - 1}/${size}`);

    // Every byte covered exactly once, with no gap between chunks.
    const covered = ranges.reduce((total, range) => {
      const [from, to] = range!.slice('bytes '.length).split('/')[0]!.split('-').map(Number);
      return total + (to! - from! + 1);
    }, 0);
    expect(covered).toBe(size);
  });

  it('replaces on conflict, so a redelivered filing overwrites rather than duplicating', async () => {
    // Effect delivery is at-least-once and the handler WILL run twice. Anything
    // other than replace leaves a duplicate personnel file behind each
    // redelivery, found by an auditor rather than by a test.
    const { client, calls } = recordingClient([
      jsonResponse({ uploadUrl: 'https://upload/session' }),
      new Response(null, { status: 202 }),
      jsonResponse({ id: 'i', webUrl: 'u' }),
    ]);
    await uploadFile(client, {
      siteId: 'site',
      driveId: 'drive',
      path: 'x.pdf',
      bytes: new Uint8Array(SIMPLE_UPLOAD_LIMIT_BYTES + 1),
      contentType: 'application/pdf',
    });
    expect(String(calls[0]?.init?.body)).toContain('"replace"');
  });

  it('refuses a response with no item id rather than storing an unusable back-reference', async () => {
    const { client } = recordingClient([jsonResponse({ webUrl: 'https://sp/x' })]);
    await expect(
      uploadFile(client, {
        siteId: 's',
        driveId: 'd',
        path: 'x.pdf',
        bytes: new Uint8Array(4),
        contentType: 'application/pdf',
      }),
    ).rejects.toThrow(/no item id/);
  });
});

describe('retryDelayMs — honouring Graph’s own throttling advice (R5)', () => {
  it('uses Retry-After when Graph supplies one', () => {
    const response = new Response(null, { status: 429, headers: { 'retry-after': '12' } });
    expect(retryDelayMs(response, 0)).toBe(12_000);
  });

  it('caps a very long Retry-After — the effect queue will redeliver', () => {
    const response = new Response(null, { status: 429, headers: { 'retry-after': '3600' } });
    expect(retryDelayMs(response, 0)).toBe(60_000);
  });

  it('backs off exponentially when no header is present', () => {
    const response = new Response(null, { status: 503 });
    expect(retryDelayMs(response, 0)).toBe(500);
    expect(retryDelayMs(response, 3)).toBe(4000);
  });

  it('ignores a non-numeric Retry-After rather than waiting NaN milliseconds', () => {
    const response = new Response(null, {
      status: 429,
      headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
    });
    expect(retryDelayMs(response, 1)).toBe(1000);
  });
});

describe('expandPathPattern (§6)', () => {
  it('substitutes the configured placeholders', () => {
    expect(
      expandPathPattern('people/{person_id}/{category_code}/', {
        person_id: 'abc',
        category_code: 'contract',
      }),
    ).toBe('people/abc/contract/');
  });

  it('leaves an unknown placeholder verbatim rather than blanking it', () => {
    // A path silently missing a segment files documents into the wrong folder
    // and nobody notices; `{persn_id}` in a folder listing is a typo somebody
    // fixes.
    expect(expandPathPattern('people/{persn_id}/', { person_id: 'abc' })).toBe(
      'people/{persn_id}/',
    );
  });
});

describe('the client ships inert when Graph is not configured', () => {
  it('exposes that as a question the filing handler can ask', async () => {
    // `.env.test` sets placeholder GRAPH_* values, so this asserts the shape of
    // the contract rather than a particular environment's answer: the handler
    // asks, and treats "no" as "filing is not configured yet" (§12.2 Q4, R1).
    const { isGraphConfigured } = await import('./graph-client.js');
    expect(typeof isGraphConfigured()).toBe('boolean');
    expect(vi.isMockFunction(isGraphConfigured)).toBe(false);
  });
});
