/**
 * The money the payment modal handles: what has been tendered, what is still
 * due, what change to hand back, and the conversion into the shape `POST /sales`
 * wants.
 *
 * This is separated from the modal for the same reason `pricing.ts` is separated
 * from the basket panel — getting change wrong is not a cosmetic bug, it is money
 * out of the drawer that the day's reconciliation will not explain, and it is the
 * one figure a customer will argue with at the counter. So it is a pure function
 * with a suite, and the modal only renders it.
 *
 * ## Units
 *
 * Everything here is whole pesewas, the unit `pricing.ts` and the shared engine
 * work in. The quoted total arrives as a decimal string and is parsed to pesewas
 * by the caller with `parseCediInput`; the tenders go back out as decimal strings
 * in `toCreateSalePayments`, because `CreateSalePayment.amount` is what the
 * `numeric(12, 2)` column stores. This module is one of the two places that
 * crossing happens, and it happens at the very end, on the way to the wire.
 *
 * ## Change is not the server's job to reveal
 *
 * The backend recomputes `changeGiven` from the tenders when it writes the sale,
 * and its figure is the one on the receipt. The change computed here is the one
 * shown to the operator *before* they submit, so they can count it into the
 * customer's hand. They agree because they are the same subtraction; showing it
 * early is the point, not duplicating authority.
 */

import { decimalStringFromPesewas } from 'a-and-b-chemist-shared';

import type { CreateSalePayment, SalePaymentMethod } from './api-types';
import { cediText } from './pricing';

/** One tender as the operator is entering it, before it is a payment. */
export interface TenderDraft {
  method: SalePaymentMethod;
  /** Whole pesewas. Zero or negative means "not really a tender yet". */
  amountPesewas: number;
  /** The operator's note on a cash line. Ignored on mobile money. */
  reference?: string;
}

/** The sum of every tender, in pesewas. */
export function tendersTotalPesewas(tenders: readonly TenderDraft[]): number {
  return tenders.reduce((total, tender) => total + Math.max(0, tender.amountPesewas), 0);
}

/**
 * What is still owed, in pesewas, or zero when the tenders cover the total.
 *
 * Clamped at zero rather than allowed to go negative: an overpayment is not a
 * negative remaining, it is change, and the two are asked for separately.
 */
export function remainingDuePesewas(
  tenders: readonly TenderDraft[],
  totalPesewas: number
): number {
  return Math.max(0, totalPesewas - tendersTotalPesewas(tenders));
}

/**
 * What to hand back, in pesewas, or zero when the tenders do not exceed the total.
 *
 * Change only ever comes out of the drawer as cash, but the arithmetic does not
 * need to know that: it is what was tendered minus what was owed. A split that
 * overshoots is the operator's to correct before submitting, and the modal shows
 * this figure so they can.
 */
export function changeDuePesewas(
  tenders: readonly TenderDraft[],
  totalPesewas: number
): number {
  return Math.max(0, tendersTotalPesewas(tenders) - totalPesewas);
}

/** True when the tenders cover the total, so the sale can be completed. */
export function isSettled(tenders: readonly TenderDraft[], totalPesewas: number): boolean {
  return remainingDuePesewas(tenders, totalPesewas) === 0;
}

/**
 * The tenders as `POST /sales` takes them.
 *
 * Anything that is not a positive whole number of pesewas is dropped rather than
 * sent: an empty row the operator added and never filled, or a field still
 * holding `'-'` mid-typing, must not become a payment the backend then refuses
 * over. The reference is sent on a cash tender and not on a mobile-money one,
 * because the server mints the mobile-money reference itself — it is what a
 * webhook finds the charge by — and discards anything a caller sent.
 */
export function toCreateSalePayments(tenders: readonly TenderDraft[]): CreateSalePayment[] {
  const payments: CreateSalePayment[] = [];
  for (const tender of tenders) {
    if (!Number.isInteger(tender.amountPesewas) || tender.amountPesewas <= 0) {
      continue;
    }
    const payment: CreateSalePayment = {
      method: tender.method,
      amount: decimalStringFromPesewas(tender.amountPesewas),
    };
    if (tender.method === 'cash') {
      const note = tender.reference?.trim();
      if (note !== undefined && note !== '') {
        payment.reference = note;
      }
    }
    payments.push(payment);
  }
  return payments;
}

/**
 * What the server will do with these tenders, decided before they are sent.
 *
 * `remainingDuePesewas` and `changeDuePesewas` above are raw arithmetic: what was
 * tendered against what was owed. The write path is not that simple, and the
 * modal must not show a figure the receipt will contradict. Two rules in
 * `backend/src/utils/settlement.ts` decide what actually happens, and this is the
 * client-side reading of them:
 *
 *  - **Change is given only on a lone cash tender that overpays.** A wallet is
 *    debited for exactly what it is told and cannot be handed coins back, so a
 *    mobile-money part, or a split of two cash notes, produces no change — the
 *    server refuses the overshoot instead. `settle` computes `change_given` this
 *    way and `tenderFault` refuses the combinations that would need it.
 *  - **Any overshoot that is not that lone cash tender is refused**, with prose
 *    the operator reads aloud. Mirroring the refusal here means the submit button
 *    is disabled and the fix is on screen, rather than the operator pressing pay,
 *    waiting a round trip, and being told what they already could have seen.
 *
 * Only whole, positive pesewas count, matching `toCreateSalePayments`: a row the
 * operator added and has not filled, or a field caught mid-typing at `'12.'`, is
 * not a tender and must not move the change figure or trip the fault.
 *
 * Status is deliberately not decided here. A mobile-money tender is written
 * `pending` and only the gateway can settle it, so whether the sale *completes*
 * is the server's answer on the receipt, not something this preview can promise.
 * `settled` says only that the tenders cover the total — enough to enable submit.
 */
export interface TenderPreview {
  /** Why the server will refuse this combination, or null when it will take it. */
  fault: string | null;
  /** Change the drawer owes back: non-zero only on a lone cash tender that overpaid. */
  changePesewas: number;
  /** What has been tendered, counting only the drafts that will actually be sent. */
  tenderedPesewas: number;
  /** What is still owed, clamped at zero. */
  duePesewas: number;
  /** True when the tenders cover the total, so the sale may be submitted. */
  settled: boolean;
}

export function previewTenders(
  tenders: readonly TenderDraft[],
  totalPesewas: number
): TenderPreview {
  const live = tenders.filter(
    (tender) => Number.isInteger(tender.amountPesewas) && tender.amountPesewas > 0
  );
  const tenderedPesewas = live.reduce((sum, tender) => sum + tender.amountPesewas, 0);
  const duePesewas = Math.max(0, totalPesewas - tenderedPesewas);
  const settled = duePesewas === 0;

  const loneCash = live.length === 1 && live[0]?.method === 'cash';
  const changePesewas =
    loneCash && tenderedPesewas > totalPesewas ? tenderedPesewas - totalPesewas : 0;

  let fault: string | null = null;
  if (tenderedPesewas > totalPesewas && !loneCash) {
    const overBy = tenderedPesewas - totalPesewas;
    fault = live.some((tender) => tender.method === 'momo')
      ? `Mobile money cannot be given change. The tenders come to ${cediText(tenderedPesewas)} on a ` +
        `${cediText(totalPesewas)} sale — reduce the mobile money part so they total exactly ${cediText(totalPesewas)}.`
      : `That is ${cediText(overBy)} more than the ${cediText(totalPesewas)} due. Change is only given on a ` +
        'single cash payment, so enter the exact amount.';
  }

  return { fault, changePesewas, tenderedPesewas, duePesewas, settled };
}
