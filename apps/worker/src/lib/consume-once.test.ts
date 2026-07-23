import { describe, expect, it, vi } from 'vitest';
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '@repo/db';
import { consumeOnce } from './consume-once.js';

/** A db whose `transaction().execute(cb)` runs `cb` with a sentinel trx. */
const SENTINEL_TRX = { marker: 'trx' } as unknown as Transaction<DB>;
function fakeDb(): Kysely<DB> {
  return {
    transaction: () => ({ execute: (cb: (trx: Transaction<DB>) => unknown) => cb(SENTINEL_TRX) }),
  } as unknown as Kysely<DB>;
}

describe('consumeOnce', () => {
  it('runs the work once when the event is new', async () => {
    const fn = vi.fn(async () => {});
    const record = vi.fn(async () => true);

    const ran = await consumeOnce(fakeDb(), 'pilot-demo', 'e1', fn, record);

    expect(ran).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(SENTINEL_TRX, 'pilot-demo', 'e1');
  });

  it('skips the work on a duplicate delivery', async () => {
    const fn = vi.fn(async () => {});
    const record = vi.fn(async () => false);

    const ran = await consumeOnce(fakeDb(), 'pilot-demo', 'e1', fn, record);

    expect(ran).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs the work on the same transaction as the dedupe insert', async () => {
    const record = vi.fn(async () => true);
    let trxSeen: unknown;

    await consumeOnce(
      fakeDb(),
      'pilot-demo',
      'e1',
      async (trx) => {
        trxSeen = trx;
      },
      record,
    );

    expect(trxSeen).toBe(SENTINEL_TRX);
  });
});
