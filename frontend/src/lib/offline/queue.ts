/**
 * The offline sale queue: what the till has rung up that the server has not got.
 *
 * ## The one job
 *
 * When `POST /sales` cannot reach the server, the sale is not lost and not
 * retried in a tight loop — it is put here, with the `clientSaleId` it was minted
 * with, and replayed later. That id is the whole safety mechanism: `sales` has a
 * unique `client_sale_id` constraint, so a replay of a sale that *did* reach the
 * server comes back `200 { replayed: true }` rather than ringing it up twice. The
 * queue stores the exact `CreateSaleBody` the till built and replays it verbatim;
 * it never re-mints the id, because a fresh id per attempt is a second sale, not a
 * retry.
 *
 * ## What may be queued, and the line that must not be crossed
 *
 * Only a request the server never answered. `ApiError.isOffline` is `kind ===
 * 'network'` and nothing else — a 401, a 403, a 409 and a 500 are all *answers*,
 * and BRIEF.md's landmine 3 is that a 500 is not an offline signal. `flushQueue`
 * therefore treats the two cases oppositely:
 *
 * - **network** → the sale is requeued (still `queued`, no blame attached) and the
 *   flush *stops*, because hammering a server that is down helps nobody and the
 *   next item would fail the same way.
 * - **an answer** → the sale is marked `failed` with the server's own words, and
 *   the flush *continues* to the next item, because one sale the server refused
 *   (out of stock, a dead session) says nothing about the next. A `failed` item is
 *   a decision for the operator on `/sync` — retry or discard — and is never
 *   silently retried forever, which is what a queue that requeued a 409 would do.
 *
 * ## Why a store over a port, and not IndexedDB directly
 *
 * The state lives in a zustand vanilla store so React can subscribe to the depth
 * for the offline indicator and `/sync` can render the list, and so all of it is
 * testable with `memoryQueue()` and no browser — `src/test/setup.ts` has no
 * IndexedDB fake on purpose. `QueuePort` is the persistence seam; `idbQueue` binds
 * it to disk. State mutations are synchronous (the counter sees "queued" the
 * instant it happens) and each persists behind them, the same optimistic-then-
 * durable split `auth-session.ts` uses.
 */

import { createStore, type StoreApi } from 'zustand/vanilla';

import { ApiError, type ApiClient } from '../api-client';
import { apiErrorMessage } from '../api-error-message';
import type { CreateSaleBody, CreateSaleResult } from '../api-types';
import { QUEUE_STORE, idbAvailable, idbClear, idbDelete, idbGetAll, idbPut } from './idb';
import type { OfflineTotal } from './offline-pricing';

/**
 * A sale that may be queued: a `CreateSaleBody` that definitely carries its
 * `clientSaleId`.
 *
 * The intersection is the point. `CreateSaleBody.clientSaleId` is optional on the
 * wire, but a sale without one cannot be made idempotent, and queueing it would be
 * queueing a sale that replays as a duplicate. Requiring it in the type means the
 * till cannot enqueue an unsafe sale by forgetting the id — the compiler refuses.
 */
export type QueueableSale = CreateSaleBody & { clientSaleId: string };

/**
 * Where a queued sale is in its life.
 *
 * - `queued` — waiting for connectivity, or never attempted. Needs nothing but a
 *   network.
 * - `sending` — a replay is in flight right now. Transient; normalized back to
 *   `queued` on hydrate, because a flush interrupted by a closed tab did not
 *   finish and the `clientSaleId` makes restarting it safe.
 * - `failed` — the server *answered* and refused. Needs an operator decision on
 *   `/sync`: retry or discard. Distinct from `queued` precisely so the UI does not
 *   present a refusal as something that will resolve on its own.
 */
export type QueuedSaleStatus = 'queued' | 'sending' | 'failed';

export interface QueuedSale {
  /** The idempotency key, and this store's key. Never re-minted. */
  clientSaleId: string;
  /** The exact body `POST /sales` takes, replayed verbatim. */
  body: QueueableSale;
  /** Epoch milliseconds, when the till queued it. Orders the `/sync` list. */
  queuedAt: number;
  /**
   * The total the customer was asked for offline, in pesewas. Shown on `/sync` and
   * the provisional receipt. There is deliberately no tax split beside it — see
   * `offline-pricing.ts`; the breakdown is the server's to state once it records
   * the sale.
   */
  provisionalTotalPesewas: number;
  lineCount: number;
  /** A short human label — the first product and how many more — for the list. */
  summary: string;
  status: QueuedSaleStatus;
  /** How many replay attempts have been made. Never a retry limit; see `failed`. */
  attempts: number;
  /** Why the last attempt was refused, in words for the counter. Null unless `failed`. */
  lastError: string | null;
}

/** Everything needed to enqueue, decided by the till at the moment of the sale. */
export interface QueuedSaleDraft {
  sale: QueueableSale;
  /** The offline money: a total and a null split. */
  provisional: OfflineTotal;
  lineCount: number;
  summary: string;
}

export interface SaleQueueState {
  /** Oldest first, which is the order `flushQueue` replays in. */
  items: QueuedSale[];
  /** False until the persisted queue has been read back at boot. */
  hydrated: boolean;
}

/** The persistence seam. `memoryQueue` for tests, `idbQueue` for the app. */
export interface QueuePort {
  load(): Promise<QueuedSale[]>;
  put(item: QueuedSale): Promise<void>;
  remove(clientSaleId: string): Promise<void>;
  clear(): Promise<void>;
}

export interface SaleQueue {
  store: StoreApi<SaleQueueState>;
  /** Reads the persisted queue back. Called once at boot, before the depth is shown. */
  hydrate(): Promise<void>;
  /** Adds a sale. A repeat of an id already queued is ignored, not duplicated. */
  enqueue(draft: QueuedSaleDraft): QueuedSale;
  /** Back to `queued` after a network failure — the server never answered. */
  requeue(clientSaleId: string): void;
  markSending(clientSaleId: string): void;
  /** The server answered and refused. `error` is shown to the operator verbatim. */
  markFailed(clientSaleId: string, error: string): void;
  /** Out of the queue for good. A successful sync and an explicit discard both call this. */
  remove(clientSaleId: string): void;
  /** How many sales are waiting — what the offline indicator shows. */
  depth(): number;
  list(): QueuedSale[];
}

/** An in-memory `QueuePort`. What every test uses. */
export function memoryQueue(): QueuePort {
  const rows = new Map<string, QueuedSale>();
  return {
    async load(): Promise<QueuedSale[]> {
      return [...rows.values()];
    },
    async put(item: QueuedSale): Promise<void> {
      rows.set(item.clientSaleId, item);
    },
    async remove(clientSaleId: string): Promise<void> {
      rows.delete(clientSaleId);
    },
    async clear(): Promise<void> {
      rows.clear();
    },
  };
}

/** The IndexedDB-backed `QueuePort`, over the guarded binding in `idb.ts`. */
export function idbQueue(): QueuePort {
  return {
    async load(): Promise<QueuedSale[]> {
      return idbGetAll<QueuedSale>(QUEUE_STORE);
    },
    async put(item: QueuedSale): Promise<void> {
      await idbPut(QUEUE_STORE, item);
    },
    async remove(clientSaleId: string): Promise<void> {
      await idbDelete(QUEUE_STORE, clientSaleId);
    },
    async clear(): Promise<void> {
      await idbClear(QUEUE_STORE);
    },
  };
}

/** Oldest first, so a replay records sales in the order the counter made them. */
function byQueuedAt(items: readonly QueuedSale[]): QueuedSale[] {
  return [...items].sort((a, b) => a.queuedAt - b.queuedAt);
}

export function createSaleQueue(port: QueuePort): SaleQueue {
  const store = createStore<SaleQueueState>()(() => ({ items: [], hydrated: false }));

  /**
   * Applies a change to one item in the store and persists the result.
   *
   * State is updated synchronously so React sees it immediately; the write to disk
   * follows. A persist that fails is swallowed on purpose — the in-memory queue
   * still works for this session, and refusing to ring up a sale at the counter
   * because a background write failed is the worse failure. The honest limit (a
   * reload loses an unpersisted sale) is the same one `browserRefreshTokenStorage`
   * accepts for a full `localStorage`.
   */
  function update(clientSaleId: string, change: (item: QueuedSale) => QueuedSale): void {
    const current = store.getState().items;
    let updated: QueuedSale | null = null;
    const items = current.map((item) => {
      if (item.clientSaleId !== clientSaleId) return item;
      updated = change(item);
      return updated;
    });
    store.setState({ items });
    if (updated !== null) {
      const persisted = updated as QueuedSale;
      void port.put(persisted).catch(() => {});
    }
  }

  return {
    store,

    async hydrate(): Promise<void> {
      let loaded: QueuedSale[];
      try {
        loaded = await port.load();
      } catch {
        // A disk that cannot be read at boot must not strand the till. Start empty
        // in memory; the operator can still sell, and this session's sales queue
        // in memory. What was on disk before is not pretended away — it simply
        // could not be read, and the alternative (throwing) would leave the till
        // showing no queue at all with no way to recover it.
        loaded = [];
      }
      // A flush interrupted by a closed tab leaves items persisted as `sending`;
      // they did not finish, so they come back as `queued` and replay from the
      // top. Safe because the `clientSaleId` makes a replay idempotent.
      const items = byQueuedAt(
        loaded.map((item) => (item.status === 'sending' ? { ...item, status: 'queued' } : item))
      );
      store.setState({ items, hydrated: true });
    },

    enqueue(draft: QueuedSaleDraft): QueuedSale {
      const existing = store
        .getState()
        .items.find((item) => item.clientSaleId === draft.sale.clientSaleId);
      // A double-tap on Record, or a retry of an enqueue that already succeeded,
      // must not put the same sale in twice. The id is the dedupe key on the server
      // and here.
      if (existing !== undefined) return existing;

      const item: QueuedSale = {
        clientSaleId: draft.sale.clientSaleId,
        body: draft.sale,
        queuedAt: Date.now(),
        provisionalTotalPesewas: draft.provisional.totalPesewas,
        lineCount: draft.lineCount,
        summary: draft.summary,
        status: 'queued',
        attempts: 0,
        lastError: null,
      };
      store.setState({ items: [...store.getState().items, item] });
      void port.put(item).catch(() => {});
      return item;
    },

    requeue(clientSaleId: string): void {
      // `lastError` is cleared: a network failure is not the sale's fault and there
      // is nothing for the operator to decide, so it must not sit in the `failed`
      // list looking like a refusal.
      update(clientSaleId, (item) => ({ ...item, status: 'queued', lastError: null }));
    },

    markSending(clientSaleId: string): void {
      update(clientSaleId, (item) => ({ ...item, status: 'sending', attempts: item.attempts + 1 }));
    },

    markFailed(clientSaleId: string, error: string): void {
      update(clientSaleId, (item) => ({ ...item, status: 'failed', lastError: error }));
    },

    remove(clientSaleId: string): void {
      store.setState({
        items: store.getState().items.filter((item) => item.clientSaleId !== clientSaleId),
      });
      void port.remove(clientSaleId).catch(() => {});
    },

    depth(): number {
      return store.getState().items.length;
    },

    list(): QueuedSale[] {
      return store.getState().items;
    },
  };
}

/** What one `flushQueue` run did, so the caller can say it plainly. */
export interface FlushResult {
  /** Sales the server accepted (new or `replayed`). */
  sent: number;
  /** Sales the server answered and refused — now `failed`, needing a decision. */
  failed: number;
  /** True when the flush stopped because the server could not be reached. */
  stoppedOffline: boolean;
  /** True when the flush stopped because the session is dead and needs signing in. */
  stoppedUnauthenticated: boolean;
}

/**
 * How one sale's replay ended. The five answers the honesty rules allow, and no
 * others: the server took it (`sent`), the server recognised it from a lost
 * response (`replayed`), the server refused it (`failed`), the server could not be
 * reached (`offline`), or the session is dead (`unauthenticated`). `flushQueue`
 * turns these into stop/continue; `/sync` shows them to the operator.
 */
export type ReplayOutcome = 'sent' | 'replayed' | 'failed' | 'offline' | 'unauthenticated';

/**
 * Replays one queued sale and records what came back.
 *
 * The single place the honesty table lives, so a per-item Retry on `/sync` and a
 * whole-queue flush cannot drift apart. The `api` is passed in rather than reached
 * for, so a test drives every branch against a fake client and no browser.
 *
 * - **network** (`isOffline`) → requeued, no blame attached. The server never
 *   answered, so this is not a refusal and the sale is simply still waiting.
 * - **dead session** → failed with the words "sign in again", because nothing can
 *   be recorded until somebody does.
 * - **any other answer** (409, 400, 500) → failed with the server's own message.
 *   A 500 lands here and not in the offline branch: BRIEF.md landmine 3 is that a
 *   500 is an answer, and queueing it as offline would retry a server fault
 *   forever while telling the counter its sale was safely held.
 */
export async function replaySale(
  api: ApiClient,
  queue: SaleQueue,
  clientSaleId: string
): Promise<ReplayOutcome> {
  const item = queue.list().find((queued) => queued.clientSaleId === clientSaleId);
  // Already gone — a concurrent flush sent it, or it was discarded. Nothing to do,
  // and reporting `sent` rather than an error keeps a double-click on Retry honest.
  if (item === undefined) return 'sent';

  queue.markSending(clientSaleId);
  try {
    // The same body, the same `clientSaleId`. If this sale actually reached the
    // server before the connection dropped, the answer is `replayed: true` and
    // stock was not taken twice — which is the entire reason the id exists.
    const result = await api.post<CreateSaleResult>('/sales', item.body);
    queue.remove(clientSaleId);
    return result.replayed ? 'replayed' : 'sent';
  } catch (error) {
    if (error instanceof ApiError && error.isOffline) {
      queue.requeue(clientSaleId);
      return 'offline';
    }
    if (error instanceof ApiError && error.isAuthentication) {
      queue.markFailed(clientSaleId, 'Sign in again to sync this sale.');
      return 'unauthenticated';
    }
    queue.markFailed(clientSaleId, apiErrorMessage(error, 'Could not record this sale.'));
    return 'failed';
  }
}

/**
 * Replays every waiting sale, oldest first, until the queue is empty or the reason
 * to stop is one that would make every remaining item fail the same way.
 */
export async function flushQueue(api: ApiClient, queue: SaleQueue): Promise<FlushResult> {
  const result: FlushResult = {
    sent: 0,
    failed: 0,
    stoppedOffline: false,
    stoppedUnauthenticated: false,
  };

  // A snapshot: `replaySale` mutates the store as we go, and iterating a live array
  // that is being spliced is how an item gets skipped.
  const pending = queue.list().filter((item) => item.status !== 'sending');

  for (const item of pending) {
    const outcome = await replaySale(api, queue, item.clientSaleId);
    if (outcome === 'sent' || outcome === 'replayed') {
      result.sent += 1;
      continue;
    }
    if (outcome === 'offline') {
      // Could not reach the server, so every remaining sale would fail identically.
      // Stop rather than hammer a server the till has just been told is down.
      result.stoppedOffline = true;
      break;
    }
    if (outcome === 'unauthenticated') {
      // Nothing more can be recorded until somebody signs in again.
      result.stoppedUnauthenticated = true;
      break;
    }
    // A refusal about *this* sale says nothing about the next, so carry on.
    result.failed += 1;
  }

  return result;
}

// --- The app's one queue ----------------------------------------------------

let queue: SaleQueue | null = null;

/**
 * The queue the app uses: IndexedDB where it exists, memory where it does not.
 *
 * Created on first use, so importing this module during a server render or in a
 * test touches no browser storage — the rule `getAuthSession()` follows. Not
 * hydrated here: `hydrate()` is async and a getter cannot be, so the app calls it
 * once at boot (the offline indicator does) before it trusts `depth()`.
 */
export function getSaleQueue(): SaleQueue {
  if (queue === null) {
    queue = createSaleQueue(idbAvailable() ? idbQueue() : memoryQueue());
  }
  return queue;
}

/** Drops the singleton. Tests use it; the app never needs to. */
export function resetSaleQueue(): void {
  queue = null;
}
