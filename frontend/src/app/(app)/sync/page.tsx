'use client';

/**
 * `/sync` — the offline queue, where somebody decides what happens to a sale the
 * server has not got. Gated by `sales:create`, the permission that made it.
 *
 * ## The two buttons, and why there are exactly two
 *
 * BRIEF.md §4.5 is that a queued sale is retried or *explicitly* discarded, and
 * never silently dropped or silently retried forever. Those are the two failure
 * modes an offline till falls into on its own: a queue that gives up after N
 * attempts loses a sale nobody decided to lose, and a queue that retries on a
 * timer keeps hammering a server it has already been told is down while the
 * counter believes everything is fine. Retry and Discard are the whole of the
 * honest design space, so this page offers neither a timeout nor a bulk discard —
 * "Discard all" is the silent drop with an extra step, and a queue of refused
 * sales is a queue of individual reasons.
 *
 * ## Why the totals here are labelled provisional
 *
 * They were computed on this device, from tax rates cached the last time the till
 * could reach the server. The split of record — VAT, NHIL, GETFund — is worked out
 * by the server when it records the sale, and the owner may have changed a rate in
 * between. `offline-pricing.ts` refuses to hold a split at all for this reason;
 * saying "Provisional" next to the figure is the same rule, in front of a person.
 *
 * ## Why this page never reads the queue back itself
 *
 * `OfflineSync` in the app shell owns hydration, once. A second `hydrate()` here
 * would re-read the disk, and a read that lands between a background flush and its
 * fire-and-forget write would put an already-sent sale back in the list. The page
 * therefore shows a spinner until `hydrated` is true rather than claiming an empty
 * queue — an empty list before hydration means "not read yet", not "nothing
 * waiting", which is the distinction the flag exists to keep.
 */

import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Spinner,
  StatusNotice,
} from '@/components/ui/display';
import { Modal } from '@/components/ui/modal';
import { useAuth } from '@/hooks/use-auth';
import { useSyncQueue } from '@/hooks/use-sync-queue';
import { apiErrorMessage } from '@/lib/api-error-message';
import { formatDateTime } from '@/lib/format';
import { flushQueue, getSaleQueue, replaySale } from '@/lib/offline/queue';
import {
  QUEUED_SALE_STATUS_TONE,
  QUEUED_SALE_STATUS_WORD,
  flushSentence,
  replaySentence,
  saleWord,
} from '@/lib/offline/sync-words';
import { cediText } from '@/lib/pricing';
import type { QueuedSale } from '@/lib/offline/queue';

/**
 * One queued sale, and the two things that can be done with it.
 *
 * The server's own words are shown verbatim in `lastError`. They are the only text
 * that explains *why* a sale was refused, and the two common answers need opposite
 * responses: "not enough stock" means go and look at the shelf, while "this session
 * has ended" means sign in again. A generic "could not be recorded" would send the
 * operator to do the wrong one.
 */
function SaleRow({
  sale,
  busy,
  onRetry,
  onDiscard,
}: {
  sale: QueuedSale;
  busy: boolean;
  onRetry: (clientSaleId: string) => void;
  onDiscard: (sale: QueuedSale) => void;
}) {
  const sending = sale.status === 'sending';

  return (
    <li className="border-b border-surface-200 p-4 last:border-b-0 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={QUEUED_SALE_STATUS_TONE[sale.status]}>
              {QUEUED_SALE_STATUS_WORD[sale.status]}
            </Badge>
            <p className="min-w-0 truncate text-sm font-semibold text-neutral-900">
              {sale.summary}
            </p>
          </div>
          <p className="mt-1 text-2xs text-neutral-500">
            {sale.lineCount === 1 ? '1 line' : `${sale.lineCount} lines`} · queued{' '}
            {formatDateTime(new Date(sale.queuedAt).toISOString())}
            {sale.attempts > 0 &&
              ` · tried ${sale.attempts === 1 ? 'once' : `${sale.attempts} times`}`}
          </p>
        </div>
        <div className="text-right">
          <span className="money text-base font-semibold text-neutral-900">
            {cediText(sale.provisionalTotalPesewas)}
          </span>
          <p className="mt-0.5 text-2xs text-neutral-500">Provisional</p>
        </div>
      </div>

      {sale.lastError !== null && (
        <p className="mt-3 text-sm text-danger-700">{sale.lastError}</p>
      )}

      {/*
        Discard is refused while this sale is `sending` even when nothing on this
        page is busy, because a background flush from `OfflineSync` can be in
        flight. Throwing away a sale that is on the wire is the one way this page
        could lose something the server already took.
      */}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => onRetry(sale.clientSaleId)}
          loading={sending}
          disabled={busy}
        >
          {sending ? 'Sending' : 'Retry'}
        </Button>
        <Button variant="ghost" onClick={() => onDiscard(sale)} disabled={busy || sending}>
          Discard
        </Button>
      </div>
    </li>
  );
}

export default function SyncPage() {
  const { api } = useAuth();
  const { items, hydrated } = useSyncQueue();

  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [flushing, setFlushing] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<QueuedSale | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  /** One attempt at a time: the queue is a single ordered list, not a set of lanes. */
  const busy = flushing || retryingId !== null;
  const refused = items.filter((sale) => sale.status === 'failed');

  // Stable on purpose. `Modal` keeps `onClose` in an effect dependency, so a fresh
  // arrow each render would tear down and rebuild its keydown listener and re-focus
  // the panel — stealing focus from the button the operator is about to press.
  const closeDiscard = useCallback(() => setDiscardTarget(null), []);

  async function retry(clientSaleId: string) {
    if (busy) return;
    setRetryingId(clientSaleId);
    setNotice(null);
    setActionError(null);
    const queue = getSaleQueue();
    try {
      const outcome = await replaySale(api, queue, clientSaleId);
      // Null for a refusal: the row has already turned negative and shown the
      // server's reason, and a second sentence here would talk over it.
      const sentence = replaySentence(outcome);
      if (sentence !== null) setNotice(sentence);
    } catch (error) {
      // `replaySale` turns every API failure into an outcome, so this is a fault in
      // the queue itself rather than a server answer. Whatever it was, the row must
      // not sit showing "Sending…" for the rest of the session, and putting it back
      // to waiting is safe — the `clientSaleId` makes a second attempt a replay of
      // the same sale, never a second one.
      queue.requeue(clientSaleId);
      setActionError(apiErrorMessage(error, 'Could not retry that sale.'));
    } finally {
      setRetryingId(null);
    }
  }

  async function retryAll() {
    if (busy) return;
    setFlushing(true);
    setNotice(null);
    setActionError(null);
    const queue = getSaleQueue();
    try {
      const result = await flushQueue(api, queue);
      // The depth is read after the attempt and from the queue, not derived from
      // the tally: the sentence says how many sales are still held here, and only
      // the store knows that.
      setNotice(flushSentence(result, queue.depth()));
    } catch (error) {
      setActionError(apiErrorMessage(error, 'Could not sync the queue.'));
    } finally {
      setFlushing(false);
    }
  }

  function discard() {
    if (discardTarget === null) return;
    getSaleQueue().remove(discardTarget.clientSaleId);
    setDiscardTarget(null);
    setNotice(null);
    setActionError(null);
    // Said out loud rather than left to the row vanishing. BRIEF.md §4.5 forbids a
    // sale being dropped silently, and that includes being dropped by a person who
    // then cannot remember whether it went to the server or not.
    setNotice('Discarded. That sale was not recorded on the server, and it will not be.');
  }

  const subtitle = !hydrated
    ? 'Reading the queue held on this device…'
    : items.length === 0
      ? 'Nothing is held on this device.'
      : refused.length === 0
        ? `${saleWord(items.length)} held on this device, waiting for the server.`
        : `${saleWord(items.length)} held on this device — ${saleWord(refused.length)} not recorded.`;

  return (
    <div>
      <PageHeader
        title="Sync"
        subtitle={subtitle}
        actions={
          <Button
            variant="secondary"
            onClick={() => void retryAll()}
            disabled={busy || items.length === 0}
            loading={flushing}
          >
            Retry all
          </Button>
        }
      />

      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
        {notice !== null && <StatusNotice>{notice}</StatusNotice>}
        {actionError !== null && <ErrorNotice>{actionError}</ErrorNotice>}

        {hydrated && refused.length > 0 && (
          <ErrorNotice>
            {`${saleWord(refused.length)} the server refused. Each one is marked below with the reason it gave, and stays here until it is retried or discarded.`}
          </ErrorNotice>
        )}

        {hydrated && items.length > 0 && (
          <Card>
            <p className="text-sm text-neutral-700">
              These totals were calculated on this device, from the tax rates cached
              the last time the till could reach the server. They are provisional:
              the server works out the VAT, NHIL and GETFund split when it records
              the sale, and its figure is the one of record.
            </p>
          </Card>
        )}

        {!hydrated && (
          <div className="flex justify-center p-12">
            <Spinner label="Reading the queue held on this device…" />
          </div>
        )}

        {hydrated && items.length === 0 && (
          <Card padded={false}>
            <EmptyState
              title="Nothing waiting to sync"
              message="A sale rung up while the server cannot be reached is held on this device and listed here, until it is recorded or you discard it."
            />
          </Card>
        )}

        {hydrated && items.length > 0 && (
          <Card padded={false}>
            <ul>
              {items.map((sale) => (
                <SaleRow
                  key={sale.clientSaleId}
                  sale={sale}
                  busy={busy}
                  onRetry={(clientSaleId) => void retry(clientSaleId)}
                  onDiscard={(target) => setDiscardTarget(target)}
                />
              ))}
            </ul>
          </Card>
        )}
      </div>

      <Modal
        open={discardTarget !== null}
        title="Discard this sale?"
        onClose={closeDiscard}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={closeDiscard}>
              Keep it queued
            </Button>
            <Button variant="danger" onClick={discard}>
              Discard sale
            </Button>
          </div>
        }
      >
        {discardTarget !== null && (
          <div className="space-y-3 text-sm text-neutral-700">
            <p>
              <span className="font-semibold text-neutral-900">{discardTarget.summary}</span>
              {' · '}
              <span className="money">{cediText(discardTarget.provisionalTotalPesewas)}</span>
              {' · queued '}
              {formatDateTime(new Date(discardTarget.queuedAt).toISOString())}
            </p>
            {/*
              The consequences are spelled out before an irreversible act, because
              "Discard" on its own reads as tidying a list. This is the only place
              in the app where a rung-up sale can be made to vanish, and it does not
              get to be ambiguous.
            */}
            <p>
              This sale is held on this device and has not been recorded on the
              server. Discarding it means it never will be.
            </p>
            <p>
              Stock will not be deducted, the sale will not appear in Sales or in
              any report, and the takings for the day will not include it. There is
              no undo, and no record is kept anywhere that it was discarded.
            </p>
            {discardTarget.lastError !== null && (
              <p className="rounded border border-surface-200 bg-surface-50 p-3">
                <span className="font-semibold text-neutral-900">
                  Why the server refused it:{' '}
                </span>
                {discardTarget.lastError}
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
