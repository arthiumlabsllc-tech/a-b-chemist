/**
 * The pure logic behind `/inventory`: turning filter state into a query, deriving
 * the two things a stock row is judged on — how much is left and how close it is
 * to its expiry date — and validating what the receive, adjust, write-off and
 * product forms write.
 *
 * Kept out of the pages for the reason `lib/sales.ts` gives. A query built inline
 * in a `useEffect` cannot be tested without rendering the page, and the
 * omit-empty rule, the FEFO day count and the "sellable on the expiry date, not
 * after" edge are exactly the things that break silently. Here they are functions
 * with tests that have been seen to fail.
 */

import { decimalStringFromPesewas } from 'a-and-b-chemist-shared';

import { PRODUCT_LIMITS } from './api-types';
import { daysSinceEpoch } from './dates';
import { parseCediInput } from './pricing';

// ---------------------------------------------------------------------------
// Filters and the list query
// ---------------------------------------------------------------------------

/**
 * The filter controls on `/inventory`. As in `SalesFilters`, the empty string is
 * "not set" for a text field and `productQueryFrom` is what turns that into an
 * omitted parameter rather than an empty one.
 */
export interface InventoryFilters {
  search: string;
  category: string;
  includeInactive: boolean;
}

export const EMPTY_INVENTORY_FILTERS: InventoryFilters = {
  search: '',
  category: '',
  includeInactive: false,
};

/**
 * The query for `GET /inventory`.
 *
 * Only `limit` and `offset` are always present. `includeInactive` is sent only
 * when it is true: the route reads a missing value as false and excludes inactive
 * products, and `api-client`'s `buildQuery` would render an explicit `false` as
 * the string `"false"` — which the route's `=== 'true' || === true` test would
 * still read as false, but sending it is noise that says nothing.
 */
export function productQueryFrom(
  filters: InventoryFilters,
  limit: number,
  offset: number
): Record<string, string | number> {
  const query: Record<string, string | number> = { limit, offset };
  const search = filters.search.trim();
  if (search !== '') query.search = search;
  const category = filters.category.trim();
  if (category !== '') query.category = category;
  if (filters.includeInactive) query.includeInactive = 'true';
  return query;
}

/** Whether any filter is set, so the page knows to offer "Clear". */
export function productFiltersActive(filters: InventoryFilters): boolean {
  return (
    filters.search.trim() !== '' || filters.category.trim() !== '' || filters.includeInactive
  );
}

// ---------------------------------------------------------------------------
// Stock level
// ---------------------------------------------------------------------------

export type StockLevel = 'out' | 'low' | 'ok';

/**
 * How a product's on-hand count reads against its reorder point.
 *
 * `quantity` is the derived physical count, expired stock included — the honest
 * figure for "what is in the drawer". A reorder level of zero means no reorder
 * point is set, so such a product is only ever out, never low: treating 0 as a
 * threshold would flag every in-stock product with no reorder level as low.
 */
export function stockLevel(quantity: number, reorderLevel: number): StockLevel {
  if (quantity <= 0) return 'out';
  if (reorderLevel > 0 && quantity <= reorderLevel) return 'low';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/**
 * The window an expiry is flagged inside, copied from `backend/src/utils/fefo.ts`.
 *
 * A value list would be guarded by the mirror suite; a lone number is not, so it
 * is named here and read nowhere else. If the backend's window moves, this moves
 * with it and the badge copy moves too — they are one decision.
 */
export const EXPIRY_ALERT_WINDOW_DAYS = 90;

/**
 * Whole days from `today` until `expiryDate`, or null when either is missing or
 * undated. Negative once the date has passed, zero on the day itself.
 *
 * This is fefo's `daysUntilExpiry`, re-derived here because the backend sends the
 * day count only for the *leading* lot and the batches table flags every lot. The
 * arithmetic itself is `lib/dates.ts`, which refuses an impossible date by the
 * same round trip fefo does — a copy of it here would be a third place to keep the
 * "sellable on the expiry date, not after" boundary right.
 *
 * Display-only: the till still sells against the server's `sellable` figure, and
 * the boundary is a named test below rather than something implied by a
 * comparison.
 */
export function daysUntilExpiry(expiryDate: string | null, today: string): number | null {
  if (expiryDate === null) return null;
  const expiry = daysSinceEpoch(expiryDate);
  const now = daysSinceEpoch(today);
  if (expiry === null || now === null) return null;
  return expiry - now;
}

export type ExpiryState = 'none' | 'expired' | 'soon' | 'ok';

/**
 * The badge a day count earns. `none` is undated stock, which has no date to be
 * past and is never flagged; `expired` is a negative count; `soon` is inside the
 * alert window, zero (today) included.
 */
export function expiryState(daysToExpiry: number | null): ExpiryState {
  if (daysToExpiry === null) return 'none';
  if (daysToExpiry < 0) return 'expired';
  if (daysToExpiry <= EXPIRY_ALERT_WINDOW_DAYS) return 'soon';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Form field parsers and validators
// ---------------------------------------------------------------------------

export type QuantityResult = { ok: true; quantity: number } | { ok: false; message: string };

/**
 * A whole-number count typed into a receive, adjust or write-off box.
 *
 * `min` varies by route: a receive is at least 1, an adjustment may count a batch
 * down to 0, a write-off is at least 1 but optional — the modal omits the field
 * for "the whole batch" rather than sending a number. Bounded by
 * `PRODUCT_LIMITS.quantity`, the same figures the route's `isInt` enforces.
 */
export function quantityBody(
  text: string,
  label: string,
  min: number,
  max: number
): QuantityResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, message: `Enter ${label}` };
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: `Enter ${label} as a whole number` };
  const value = Number(trimmed);
  if (value < min) return { ok: false, message: `Enter ${min} or more` };
  if (value > max) return { ok: false, message: `Enter ${max} or fewer` };
  return { ok: true, quantity: value };
}

export type MoneyResult = { ok: true; amount: string } | { ok: false; message: string };

/**
 * A cost or unit price typed into a form, as the two-decimal string the money
 * columns store. Zero is allowed — an unknown cost or a free item is 0, and the
 * service defaults a missing cost to it — so this is `paymentAmountBody` from
 * `lib/sales.ts` without the "more than zero" rule.
 */
export function moneyBody(text: string, label: string): MoneyResult {
  const pesewas = parseCediInput(text);
  if (pesewas === null) {
    return { ok: false, message: `Enter ${label} as an amount, for example 12.50` };
  }
  return { ok: true, amount: decimalStringFromPesewas(pesewas) };
}

/** A required single-line field, trimmed and bounded. `null` when it passes. */
export function requiredText(value: string, label: string, max: number): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return `Enter ${label}`;
  if (trimmed.length > max) return `Keep ${label} under ${max} characters`;
  return null;
}

/** An optional single-line field: empty passes, but a value is bounded. */
export function optionalText(value: string, label: string, max: number): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) return `Keep ${label} under ${max} characters`;
  return null;
}

/**
 * Why stock is changing. Mandatory on an adjustment and a write-off, where it is
 * the audit trail; the bound is `PRODUCT_LIMITS.reason`, the route's own.
 */
export function validateCorrectionReason(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length < PRODUCT_LIMITS.reason.min) {
    return `Give at least ${PRODUCT_LIMITS.reason.min} characters — this is the audit trail for the correction`;
  }
  if (trimmed.length > PRODUCT_LIMITS.reason.max) {
    return `Keep the reason under ${PRODUCT_LIMITS.reason.max} characters`;
  }
  return null;
}

/**
 * What was counted or what happened. Mandatory on a correction and at least one
 * character — the route enforces `min: 1` on a correction's note even though
 * `PRODUCT_LIMITS.note.min` is 0, because 0 is the bound for the optional one.
 */
export function validateCorrectionNote(note: string): string | null {
  const trimmed = note.trim();
  if (trimmed === '') return 'Describe what was counted or what happened';
  if (trimmed.length > PRODUCT_LIMITS.note.max) {
    return `Keep the note under ${PRODUCT_LIMITS.note.max} characters`;
  }
  return null;
}

/** A receive's reason is optional, but if given it is a real one. */
export function validateOptionalReason(reason: string): string | null {
  return reason.trim() === '' ? null : validateCorrectionReason(reason);
}

/** A receive's note is optional, but if given it is bounded. */
export function validateOptionalNote(note: string): string | null {
  return optionalText(note, 'the note', PRODUCT_LIMITS.note.max);
}
