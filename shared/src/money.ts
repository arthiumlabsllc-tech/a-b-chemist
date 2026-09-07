import { TaxError } from './errors';

/**
 * Money and rate arithmetic, in integers.
 *
 * Every amount in this package is a whole number of **pesewas** — the cedi's
 * hundredth, the smallest unit of Ghanaian currency in circulation — and every
 * rate is a whole number of **ten-thousandths**. There is no floating-point
 * money anywhere in here, and that is not a style preference.
 *
 * `0.1 + 0.2` is `0.30000000000000004`. A till that adds cedis in doubles is
 * wrong by a pesewa on some totals, and the failure is invisible at the counter:
 * the receipt looks right, the drawer is short, and the difference surfaces as a
 * reconciliation gap at the end of a month that cannot be traced to a line.
 * Integers cannot drift. `12345 + 678` is `13023` in every JavaScript engine on
 * every device, which is the property the offline pricer in Phase 9 depends on
 * when it has to produce the same total as the server did.
 *
 * Ten-thousandths for rates because that is exactly what the schema stores:
 * `vat_rate numeric(5, 4)`, `nhil_rate numeric(5, 4)`, `getfund_rate
 * numeric(5, 4)`. Four decimal places, so `0.15` is `1500` and `0.025` is `250`
 * with nothing lost. A rate carried as a double could not represent `0.025`
 * exactly either.
 */

export const PESEWAS_PER_CEDI = 100;

/** Rates are integers in ten-thousandths. `numeric(5, 4)` has four decimal places. */
export const RATE_SCALE = 10_000;

/**
 * The largest amount the engine will work with: GHS 900,000.
 *
 * Derived, not chosen. Every amount here is either multiplied by a rate or by
 * another amount, and each product has to stay inside `Number.MAX_SAFE_INTEGER`
 * (2^53 = 9,007,199,254,740,992) or the integer arithmetic this package rests on
 * stops being exact. The tightest product is in `discount.ts`, which computes
 * `discount * lineGross`; both are bounded by the basket total, so the worst case
 * is the ceiling squared. Solving `T^2 < 2^53` gives `T <= 94,906,265`, and
 * 90,000,000 sits below that with room to spare.
 *
 * Nine hundred thousand cedis is not a limit a community pharmacy will meet. It
 * is far above a single line, a whole basket, a day's takings or the entire stock
 * holding, and the engine refuses above it rather than quietly returning a figure
 * that happens to be one pesewa out. The refusal is arithmetic, not commercial,
 * and the comment is here so that raising it means re-deriving it.
 *
 * The alternative to a ceiling is `bigint`, which has no such bound. It is not
 * used because `BigInt` is ES2020 and this package targets ES2017: a tablet old
 * enough to lack it would fail at the till, offline, with no server to fall back
 * on. A documented ceiling is the safer trade.
 */
export const MAX_AMOUNT_PESEWAS = 90_000_000;

/**
 * The largest value the string boundary will parse or format:
 * GHS 9,999,999,999.99.
 *
 * Exactly `numeric(12, 2)`, the declared type of every money column this package's
 * output is written to — `sales.vat_amount`, `sales.tax_total`,
 * `sale_items.taxable_base`. So a value this module produced can always be stored,
 * and a value read back out of a column can always be parsed.
 *
 * Much looser than `MAX_AMOUNT_PESEWAS` because it bounds *storage*, not
 * arithmetic: nothing at this width is ever multiplied. A value parsed here and
 * then handed to the engine is checked again, against the tighter bound, at the
 * point it is used.
 */
export const MAX_TOTAL_PESEWAS = 999_999_999_999;

/** `numeric(12, 2)`: ten digits before the point, two after. */
const DECIMAL_MONEY = /^(\d{1,10})(?:\.(\d{1,2}))?$/;

/** `numeric(5, 4)` restricted to the zero-to-one range a rate can meaningfully take. */
const DECIMAL_RATE = /^([01])(?:\.(\d{1,4}))?$/;

/**
 * Integer division and its remainder.
 *
 * Both exact, for every input this package can receive, and the reason is worth
 * stating because it is what makes the two lines below safe rather than merely
 * short. IEEE 754 division returns the correctly-rounded true quotient. If that
 * quotient is an integer it is exactly representable at these magnitudes and comes
 * back exactly. If it is not, its distance from the nearest integer is at least
 * `1 / denominator`, because the quotient of two integers with denominator `d` has
 * a fractional part that is a multiple of `1/d`. Rounding error is at most half an
 * ULP, which is `q * 2^-53 / 2`. For that to move the result across an integer
 * boundary needs `q / 2^54 >= 1 / d`, so `q * d >= 2^54` — and `q * d` is
 * approximately the numerator, which is below `2^53` by construction.
 *
 * The correction loops this function used to carry, walking a negative or
 * over-wide remainder back into range, could therefore never execute. They were
 * removed rather than annotated, on the grounds that a guard which cannot run and
 * cannot be tested is not a guard: it is a claim nobody can check. What replaces
 * them is the argument above, plus the ceilings on `MAX_AMOUNT_PESEWAS` that keep
 * the premise true, plus a sweep in `money.test.ts` that looks for a
 * counter-example and fails if one ever appears.
 */
export function floorDiv(numerator: number, denominator: number): { quotient: number; remainder: number } {
  const quotient = Math.floor(numerator / denominator);
  return { quotient, remainder: numerator - quotient * denominator };
}

/**
 * Rounds a ratio to the nearest whole pesewa, halves toward positive infinity.
 *
 * The rounding rule is **ours, not GRA's**. The Authority publishes rates, a
 * worked example and receipt requirements, and no rule for a fraction of a
 * pesewa — its own illustration, 15% of 1,000, divides exactly and so never
 * raises the question. Something has to be chosen, so the choice is made once,
 * here, and written down.
 *
 * Half up rather than half-to-even ("banker's rounding"). Half-to-even
 * is the better rule for a statistician summing many independent values, because
 * it does not bias the total upward. It is the worse rule for a receipt, because
 * it produces answers a person with a calculator cannot reproduce: `0.125` rounds
 * to `0.12` and the customer is told the till disagrees with their arithmetic.
 * This is a shop, and a rounding rule that the person paying can verify by hand
 * is worth more than one that is unbiased in the ninth decimal.
 *
 * For every operand this package produces, "half up" and "half away from zero" are
 * the same rule, because amounts and rates are asserted non-negative before they
 * are multiplied. They differ only on a negative numerator, where flooring rounds
 * toward positive infinity: `-4.5` returns `-4`, not `-5`. No caller can reach
 * that, and `money.test.ts` pins it anyway — a refund or a credit note is the
 * obvious future caller, and it should find the behaviour written down rather
 * than discover it.
 *
 * Both operands are integers and the result is an integer, so there is no
 * accumulated error to reason about — each line is rounded once, from an exact
 * product, and the rounds are then summed.
 */
export function roundHalfUp(numerator: number, denominator: number): number {
  const { quotient, remainder } = floorDiv(numerator, denominator);
  // `remainder * 2 >= denominator` is `remainder >= denominator / 2` without
  // dividing, so it stays in integers and needs no half-pesewa constant.
  return remainder * 2 >= denominator ? quotient + 1 : quotient;
}

/** Throws unless the value is a non-negative integer of pesewas. */
export function assertPesewas(value: number, field: string): number {
  if (!Number.isInteger(value)) {
    throw new TaxError(
      'amount_out_of_range',
      `${field} must be a whole number of pesewas`,
      field
    );
  }
  if (value < 0) {
    throw new TaxError('amount_out_of_range', `${field} cannot be negative`, field);
  }
  return value;
}

/**
 * Checks an amount the engine is about to multiply by a rate.
 *
 * Stricter than `assertPesewas` by design — see `MAX_AMOUNT_PESEWAS`.
 */
export function assertAmount(value: number, field: string): number {
  assertPesewas(value, field);
  if (value > MAX_AMOUNT_PESEWAS) {
    throw new TaxError(
      'amount_out_of_range',
      `${field} is larger than this system can price`,
      field
    );
  }
  return value;
}

/** Checks a summed total against what the schema can store. */
export function assertTotal(value: number, field: string): number {
  assertPesewas(value, field);
  if (value > MAX_TOTAL_PESEWAS) {
    throw new TaxError(
      'amount_out_of_range',
      `${field} is larger than this system can store`,
      field
    );
  }
  return value;
}

/**
 * `amount * rate`, rounded to a whole pesewa.
 *
 * The single place a rate meets money. Everything else in the package calls this,
 * so there is one rounding decision in the codebase and one test suite on it.
 */
export function applyRate(amountPesewas: number, rateTenThousandths: number): number {
  return roundHalfUp(amountPesewas * rateTenThousandths, RATE_SCALE);
}

/**
 * Parses a decimal money string into pesewas.
 *
 * Strings, not numbers, because that is what arrives: `pg` hands back `numeric`
 * as a string by default and this project does not override that (see
 * `backend/src/database/pg-types.ts`, which overrides only `date`), a JSON body
 * may carry either, and a CSV cell always carries text. `backend/utils/coerce.ts`
 * has already validated the *shape* for the API's money fields and returns the
 * same decimal string; this is the step from that string to the integer the
 * engine works in, and it lives here so the browser cache in Phase 9 converts
 * identically rather than reimplementing it.
 *
 * More than two decimal places is refused rather than rounded. A cost price typed
 * to four places and silently stored to two is a margin figure nobody chose, and
 * Postgres would round it in the column without saying so.
 *
 * Trimmed first, like every coercer in `backend/utils/coerce.ts` and like
 * `parseRate` below. The three of them read the same cells — a CSV column, a JSON
 * body, a `numeric` over `pg` — and a spreadsheet that right-aligns money into
 * `' 12.50'` is ordinary. One of the three refusing it would be a failure that
 * depends on which parser a field happened to reach.
 *
 * The regex and `MAX_TOTAL_PESEWAS` are the same bound written twice: the widest
 * string that matches, `'9999999999.99'`, is exactly the largest total. So the
 * `assertTotal` at the end cannot fire today. It stays, for the same reason a
 * guard on an unreachable branch stays — the day somebody widens the regex to
 * twelve integer digits is the day a value the schema cannot hold starts flowing
 * out of this function, and it would fail as a Postgres overflow at insert time
 * rather than as a message here.
 */
export function pesewasFromDecimalString(value: string, field: string): number {
  const match = DECIMAL_MONEY.exec(value.trim());
  if (match === null) {
    throw new TaxError('amount_out_of_range', `Enter ${field} as an amount, for example 12.50`, field);
  }
  const [, whole, fraction] = match;
  if (whole === undefined) {
    throw new TaxError('amount_out_of_range', `Enter ${field} as an amount`, field);
  }
  // Padded on the right, so `'12.5'` is twelve cedis fifty pesewas and not twelve
  // cedi and a fifth of a pesewa.
  const pesewas = Number(whole) * PESEWAS_PER_CEDI + Number((fraction ?? '').padEnd(2, '0'));
  return assertTotal(pesewas, field);
}

/**
 * Pesewas back to the decimal string Postgres stores and a receipt prints.
 *
 * The round trip is exact: `decimalStringFromPesewas(pesewasFromDecimalString(s))`
 * normalises `s` and nothing else. `'12.5'` comes back as `'12.50'`, which is the
 * only change, and it is the change a money column makes anyway.
 */
export function decimalStringFromPesewas(value: number): string {
  assertTotal(value, 'the amount');
  const { quotient, remainder } = floorDiv(value, PESEWAS_PER_CEDI);
  return `${quotient}.${String(remainder).padStart(2, '0')}`;
}

/**
 * Parses a rate into ten-thousandths.
 *
 * Accepts a string or a number, because the two arrive from different places: a
 * string from `numeric(5, 4)` over `pg`, a number from a JSON settings form.
 *
 * A number is routed through `String()` rather than multiplied by 10,000. That
 * looks like a detour and is the point. `String()` gives the shortest decimal that
 * reads back as the same double, which for a rate anybody typed is the rate they
 * typed: all 10,001 four-place rates between zero and one — every in-range value
 * `numeric(5, 4)` can hold — come back with at most four decimal places and parse
 * exactly.
 *
 * The multiply route cannot say that. `(i / 10000) * 10000` truncates to the wrong
 * integer for 573 of those 10,001, and it errs downward: `0.0003 * 10000` is
 * `2.9999999999999996`, so a rate of three ten-thousandths arrives as two. Both of
 * those counts are measured by `money.test.ts` rather than quoted from memory, so
 * this paragraph cannot outlive the behaviour it explains.
 *
 * The same route refuses a rate that arrived as the result of floating-point
 * arithmetic — `String(0.1 + 0.2)` is `'0.30000000000000004'`, seventeen digits,
 * which fails the four-place rule. A rate that has already been through a double is
 * a rate nobody wrote down, and this refuses to guess at it.
 *
 * Above one is refused. `numeric(5, 4)` would hold `9.9999`, so a 999.99% VAT is
 * representable in the column and nonsense everywhere else; allowing it would mean
 * a settings form typo becomes a receipt charging ten times the price.
 */
export function parseRate(value: string | number, field: string): number {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TaxError('rate_out_of_range', `Enter ${field} as a percentage`, field);
    }
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new TaxError('rate_out_of_range', `Enter ${field} as a percentage`, field);
  }

  const match = DECIMAL_RATE.exec(text);
  if (match === null) {
    throw new TaxError(
      'rate_out_of_range',
      `Enter ${field} as a decimal with at most four places, between 0 and 1`,
      field
    );
  }

  const [, whole, fraction] = match;
  // Padded on the right: `'025'` is two and a half percent, so 250 ten-thousandths.
  // Padded on the left it would read as a quarter of one percent, and every levy
  // on every receipt in the country would be ten times too small.
  const scaled = Number((fraction ?? '').padEnd(4, '0'));
  if (whole === '1' && scaled !== 0) {
    throw new TaxError('rate_out_of_range', `Enter ${field} as a decimal between 0 and 1`, field);
  }
  return whole === '1' ? RATE_SCALE : scaled;
}

/**
 * Ten-thousandths back to the decimal string `numeric(5, 4)` stores and a settings
 * form displays: `1500` is `'0.1500'`, `250` is `'0.0250'`, `RATE_SCALE` is
 * `'1.0000'`.
 *
 * Always four places, because that is what Postgres returns for the column and so
 * `rateDecimalString(parseRate(text))` is `text` for any `text` that came out of the
 * database. A formatter that trimmed to `'0.15'` would still be accepted by
 * `parseRate`, but the round trip would not be the identity and a settings screen
 * that re-saved what it had just read would appear to change the row.
 *
 * Distinct from `rateLabel`, which is for a receipt and for a human: `'15%'` there,
 * `'0.1500'` here. One is a statutory rate named beside a levy, the other is a value
 * going back into the column it came from, and neither spelling serves both.
 */
export function rateDecimalString(rateTenThousandths: number): string {
  assertRate(rateTenThousandths);
  const { quotient, remainder } = floorDiv(rateTenThousandths, RATE_SCALE);
  return `${quotient}.${String(remainder).padStart(4, '0')}`;
}

/** One percent, expressed in ten-thousandths. `RATE_SCALE / 100`. */
const TEN_THOUSANDTHS_PER_PERCENT = 100;

/**
 * A rate as a person reads it: `1500` is `'15%'`, `250` is `'2.5%'`.
 *
 * Here rather than in each renderer because GRA requires the receipt to name the
 * rate beside each levy — "a separate line for NHIL at 2.5%, GETFund levy at
 * 2.5%, and a line for the VAT at 15%" — and the API's receipt data and the till's
 * offline receipt must spell it the same way. Two formatters is two spellings.
 *
 * The divisor is a hundred, not `RATE_SCALE`. A rate in ten-thousandths is a
 * fraction of one, so turning it into a *percentage* means dividing by the number
 * of ten-thousandths in one percent. Dividing by `RATE_SCALE` instead returns the
 * fraction and labels it with a percent sign: `'0.15%'` for the 15% VAT, which is
 * a receipt that misstates a statutory rate by a factor of a hundred.
 */
export function rateLabel(rateTenThousandths: number): string {
  assertRate(rateTenThousandths);
  const { quotient, remainder } = floorDiv(rateTenThousandths, TEN_THOUSANDTHS_PER_PERCENT);
  if (remainder === 0) return `${quotient}%`;
  // Padded on the left, to two places, because the remainder is hundredths of a
  // percent: `1` is `0.01%` and padding on the right would print `0.1%`. That is
  // the inverse of `parseRate`'s padding, which is on the right and correct there
  // — parsing reads the digits somebody typed after a decimal point, formatting
  // writes a remainder into a fixed width, and the two are not one operation.
  //
  // Trailing zeros are then stripped, not left at a fixed two places: `'2.50%'` on
  // a receipt reads as though the rate were known to more precision than it is.
  const digits = String(remainder).padStart(2, '0').replace(/0+$/u, '');
  return `${quotient}.${digits}%`;
}

/** Checks a rate is one this package produced, before it is displayed or applied. */
export function assertRate(rateTenThousandths: number): number {
  if (
    !Number.isInteger(rateTenThousandths) ||
    rateTenThousandths < 0 ||
    rateTenThousandths > RATE_SCALE
  ) {
    throw new TaxError(
      'rate_out_of_range',
      'A tax rate must be a whole number of ten-thousandths between 0 and 10000',
      'rate'
    );
  }
  return rateTenThousandths;
}
