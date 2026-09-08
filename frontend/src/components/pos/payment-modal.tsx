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
 * ## The shape of the screen
 *
 * A till is operated with a thumb, so the money goes in the way a till takes it: a
 * keypad and a row of note chips on one side, the method as big tiles rather than a
 * dropdown, and the tenders already committed listed where the operator can count
 * them against the cash in their hand. The operator composes one tender at a time in
 * the amount field and commits it with "Add payment"; "Complete" only enables once
 * the committed tenders cover the total. Composing-then-committing, rather than
 * editing a list of rows in place, is what keeps a half-entered second note from
 * ever looking like money the sale already has.
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

import { decimalStringFromPesewas } from 'a-and-b-chemist-shared';

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

/**
 * The note denominations worth a single tap, largest first: the notes a Ghanaian
 * drawer actually holds, so covering a total is a couple of taps rather than a
 * keyed figure. One cedi rounds it off.
 */
const QUICK_ADD_CEDIS: readonly number[] = [200, 100, 50, 20, 10, 5, 1];

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

/** A banknote, for the cash tile. */
function CashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5"
    >
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M5.5 9.5v.01M18.5 14.5v.01" />
    </svg>
  );
}

/** A phone, for the mobile-money tile. */
function MomoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5"
    >
      <rect x="7" y="2.5" width="10" height="19" rx="2" />
      <path d="M11 18.5h2" />
    </svg>
  );
}

/** The keypad's delete key. */
function BackspaceIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5"
    >
      <path d="M9 5h12v14H9L3 12l6-7z" />
      <path d="M12.5 9.5l5 5M17.5 9.5l-5 5" />
    </svg>
  );
}

function MethodIcon({ method }: { method: SalePaymentMethod }) {
  return method === 'cash' ? <CashIcon /> : <MomoIcon />;
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
  const amountId = useId();
  const referenceId = useId();
  const approverId = useId();
  const nextKey = useRef(0);

  // The tenders already committed to this sale, and the one being composed on the
  // keypad. Kept apart so a half-entered note never counts towards what is owed.
  const [committed, setCommitted] = useState<TenderRow[]>([]);
  const [method, setMethod] = useState<SalePaymentMethod>('cash');
  const [amountText, setAmountText] = useState('');
  const [reference, setReference] = useState('');
  const [approver, setApprover] = useState('');

  const totalPesewas = parseCediInput(totalText) ?? 0;

  // Reset every time the modal opens, so a sale is never charged against the
  // tenders of the one before it. The composer starts on cash for the exact total —
  // the common case is one tender that covers it, and the operator only reaches for
  // the keypad when the customer hands over something else.
  useEffect(() => {
    if (!open) return;
    setCommitted([]);
    setMethod('cash');
    setAmountText(totalText);
    setReference('');
    setApprover('');
  }, [open, totalText]);

  const drafts: TenderDraft[] = committed.map((row) => ({
    method: row.method,
    amountPesewas: parseCediInput(row.amountText) ?? 0,
    ...(row.method === 'cash' ? { reference: row.reference } : {}),
  }));
  const preview = previewTenders(drafts, totalPesewas);

  const composerPesewas = parseCediInput(amountText) ?? 0;
  const usesMomo = method === 'momo' || committed.some((row) => row.method === 'momo');
  const warning =
    usesMomo && paymentConfig !== null ? gatewayWarning(paymentConfig.mode) : null;

  const methods = offline ? CASH_ONLY : SALE_PAYMENT_METHODS;

  const approvalMissing = requiresApproval && approver === '';
  const canAdd = composerPesewas > 0 && committed.length < MAX_TENDERS && !submitting;
  const canSubmit =
    preview.fault === null && preview.settled && !approvalMissing && !submitting;

  function pressKey(key: string) {
    setAmountText((current) => {
      if (key === 'back') return current.slice(0, -1);
      if (key === '.') {
        if (current.includes('.')) return current;
        return current === '' ? '0.' : `${current}.`;
      }
      if (current.includes('.')) {
        const [, decimals = ''] = current.split('.');
        if (decimals.length >= 2) return current;
      }
      if (current === '0') return key;
      return `${current}${key}`;
    });
  }

  function addQuickCedis(cedis: number) {
    setAmountText(decimalStringFromPesewas(composerPesewas + cedis * 100));
  }

  function setExactRemaining() {
    setAmountText(decimalStringFromPesewas(preview.duePesewas));
  }

  function addPayment() {
    if (!canAdd) return;
    nextKey.current += 1;
    const row: TenderRow = { key: `t${nextKey.current}`, method, amountText, reference };
    // Leave the next tender pre-filled with what is still outstanding, so a split
    // is two taps rather than a re-keyed figure.
    const remainingAfter = Math.max(0, totalPesewas - (preview.tenderedPesewas + composerPesewas));
    setCommitted((current) => [...current, row]);
    setAmountText(remainingAfter > 0 ? decimalStringFromPesewas(remainingAfter) : '');
    setReference('');
  }

  function removeCommitted(key: string) {
    setCommitted((current) => current.filter((row) => row.key !== key));
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
      title="Take payment"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-neutral-600">
            Committed{' '}
            <span className="money font-semibold text-neutral-900">
              {cediText(preview.tenderedPesewas)}
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="md" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="secondary" size="md" onClick={addPayment} disabled={!canAdd}>
              Add payment
            </Button>
            <Button variant="primary" size="md" loading={submitting} disabled={!canSubmit} onClick={submit}>
              {submitting
                ? offline
                  ? 'Holding…'
                  : 'Recording…'
                : `${offline ? 'Hold on this device' : 'Complete'} · ${cediText(totalPesewas)}`}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-neutral-600">
          <span className="money font-semibold text-neutral-900">{cediText(preview.duePesewas)}</span>{' '}
          still to collect of {cediText(totalPesewas)}
        </p>

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

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium text-neutral-700">Method</p>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {methods.map((option) => {
                  const selected = option === method;
                  return (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setMethod(option)}
                      className={[
                        'flex min-h-touch-lg flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2 text-sm font-medium',
                        selected
                          ? 'border-primary-500 bg-primary-50 text-primary-700 ring-1 ring-primary-500'
                          : 'border-surface-200 bg-white text-neutral-700 hover:bg-surface-100',
                      ].join(' ')}
                    >
                      <MethodIcon method={option} />
                      <span>{METHOD_LABELS[option]}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label htmlFor={amountId} className="text-sm font-medium text-neutral-700">
                Amount (GHS)
              </label>
              <input
                id={amountId}
                type="text"
                inputMode="decimal"
                value={amountText}
                placeholder="0.00"
                onChange={(event) => setAmountText(event.target.value)}
                className={[controlClass, 'mt-1 min-h-touch-lg text-right text-xl font-semibold'].join(' ')}
              />
            </div>

            {method === 'cash' && (
              <div>
                <label htmlFor={referenceId} className="text-sm font-medium text-neutral-700">
                  Note (optional)
                </label>
                <input
                  id={referenceId}
                  type="text"
                  value={reference}
                  placeholder="e.g. the note serial, if you keep one"
                  onChange={(event) => setReference(event.target.value)}
                  className={[controlClass, 'mt-1 min-h-touch text-sm'].join(' ')}
                />
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={setExactRemaining}
                className="min-h-touch rounded-full border border-primary-500 px-3 text-sm font-medium text-primary-700 hover:bg-primary-50"
              >
                Exact {cediText(preview.duePesewas)}
              </button>
              {QUICK_ADD_CEDIS.map((cedis) => (
                <button
                  key={cedis}
                  type="button"
                  onClick={() => addQuickCedis(cedis)}
                  className="min-h-touch rounded-full px-2 text-sm text-neutral-600 hover:bg-surface-100 hover:text-neutral-900"
                >
                  +{cedis}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2" role="group" aria-label="Amount keypad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'].map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => pressKey(key)}
                  aria-label={key === 'back' ? 'Delete last digit' : key === '.' ? 'Decimal point' : key}
                  className="inline-flex min-h-touch-lg items-center justify-center rounded-lg border border-surface-200 bg-white text-lg font-semibold text-neutral-800 hover:bg-surface-100"
                >
                  {key === 'back' ? <BackspaceIcon /> : key}
                </button>
              ))}
            </div>
            <Button variant="secondary" size="md" block onClick={() => setAmountText('')}>
              Clear amount
            </Button>

            <div>
              <p className="text-sm font-medium text-neutral-700">Payments on this sale</p>
              {committed.length === 0 ? (
                <p className="mt-1 rounded-lg border border-dashed border-surface-300 p-3 text-sm text-neutral-500">
                  Nothing added yet. Choose a method and tap “Add payment”.
                </p>
              ) : (
                <ul className="mt-1 divide-y divide-surface-200 rounded-lg border border-surface-200">
                  {committed.map((row) => (
                    <li key={row.key} className="flex items-center gap-2 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate text-sm text-neutral-800">
                        {METHOD_LABELS[row.method]}
                        {row.method === 'cash' && row.reference.trim() !== '' && (
                          <span className="text-neutral-400"> · {row.reference}</span>
                        )}
                      </span>
                      <span className="money shrink-0 text-sm font-semibold text-neutral-900">
                        {cediText(parseCediInput(row.amountText) ?? 0)}
                      </span>
                      <button
                        type="button"
                        aria-label="Remove this payment"
                        onClick={() => removeCommitted(row.key)}
                        disabled={submitting}
                        className="inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-surface-100 hover:text-danger-600 disabled:opacity-30"
                      >
                        <span aria-hidden="true" className="text-xl leading-none">
                          {'×'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-sm text-neutral-600">
                Remaining{' '}
                <span className="money font-semibold text-neutral-900">
                  {cediText(preview.duePesewas)}
                </span>
              </p>
              {preview.changePesewas > 0 && (
                <p className="text-sm text-neutral-600">
                  Change{' '}
                  <span className="money font-semibold text-neutral-900">
                    {cediText(preview.changePesewas)}
                  </span>
                </p>
              )}
            </div>
          </div>
        </div>

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
