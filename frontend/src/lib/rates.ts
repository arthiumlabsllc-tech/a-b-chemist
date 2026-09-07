/**
 * Rate entry for the tax settings form.
 *
 * ## Why this exists rather than the page calling the engine
 *
 * A rate has three spellings and the settings page touches all of them: the
 * column stores a decimal (`'0.1500'`), a receipt names a percentage (`'15%'`),
 * and the engine prices with whole ten-thousandths (`1500`). `pricing.ts` warns
 * at length that handing the parser the wrong one — `1500` where it wants
 * `'0.1500'` — reads as a rate of 15,000% and is refused, or worse, accepted
 * somewhere that does not check. The conversions live in `a-and-b-chemist-shared`
 * precisely so nobody re-derives them; this module is the settings page's door to
 * them, so the page holds decimal strings and never an integer of ten-thousandths.
 *
 * Nothing here is authoritative. `PUT /tax/settings` re-validates every rate with
 * the same `parseRate` and reports all the faults at once, so a rate this module
 * accepted and the server refused is still refused — this only lets the form say
 * "that is not a rate" before the round trip, which is the difference between a
 * correction and a save that silently did nothing.
 */

import { isTaxError, parseRate, rateDecimalString, rateLabel } from 'a-and-b-chemist-shared';

/**
 * The result of reading one rate field.
 *
 * On success it carries all three spellings at once — `rate` for the caller that
 * needs to compare against GRA's figures, `label` for the live "= 15%" hint, and
 * `decimal` for the value that goes back into the column — because they are all
 * derived from the one parse and computing any of them twice is how two
 * spellings drift apart.
 */
export type RateFieldResult =
  | { ok: true; rate: number; label: string; decimal: string }
  | { ok: false; message: string };

/**
 * Reads what the operator typed into a rate field.
 *
 * Total: a bad rate is an ordinary keystroke, not an exception, so it comes back
 * as `{ ok: false }` with the engine's own wording rather than throwing into an
 * error boundary while somebody is still typing. Empty is special-cased to a
 * message that says how to charge none, because the engine's "enter as a decimal
 * between 0 and 1" does not tell an owner that `0` is the way to switch a levy
 * off. A non-`TaxError` is rethrown: that is a bug, not a typo, and swallowing it
 * would leave the form showing a stale rate.
 *
 * `field` is the label the engine puts in its own message ("Enter VAT as …"), so
 * the caller passes the human name of the levy rather than a column key.
 */
export function parseRateField(text: string, field: string): RateFieldResult {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, message: `Enter ${field} as a decimal, or 0 to charge none` };
  }
  try {
    const rate = parseRate(trimmed, field);
    return { ok: true, rate, label: rateLabel(rate), decimal: rateDecimalString(rate) };
  } catch (error) {
    if (isTaxError(error)) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

/**
 * The decimal string to seed a field with from a whole ten-thousandths rate.
 *
 * This is the "restore Act 1151" affordance: GRA's reference figures arrive on
 * `TaxSettingsView.act1151` as integers of ten-thousandths, and the field holds a
 * decimal, so the two meet here and nowhere else. It does not defend against an
 * out-of-range rate — those integers are the engine's own `GRA_RATES` constants
 * surfaced through the API, and `rateDecimalString` asserts them, so a throw here
 * would mean the published figures themselves are corrupt rather than that a
 * caller mistyped.
 */
export function decimalFromRate(rateTenThousandths: number): string {
  return rateDecimalString(rateTenThousandths);
}

/**
 * A whole ten-thousandths rate as a person reads it: `1500` is `'15%'`.
 *
 * The partner to `decimalFromRate`, and the reason it exists separately: GRA's
 * reference figures on `TaxSettingsView.act1151` arrive as integers with no
 * spelling attached, and the reference card is read by an owner who thinks in
 * percentages, not in decimal fractions of one. This is `rateLabel` from the
 * shared package — the same formatter the receipt uses to name a levy beside the
 * amount it added — so the settings page and a printed receipt cannot call the
 * same rate by two names.
 */
export function labelFromRate(rateTenThousandths: number): string {
  return rateLabel(rateTenThousandths);
}
