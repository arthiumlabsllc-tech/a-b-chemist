'use client';

import { useEffect } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { BACKGROUND_SYNC_TAG, getBackgroundSync } from '@/lib/offline/background-sync';
import { flushQueue, getSaleQueue } from '@/lib/offline/queue';
import type { ApiClient } from '@/lib/api-client';
import type { SaleQueue } from '@/lib/offline/queue';

/**
 * Reconciles the offline queue: reads it back at boot, then replays it whenever
 * the chance to succeed appears.
 *
 * Mounted once inside the auth boundary (in `AppShell`), so there is a session and
 * an authenticated `api` to replay through. A component rather than a call at
 * module scope for the reason `SessionBootstrap` gives: importing this must not
 * touch IndexedDB or start a request.
 *
 * ## When it flushes, and why not on a timer
 *
 * On boot once the persisted queue is back and the browser reports a network; on
 * the `online` event; and on a message from the service worker's background-sync
 * handoff. Never on a timer. BRIEF.md §4.5 is that a queued item is retried or
 * explicitly discarded, "never silently retried forever" — a polling flush is
 * exactly that, and it would hammer a server the till has already been told is
 * down. The three triggers here are all "the situation changed", which is the only
 * honest reason to try again.
 *
 * The third trigger only arrives because this component also asks for it: see
 * `background-sync.ts`, which registers the tag whenever the queue holds something.
 * Without that the worker's `sync` listener never fires and a discarded tab keeps
 * its sales until somebody opens it.
 *
 * ## Why one flush at a time
 *
 * `online`, the boot flush and a service-worker message can land close together.
 * Concurrent flushes are *safe* — `flushQueue` skips items already `sending`, and
 * the `clientSaleId` makes even a genuine double-post come back `replayed` rather
 * than a second sale — but they waste requests against a server that may still be
 * struggling. The guard makes it one at a time without changing what correctness
 * depends on.
 */

let hydrateStarted = false;
let flushInFlight = false;

async function runFlush(api: ApiClient, queue: SaleQueue): Promise<void> {
  if (flushInFlight) return;
  flushInFlight = true;
  try {
    await flushQueue(api, queue);
  } finally {
    flushInFlight = false;
  }
}

/** Lets a test observe the once-only behaviour. The app never calls it. */
export function resetOfflineSync(): void {
  hydrateStarted = false;
  flushInFlight = false;
}

export function OfflineSync() {
  const { api } = useAuth();

  useEffect(() => {
    const queue = getSaleQueue();

    if (!hydrateStarted) {
      hydrateStarted = true;
      // Read the persisted queue back before trusting `depth()`, then flush if the
      // browser already reports a network — a tablet that regained signal while it
      // was closed reconciles the moment it is opened, without the operator
      // having to find the Sync page.
      void queue.hydrate().then(() => {
        if (typeof navigator !== 'undefined' && navigator.onLine) {
          void runFlush(api, queue);
        }
      });
    }

    const onOnline = () => {
      void runFlush(api, queue);
    };

    const onWorkerMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown } | null;
      if (data !== null && data.type === BACKGROUND_SYNC_TAG) {
        void runFlush(api, queue);
      }
    };

    window.addEventListener('online', onOnline);
    // Optional-chained: there is no service worker in development (the registrar
    // is production-only) or on a browser without one, and the `online` listener
    // above already covers those. The worker handoff is the extra path that wakes
    // a backgrounded tab, not the only one.
    navigator.serviceWorker?.addEventListener('message', onWorkerMessage);

    return () => {
      window.removeEventListener('online', onOnline);
      navigator.serviceWorker?.removeEventListener('message', onWorkerMessage);
    };
  }, [api]);

  // Kept out of the effect above on purpose: arming the wake-up depends on the
  // queue and on nothing else, so an `api` that changes identity would otherwise
  // tear down and rebuild this subscription for a reason that has nothing to do
  // with it.
  useEffect(() => {
    const queue = getSaleQueue();
    const sync = getBackgroundSync();

    // Every change, not just the empty-to-non-empty transition. A one-shot sync is
    // consumed when the browser fires it, so a flush that failed because the server
    // was still down has to ask again — and at that point the depth is unchanged,
    // which is what makes the obvious dedupe by depth drop the one re-arming that
    // matters. `register` is idempotent, so the repeats cost nothing but a promise.
    const reconcile = () => {
      void sync.reconcile(queue.depth());
    };

    reconcile();
    return queue.store.subscribe(reconcile);
  }, []);

  return null;
}
