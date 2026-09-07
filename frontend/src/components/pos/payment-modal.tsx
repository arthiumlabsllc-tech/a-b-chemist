'use client';

/**
 * Taking the money.
 *
 * The modal opens on a total — online, the *server's* figure, fetched by the page
 * the moment Charge was pressed; offline, the figure this device priced — and not
 * on the basket panel's local preview. That is the whole point of the quote round
 * trip: the number the customer is asked for here is the number the write path will
 * use, so a price or a rate that moved since the grid loaded is already reflected,
 * and the total at the top of this modal is the one on the receipt.
 *
 * ## Why it takes a total and not a `QuoteResult`
 *
 * It only ever read `quote.basket.total`. Taking the whole quote would have let an
 * offline caller satisfy the prop by building a `QuoteResult` on the device, and a
 * `QuoteResult` is mostly tax columns — `vatAmount`, `nhilAmount`, `getfundAmount`
 * on every line plus a `BasketView`. Filling those in offline is exactly what
 * BRIEF.md §4.5 forbids, and the type would have permitted it. Asking for the one
 * string this modal actually charges against makes the fabrication unreachable
 * rather than merely discouraged.
 *
 * ## Offline
 *
 * Cash only, and not as a disabled option: a mobile-money tender is written
 * `pending` and settled by the gateway, so offline it cannot even be started —
 * there is no charge for the customer to approve. Queueing one would be recording a
 * claim that money moved when nothing did. The warning spells out the other two
 * things the server has not confirmed, stock and the split, because this is the
 * last moment anybody can act on them: after the button the sale is held and the
 * next look at it is on `/sync`.
 *
 * ## What it decides locally, and why that is safe
 *
 * The change and the "this combination will be refused" message come from
 * `previewTenders`, which is the client-side reading of the two rules in
 * `backend/src/utils/settlement.ts`. Mirroring them here is not duplicating
 * authority — the server still decides, and if the two ever disagreed the server's
 * answer arrives as the error this modal shows on submit. What mirroring buys is
 * that the operator sees the change before they count it into a hand, and sees a
 * refused split before they press pay, instead of after a round trip.
 *
 * ## Mobile money is not settled here
 *
 * A cash tender is money in the drawer. A mobile-money tender is written `pending`
 * and only the gateway can settle it, so a momo sale completes later — on the
 * webhook, or on the verify route when the webhook does not arrive. This modal
 * therefore never claims a momo sale is paid; the receipt says it is awaiting
 * confirmation. When the gateway is in test or unconfigured, a warning says so
 * before the operator asks a customer to approve a charge that is not real.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { controlClass } from '@/components/ui/field';
import { ErrorNotice, WarningNotice } from '@/components/ui/display';
import { ROLE_LABELS } from '@/lib/navigation';
import { parseCediInput, cediText } from '@/lib/pricing';
import { previewTenders } from '@/lib/tender';
import type { TenderDraft } from '@/lib/tender';
import { SALE_PAYMENT_METHODS } from '@/lib/api-types';
import type { Approver, GatewayMode, PaymentConfig, SalePaymentMethod } from '@/lib/api-types';

/** At most four tenders, matching the backend's `MAX_TENDERS_PER_SALE`. */
const MAX_TENDERS = 4;

/** The only tender that does not need a server to settle it. */
const CASH_ONLY: readonly SalePaymentMethod[] = ['cash'];

const METHOD_LABELS: Record<SalePaymentMethod, string> = {
  cash: 'Cash',
  momo: 'Mobile money',
};

interface TenderRow {
  key: string;
  method: SalePaymentMethod;
  /** Raw cedi text, so the operator can pass through '12.' on the way to '12.50'. */
  amountText: string;
  reference: string;
}

export interface PaymentModalProps {
  open: boolean;
  /**
   * What to charge, as a plain decimal string in cedis — `'25.00'`, with no
   * thousands separator, so `parseCediInput` accepts it and the operator can edit
   * it. Online this is the server's `quote.basket.total`; offline it is the total
   * this device priced.
   */
  totalText: string;
  /** True when the server could not be reached, so the sale will be held on device. */
  offline: boolean;
  paymentConfig: PaymentConfig | null;
  approvers: readonly Approver[];
  /** True when a line needs a pharmacist's or the owner's approval. */
  requiresApproval: boolean;
  submitting: boolean;
  error: string | null;
  onSubmit: (tenders: TenderDraft[], approverId: string | null) => void;
  onClose: () => void;
}

function gatewayWarning(mode: GatewayMode): string | null {
  if (mode === 'live') return null;
  return mode === 'test'
    ? 'Mobile money is in test mode. A charge here is not real and will not move money.'
    : 'Mobile money is not configured on this server, so a charge cannot be confirmed. Take cash, or ask the owner to configure the gateway.';
}

export function PaymentModal({
  open,
  totalText,
  offline,
  paymentConfig,
  approvers,
  requiresApproval,
  submitting,
  error,
  onSubmit,
  onClose,
}: PaymentModalProps) {
  const approverId = useId();
  const nextKey = useRef(0);

  const [rows, setRows] = useState<TenderRow[]>([]);
  const [approver, setApprover] = useState('');

  const totalPesewas = parseCediInput(totalText) ?? 0;

  // Reset every time the modal opens, so a sale is never charged against the
  // tenders of the one before it. The first row is cash, prefilled with the exact
  // total — the common case is one note that covers it, and the operator edits the
  // figure only when the customer hands over more.
  useEffect(() => {
    if (!open) return;
    nextKey.current += 1;
    setRows([{ key: `t${nextKey.current}`, method: 'cash', amountText: totalText, reference: '' }]);
    setApprover('');
  }, [open, totalText]);

  const drafts: TenderDraft[] = rows.map((row) => ({
    method: row.method,
    amountPesewas: parseCediInput(row.amountText) ?? 0,
    ...(row.method === 'cash' ? { reference: row.reference } : {}),
  }));
  const preview = previewTenders(drafts, totalPesewas);

  const usesMomo = rows.some((row) => row.method === 'momo');
  const warning =
    usesMomo && paymentConfig !== null ? gatewayWarning(paymentConfig.mode) : null;

  const methods = offline ? CASH_ONLY : SALE_PAYMENT_METHODS;

  const approvalMissing = requiresApproval && approver === '';
  const canSubmit =
    preview.fault === null && preview.settled && !approvalMissing && !submitting;

  function updateRow(key: string, patch: Partial<TenderRow>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function addRow() {
    if (rows.length >= MAX_TENDERS) return;
    nextKey.current += 1;
    setRows((current) => [
      ...current,
      { key: `t${nextKey.current}`, method: 'cash', amountText: '', reference: '' },
    ]);
  }

  function removeRow(key: string) {
    setRows((current) => current.filter((row) => row.key !== key));
  }

  function submit() {
    if (!canSubmit) return;
    onSubmit(drafts, requiresApproval ? approver : null);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`Take payment · ${cediText(totalPesewas)}`}
      footer={
        <div className="space-y-2">
          <div className="flex items-center justify-between text-base font-semibold text-neutral-900">
            <span>{preview.changePesewas > 0 ? 'Change due' : 'Total due'}</span>
            <span className="money">
              {cediText(preview.changePesewas > 0 ? preview.changePesewas : preview.duePesewas)}
            </span>
          </div>
          <Button variant="primary" size="lg" block loading={submitting} disabled={!canSubmit} onClick={submit}>
            {submitting
              ? offline
                ? 'Holding…'
                : 'Recording…'
              : `${offline ? 'Hold on this device' : 'Complete sale'} · ${cediText(totalPesewas)}`}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error !== null && <ErrorNotice>{error}</ErrorNotice>}
        {offline && (
          <WarningNotice>
            The server cannot be reached. This sale will be held on this device and sent when the
            connection returns. The total is provisional and stock has not been checked — the
            server confirms both when it records the sale, and if it disagrees the sale will appear
            on Sync needing a decision. Mobile money is not offered: a charge cannot be started
            without the gateway.
          </WarningNotice>
        )}
        {warning !== null && <WarningNotice>{warning}</WarningNotice>}
        {preview.fault !== null && <ErrorNotice>{preview.fault}</ErrorNotice>}

        <div className="space-y-2">
          {rows.map((row) => (
            <div
              key={row.key}
              className="grid grid-cols-[auto_1fr_auto] items-start gap-2 rounded-lg border border-surface-200 p-2"
            >
              <select
                aria-label="Payment method"
                value={row.method}
                onChange={(event) =>
                  updateRow(row.key, { method: event.target.value as SalePaymentMethod })
                }
                className={[controlClass, 'min-h-touch w-32 text-sm'].join(' ')}
              >
                {methods.map((method) => (
                  <option key={method} value={method}>
                    {METHOD_LABELS[method]}
                  </option>
                ))}
              </select>

              <div className="space-y-2">
                <label className="block">
                  <span className="sr-only">Amount in cedis</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={row.amountText}
                    placeholder="0.00"
                    onChange={(event) => updateRow(row.key, { amountText: event.target.value })}
                    className={[controlClass, 'min-h-touch text-sm'].join(' ')}
                  />
                </label>
                {row.method === 'cash' && (
                  <label className="block">
                    <span className="sr-only">Cash note (optional)</span>
                    <input
                      type="text"
                      value={row.reference}
                      placeholder="Note (optional)"
                      onChange={(event) => updateRow(row.key, { reference: event.target.value })}
                      className={[controlClass, 'min-h-touch text-sm'].join(' ')}
                    />
                  </label>
                )}
              </div>

              <button
                type="button"
                aria-label="Remove this tender"
                onClick={() => removeRow(row.key)}
                disabled={rows.length === 1}
                className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-md text-neutral-400 hover:bg-surface-100 hover:text-danger-600 disabled:opacity-30"
              >
                <span aria-hidden="true" className="text-xl leading-none">
                  {'\u00d7'}
                </span>
              </button>
            </div>
          ))}

          <div className="flex items-center justify-between gap-2">
            <Button variant="secondary" size="md" onClick={addRow} disabled={rows.length >= MAX_TENDERS}>
              Add tender
            </Button>
            <Button
              variant="ghost"
              size="md"
              onClick={() => {
                const [first] = rows;
                if (first !== undefined) {
                  updateRow(first.key, { method: 'cash', amountText: totalText, reference: first.reference });
                  setRows((current) => current.slice(0, 1));
                }
              }}
            >
              Exact cash
            </Button>
          </div>
        </div>

        <dl className="space-y-1 rounded-lg bg-surface-50 p-3 text-sm">
          <div className="flex justify-between text-neutral-600">
            <dt>Tendered</dt>
            <dd className="money">{cediText(preview.tenderedPesewas)}</dd>
          </div>
          <div className="flex justify-between text-neutral-600">
            <dt>Still due</dt>
            <dd className="money">{cediText(preview.duePesewas)}</dd>
          </div>
          <div className="flex justify-between font-semibold text-neutral-900">
            <dt>Change</dt>
            <dd className="money">{cediText(preview.changePesewas)}</dd>
          </div>
        </dl>

        {requiresApproval && (
          <div>
            <label className="block text-sm font-medium text-neutral-700" htmlFor={approverId}>
              Approver
              <span aria-hidden="true" className="text-danger-600">
                {' *'}
              </span>
            </label>
            <p className="mt-0.5 text-2xs text-neutral-500">
              This basket has a prescription-only item, so a pharmacist or the owner must approve it.
            </p>
            <select
              id={approverId}
              value={approver}
              onChange={(event) => setApprover(event.target.value)}
              className={[controlClass, 'mt-1'].join(' ')}
            >
              <option value="">Select who is approving…</option>
              {approvers.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.fullName} · {ROLE_LABELS[person.role]}
                </option>
              ))}
            </select>
            {approvers.length === 0 && (
              <p className="mt-1 text-2xs text-danger-700">
                Nobody who can approve is signed in to this pharmacy. Ask the owner or a pharmacist.
              </p>
            )}
          </div>
        )}

        {usesMomo && (
          <p className="text-2xs text-neutral-500">
            A mobile-money sale is recorded as awaiting confirmation and completes when the payment
            is confirmed.
          </p>
        )}
      </div>
    </Modal>
  );
}
