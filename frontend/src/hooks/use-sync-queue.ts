'use client';

import { useSyncExternalStore } from 'react';

import { getSaleQueue, type SaleQueueState } from '@/lib/offline/queue';

/**
 * The offline queue and the connection, as React state.
 *
 * Two subscriptions the offline indicator and `/sync` both need, kept beside the
 * queue they read so the components do not each re-derive them. This file is the
 * only place the queue's vanilla store meets React, exactly as `use-auth.ts` is
 * the only place the session's does — and for the same three reasons: a server
 * render must not touch the singleton, the server snapshot must be a stable empty
 * value, and the subscription has to be torn down cleanly.
 */

/**
 * The state reported while rendering on the server and during hydration.
 *
 * Empty and `hydrated: false`, which is the truth: the server holds no queue. A
 * module-level constant rather than a fresh object, because React requires
 * `getServerSnapshot` to return a cached value and a new object each call makes it
 * re-render forever.
 */
const SERVER_STATE: SaleQueueState = { items: [], hydrated: false };

/** The queue on the client, and null anywhere else. */
function resolveQueue() {
  if (typeof window === 'undefined') return null;
  return getSaleQueue();
}

function subscribeQueue(onStoreChange: () => void): () => void {
  return resolveQueue()?.store.subscribe(onStoreChange) ?? (() => {});
}

function getQueueSnapshot(): SaleQueueState {
  return resolveQueue()?.store.getState() ?? SERVER_STATE;
}

function getQueueServerSnapshot(): SaleQueueState {
  return SERVER_STATE;
}

/**
 * The queued sales, oldest first, and whether the persisted queue has been read
 * back yet.
 *
 * `hydrated` matters for honesty: before it is true the list is empty because
 * nothing has been loaded, not because nothing is queued, and a component that
 * showed "all synced" in that window would be wrong. The indicator waits for it.
 */
export function useSyncQueue(): SaleQueueState {
  return useSyncExternalStore(subscribeQueue, getQueueSnapshot, getQueueServerSnapshot);
}

function subscribeOnline(onStoreChange: () => void): () => void {
  window.addEventListener('online', onStoreChange);
  window.addEventListener('offline', onStoreChange);
  return () => {
    window.removeEventListener('online', onStoreChange);
    window.removeEventListener('offline', onStoreChange);
  };
}

/**
 * Whether the browser thinks it can reach the network.
 *
 * `navigator.onLine` is a hint, not a promise — it reports true behind a captive
 * portal that answers nothing — so this drives the *indicator* and never a
 * decision about whether a sale was recorded. That decision is `ApiError.isOffline`,
 * which is set only by a request that actually failed to connect. The server
 * snapshot is `true`: a server render is never offline, and saying so avoids a
 * hydration flip on every load.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true
  );
}
