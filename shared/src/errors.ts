/**
 * The errors this package throws.
 *
 * A typed code rather than message-sniffing. The API turns these into HTTP
 * responses and the offline till turns them into a queued-sale rejection, and
 * both need to distinguish "the caller asked for something impossible" from "the
 * caller has a bug". Matching on message text would mean a copy edit in one
 * package silently changes control flow in another.
 *
 * Nothing here extends `Error` with a stack-capturing shim. `target` is ES2017,
 * so classes are emitted natively and `instanceof` works in both consumers —
 * which is the whole reason the caller can catch this type at all.
 */

export const TAX_ERROR_CODES = [
  /** An amount was not a non-negative integer of pesewas inside the engine's range. */
  'amount_out_of_range',
  /** A rate was not a decimal of at most four places between zero and one. */
  'rate_out_of_range',
  /** A VAT treatment was not one of the three the schema allows. */
  'unknown_treatment',
  /** A discount was larger than the basket it was being taken off. */
  'discount_exceeds_basket',
  /** A discount was asked for with no reason recorded against it. */
  'discount_reason_required',
  /** A basket was empty, so there was nothing to price. */
  'basket_has_no_value',
  /** A line arrived with a quantity or unit price the engine cannot multiply. */
  'line_out_of_range',
] as const;

export type TaxErrorCode = (typeof TAX_ERROR_CODES)[number];

export class TaxError extends Error {
  readonly code: TaxErrorCode;

  /**
   * The field the caller used, echoed back so the API can point at the right
   * input. Absent when the problem is not attributable to one field.
   */
  readonly field?: string;

  constructor(code: TaxErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'TaxError';
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

/**
 * True when the value is one of ours.
 *
 * Written as a type guard rather than left to `instanceof` at each call site so
 * the narrowing happens once and the API's error mapper does not have to cast.
 */
export function isTaxError(value: unknown): value is TaxError {
  return value instanceof TaxError;
}
