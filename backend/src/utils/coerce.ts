import { isDateOnly } from './fefo';
import { HttpError } from './http';

/**
 * Turning whatever arrived into a value the database will accept.
 *
 * Express-validator covers the JSON routes, but it cannot cover the CSV import,
 * where a field arrives as a string from a spreadsheet and nothing has looked at
 * it yet; and it will not cover the offline queue in Phase 9, where a queued
 * sale is replayed hours after it was typed. Rather than three sets of coercion
 * rules that drift, these are the rules, and every entry point uses them.
 *
 * Each one throws an `HttpError` with a message written for the person at the
 * counter. No message here names a table, a column, a constraint or a Postgres
 * error code: "Cost price must be a number" is help, "numeric field overflow"
 * is a schema disclosure.
 */

export interface MoneySpec {
  /** The field name as the caller knows it, used in the message. */
  field: string;
  /** Digits allowed before the decimal point. */
  integerDigits: number;
  /** Digits allowed after it. More than this would be silently rounded. */
  decimals: number;
}

/** `numeric(12, 2)`: precision 12, scale 2, so ten digits before the point. */
export const UNIT_PRICE: MoneySpec = { field: 'unit price', integerDigits: 10, decimals: 2 };

/** `numeric(12, 4)`: precision 12, scale 4, so eight digits before the point. */
export const COST_PRICE: MoneySpec = { field: 'cost price', integerDigits: 8, decimals: 4 };

/**
 * `numeric(12, 2)`, as `sales.discount` is. A separate spec from `UNIT_PRICE`
 * though the shape is identical, because the field name is what the message is
 * built from: "Enter a discount" and "Enter a unit price" are the same column type
 * and two different questions, and a cashier told to check the unit price when the
 * discount is the wrong field will look at the wrong field.
 */
export const DISCOUNT: MoneySpec = { field: 'discount', integerDigits: 10, decimals: 2 };

/** `numeric(12, 2)`, as `sale_payments.amount` and the money columns on `sales`. */
export const PAYMENT_AMOUNT: MoneySpec = {
  field: 'payment amount',
  integerDigits: 10,
  decimals: 2,
};

const INTEGER = /^[+-]?\d{1,15}$/;
const TRUTHY = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSY = new Set(['false', '0', 'no', 'n', 'off']);

function invalid(message: string, code = 'validation_failed'): never {
  throw new HttpError(400, message, { code });
}

/**
 * A whole number, from a number or a numeric string.
 *
 * `Number.isSafeInteger` rather than a range check alone: past 2^53 a JS number
 * cannot represent every integer, and a quantity that arrives as one would be
 * stored as a neighbour of what was typed. Quantities are base units in a
 * single pharmacy, so the safe range is far larger than any real value and the
 * check costs nothing.
 */
export function toInteger(
  value: unknown,
  field: string,
  options: { min: number; max?: number }
): number {
  const raw = typeof value === 'string' ? value.trim() : value;

  let parsed: number;
  if (typeof raw === 'number') {
    parsed = raw;
  } else if (typeof raw === 'string' && INTEGER.test(raw)) {
    parsed = Number(raw);
  } else {
    return invalid(`Enter ${field} as a whole number`);
  }

  if (!Number.isSafeInteger(parsed)) {
    return invalid(`Enter ${field} as a whole number`);
  }
  return withinRange(parsed, field, options);
}

function withinRange(
  value: number,
  field: string,
  options: { min: number; max?: number }
): number {
  if (value < options.min) {
    invalid(`${capitalise(field)} must be ${options.min} or more`);
  }
  if (options.max !== undefined && value > options.max) {
    invalid(`${capitalise(field)} must be ${options.max} or less`);
  }
  return value;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Money, returned as the decimal string Postgres uses.
 *
 * Never a JS number. `numeric` arrives as a string and leaves as one, because a
 * double cannot hold 0.1 exactly and a till that adds money in doubles is off by
 * a pesewa on some totals — the kind of error that shows up as a reconciliation
 * difference at the end of a month and cannot be traced to a line.
 *
 * The decimal count is checked rather than left to Postgres, which would round
 * `2.345` to `2.35` in a `numeric(12, 2)` column without saying so. A cost
 * price typed to four places and silently stored to two is a margin figure
 * nobody chose.
 */
export function toMoneyString(value: unknown, spec: MoneySpec): string {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '' || raw === null || raw === undefined) {
    return invalid(`Enter a ${spec.field}`);
  }

  let text: string;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return invalid(`Enter ${spec.field} as an amount`);
    text = String(raw);
  } else if (typeof raw === 'string') {
    text = raw;
  } else {
    return invalid(`Enter ${spec.field} as an amount`);
  }

  // Anchored, no exponent form and no thousands separators: `1e3` and `1,000`
  // are both things a spreadsheet can produce and neither is an amount.
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) return invalid(`Enter ${spec.field} as an amount, for example 12.50`);

  const [, whole, fraction] = match;
  if (whole === undefined) return invalid(`Enter ${spec.field} as an amount`);
  if (whole.replace(/^0+(?=\d)/, '').length > spec.integerDigits) {
    return invalid(`${capitalise(spec.field)} is too large`);
  }
  if (fraction !== undefined && fraction.length > spec.decimals) {
    return invalid(
      `${capitalise(spec.field)} cannot have more than ${spec.decimals} decimal places`
    );
  }
  return text;
}

/**
 * A boolean, from a boolean, the numeric spelling of one, or the words a
 * spreadsheet cell holds.
 *
 * An empty cell is false rather than an error: in a CSV, a blank
 * `requires_prescription` column means "not a prescription item", which is also
 * the column's default. Refusing it would make every row of a template with the
 * column present and mostly blank fail.
 *
 * Anything else that is not recognisable is refused rather than read as false.
 * Blank means "no"; unparseable means "we could not tell", and for this field in
 * particular the two are not interchangeable — a prescription-only medicine that
 * becomes an over-the-counter one because a caller sent `1` and `1` was not a
 * string is a dispensing control that failed silently.
 */
export function toBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;

  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return invalid(`Enter ${field} as yes or no`);
  }
  if (typeof value !== 'string') {
    return invalid(`Enter ${field} as yes or no`);
  }

  const text = value.trim().toLowerCase();
  if (text === '') return false;
  if (TRUTHY.has(text)) return true;
  if (FALSY.has(text)) return false;
  return invalid(`Enter ${field} as yes or no`);
}

/**
 * A `'YYYY-MM-DD'` date, or null for an empty cell.
 *
 * `isDateOnly` round-trips through a real date, so `2026-02-30` is refused
 * rather than accepted and rolled forward to 2 March by the calendar. An expiry
 * date that does not exist is a typing error worth stopping at the door.
 *
 * A value that is neither a string nor absent is refused rather than read as
 * null. Null means undated stock, and `utils/fefo.ts` treats undated stock as
 * sellable forever — so a number arriving here and quietly becoming null would
 * turn an expiry date into no expiry at all, which is the one direction this
 * field must never fail in.
 */
export function toDateOnlyOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    return invalid(`Enter ${field} as a date in YYYY-MM-DD form`);
  }

  const text = value.trim();
  if (text === '') return null;
  if (!isDateOnly(text)) return invalid(`Enter ${field} as a date in YYYY-MM-DD form`);
  return text;
}

/**
 * A member of an enum, checked against the same list the database was built
 * from. A value outside it is a 400 here rather than a 22P02 at the counter.
 */
export function toEnumMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): T {
  const text = typeof value === 'string' ? value.trim() : '';
  const found = allowed.find((candidate) => candidate === text);
  if (found === undefined) {
    return invalid(`Enter ${field} as one of: ${allowed.join(', ')}`);
  }
  return found;
}

/** Required text: trimmed, non-empty, capped. */
export function toText(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') invalid(`Enter ${field}`);
  if (text.length > maxLength) {
    invalid(`${capitalise(field)} must be ${maxLength} characters or fewer`);
  }
  return text;
}

/**
 * Optional text: an empty cell is null rather than an empty string.
 *
 * A value that is present but not text is refused rather than dropped, for the
 * same reason the boolean and the date are: these fields feed the audit trail, and
 * a note that arrives as something unreadable and is stored as null leaves a hole
 * that looks exactly like a note nobody wrote.
 */
export function toTextOrNull(value: unknown, field: string, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return invalid(`Enter ${field} as text`);

  const text = value.trim();
  if (text === '') return null;
  if (text.length > maxLength) {
    invalid(`${capitalise(field)} must be ${maxLength} characters or fewer`);
  }
  return text;
}
