/**
 * The pure logic behind `/sales`: turning filter state into a query, and
 * validating the two things the sale detail page writes — a void reason and an
 * amount added to a pending sale.
 *
 * Kept out of the pages for the reason every `lib` module exists. A query built
 * inline in a `useEffect` cannot be tested without rendering the page, and the
 * omit-empty rule — an unset filter must not be sent as `?status=`, which the
 * backend would then have to interpret as a value — is exactly the kind of thing
 * that breaks silently. Here it is a function with a test that has been seen to
 * fail.
 */

import { decimalStringFromPesewas, pesewasFromDecimalString } from 'a-and-b-chemist-shared';

import { SALE_LIMITS } from './api-types';
import type { SaleStatus } from './api-types';
import { parseCediInput } from './pricing';

/**
 * The filter controls on `/sales`. The empty string is "not set" for every field:
 * a `<select>` resting on "All statuses" and a cleared text box both arrive here
 * as `''`, and `salesQueryFrom` is what turns that into an omitted parameter
 * rather than an empty one.
 */
export interface SalesFilters {
  status: SaleStatus | '';
  search: string;
  /** `YYYY-MM-DD`, as an `<input type="date">` yields. Empty means unset. */
  from: string;
  to: string;
  servedBy: string;
}

export const EMPTY_SALES_FILTERS: SalesFilters = {
  status: '',
  search: '',
  from: '',
  to: '',
  servedBy: '',
};

/**
 * The query for `GET /sales`.
 *
 * Only `limit` and `offset` are always present; a filter that is not set is left
 * out entirely rather than sent empty. `api-client`'s `buildQuery` drops
 * `undefined` and `null` but not `''`, so the omission happens here, where the
 * empty-means-unset rule is written down once and held by a test.
 */
export function salesQueryFrom(
  filters: SalesFilters,
  limit: number,
  offset: number
): Record<string, string | number> {
  const query: Record<string, string | number> = { limit, offset };
  if (filters.status !== '') query.status = filters.status;
  const search = filters.search.trim();
  if (search !== '') query.search = search;
  if (filters.from !== '') query.from = filters.from;
  if (filters.to !== '') query.to = filters.to;
  if (filters.servedBy !== '') query.servedBy = filters.servedBy;
  return query;
}

/** Whether any filter is set, so the page knows to offer "Clear". */
export function salesFiltersActive(filters: SalesFilters): boolean {
  return (
    filters.status !== '' ||
    filters.search.trim() !== '' ||
    filters.from !== '' ||
    filters.to !== '' ||
    filters.servedBy !== ''
  );
}

/**
 * A start date after the end date matches nothing, and the backend would run the
 * query and return an empty list — which reads as "no sales in this range" rather
 * than "you typed the range backwards". Catching it here puts a sentence on the
 * screen instead. An open end is not an error: leaving one bound unset is normal.
 */
export function validateDateRange(from: string, to: string): string | null {
  if (from === '' || to === '') return null;
  // `YYYY-MM-DD` sorts lexicographically the same as chronologically.
  return from <= to ? null : 'The start date is after the end date';
}

/**
 * Why this sale is being voided. The bound is `SALE_LIMITS.voidReason` — the same
 * figures the route validates — so the operator is told before the round trip that
 * "oops" is too short to be an audit trail.
 */
export function validateVoidReason(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length < SALE_LIMITS.voidReason.min) {
    return `Give at least ${SALE_LIMITS.voidReason.min} characters — this is the audit trail for the void`;
  }
  if (trimmed.length > SALE_LIMITS.voidReason.max) {
    return `Keep the reason under ${SALE_LIMITS.voidReason.max} characters`;
  }
  return null;
}

export type PaymentAmountResult =
  | { ok: true; amount: string; pesewas: number }
  | { ok: false; message: string };

/**
 * What the operator typed into an "add payment" box, as the decimal string the API
 * stores.
 *
 * `parseCediInput` already refuses anything that is not a bounded amount, so a
 * null is "not an amount" and a non-positive figure is "an amount that pays
 * nothing". Running through pesewas and back with `decimalStringFromPesewas`
 * normalises `12.` and `12.5` to `12.00` and `12.50` — the two-decimal form the
 * money columns hold — rather than forwarding whatever string was typed.
 */
export function paymentAmountBody(text: string): PaymentAmountResult {
  const pesewas = parseCediInput(text);
  if (pesewas === null) {
    return { ok: false, message: 'Enter the amount this payment covers, for example 12.50' };
  }
  if (pesewas <= 0) {
    return { ok: false, message: 'The amount must be more than zero' };
  }
  return { ok: true, amount: decimalStringFromPesewas(pesewas), pesewas };
}

/**
 * What is still owed on a sale, as a decimal string, floored at zero.
 *
 * Pesewas arithmetic rather than `Number(total) - Number(paid)`: both arrive as
 * decimal strings off `numeric` columns, and subtracting them as floats is how a
 * fraction of a pesewa creeps into the one figure the operator then types into the
 * drawer. Floored because a sale can be overpaid — change given — and an "add
 * payment" box prefilled with a negative owed would be nonsense.
 */
export function outstandingBalance(total: string, paid: string): string {
  const owed =
    pesewasFromDecimalString(total, 'the total') -
    pesewasFromDecimalString(paid, 'the amount paid');
  return decimalStringFromPesewas(owed > 0 ? owed : 0);
}
