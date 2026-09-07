'use client';

/**
 * The three dialogs that write stock on `/inventory/[id]`: receive a delivery,
 * adjust a batch to a counted total, and write stock off.
 *
 * All three are forms in the sense `sale-modals.tsx` establishes — they collect
 * and validate a body and hand it up to the page, which is the one place that
 * talks to the API and owns `submitting` and the error. None knows the product or
 * batch id, so none can disagree with the route about where the write goes.
 *
 * The validators are `lib/inventory.ts`'s, bounded by the same `PRODUCT_LIMITS`
 * the route enforces, so an operator is told a reason is too short before the
 * round trip rather than after it.
 */

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorNotice, StatusNotice, WarningNotice } from '@/components/ui/display';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { PRODUCT_LIMITS } from '@/lib/api-types';
import type { AdjustBatchBody, ReceiveStockBody, WriteOffBody } from '@/lib/api-types';
import {
  moneyBody,
  quantityBody,
  requiredText,
  validateCorrectionNote,
  validateCorrectionReason,
  validateOptionalNote,
  validateOptionalReason,
} from '@/lib/inventory';
import type { QuantityResult } from '@/lib/inventory';

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------

export interface ReceiveStockModalProps {
  open: boolean;
  productName: string;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: ReceiveStockBody) => void;
}

export function ReceiveStockModal({
  open,
  productName,
  submitting,
  error,
  onClose,
  onSubmit,
}: ReceiveStockModalProps) {
  const [lotNumber, setLotNumber] = useState('');
  const [quantityText, setQuantityText] = useState('');
  const [costPriceText, setCostPriceText] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) {
      setLotNumber('');
      setQuantityText('');
      setCostPriceText('');
      setExpiryDate('');
      setReason('');
      setNote('');
    }
  }, [open]);

  const lotError = requiredText(lotNumber, 'the lot number', PRODUCT_LIMITS.lotNumber.max);
  const quantity = quantityBody(
    quantityText,
    'how many units arrived',
    PRODUCT_LIMITS.quantity.min,
    PRODUCT_LIMITS.quantity.max
  );
  const cost = moneyBody(costPriceText, 'the cost price');
  const reasonError = validateOptionalReason(reason);
  const noteError = validateOptionalNote(note);

  const canSubmit =
    lotError === null && quantity.ok && cost.ok && reasonError === null && noteError === null && !submitting;

  function submit() {
    if (lotError !== null || !quantity.ok || !cost.ok) return;
    onSubmit({
      lotNumber: lotNumber.trim(),
      quantity: quantity.quantity,
      costPrice: cost.amount,
      expiryDate: expiryDate === '' ? null : expiryDate,
      ...(reason.trim() !== '' ? { reason: reason.trim() } : {}),
      ...(note.trim() !== '' ? { note: note.trim() } : {}),
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Receive stock — ${productName}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} disabled={!canSubmit} onClick={submit}>
            Receive stock
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error !== null && <ErrorNotice>{error}</ErrorNotice>}
        <StatusNotice>
          Receiving adds a lot to this product. If the lot number and expiry match one already on
          the shelf, the delivery is merged into it rather than creating a duplicate.
        </StatusNotice>
        <Field
          label="Lot number"
          htmlFor="receive-lot"
          hint="The batch or lot number printed on the delivery."
          error={lotError ?? undefined}
          required
        >
          <Input
            id="receive-lot"
            value={lotNumber}
            autoComplete="off"
            onChange={(event) => setLotNumber(event.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Units received"
            htmlFor="receive-quantity"
            hint="Base units — single tablets or sachets, not packs."
            error={quantity.ok ? undefined : quantity.message}
            required
          >
            <Input
              id="receive-quantity"
              type="text"
              inputMode="numeric"
              value={quantityText}
              onChange={(event) => setQuantityText(event.target.value)}
            />
          </Field>
          <Field
            label="Cost price"
            htmlFor="receive-cost"
            hint="What one unit cost, for example 0.85."
            error={cost.ok ? undefined : cost.message}
            required
          >
            <Input
              id="receive-cost"
              type="text"
              inputMode="decimal"
              value={costPriceText}
              onChange={(event) => setCostPriceText(event.target.value)}
            />
          </Field>
        </div>
        <Field
          label="Expiry date"
          htmlFor="receive-expiry"
          hint="Leave empty for undated stock."
        >
          <Input
            id="receive-expiry"
            type="date"
            value={expiryDate}
            onChange={(event) => setExpiryDate(event.target.value)}
          />
        </Field>
        <Field
          label="Reason"
          htmlFor="receive-reason"
          hint="Optional. For example a supplier or delivery note."
          error={reasonError ?? undefined}
        >
          <Input
            id="receive-reason"
            value={reason}
            autoComplete="off"
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <Field label="Note" htmlFor="receive-note" hint="Optional." error={noteError ?? undefined}>
          <Textarea
            id="receive-note"
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Adjust
// ---------------------------------------------------------------------------

export interface AdjustBatchModalProps {
  open: boolean;
  productName: string;
  lotNumber: string;
  /** What the system believes this lot holds, shown so the count is a correction. */
  currentQuantity: number;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: AdjustBatchBody) => void;
}

export function AdjustBatchModal({
  open,
  productName,
  lotNumber,
  currentQuantity,
  submitting,
  error,
  onClose,
  onSubmit,
}: AdjustBatchModalProps) {
  const [quantityText, setQuantityText] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) {
      setQuantityText(String(currentQuantity));
      setReason('');
      setNote('');
    }
  }, [open, currentQuantity]);

  const quantity = quantityBody(
    quantityText,
    'the counted quantity',
    0,
    PRODUCT_LIMITS.quantity.max
  );
  const reasonError = validateCorrectionReason(reason);
  const noteError = validateCorrectionNote(note);
  const canSubmit = quantity.ok && reasonError === null && noteError === null && !submitting;
  const delta = quantity.ok ? quantity.quantity - currentQuantity : 0;

  function submit() {
    if (!quantity.ok || reasonError !== null || noteError !== null) return;
    onSubmit({ quantity: quantity.quantity, reason: reason.trim(), note: note.trim() });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Adjust lot ${lotNumber} — ${productName}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} disabled={!canSubmit} onClick={submit}>
            Save adjustment
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error !== null && <ErrorNotice>{error}</ErrorNotice>}
        <WarningNotice>
          An adjustment sets the lot to the total you counted; it does not add or subtract. The
          difference is written to the ledger against your name.
        </WarningNotice>
        <Field
          label="Counted quantity"
          htmlFor="adjust-quantity"
          hint={`The system holds ${currentQuantity}. Enter the total you counted.`}
          error={quantity.ok ? undefined : quantity.message}
          required
        >
          <Input
            id="adjust-quantity"
            type="text"
            inputMode="numeric"
            value={quantityText}
            onChange={(event) => setQuantityText(event.target.value)}
          />
        </Field>
        {quantity.ok && delta !== 0 && (
          <StatusNotice>
            This records a correction of {delta > 0 ? `+${delta}` : delta} units.
          </StatusNotice>
        )}
        <Field
          label="Reason"
          htmlFor="adjust-reason"
          hint="At least 3 characters. This is the audit trail for the correction."
          error={reasonError ?? undefined}
          required
        >
          <Input
            id="adjust-reason"
            value={reason}
            autoComplete="off"
            placeholder="Stock count, damage, theft…"
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <Field
          label="Note"
          htmlFor="adjust-note"
          hint="What was counted or what happened."
          error={noteError ?? undefined}
          required
        >
          <Textarea
            id="adjust-note"
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Write off
// ---------------------------------------------------------------------------

export interface WriteOffBatchModalProps {
  open: boolean;
  productName: string;
  lotNumber: string;
  currentQuantity: number;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: WriteOffBody) => void;
}

export function WriteOffBatchModal({
  open,
  productName,
  lotNumber,
  currentQuantity,
  submitting,
  error,
  onClose,
  onSubmit,
}: WriteOffBatchModalProps) {
  const [wholeBatch, setWholeBatch] = useState(true);
  const [quantityText, setQuantityText] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) {
      setWholeBatch(true);
      setQuantityText('');
      setReason('');
      setNote('');
    }
  }, [open]);

  // A partial write-off cannot exceed what the lot holds; the whole-batch case
  // sends no quantity at all, which the route reads as "all of it".
  const quantity: QuantityResult = wholeBatch
    ? { ok: true, quantity: currentQuantity }
    : quantityBody(quantityText, 'how many units to write off', 1, currentQuantity);
  const reasonError = validateCorrectionReason(reason);
  const noteError = validateCorrectionNote(note);
  const canSubmit = quantity.ok && reasonError === null && noteError === null && !submitting;

  function submit() {
    if (!quantity.ok || reasonError !== null || noteError !== null) return;
    onSubmit({
      ...(wholeBatch ? {} : { quantity: quantity.quantity }),
      reason: reason.trim(),
      note: note.trim(),
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Write off lot ${lotNumber} — ${productName}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="danger" loading={submitting} disabled={!canSubmit} onClick={submit}>
            Write off
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error !== null && <ErrorNotice>{error}</ErrorNotice>}
        <WarningNotice>
          Written-off stock leaves the shelf for good and cannot be sold. It stays on the ledger as
          a write-off against your name.
        </WarningNotice>
        <label
          htmlFor="writeoff-whole"
          className="flex items-start gap-3 rounded-md border border-surface-200 p-3"
        >
          <input
            id="writeoff-whole"
            type="checkbox"
            className="mt-0.5 h-5 w-5 accent-primary-500"
            checked={wholeBatch}
            onChange={(event) => setWholeBatch(event.target.checked)}
          />
          <span className="text-sm">
            <span className="font-medium text-neutral-800">Write off the whole lot</span>
            <span className="mt-0.5 block text-neutral-600">
              All {currentQuantity} units. Turn this off to write off part of the lot.
            </span>
          </span>
        </label>
        {!wholeBatch && (
          <Field
            label="Units to write off"
            htmlFor="writeoff-quantity"
            hint={`At most ${currentQuantity}, the lot holds no more.`}
            error={quantity.ok ? undefined : quantity.message}
            required
          >
            <Input
              id="writeoff-quantity"
              type="text"
              inputMode="numeric"
              value={quantityText}
              onChange={(event) => setQuantityText(event.target.value)}
            />
          </Field>
        )}
        <Field
          label="Reason"
          htmlFor="writeoff-reason"
          hint="At least 3 characters. This is the audit trail for the write-off."
          error={reasonError ?? undefined}
          required
        >
          <Input
            id="writeoff-reason"
            value={reason}
            autoComplete="off"
            placeholder="Expired, damaged, recalled…"
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <Field
          label="Note"
          htmlFor="writeoff-note"
          hint="What was written off and why."
          error={noteError ?? undefined}
          required
        >
          <Textarea
            id="writeoff-note"
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
