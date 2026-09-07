/**
 * The words `/sync` and the offline indicator show, checked against the honesty
 * rules they are carrying.
 *
 * Wording is usually not worth a test. This wording is, for the reason
 * `sync-words.ts` gives: it is the last place the distinction between "the server
 * could not be reached" and "the server refused" survives on its way to the
 * operator. `queue.ts` has a test that the two *states* are never flattened; this
 * suite is the same test one layer up, on the sentences. A refactor that made
 * `flushSentence` share one branch for both would pass the queue suite and still
 * tell a cashier their rejected sale was safely queued.
 */

import {
  QUEUED_SALE_STATUS_TONE,
  QUEUED_SALE_STATUS_WORD,
  flushSentence,
  replaySentence,
  saleWord,
} from '../sync-words';
import type { QueuedSaleStatus } from '../queue';
import type { FlushResult } from '../queue';

const STATUSES: readonly QueuedSaleStatus[] = ['queued', 'sending', 'failed'];

function flush(overrides: Partial<FlushResult> = {}): FlushResult {
  return { sent: 0, failed: 0, stoppedOffline: false, stoppedUnauthenticated: false, ...overrides };
}

describe('the status words', () => {
  it('words and tones every status a queued sale can have', () => {
    // Exhaustive by type, but a `Record` is satisfied by an empty string, and an
    // empty badge is a status the operator has to guess at.
    for (const status of STATUSES) {
      expect(QUEUED_SALE_STATUS_WORD[status].trim().length).toBeGreaterThan(0);
      expect(QUEUED_SALE_STATUS_TONE[status].length).toBeGreaterThan(0);
    }
  });

  it('never calls a refused sale a sync problem', () => {
    // "Failed to sync" reads as plumbing that will sort itself out. The sale is not
    // in the books, stock has not moved and the takings do not include it, so the
    // word has to say that the server did not record it.
    expect(QUEUED_SALE_STATUS_WORD.failed).toBe('Not recorded');
    expect(QUEUED_SALE_STATUS_WORD.failed.toLowerCase()).not.toContain('sync');
    expect(QUEUED_SALE_STATUS_TONE.failed).toBe('negative');
  });

  it('does not blame a sale that is only waiting for a network', () => {
    expect(QUEUED_SALE_STATUS_TONE.queued).toBe('neutral');
    expect(QUEUED_SALE_STATUS_WORD.queued.toLowerCase()).not.toContain('fail');
    expect(QUEUED_SALE_STATUS_WORD.queued.toLowerCase()).not.toContain('error');
  });
});

describe('flushSentence — the two failures stay two failures', () => {
  it('says an unreachable server is holding the sales, not losing them', () => {
    const sentence = flushSentence(flush({ stoppedOffline: true }), 3);

    expect(sentence).toContain('Cannot reach the server');
    expect(sentence).toContain('3 sales still held');
    // The promise that makes it safe to walk away from: these go on their own when
    // the connection returns. Without it the operator's only read is "broken".
    expect(sentence).toContain('when the connection returns');
    // And it must not wear the other failure's words — nothing was refused here.
    expect(sentence).not.toContain('could not be recorded');
  });

  it('says a refusal needs a decision, and does not mention the connection', () => {
    const sentence = flushSentence(flush({ failed: 2 }), 2);

    expect(sentence).toContain('2 sales could not be recorded');
    expect(sentence).toContain('needs a decision');
    // Mentioning the connection here would send the operator to check the wifi
    // instead of reading the server's reason on the row.
    expect(sentence).not.toContain('Cannot reach the server');
    expect(sentence).not.toContain('connection returns');
  });

  it('reports both tallies when some were recorded and some were refused', () => {
    const sentence = flushSentence(flush({ sent: 4, failed: 1 }), 1);

    expect(sentence).toContain('Recorded 4 sales');
    expect(sentence).toContain('1 sale could not be recorded');
  });

  it('says plainly when nothing was waiting, rather than reporting a success of zero', () => {
    // "Recorded 0 sales" reads as a failure to somebody glancing at it.
    expect(flushSentence(flush(), 0)).toBe('Nothing was waiting to send.');
  });

  it('reports a clean run as recorded', () => {
    expect(flushSentence(flush({ sent: 1 }), 0)).toBe('Recorded 1 sale.');
  });

  it('puts a dead session ahead of the tallies, because the run stopped early', () => {
    // A partial run described by its tally alone looks complete. The session
    // sentence names the one thing that unblocks everything else.
    const sentence = flushSentence(flush({ sent: 1, stoppedUnauthenticated: true }), 2);

    expect(sentence).toContain('Your session has ended');
    expect(sentence).toContain('Sign in again');
    expect(sentence).toContain('2 sales still held here');
  });

  it('prefers the offline sentence over the tallies for the same reason', () => {
    const sentence = flushSentence(flush({ sent: 1, stoppedOffline: true }), 5);
    expect(sentence).toContain('Cannot reach the server');
    expect(sentence).not.toContain('Recorded');
  });
});

describe('replaySentence — one Retry button', () => {
  it('stays silent on a refusal, because the row already shows the server’s own reason', () => {
    // A generic "could not be recorded" above the list would talk over `lastError`,
    // which is the only text that says *why* — "not enough stock" and "this session
    // has ended" need opposite responses from the operator.
    expect(replaySentence('failed')).toBeNull();
  });

  it('explains a replayed sale rather than folding it into a plain success', () => {
    const sentence = replaySentence('replayed');

    expect(sentence).not.toBeNull();
    // The surprising good outcome. Spelling it out is what stops the operator
    // ringing the same basket up again because the first attempt "failed".
    expect(sentence).toContain('Already recorded');
    expect(sentence).toContain('stock was not taken twice');
  });

  it('says an unreachable server is holding the sale', () => {
    const sentence = replaySentence('offline');
    expect(sentence).toContain('Cannot reach the server');
    expect(sentence).toContain('still held on this device');
  });

  it('words every outcome, so none can fall through to an undefined notice', () => {
    for (const outcome of ['sent', 'replayed', 'offline', 'unauthenticated'] as const) {
      expect(replaySentence(outcome)).not.toBeNull();
    }
  });
});

describe('saleWord', () => {
  it('pluralises by the count and nothing else', () => {
    expect(saleWord(0)).toBe('0 sales');
    expect(saleWord(1)).toBe('1 sale');
    expect(saleWord(2)).toBe('2 sales');
  });
});
