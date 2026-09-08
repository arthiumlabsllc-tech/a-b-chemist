'use client';

/**
 * The two dialogs `/sales/[id]` opens: void a sale, and add a payment to one that
 * is still pending.
 *
 * Both are forms in the same sense the staff dialogs are — they collect and
 * validate a body and hand it up to the page, which is the one place that talks to
 * the API and owns `submitting` and the error. Neither dialog knows the sale's id
 * or how the request is made, so neither can disagree with the route about it.
 *
 * The verify action is deliberately *not* here. It takes no input — it asks the
 * gateway about a tender that already exists — so it is a button on the page, not
 * a dialog. Wrapping a one-press action in a modal would be a step to confirm a
 * step.
 */

import { useEffect, useState } from 'react';

import { METHOD_WORD } from '@/components/pos/sale-words';
import { Button } from '@/components/ui/button';
import { ErrorNotice, Money, WarningNotice } from '@/components/ui/display';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { shownError, useTouchedFields } from '@/hooks/use-touched';
import { SALE_PAYMENT_METHODS } from '@/lib/api-types';
import type { CreateSalePayment, SalePaymentMethod, VoidSaleBody } from '@/lib/api-types';
import { paymentAmountBody, validateVoidReason } from '@/lib/sales';

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

export interface VoidSaleModalProps {
  open: boolean;
  saleNumber: string;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: VoidSaleBody) => void;
}

export function VoidSaleModal({
  open,
  saleNumber,
  submitting,
  error,
  onClose,
  onSubmit,
}: VoidSaleModalProps) {
  const [reason, setReason] = useState('');
  const { touched, touch, resetTouched } = useTouchedFields();

  useEffect(() => {
    if (open) {
      setReason('');
      resetTouched();
    }
  }, [open, resetTouched]);

  const reasonError = validateVoidReason(reason);
  const canSubmit = reasonError === null && !submitting;

  function submit() {
    if (!canSubmit) return;
    onSubmit({ reason: reason.trim() });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Void sale ${saleNumber}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="danger" loading={submitting} disabled={!canSubmit} onClick={submit}>
            Void sale
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error !== null && <ErrorNotice>{error}</ErrorNotice>}
        <WarningNotice>
          Voiding puts the stock back into the batches it came from and reverses every tender on
          the sale. It is recorded against your name and cannot be undone.
        </WarningNotice>
        <Field
          label="Reason"
          htmlFor="void-reason"
          hint="At least 3 characters. This is the audit trail for the void."
          error={shownError(touched, 'reason', reasonError)}
          required
        >
          <Textarea
            id="void-reason"
            rows={3}
            value={reason}
            placeholder="Wrong item rung, customer changed their mind…"
            onChange={(event) => {
              touch('reason');
              setReason(event.target.value);
            }}
          />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Add a payment
// ---------------------------------------------------------------------------

export interface AddPaymentModalProps {
  open: boolean;
  saleNumber: string;
  /** Decimal string still owed, prefilled into the amount box. */
  outstanding: string;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: CreateSalePayment) => void;
}

export function AddPaymentModal({
  open,
  saleNumber,
  outstanding,
  submitting,
  error,
  onClose,
  onSubmit,
}: AddPaymentModalProps) {
  const [method, setMethod] = useState<SalePaymentMethod>('cash');
  const [amountText, setAmountText] = useState('');
  const [reference, setReference] = useState('');
  const { touched, touch, resetTouched } = useTouchedFields();

  useEffect(() => {
    if (open) {
      setMethod('cash');
      setAmountText(outstanding);
      setReference('');
      resetTouched();
    }
  }, [open, outstanding, resetTouched]);

  const amount = paymentAmountBody(amountText);
  const canSubmit = amount.ok && !submitting;

  function submit() {
    if (!amount.ok || submitting) return;
    const trimmedReference = reference.trim();
    onSubmit({
      method,
      amount: amount.amount,
      // A momo reference is thrown away and replaced by one this server mints, so
      // it is only collected — and only sent — on a cash tender.
      ...(method === 'cash' && trimmedReference !== '' ? { reference: trimmedReference } : {}),
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Add a payment to sale ${saleNumber}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} disabled={!canSubmit} onClick={submit}>
            Add payment
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error !== null && <ErrorNotice>{error}</ErrorNotice>}
        <p className="text-sm text-neutral-600">
          Still owed on this sale:{' '}
          <Money value={outstanding} className="font-semibold text-neutral-900" />
        </p>
        {method === 'momo' && (
          <WarningNotice>
            A mobile-money payment is recorded as awaiting confirmation and completes when the
            gateway confirms it, not now.
          </WarningNotice>
        )}
        <Field label="Method" htmlFor="add-payment-method">
          <Select
            id="add-payment-method"
            value={method}
            onChange={(event) => setMethod(event.target.value as SalePaymentMethod)}
          >
            {SALE_PAYMENT_METHODS.map((option) => (
              <option key={option} value={option}>
                {METHOD_WORD[option]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Amount"
          htmlFor="add-payment-amount"
          hint="In cedis, for example 12.50"
          error={shownError(touched, 'amount', amount.ok ? null : amount.message)}
          required
        >
          <Input
            id="add-payment-amount"
            type="text"
            inputMode="decimal"
            value={amountText}
            onChange={(event) => {
              touch('amount');
              setAmountText(event.target.value);
            }}
          />
        </Field>
        {method === 'cash' && (
          <Field
            label="Note"
            htmlFor="add-payment-reference"
            hint="Optional. A note on this cash payment."
          >
            <Input
              id="add-payment-reference"
              value={reference}
              autoComplete="off"
              onChange={(event) => setReference(event.target.value)}
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}
