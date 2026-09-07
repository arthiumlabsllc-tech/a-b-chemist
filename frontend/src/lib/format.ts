/**
 * Turning the strings the API sends into text a person reads.
 *
 * Money and dates arrive as strings — `pg` hands back `numeric` and `timestamp`
 * as strings and the API does not convert them — and every page shows them. Doing
 * it in one place keeps a receipt, a stock row and a report agreeing on what
 * `GHS 1,234.50` and "31 Mar 2027" look like, and keeps the two representations
 * of money from being confused on a page: a decimal string from the API here, and
 * whole pesewas in `pricing.ts`, which has its own `moneyText`/`cediText` for the
 * basket it is pricing before any string exists.
 *
 * Everything here is total. A value the formatter does not recognise becomes an
 * em dash rather than a thrown error or, worse, a confident wrong figure: a till
 * that shows "GHS 0.00" for an amount it could not read tells the operator the
 * sale is free, while "—" tells them something is missing. The two are opposite
 * instructions and only one of them is honest.
 */

import { format, parseISO } from 'date-fns';

/**
 * What a value this app cannot read looks like.
 *
 * Exported so a formatter that is not about money — a percentage, a ratio —
 * leaves a gap the same way. Two modules each holding their own dash would be two
 * conventions for "nothing to show", and the reader is the one who has to notice.
 */
export const MISSING = '—';

/**
 * Groups the integer part and fixes two decimals: `'1234.5'` is `'1,234.50'`.
 *
 * Hand-grouped rather than `Intl.NumberFormat`, for the reason `pricing.ts`
 * gives at length: a locale formatter's output depends on the ICU data the
 * runtime was built with, so the same receipt can print differently on a laptop
 * and on a container without full ICU. A statutory document that differs by
 * device is one nobody can reconcile.
 *
 * A third decimal is truncated, not rounded. Money columns are `numeric(12, 2)`
 * so it cannot occur; this is the defensive behaviour for a value that should
 * already be two places, and truncating beats inventing a rounding rule for a
 * case that does not arise.
 */
export function formatMoney(decimal: string | null | undefined): string {
  if (decimal === null || decimal === undefined) return MISSING;
  const trimmed = decimal.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return MISSING;

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const parts = unsigned.split('.');
  const whole = parts[0] ?? '0';
  const fraction = parts[1] ?? '';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return `${negative ? '-' : ''}${grouped}.${(fraction + '00').slice(0, 2)}`;
}

/** `'GHS 1,234.50'`, or an em dash when there is no amount to show. */
export function formatCedis(decimal: string | null | undefined): string {
  const money = formatMoney(decimal);
  return money === MISSING ? MISSING : `GHS ${money}`;
}

/**
 * A date with no time: `'2027-03-31'` is `'31 Mar 2027'`.
 *
 * `parseISO` reads a date-only string as local midnight, so an expiry date shows
 * as the day printed on the box whichever timezone the tablet is set to — which
 * matters because a batch is sellable *on* its expiry date and a display that
 * shifted it by a day would disagree with the rule the till enforces.
 */
export function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return MISSING;
  try {
    return format(parseISO(iso), 'd MMM yyyy');
  } catch {
    // `parseISO` yields an Invalid Date rather than throwing, and `format` then
    // throws a RangeError. Either way the answer is "no date to show".
    return MISSING;
  }
}

/** An ISO timestamp in local date and time: `'5 Sep 2026, 14:30'`. */
export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return MISSING;
  try {
    return format(parseISO(iso), 'd MMM yyyy, HH:mm');
  } catch {
    return MISSING;
  }
}

/**
 * A date with no time and no year: `'2026-09-05'` is `'5 Sep'`.
 *
 * For an axis, where a full date per tick is wider than the space between ticks
 * and the year is stated once in the heading above the chart. Not for a figure
 * that has to be read on its own — a receipt line saying "5 Sep" is a date the
 * reader has to guess a year for, which is why `formatDate` remains the default
 * and this one is opt-in by name.
 */
export function formatShortDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return MISSING;
  try {
    return format(parseISO(iso), 'd MMM');
  } catch {
    return MISSING;
  }
}
