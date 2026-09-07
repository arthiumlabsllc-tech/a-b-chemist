import { apportionDiscount } from '../discount';
import { isTaxError } from '../errors';
import { MAX_AMOUNT_PESEWAS } from '../money';

/**
 * Splitting a basket discount across the lines it covers.
 *
 * The property that matters is not that the shares look proportionate but that
 * they are *exact*: they sum to the discount asked for, no line carries more than
 * it is worth, and the pesewas the flooring left behind land somewhere named. A
 * receipt whose lines do not add to its total is the first thing an auditor checks
 * and the hardest thing to explain afterwards, so the sweep at the bottom of this
 * file looks for a basket where that happens rather than trusting the argument in
 * the module header that says it cannot.
 */

interface Failure {
  code: string;
  message: string;
  field: string | undefined;
}

/** Runs something expected to refuse, and reports what it refused with. */
function failureOf(run: () => unknown): Failure {
  try {
    run();
  } catch (error) {
    if (isTaxError(error)) {
      return { code: error.code, message: error.message, field: error.field };
    }
    throw error;
  }
  throw new Error('expected the engine to refuse, and it returned a value instead');
}

/**
 * A deterministic pseudo-random source.
 *
 * Deterministic because a sweep that finds a defect has to be reproducible from
 * the failure message alone. `Math.random` would produce a red test nobody could
 * run twice, which is a red test that gets re-run until it goes green.
 */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state;
  };
}

describe('apportionDiscount', () => {
  it('divides a discount that comes out even, with nothing left over', () => {
    expect(apportionDiscount([1_000, 2_000, 3_000], 600)).toEqual({
      shares: [100, 200, 300],
      drift: 0,
      driftLines: [],
    });
  });

  it('puts the remainder on the largest line', () => {
    // 10.50, 10.50 and 30.00 with a one-cedi discount. Flooring gives 20, 20 and
    // 58 — 98 of the 100 pesewas — and the two left over go to the 30.00 line,
    // which is the largest and has room for them.
    expect(apportionDiscount([1_050, 1_050, 3_000], 100)).toEqual({
      shares: [20, 20, 60],
      drift: 2,
      driftLines: [2],
    });
  });

  it('breaks a tie by earliest position, so the till and the offline pricer agree', () => {
    // Both lines are the same size, so "largest" does not choose between them. The
    // tie-break has to be *fixed* rather than left to the sort, because a receipt
    // that differs between the server and a phone offline is a receipt that cannot
    // be reconciled. Earliest-wins also puts the drift nearest the top, where a
    // person reading it looks first.
    expect(apportionDiscount([5_000, 5_000], 1)).toEqual({
      shares: [1, 0],
      drift: 1,
      driftLines: [0],
    });
    // Three equal lines and two pesewas of drift: the first line has room for both
    // and takes both, because "largest first" fills one line before moving on rather
    // than spreading. Spreading would be a different and equally defensible rule,
    // so which one this is has to be written down.
    expect(apportionDiscount([5_000, 5_000, 5_000], 2)).toEqual({
      shares: [2, 0, 0],
      drift: 2,
      driftLines: [0],
    });
    // The same three equal lines with less room each: now the drift does spread, and
    // it spreads earliest-first, which is the tie-break visible on its own.
    expect(apportionDiscount([2, 2, 2], 5)).toEqual({
      shares: [2, 2, 1],
      drift: 2,
      driftLines: [0, 1],
    });
  });

  it('moves the remainder on when the largest line cannot take it', () => {
    // The case that makes the capacity refinement non-optional. Three one-pesewa
    // lines with a two-pesewa discount: flooring gives every line zero, so the whole
    // discount is drift and the largest line is one pesewa wide. Filling it anyway
    // would give a line a discount bigger than its own value and a negative taxable
    // base — a sale that reduces the day's VAT instead of adding to it.
    expect(apportionDiscount([1, 1, 1], 2)).toEqual({
      shares: [1, 1, 0],
      drift: 2,
      driftLines: [0, 1],
    });
  });

  it('spreads a remainder across as many lines as it takes', () => {
    // Five one-pesewa lines and a four-pesewa discount: every line but the last ends
    // up free. Nothing is negative, the shares still sum to the discount, and the
    // termination argument in the module header — drift can never exceed capacity —
    // is what allows the loop to run out of outstanding pesewas before it runs out
    // of lines.
    expect(apportionDiscount([1, 1, 1, 1, 1], 4)).toEqual({
      shares: [1, 1, 1, 1, 0],
      drift: 4,
      driftLines: [0, 1, 2, 3],
    });
  });

  it('takes the whole basket when the discount is the whole basket', () => {
    // `discount > total` is refused, so `discount === total` is allowed: a 100%
    // discount is a complimentary sale, and every share is exact with no drift.
    expect(apportionDiscount([1_000, 2_000, 3_000], 6_000)).toEqual({
      shares: [1_000, 2_000, 3_000],
      drift: 0,
      driftLines: [],
    });
    expect(apportionDiscount([700], 700)).toEqual({ shares: [700], drift: 0, driftLines: [] });
  });

  it('prices a basket of complimentary items when no discount was asked for', () => {
    // The zero-discount check runs before the zero-total refusal, deliberately. A
    // till must be able to ring up a free supply — a sample, a warranty
    // replacement — and refusing it would mean the one sale a pharmacy cannot take
    // is the one that costs it nothing.
    expect(apportionDiscount([0, 0, 0], 0)).toEqual({
      shares: [0, 0, 0],
      drift: 0,
      driftLines: [],
    });
  });

  it('reports the drift as the remainder the flooring left, and names every line that absorbed some', () => {
    const { shares, drift, driftLines } = apportionDiscount([1_050, 1_050, 3_000], 100);
    // Drift is the rounding remainder, captured before placement. Recomputing it
    // after the shares are final would always give zero and tell the caller nothing.
    expect(drift).toBe(2);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(100);
    expect(driftLines.length).toBeGreaterThan(0);
    for (const index of driftLines) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(shares.length);
    }
  });
});

describe('apportionDiscount refusals', () => {
  it('refuses an empty basket', () => {
    expect(failureOf(() => apportionDiscount([], 0))).toEqual({
      code: 'basket_has_no_value',
      message: 'There is nothing in the basket to discount',
      field: undefined,
    });
  });

  it('refuses a discount on a basket where nothing has a price', () => {
    // Returning zeros here would silently drop a discount somebody typed in, and
    // the operator would see a total that does not match what they pressed.
    expect(failureOf(() => apportionDiscount([0, 0], 100))).toEqual({
      code: 'basket_has_no_value',
      message: 'A discount needs something with a price to come off',
      field: undefined,
    });
  });

  it('refuses a discount larger than the basket', () => {
    // Over-discounting is a real mistake at a counter and must not become a
    // negative sale: a negative line total flows into the day's takings and into
    // the VAT figures as a subtraction nobody authorised.
    expect(failureOf(() => apportionDiscount([100], 101))).toEqual({
      code: 'discount_exceeds_basket',
      message: 'The discount is more than the basket is worth',
      field: undefined,
    });
    expect(failureOf(() => apportionDiscount([1_000, 2_000], 3_001)).code).toBe(
      'discount_exceeds_basket'
    );
  });

  it('refuses a discount that is not a whole number of pesewas', () => {
    expect(failureOf(() => apportionDiscount([1_000], 1.5))).toEqual({
      code: 'amount_out_of_range',
      message: 'the discount must be a whole number of pesewas',
      field: 'the discount',
    });
    expect(failureOf(() => apportionDiscount([1_000], -1))).toEqual({
      code: 'amount_out_of_range',
      message: 'the discount cannot be negative',
      field: 'the discount',
    });
  });

  it('refuses a line that is not a whole number of pesewas, naming the line', () => {
    expect(failureOf(() => apportionDiscount([1_000, 2.5], 100))).toEqual({
      code: 'amount_out_of_range',
      message: 'line 2 must be a whole number of pesewas',
      field: 'line 2',
    });
  });

  it('refuses a single line above the arithmetic ceiling', () => {
    expect(failureOf(() => apportionDiscount([MAX_AMOUNT_PESEWAS + 1], 1))).toEqual({
      code: 'amount_out_of_range',
      message: 'Line 1 is larger than this system can price',
      field: undefined,
    });
  });

  it('refuses a basket whose total is above the ceiling, even when every line is under it', () => {
    // The check the ceiling was re-derived for. The product `discount * value` is
    // bounded by the total squared, so a basket of many individually-acceptable
    // lines can overflow it: two GHS-900,000 lines pass the per-line check and
    // their total does not. Without this the arithmetic goes inexact quietly,
    // which is the exact failure this package exists to prevent.
    expect(
      failureOf(() => apportionDiscount([MAX_AMOUNT_PESEWAS, MAX_AMOUNT_PESEWAS], 1))
    ).toEqual({
      code: 'amount_out_of_range',
      message: 'The basket is larger than this system can price',
      field: undefined,
    });
    // And the ceiling itself is accepted, so the refusal is at the bound and not
    // somewhere below it.
    expect(apportionDiscount([MAX_AMOUNT_PESEWAS], 0).shares).toEqual([0]);
  });
});

describe('apportionDiscount over a sweep of baskets', () => {
  it('keeps every invariant that makes the shares defensible', () => {
    // The module header argues that drift can never exceed capacity, so the loop
    // always finishes and the shares always sum exactly. An argument is worth
    // having and not worth trusting: this looks for a basket that breaks any part of
    // it, over shapes chosen to be awkward rather than typical — zero-value lines
    // mixed with large ones, discounts at both ends of the range, and single-line
    // baskets where the whole discount is drift.
    const next = lcg(20_260_901);
    const faults: string[] = [];

    for (let trial = 0; trial < 4_000 && faults.length < 20; trial += 1) {
      const lineCount = 1 + (next() % 8);
      const gross: number[] = [];
      for (let index = 0; index < lineCount; index += 1) {
        // Roughly one line in six is worth nothing, which is where the capacity
        // waterfall earns its place.
        gross.push(next() % 6 === 0 ? 0 : next() % 50_000);
      }
      const total = gross.reduce((sum, value) => sum + value, 0);
      if (total === 0) continue;
      const discount = next() % (total + 1);

      let result;
      try {
        result = apportionDiscount(gross, discount);
      } catch (error) {
        // Nothing in this range may refuse: every line is under the ceiling, the
        // total is under it, and the discount is at most the total.
        faults.push(
          `${JSON.stringify(gross)} discount ${discount} threw ${
            isTaxError(error) ? error.message : String(error)
          }`
        );
        continue;
      }

      const where = `${JSON.stringify(gross)} discount ${discount}`;
      const summed = result.shares.reduce((sum, share) => sum + share, 0);
      if (result.shares.length !== gross.length) {
        faults.push(`${where}: ${result.shares.length} shares for ${gross.length} lines`);
      }
      if (summed !== discount) {
        faults.push(`${where}: shares sum to ${summed}, not ${discount}`);
      }
      for (let index = 0; index < result.shares.length; index += 1) {
        const share = result.shares[index] ?? 0;
        const value = gross[index] ?? 0;
        if (!Number.isInteger(share) || share < 0) {
          faults.push(`${where}: line ${index} share is ${share}`);
        }
        if (share > value) {
          faults.push(`${where}: line ${index} carries ${share} of discount on a ${value} line`);
        }
      }
      // The flooring is the reason the drift is never negative: every share starts
      // at or below its exact proportion, so the shares can only fall short.
      if (result.drift < 0) {
        faults.push(`${where}: drift is ${result.drift}`);
      }
      if (result.drift > 0 && result.driftLines.length === 0) {
        faults.push(`${where}: ${result.drift} pesewas of drift landed on no line`);
      }
      if (result.drift === 0 && result.driftLines.length !== 0) {
        faults.push(`${where}: no drift, but ${result.driftLines.length} lines are named`);
      }
      for (const index of result.driftLines) {
        if (index < 0 || index >= gross.length) {
          faults.push(`${where}: drift line ${index} is not a line`);
        }
      }
    }

    expect(faults).toEqual([]);
  });

  it('is reproducible: the same basket gives the same shares every time', () => {
    // Parity between the server and the offline pricer depends on this. It is
    // asserted separately from the sweep because the sweep would also pass if the
    // answer were stable-but-wrong, and would fail to notice an answer that changed
    // between runs.
    const gross = [1_050, 0, 3_000, 1_050, 7];
    for (const discount of [0, 1, 7, 1_050, 5_106]) {
      const first = apportionDiscount(gross, discount);
      for (let repeat = 0; repeat < 20; repeat += 1) {
        expect(apportionDiscount(gross, discount)).toEqual(first);
      }
    }
  });

  it('does not mutate what it was given', () => {
    // A caller prices a basket, then writes it to a queue for later sync. If the
    // array came back rearranged or shortened, the queue would hold lines in an
    // order that no longer matches the shares.
    const gross = [1_050, 3_000, 1];
    const copy = [...gross];
    apportionDiscount(gross, 100);
    expect(gross).toEqual(copy);
  });
});
