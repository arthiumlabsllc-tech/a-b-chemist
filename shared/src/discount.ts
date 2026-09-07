import { TaxError } from './errors';
import { MAX_AMOUNT_PESEWAS, assertPesewas, floorDiv } from './money';

/**
 * Splitting a basket-level discount across the lines it covers.
 *
 * The discount has to be apportioned before tax rather than after it, and the
 * reason is that the three charges are computed per line, because each line
 * carries its own `vat_treatment`. A basket holding an exempt medicine and a
 * standard-rated bottle of shampoo cannot have one tax figure computed on its
 * total at all. So the discount has to reach each line's taxable base, and the
 * only defensible way to divide it is in proportion to what each line is worth.
 *
 * Proportional division of an integer into integer parts does not sum exactly.
 * A GHS 1.00 discount across three GHS 0.50 lines is 33.33 pesewas each, and
 * 33 + 33 + 33 is 99, not 100 — a pesewa that exists in the basket and belongs
 * to no line. Left alone it shows up as a receipt whose lines do not add to its
 * total, which is the first thing an auditor checks and the hardest thing to
 * explain afterwards. So the remainder is placed deliberately, on the largest
 * line, and the shares are exact.
 */

export interface ApportionedDiscount {
  /** One entry per input line, in the input's order. Sums exactly to the discount. */
  shares: number[];
  /** Pesewas of rounding remainder that had to be placed on a line. */
  drift: number;
  /**
   * The lines that absorbed the drift, in the order they were filled.
   *
   * Almost always a single entry, the largest line. More than one only in the
   * case documented on `apportionDiscount`, where the largest line could not take
   * the whole remainder without its own discount exceeding its own value.
   */
  driftLines: number[];
}

/**
 * Divides `discountPesewas` across `grossValues` in proportion to each.
 *
 * Shares are floored, and the remainder is then pushed onto the largest line.
 * Flooring rather than rounding half-up is what makes the remainder always
 * positive: every share is at or below its exact proportion, so the shares can
 * only fall short of the discount and never overshoot it. A negative remainder
 * would mean taking pesewas back off a line, and a line that has already been
 * floored is the wrong place to take them from.
 *
 * "Largest" means largest gross value, ties broken by the earliest position in the
 * basket. The tie-break is arbitrary but it has to be *fixed*, because the till
 * and the offline pricer must reach the same answer for the same basket, and a
 * sort that is not stable across engines is a receipt that differs between the
 * two. Earliest-wins also means the drift lands on the line nearest the top of the
 * receipt, which is where a person reading it will look first.
 *
 * One refinement to "push it on the largest line", and it is not optional. A line
 * cannot carry more discount than it is worth, or its taxable base goes negative
 * and the tax on it goes negative with it — a sale that reduces the day's VAT
 * rather than adding to it. So each line is filled only up to its own value, and
 * any remainder still outstanding moves to the next largest. Three one-pesewa
 * lines with a two-pesewa discount is the smallest case that needs this: flooring
 * gives every line zero, the whole discount is drift, and the largest line is one
 * pesewa wide.
 *
 * That this always finishes is not luck. The capacity available is
 * `total − Σ floor(share)`, and the drift is `discount − Σ floor(share)`. Since
 * the discount is refused when it exceeds the total, drift is never more than
 * capacity, so there is always room. `discount.test.ts` pins that over a sweep of
 * several thousand baskets rather than trusting the argument.
 *
 * @throws `TaxError` `basket_has_no_value` if every line is worth zero and a
 *   discount was asked for — there is no proportion to divide by, and returning
 *   zeros would silently drop a discount somebody typed in.
 * @throws `TaxError` `discount_exceeds_basket` if the discount is larger than the
 *   basket. Over-discounting is a real mistake at a counter and must not become a
 *   negative sale.
 */
export function apportionDiscount(
  grossValues: readonly number[],
  discountPesewas: number
): ApportionedDiscount {
  const discount = assertPesewas(discountPesewas, 'the discount');
  if (grossValues.length === 0) {
    throw new TaxError('basket_has_no_value', 'There is nothing in the basket to discount');
  }

  const gross = grossValues.map((value, index) => {
    assertPesewas(value, `line ${index + 1}`);
    if (value > MAX_AMOUNT_PESEWAS) {
      throw new TaxError('amount_out_of_range', `Line ${index + 1} is larger than this system can price`);
    }
    return value;
  });

  const total = gross.reduce((sum, value) => sum + value, 0);

  if (discount === 0) {
    // Checked before the zero-total refusal: a basket of complimentary items with
    // no discount asked for is a valid thing to price, and refusing it would mean
    // a till cannot ring up a free supply.
    return { shares: gross.map(() => 0), drift: 0, driftLines: [] };
  }
  if (total === 0) {
    throw new TaxError('basket_has_no_value', 'A discount needs something with a price to come off');
  }
  if (discount > total) {
    throw new TaxError(
      'discount_exceeds_basket',
      'The discount is more than the basket is worth'
    );
  }
  // The basket as a whole, not just each line. Every line was checked against
  // `MAX_AMOUNT_PESEWAS` above and that is not enough: the product below is
  // `discount * value`, where the discount is bounded by the *total* and the value
  // by the largest line, so the worst case is the total squared. A basket of many
  // individually-small lines passes the per-line check and overflows the product —
  // twelve thousand GHS-900 lines is enough. `T^2 < 2^53` is the inequality the
  // ceiling in `money.ts` was derived from, and this is where it is enforced.
  if (total > MAX_AMOUNT_PESEWAS) {
    throw new TaxError('amount_out_of_range', 'The basket is larger than this system can price');
  }

  const shares = gross.map((value) => floorDiv(discount * value, total).quotient);
  // Captured before anything is placed. This is the rounding remainder the
  // flooring left behind, and it is what `drift` reports — recomputing it after
  // the placement would always give zero and tell the caller nothing.
  const drift = discount - shares.reduce((sum, share) => sum + share, 0);
  let outstanding = drift;

  // Largest first, earliest first among equals. Built as an explicit order rather
  // than `sort` on a comparator that subtracts, so the tie-break is a statement
  // about indices and not a consequence of the sort being stable — `Array#sort`
  // is specified stable, but relying on that here would put the determinism of a
  // receipt on a property of the engine rather than of this code.
  const order = gross
    .map((value, index) => ({ value, index }))
    .sort((a, b) => (b.value === a.value ? a.index - b.index : b.value - a.value));

  const driftLines: number[] = [];
  for (const entry of order) {
    if (outstanding === 0) break;
    const share = shares[entry.index];
    if (share === undefined) continue;
    // Never more than the line is worth. See the three-pesewa case above.
    const room = entry.value - share;
    if (room <= 0) continue;
    const placed = room < outstanding ? room : outstanding;
    shares[entry.index] = share + placed;
    outstanding -= placed;
    driftLines.push(entry.index);
  }

  if (outstanding !== 0) {
    // Unreachable while the discount is refused above the total: capacity is
    // `total − Σ shares` and drift is `discount − Σ shares`. Kept as an error
    // rather than a silent shortfall, because the alternative is a basket whose
    // lines do not add to its total — the exact defect this module exists to
    // prevent, arriving through a path nobody thought about.
    throw new TaxError(
      'discount_exceeds_basket',
      'The discount could not be divided across the basket'
    );
  }

  return { shares, drift, driftLines };
}
