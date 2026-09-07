'use client';

import Link from 'next/link';

import { ErrorNotice, StatusNotice, WarningNotice } from '@/components/ui/display';
import { useAuth } from '@/hooks/use-auth';
import { useOnline, useSyncQueue } from '@/hooks/use-sync-queue';
import { saleWord } from '@/lib/offline/sync-words';

/**
 * The honest offline indicator BRIEF.md §4.5 asks for: driven by the real queue,
 * never by a guess.
 *
 * ## What it reads, and what it deliberately does not
 *
 * The count is `useSyncQueue().items.length` — the sales actually persisted on this
 * device — not `navigator.onLine` on its own. `onLine` only chooses the wording.
 * That ordering is the point of the rule: an indicator driven by the connection
 * flag says "offline" behind a captive portal that answers nothing and "online"
 * with a queue of unsent sales sitting unseen. Driven by the queue, it says the
 * thing that matters — how many sales have not reached the server — whether or not
 * the browser thinks it is connected.
 *
 * ## The four things it can say
 *
 * Each is an independent fact, so they stack rather than compete — an operator
 * restarting a tablet during an outage is told all of the ones that are true.
 *
 * - **Unconfirmed session** (a warning): this session was restored from the
 *   device's cache because the server could not be reached, so the name on screen
 *   has not been checked. `auth-session.ts` gives the reasoning; this is where it
 *   stops being a private fact about the store.
 * - **Failed** (an error): the server *answered* and refused one or more sales.
 *   These need a decision, and they are never dressed as "still syncing" or as an
 *   outage — a refusal is a different problem with a different remedy.
 * - **Offline** (a warning): the connection is down; sales are being held here.
 * - **Syncing** (neutral): back online with sales still queued, on their way.
 *
 * Before the persisted queue has been read back (`hydrated` is false) it does not
 * claim a count, because an empty list then means "not loaded yet", not "nothing
 * queued" — the same distinction the queue's `hydrated` flag exists to keep.
 */

export function OfflineIndicator() {
  const online = useOnline();
  const { items, hydrated } = useSyncQueue();
  // Renamed at the door: `offline` on the session is about authority, and calling
  // it `offline` next to `navigator.onLine` in the same function invites exactly the
  // confusion the two flags being separate is meant to prevent.
  const { offline: unconfirmed } = useAuth();

  const depth = items.length;
  const failed = items.filter((item) => item.status === 'failed').length;

  // Connected and nothing waiting: the common case, and it says nothing at all.
  if (online && depth === 0 && !unconfirmed) {
    return null;
  }

  return (
    <div className="space-y-2 border-b border-surface-200 px-4 py-3 sm:px-6">
      {unconfirmed && (
        <WarningNotice>
          Signed in from this device — the server could not be reached to confirm
          who you are. Sales you ring up are held here, and are checked against the
          server when the connection returns.
        </WarningNotice>
      )}

      {failed > 0 && (
        <ErrorNotice>
          {saleWord(failed)} could not be recorded.{' '}
          <Link href="/sync" className="font-semibold underline underline-offset-2">
            Open Sync to retry or discard them
          </Link>
        </ErrorNotice>
      )}

      {!online ? (
        <WarningNotice>
          {hydrated && depth > 0
            ? `You are offline — ${saleWord(depth)} queued on this device. `
            : 'You are offline — sales will be queued on this device until the connection returns. '}
          <Link href="/sync" className="font-semibold underline underline-offset-2">
            Review the queue
          </Link>
        </WarningNotice>
      ) : (
        depth > 0 && <StatusNotice>Syncing {saleWord(depth)}…</StatusNotice>
      )}
    </div>
  );
}
