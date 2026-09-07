/**
 * The offline sale queue and its replay, against the in-memory port and a scripted
 * fake `ApiClient`.
 *
 * The heart of this suite is the honesty table at the bottom: BRIEF.md §4.5 and
 * landmine 3 say only a server that could not be reached puts a sale back in the
 * queue, while a 409, a 500 and a 401 are answers that must surface as failures
 * and never as "you are offline, your sale is queued". Each of those is a separate
 * test, written to fail if the two cases are ever flattened together.
 */

import { ApiError, type ApiClient } from '../../api-client';
import {
  createSaleQueue,
  flushQueue,
  memoryQueue,
  replaySale,
  type QueuedSale,
  type QueuedSaleDraft,
  type QueuePort,
  type QueueableSale,
} from '../queue';

/** Lets the fire-and-forget persistence behind a synchronous mutation settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function draft(
  clientSaleId: string,
  overrides: Partial<QueuedSaleDraft> = {}
): QueuedSaleDraft {
  const sale: QueueableSale = {
    clientSaleId,
    lines: [{ productId: 'prod-1', quantity: 2 }],
    payments: [{ method: 'cash', amount: '25.00' }],
  };
  return {
    sale,
    provisional: { totalPesewas: 2500, taxSplit: null },
    lineCount: 1,
    summary: 'Paracetamol 500mg',
    ...overrides,
  };
}

/** A persisted row, for seeding a port before `hydrate()`. */
function persisted(
  clientSaleId: string,
  queuedAt: number,
  status: QueuedSale['status']
): QueuedSale {
  return {
    clientSaleId,
    body: { clientSaleId, lines: [{ productId: 'prod-1', quantity: 1 }] },
    queuedAt,
    provisionalTotalPesewas: 1000,
    lineCount: 1,
    summary: clientSaleId,
    status,
    attempts: status === 'queued' ? 0 : 1,
    lastError: null,
  };
}

type Outcome = { ok: true; replayed?: boolean } | { ok: false; error: unknown };

/** A fake client whose `post` replays scripted outcomes and records every call. */
function scriptedApi(outcomes: Outcome[]): {
  api: ApiClient;
  calls: Array<{ path: string; body: unknown }>;
} {
  const calls: Array<{ path: string; body: unknown }> = [];
  let index = 0;
  const post = async (path: string, body?: unknown): Promise<unknown> => {
    calls.push({ path, body });
    const outcome = outcomes[index];
    index += 1;
    if (outcome === undefined) {
      throw new Error('the fake api was called more times than it was scripted for');
    }
    if (outcome.ok) {
      return { detail: { sale: { id: 'sale-row' } }, replayed: outcome.replayed ?? false };
    }
    throw outcome.error;
  };
  return { api: { post } as unknown as ApiClient, calls };
}

const NETWORK = new ApiError('network', 'Cannot reach the API. Check the connection and try again.', {
  code: 'network_error',
});
const SHORT_DRAWER = new ApiError('http', 'Not enough stock: Paracetamol — 1 short', {
  status: 409,
  code: 'short_drawer',
});
const SERVER_FAULT = new ApiError('http', 'Request failed with 500', { status: 500 });
const SESSION_ENDED = new ApiError('http', 'This session has ended', {
  status: 401,
  code: 'token_invalid',
});

describe('the sale queue', () => {
  it('enqueues a sale as queued, at the depth the indicator reads', () => {
    const queue = createSaleQueue(memoryQueue());
    expect(queue.depth()).toBe(0);

    const item = queue.enqueue(draft('sale-1'));

    expect(item.status).toBe('queued');
    expect(item.clientSaleId).toBe('sale-1');
    expect(item.provisionalTotalPesewas).toBe(2500);
    expect(queue.depth()).toBe(1);
    expect(queue.list()).toHaveLength(1);
  });

  it('does not enqueue the same clientSaleId twice — a double-tap is one sale', () => {
    const queue = createSaleQueue(memoryQueue());
    queue.enqueue(draft('sale-1'));
    queue.enqueue(draft('sale-1'));

    expect(queue.depth()).toBe(1);
  });

  it('persists an enqueued sale so it survives a reload', async () => {
    const port = memoryQueue();
    const queue = createSaleQueue(port);
    queue.enqueue(draft('sale-1'));

    await settle();
    const onDisk = await port.load();
    expect(onDisk.map((item) => item.clientSaleId)).toEqual(['sale-1']);
  });

  it('removes a sale from the store and from disk', async () => {
    const port: QueuePort = memoryQueue();
    const queue = createSaleQueue(port);
    queue.enqueue(draft('sale-1'));
    await settle();

    queue.remove('sale-1');
    await settle();

    expect(queue.depth()).toBe(0);
    expect(await port.load()).toEqual([]);
  });

  it('hydrates oldest-first and turns an interrupted send back into queued', async () => {
    const port = memoryQueue();
    // Persisted out of order, and one left as `sending` by a tab that closed
    // mid-flush. It did not finish, so it comes back as `queued` and replays from
    // the top — safe because the clientSaleId makes a replay idempotent.
    await port.put(persisted('later', 200, 'sending'));
    await port.put(persisted('earlier', 100, 'queued'));

    const queue = createSaleQueue(port);
    await queue.hydrate();

    expect(queue.list().map((item) => item.clientSaleId)).toEqual(['earlier', 'later']);
    expect(queue.list().find((item) => item.clientSaleId === 'later')?.status).toBe('queued');
    expect(queue.store.getState().hydrated).toBe(true);
  });
});

describe('replaySale — one Retry button on /sync', () => {
  it('sends only the sale it was asked about and leaves the others queued', async () => {
    const queue = createSaleQueue(memoryQueue());
    queue.enqueue(draft('sale-1'));
    queue.enqueue(draft('sale-2'));
    const { api, calls } = scriptedApi([{ ok: true }]);

    const outcome = await replaySale(api, queue, 'sale-2');

    // The whole point of a per-item Retry: the operator chose *this* sale, so the
    // refused one next to it must not be swept along and failed again.
    expect(outcome).toBe('sent');
    expect(calls).toHaveLength(1);
    expect((calls[0]?.body as QueueableSale).clientSaleId).toBe('sale-2');
    expect(queue.list().map((item) => item.clientSaleId)).toEqual(['sale-1']);
  });

  it('requeues and reports offline when the server could not be reached', async () => {
    const queue = createSaleQueue(memoryQueue());
    queue.enqueue(draft('sale-1'));
    const { api } = scriptedApi([{ ok: false, error: NETWORK }]);

    const outcome = await replaySale(api, queue, 'sale-1');

    expect(outcome).toBe('offline');
    const item = queue.list().find((queued) => queued.clientSaleId === 'sale-1');
    expect(item?.status).toBe('queued');
    expect(item?.lastError).toBeNull();
  });

  it('reports a sale that is already gone as sent, without calling the server', async () => {
    const queue = createSaleQueue(memoryQueue());
    queue.enqueue(draft('sale-1'));
    const { api, calls } = scriptedApi([]);

    queue.remove('sale-1');
    // A double-click on Retry, or a concurrent flush that got there first. The sale
    // is not waiting any more, which is the outcome the button promised.
    const outcome = await replaySale(api, queue, 'sale-1');

    expect(outcome).toBe('sent');
    expect(calls).toHaveLength(0);
  });
});

describe('flushQueue — the honesty table', () => {
  it('replays the exact body and the same clientSaleId, then removes the sale', async () => {
    const queue = createSaleQueue(memoryQueue());
    queue.enqueue(draft('sale-1'));
    const { api, calls } = scriptedApi([{ ok: true }]);

    const result = await flushQueue(api, queue);

    expect(result.sent).toBe(1);
    expect(queue.depth()).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/sales');
    // The idempotency key is the whole mechanism: a replay must carry the id it was
    // minted with, or the server records a second sale instead of recognising this one.
    expect((calls[0]?.body as QueueableSale).clientSaleId).toBe('sale-1');
  });

  it('accepts a replayed sale the server had already recorded', async () => {
    const queue = createSaleQueue(memoryQueue());
    queue.enqueue(draft('sale-1'));
    const { api } = scriptedApi([{ ok: true, replayed: true }]);

    const result = await flushQueue(api, queue);

    // `replayed: true` is a success, not an error: the sale that lost its response
    // did reach the server, and stock was not taken twice.
    expect(result.sent).toBe(1);
    expect(queue.depth()).toBe(0);
  });

  it('requeues and stops when the server could not be reached', async () => {
    const queue = createSaleQueue(memoryQueue());
    queue.enqueue(draft('sale-1'));
    queue.enqueue(draft('sale-2'));
    const { api, calls } = scriptedApi([{ ok: false, error: NETWORK }]);

    const result = await flushQueue(api, queue);

    expect(result.stoppedOffline).toBe(true);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    // Stopped after the first: hammering a server that is down helps nobody, and
    // sale-2 would fail identically, so it is not even attempted.
    expect(calls).toHaveLength(1);
    expect(queue.depth()).toBe(2);

    const first = queue.list().find((item) => item.clientSaleId === 'sale-1');
    // Back to queued with no blame attached — the network failed, not the sale.
    expect(first?.status).toBe('queued');
    expect(first?.lastError).toBeNull();
    expect(first?.attempts).toBe(1);
  });

  it('marks a 409 failed with the server’s words and carries on to the next sale', async () => {
    const queue = createSaleQueue(memoryQueue());
    queue.enqueue(draft('sale-1'));
    queue.enqueue(draft('sale-2'));
    const { api, calls } = scriptedApi([{ ok: false, error: SHORT_DRAWER }, { ok: true }]);

    const result = await flushQueue(api, queue);

    // A refusal is an answer about *this* sale, so the next is still worth trying.
    expect(calls).toHaveLength(2);
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.stoppedOffline).toBe(false);

    const refused = queue.list().find((item) => item.clientSaleId === 'sale-1');
    expect(refused?.status).toBe('failed');
    expect(refused?.lastError).toBe('Not enough stock: Paracetamol — 1 short');
    // The accepted one is gone; only the refusal is left for the operator.
    expect(queue.list().map((item) => item.clientSaleId)).toEqual(['sale-1']);
  });

  it('treats a 500 as a failure, never as an offline state', async () => {
    // BRIEF.md landmine 3: a 500 is not an offline signal. Were it queued as
    // offline, the till would say "your sale is queued" while nothing was written
    // anywhere and the queue silently retried a server fault forever.
    const queue = createSaleQueue(memoryQueue());
    queue.enqueue(draft('sale-1'));
    const { api } = scriptedApi([{ ok: false, error: SERVER_FAULT }]);

    const result = await flushQueue(api, queue);

    expect(result.stoppedOffline).toBe(false);
    expect(result.failed).toBe(1);
    const item = queue.list().find((queued) => queued.clientSaleId === 'sale-1');
    expect(item?.status).toBe('failed');
    expect(item?.lastError).not.toBeNull();
  });

  it('stops on a dead session rather than failing every sale one by one', async () => {
    const queue = createSaleQueue(memoryQueue());
    queue.enqueue(draft('sale-1'));
    queue.enqueue(draft('sale-2'));
    const { api, calls } = scriptedApi([{ ok: false, error: SESSION_ENDED }]);

    const result = await flushQueue(api, queue);

    expect(result.stoppedUnauthenticated).toBe(true);
    expect(calls).toHaveLength(1);
    const first = queue.list().find((item) => item.clientSaleId === 'sale-1');
    expect(first?.status).toBe('failed');
    expect(first?.lastError).toBe('Sign in again to sync this sale.');
    // sale-2 was never attempted; it is still queued, waiting for a live session.
    expect(queue.list().find((item) => item.clientSaleId === 'sale-2')?.status).toBe('queued');
  });
});
