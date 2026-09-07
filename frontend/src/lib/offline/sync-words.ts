/**
 * The words and badge tones `/sync` and the offline indicator render, in one place.
 *
 * ## These sentences are the honesty rules, spelled out
 *
 * `queue.ts` decides what happened to a sale; this file decides what the operator
 * is told about it, and the two must not drift. Three distinctions carry the whole
 * weight of BRIEF.md §4.5 and landmine 3:
 *
 * - **"Cannot reach the server" is not "could not be recorded".** The first means
 *   the sale is still held here and will go when the connection returns — nothing
 *   is wrong with it. The second means the server *answered* and refused, so the
 *   sale needs a person to decide. Flattening them is the exact failure the
 *   landmine names: a 500 dressed as an offline state tells the counter its sale
 *   is safely queued while nothing was written anywhere.
 * - **A `failed` sale reads "Not recorded", never "Failed to sync".** "Sync" sounds
 *   like plumbing that will sort itself out. The truth is that this sale is not in
 *   the books, stock has not moved and the day's takings do not include it.
 * - **A provisional total is called provisional.** The tax split is not known until
 *   the server records the sale, and a figure shown without that word invites the
 *   operator to read it as the receipt of record.
 */

import type { BadgeTone } from '@/components/ui/display';
import type { QueuedSaleStatus } from './queue';
import type { FlushResult, ReplayOutcome } from './queue';

export const QUEUED_SALE_STATUS_WORD: Record<QueuedSaleStatus, string> = {
  // "Waiting to send" rather than "Pending": pending says nothing about which side
  // of the wire the problem is on, and here there is no problem — only no network.
  queued: 'Waiting to send',
  sending: 'Sending…',
  failed: 'Not recorded',
};

export const QUEUED_SALE_STATUS_TONE: Record<QueuedSaleStatus, BadgeTone> = {
  queued: 'neutral',
  sending: 'neutral',
  // Negative, not warning. A warning is something to keep an eye on; this is a sale
  // the server refused and it stays refused until somebody retries or discards it.
  failed: 'negative',
};

/** `1 sale` / `3 sales`. One pluraliser, so the indicator and the page agree. */
export function saleWord(count: number): string {
  return `${count} sale${count === 1 ? '' : 's'}`;
}

/**
 * What a whole-queue attempt did, in one sentence.
 *
 * `remaining` is the real depth after the attempt, read by the caller from the
 * queue rather than derived here: a sentence that computes its own count is a
 * second opinion about state that only the store holds.
 *
 * The offline and unauthenticated branches come first and return early, because
 * both mean the attempt stopped before it had looked at everything — reporting
 * `sent`/`failed` tallies alone would describe a partial run as a complete one.
 */
export function flushSentence(result: FlushResult, remaining: number): string {
  if (result.stoppedOffline) {
    return `Cannot reach the server. ${saleWord(remaining)} still held on this device, and will be sent when the connection returns.`;
  }
  if (result.stoppedUnauthenticated) {
    return `Your session has ended. Sign in again to send the ${saleWord(remaining)} still held here.`;
  }
  if (result.sent === 0 && result.failed === 0) {
    return 'Nothing was waiting to send.';
  }
  if (result.failed === 0) {
    return `Recorded ${saleWord(result.sent)}.`;
  }
  if (result.sent === 0) {
    return `${saleWord(result.failed)} could not be recorded. Each one needs a decision below.`;
  }
  return `Recorded ${saleWord(result.sent)}; ${saleWord(result.failed)} could not be recorded and need a decision below.`;
}

/**
 * What one Retry did, or null when the row itself already says it.
 *
 * `failed` returns null on purpose. The row turns negative and shows `lastError` —
 * the server's own words, which are the only ones that explain *why* — and a second
 * generic sentence above the list would talk over the one piece of information the
 * operator actually needs.
 *
 * `replayed` is spelled out rather than folded into "Recorded" because it is the
 * surprising good outcome: the sale that appeared to fail did reach the server, and
 * saying so is what stops the operator ringing it up a second time.
 */
export function replaySentence(outcome: ReplayOutcome): string | null {
  switch (outcome) {
    case 'sent':
      return 'Recorded on the server.';
    case 'replayed':
      return 'Already recorded — the server recognised this sale, so stock was not taken twice.';
    case 'offline':
      return 'Cannot reach the server. This sale is still held on this device.';
    case 'unauthenticated':
      return 'Your session has ended. Sign in again to sync.';
    case 'failed':
      return null;
  }
}
