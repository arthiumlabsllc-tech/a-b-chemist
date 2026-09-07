'use client';

/**
 * One product. `/inventory/[id]`, gated by `inventory:read`.
 *
 * The product card, its lots in FEFO order, the movement ledger, and every stock
 * write: receive a delivery, adjust a lot to a counted total, write stock off,
 * edit the product, and trace a recall. The page is the one place that talks to the
 * API; the dialogs collect and validate a body and hand it up, so none of them
 * knows the product or lot id.
 *
 * Two honesty points the layout is built around. First, "on hand" and "sellable
 * today" are shown as two figures, because the derived `quantity` counts expired
 * stock and the till sells against `sellable` — a card that showed one number for
 * both would let an operator believe out-of-date stock could be sold. Second, the
 * write buttons are gated by permission *and* by state: a lot that holds nothing
 * cannot be written off, so the button is not offered rather than offered and
 * refused.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';

import {
  EXPIRY_TONE,
  EXPIRY_WORD,
  MOVEMENT_TONE,
  MOVEMENT_WORD,
  SELL_UNIT_WORD,
  STOCK_LEVEL_TONE,
  STOCK_LEVEL_WORD,
  VAT_TREATMENT_WORD,
} from '@/components/inventory/inventory-words';
import { ProductModal } from '@/components/inventory/product-modal';
import { RecallPanel } from '@/components/inventory/recall-panel';
import {
  AdjustBatchModal,
  ReceiveStockModal,
  WriteOffBatchModal,
} from '@/components/inventory/stock-modals';
import { Button } from '@/components/ui/button';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  Money,
  PageHeader,
  Spinner,
  StatusNotice,
} from '@/components/ui/display';
import { Modal } from '@/components/ui/modal';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api-error-message';
import type {
  AdjustBatchBody,
  BatchRow,
  MovementRow,
  MovementsResponse,
  ProductBody,
  ProductDetail,
  ProductWriteResponse,
  RecallResult,
  ReceiveStockBody,
  StockWriteResult,
  WriteOffBody,
} from '@/lib/api-types';
import { todayIso } from '@/lib/dates';
import { formatDate, formatDateTime } from '@/lib/format';
import { daysUntilExpiry, expiryState, stockLevel } from '@/lib/inventory';

type OpenModal = 'edit' | 'receive' | 'adjust' | 'writeOff' | 'recall' | null;

/** How many ledger rows to show. The route caps this at its own list limit. */
const MOVEMENT_LIMIT = 50;

export default function ProductPage() {
  const { api, can } = useAuth();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [modal, setModal] = useState<OpenModal>(null);
  const [activeBatch, setActiveBatch] = useState<BatchRow | null>(null);
  const [recall, setRecall] = useState<RecallResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  const today = todayIso();

  const canReceive = can('inventory:receive');
  const canAdjust = can('inventory:adjust');
  const canWriteOff = can('inventory:write_off');
  const canRecall = can('inventory:recall:read');
  const canEdit = can('inventory:product:write');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        // Both are `inventory:read`, so they are fetched together rather than in a
        // waterfall; if either fails the page says it could not load the product.
        const [product, ledger] = await Promise.all([
          api.get<ProductDetail>(`/inventory/${id}`),
          api.get<MovementsResponse>(`/inventory/${id}/movements`, {
            query: { limit: MOVEMENT_LIMIT },
          }),
        ]);
        if (cancelled) return;
        setDetail(product);
        setMovements(ledger.movements);
      } catch (error) {
        if (!cancelled) setLoadError(apiErrorMessage(error, 'Could not load this product.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, id, reloadToken]);

  function openSimple(next: OpenModal) {
    setSubmitError(null);
    setNotice(null);
    setModal(next);
  }

  function openBatch(next: 'adjust' | 'writeOff', batch: BatchRow) {
    setSubmitError(null);
    setNotice(null);
    setActiveBatch(batch);
    setModal(next);
  }

  function closeModal() {
    setModal(null);
    setActiveBatch(null);
    setRecall(null);
    setSubmitError(null);
  }

  async function onReceive(body: ReceiveStockBody) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.post<StockWriteResult>(`/inventory/${id}/batches`, body);
      setNotice(
        result.merged
          ? `Merged ${result.quantityChange} units into lot ${result.batch.lotNumber}.`
          : `Received ${result.quantityChange} units as lot ${result.batch.lotNumber}.`
      );
      closeModal();
      reload();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'Could not receive the stock.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function onAdjust(body: AdjustBatchBody) {
    if (activeBatch === null) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.post<StockWriteResult>(
        `/inventory/${id}/batches/${activeBatch.id}/adjust`,
        body
      );
      setNotice(`Lot ${result.batch.lotNumber} set to ${result.quantityAfter} units.`);
      closeModal();
      reload();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'Could not adjust the lot.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function onWriteOff(body: WriteOffBody) {
    if (activeBatch === null) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.post<StockWriteResult>(
        `/inventory/${id}/batches/${activeBatch.id}/write-off`,
        body
      );
      setNotice(`Wrote off ${-result.quantityChange} units from lot ${result.batch.lotNumber}.`);
      closeModal();
      reload();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'Could not write off the stock.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function onEdit(body: ProductBody) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.patch<ProductWriteResponse>(`/inventory/${id}`, body);
      setNotice(`Saved ${result.product.name}.`);
      closeModal();
      reload();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'Could not save the product.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function onRecall(batch: BatchRow) {
    setSubmitting(true);
    setSubmitError(null);
    setNotice(null);
    try {
      const result = await api.get<RecallResult>(`/inventory/${id}/batches/${batch.id}/recall`);
      setRecall(result);
      setActiveBatch(batch);
      setModal('recall');
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'Could not trace this lot.'));
    } finally {
      setSubmitting(false);
    }
  }

  const product = detail?.product ?? null;
  const level = product === null ? null : stockLevel(product.quantity, product.reorderLevel);
  const leadingExpiry = expiryState(detail?.leadingDaysToExpiry ?? null);

  return (
    <div>
      <PageHeader
        title={product === null ? 'Product' : product.name}
        subtitle={product === null ? undefined : `${product.code}${product.category !== null ? ` · ${product.category}` : ''}`}
        actions={
          <Button variant="secondary" onClick={() => router.push('/inventory')}>
            Back to stock
          </Button>
        }
      />

      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
        {notice !== null && <StatusNotice>{notice}</StatusNotice>}
        {modal === null && submitError !== null && <ErrorNotice>{submitError}</ErrorNotice>}

        {loadError !== null && (
          <div className="space-y-3">
            <ErrorNotice>{loadError}</ErrorNotice>
            <Button variant="secondary" onClick={reload}>
              Try again
            </Button>
          </div>
        )}

        {loading && loadError === null && (
          <div className="flex justify-center p-12">
            <Spinner label="Loading product…" />
          </div>
        )}

        {!loading && loadError === null && detail !== null && product !== null && level !== null && (
          <div className="space-y-4">
            <Card className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STOCK_LEVEL_TONE[level]}>{STOCK_LEVEL_WORD[level]}</Badge>
                {detail.leading !== null && leadingExpiry !== 'none' && (
                  <Badge tone={EXPIRY_TONE[leadingExpiry]}>{EXPIRY_WORD[leadingExpiry]}</Badge>
                )}
                {product.requiresPrescription && <Badge tone="warning">Prescription</Badge>}
                {!product.isActive && <Badge tone="neutral">Inactive</Badge>}
              </div>

              <p className="text-sm text-neutral-700">
                On hand <span className="font-semibold text-neutral-900">{product.quantity}</span>{' '}
                units · sellable today{' '}
                <span className="font-semibold text-neutral-900">{detail.sellable}</span> · reorder
                at {product.reorderLevel}
              </p>

              {detail.leading !== null && (
                <p className="text-2xs text-neutral-600">
                  Front of shelf: lot {detail.leading.lotNumber}
                  {detail.leading.expiryDate !== null
                    ? `, expires ${formatDate(detail.leading.expiryDate)}`
                    : ', no expiry date'}
                  {detail.leadingDaysToExpiry !== null &&
                    ` (${detail.leadingDaysToExpiry} ${detail.leadingDaysToExpiry === 1 ? 'day' : 'days'})`}
                </p>
              )}

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-surface-200 pt-3 text-sm sm:grid-cols-3">
                <Fact label="Unit price">
                  <Money value={product.unitPrice} /> / {SELL_UNIT_WORD[product.defaultSellUnit].toLowerCase()}
                </Fact>
                <Fact label="Pack size">{product.packSize}</Fact>
                <Fact label="VAT">{VAT_TREATMENT_WORD[product.vatTreatment]}</Fact>
                <Fact label="Generic">{product.genericName ?? '—'}</Fact>
                <Fact label="Manufacturer">{product.manufacturer ?? '—'}</Fact>
                <Fact label="Shelf">{product.shelfLocation ?? '—'}</Fact>
                <Fact label="Barcode">{product.barcode ?? '—'}</Fact>
                <Fact label="Average cost">
                  <Money value={product.costPrice} />
                </Fact>
              </dl>

              {(canReceive || canEdit) && (
                <div className="flex flex-wrap gap-2 border-t border-surface-200 pt-3">
                  {canReceive && (
                    <Button variant="primary" onClick={() => openSimple('receive')} disabled={submitting}>
                      Receive stock
                    </Button>
                  )}
                  {canEdit && (
                    <Button variant="secondary" onClick={() => openSimple('edit')} disabled={submitting}>
                      Edit product
                    </Button>
                  )}
                </div>
              )}
            </Card>

            <Card padded={false}>
              <div className="border-b border-surface-200 px-4 py-3">
                <h2 className="text-sm font-semibold text-neutral-900">
                  Lots ({detail.batches.length})
                </h2>
                <p className="mt-0.5 text-2xs text-neutral-500">
                  First expired, first out. Undated stock goes last.
                </p>
              </div>
              {detail.batches.length === 0 ? (
                <EmptyState title="No stock received yet" message="Receive a delivery to add the first lot." />
              ) : (
                <ul className="divide-y divide-surface-200">
                  {detail.batches.map((batch) => {
                    const batchExpiry = expiryState(daysUntilExpiry(batch.expiryDate, today));
                    return (
                      <li key={batch.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium text-neutral-900">Lot {batch.lotNumber}</p>
                            {batch.expiryDate !== null && batchExpiry !== 'none' && (
                              <Badge tone={EXPIRY_TONE[batchExpiry]}>{EXPIRY_WORD[batchExpiry]}</Badge>
                            )}
                          </div>
                          <p className="mt-0.5 text-2xs text-neutral-500">
                            {batch.quantity} units · cost <Money value={batch.costPrice} /> · received{' '}
                            {formatDateTime(batch.receivedAt)}
                            {batch.expiryDate !== null
                              ? ` · expires ${formatDate(batch.expiryDate)}`
                              : ' · no expiry date'}
                          </p>
                        </div>
                        {(canAdjust || (canWriteOff && batch.quantity > 0) || canRecall) && (
                          <div className="flex shrink-0 flex-wrap gap-2">
                            {canAdjust && (
                              <Button variant="secondary" onClick={() => openBatch('adjust', batch)} disabled={submitting}>
                                Adjust
                              </Button>
                            )}
                            {canWriteOff && batch.quantity > 0 && (
                              <Button variant="secondary" onClick={() => openBatch('writeOff', batch)} disabled={submitting}>
                                Write off
                              </Button>
                            )}
                            {canRecall && (
                              <Button variant="ghost" loading={submitting} onClick={() => void onRecall(batch)}>
                                Trace recall
                              </Button>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <Card padded={false}>
              <div className="border-b border-surface-200 px-4 py-3">
                <h2 className="text-sm font-semibold text-neutral-900">Movement ledger</h2>
                <p className="mt-0.5 text-2xs text-neutral-500">
                  Newest first. Every arrival, correction, sale and write-off.
                </p>
              </div>
              {movements.length === 0 ? (
                <EmptyState title="No movements yet" />
              ) : (
                <ul className="divide-y divide-surface-200">
                  {movements.map((movement) => (
                    <li key={movement.id} className="p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Badge tone={MOVEMENT_TONE[movement.movementType]}>
                          {MOVEMENT_WORD[movement.movementType]}
                        </Badge>
                        <span className="text-sm text-neutral-900">
                          {movement.quantityChange > 0 ? `+${movement.quantityChange}` : movement.quantityChange}
                          <span className="text-2xs text-neutral-500"> → {movement.quantityAfter}</span>
                        </span>
                      </div>
                      <p className="mt-1 text-2xs text-neutral-500">
                        {formatDateTime(movement.createdAt)}
                        {movement.performedByName !== null ? ` · ${movement.performedByName}` : ''}
                        {movement.reason !== null ? ` · ${movement.reason}` : ''}
                        {movement.note !== null ? ` · ${movement.note}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </div>

      {canEdit && (
        <ProductModal
          open={modal === 'edit'}
          mode="edit"
          product={product}
          submitting={submitting}
          error={submitError}
          onClose={closeModal}
          onSubmit={(body) => void onEdit(body)}
        />
      )}
      <ReceiveStockModal
        open={modal === 'receive'}
        productName={product?.name ?? ''}
        submitting={submitting}
        error={submitError}
        onClose={closeModal}
        onSubmit={(body) => void onReceive(body)}
      />
      <AdjustBatchModal
        open={modal === 'adjust'}
        productName={product?.name ?? ''}
        lotNumber={activeBatch?.lotNumber ?? ''}
        currentQuantity={activeBatch?.quantity ?? 0}
        submitting={submitting}
        error={submitError}
        onClose={closeModal}
        onSubmit={(body) => void onAdjust(body)}
      />
      <WriteOffBatchModal
        open={modal === 'writeOff'}
        productName={product?.name ?? ''}
        lotNumber={activeBatch?.lotNumber ?? ''}
        currentQuantity={activeBatch?.quantity ?? 0}
        submitting={submitting}
        error={submitError}
        onClose={closeModal}
        onSubmit={(body) => void onWriteOff(body)}
      />
      <Modal
        open={modal === 'recall'}
        onClose={closeModal}
        size="lg"
        title={`Recall trace — lot ${activeBatch?.lotNumber ?? ''}`}
        footer={
          <div className="flex justify-end">
            <Button variant="ghost" onClick={closeModal}>
              Close
            </Button>
          </div>
        }
      >
        {recall !== null && <RecallPanel recall={recall} />}
      </Modal>
    </div>
  );
}

/** One labelled fact in the product card's grid. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-2xs text-neutral-500">{label}</dt>
      <dd className="text-neutral-900">{children}</dd>
    </div>
  );
}
