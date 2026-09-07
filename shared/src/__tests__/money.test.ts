import { isTaxError } from '../errors';
import {
  MAX_AMOUNT_PESEWAS,
  MAX_TOTAL_PESEWAS,
  PESEWAS_PER_CEDI,
  RATE_SCALE,
  applyRate,
  assertAmount,
  assertPesewas,
  assertRate,
  assertTotal,
  decimalStringFromPesewas,
  floorDiv,
  parseRate,
  pesewasFromDecimalString,
  rateDecimalString,
  rateLabel,
  roundHalfUp,
} from '../money';
import { ACT_1151_AS_STORED, GRA_EXAMPLE, GRA_RATES } from '../fixtures/gra-worked-example';

/**
 * The arithmetic the rest of the package rests on.
 *
 * Nothing here is about tax. These are the tests that make the tax tests mean
 * something: if `roundHalfUp` is wrong, every figure in `parity.test.ts` is wrong
 * in the same way and agrees with itself. So this suite checks the primitives
 * against properties that do not involve the primitives — floor division against
 * the defining relation of floor division, the ceiling against the inequality it
 * was derived from, the formatters against a round trip back to the number they
 * were given.
 *
 * It also checks the two constants against each other, because the difference
 * between them is a decision rather than an accident: `MAX_AMOUNT_PESEWAS` bounds
 * what may be multiplied and `MAX_TOTAL_PESEWAS` bounds what may be stored, and a
 * future edit that collapses them into one loses the guarantee either way.
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
 * The defining property of floor division, checked without dividing.
 *
 * This is what makes the sweep below a test rather than a restatement. `floorDiv`
 * computes both of its outputs from `Math.floor(n / d)`, so comparing one against
 * the other proves nothing; what pins the answer is that the remainder has to sit
 * in `[0, d)` and the pair has to reconstruct `n`. A quotient one too high makes
 * the remainder negative, one too low makes it a whole denominator wide, and both
 * are caught by the range alone — which is independent information, not the input
 * read back.
 *
 * Every operation in here is exact for the inputs it is given: `quotient * d` is
 * at most `n` and therefore below 2^53, and an integer below 2^53 that is the true
 * product of two representable integers is returned exactly by IEEE multiplication.
 *
 * It returns a description of the fault rather than asserting, and the sweep
 * collects. That is a performance decision with a real consequence: over a million
 * cases, and `expect` carries enough overhead per call that asserting inside the
 * loop made this one file take three minutes to run. A suite that slow is a suite
 * that stops being run, and then it is not a suite.
 */
function floorDivisionFault(numerator: number, denominator: number): string | null {
  const { quotient, remainder } = floorDiv(numerator, denominator);
  const where = `${numerator}/${denominator}`;
  if (!Number.isInteger(quotient)) return `${where}: quotient ${quotient} is not an integer`;
  if (remainder < 0) {
    return `${where}: remainder ${remainder} is negative, so quotient ${quotient} is one too high`;
  }
  if (remainder >= denominator) {
    return `${where}: remainder ${remainder} is a whole ${denominator} wide, so quotient ${quotient} is one too low`;
  }
  if (quotient * denominator + remainder !== numerator) {
    return `${where}: ${quotient}*${denominator}+${remainder} does not reconstruct ${numerator}`;
  }
  return null;
}

/** The same check, for the handful of cases worth failing loudly and individually. */
function expectFloorDivision(numerator: number, denominator: number): void {
  expect(floorDivisionFault(numerator, denominator)).toBeNull();
}

/** Half-to-even, written out so the two rules can be shown to disagree. */
function roundHalfEven(numerator: number, denominator: number): number {
  const { quotient, remainder } = floorDiv(numerator, denominator);
  const twice = remainder * 2;
  if (twice < denominator) return quotient;
  if (twice > denominator) return quotient + 1;
  return quotient % 2 === 0 ? quotient : quotient + 1;
}

describe('floorDiv', () => {
  it('divides exactly when it can', () => {
    expect(floorDiv(6, 2)).toEqual({ quotient: 3, remainder: 0 });
    expect(floorDiv(0, 5)).toEqual({ quotient: 0, remainder: 0 });
    expect(floorDiv(12_000, 12_000)).toEqual({ quotient: 1, remainder: 0 });
  });

  it('rounds the quotient down, not to nearest', () => {
    expect(floorDiv(7, 2)).toEqual({ quotient: 3, remainder: 1 });
    // One pesewa into a ten-thousandth rate scale: the quotient is zero and the
    // whole amount is remainder, which is what makes `roundHalfUp` decide it.
    expect(floorDiv(1, RATE_SCALE)).toEqual({ quotient: 0, remainder: 1 });
    expect(floorDiv(9_999, RATE_SCALE)).toEqual({ quotient: 0, remainder: 9_999 });
  });

  it('satisfies the defining property across a sweep of small denominators', () => {
    // Capped so a broken `floorDiv` produces twenty readable lines rather than a
    // megabyte of them.
    //
    // The numerator range is symmetric about zero, and the negative half is not
    // decorative. `Math.trunc` and `Math.floor` agree on every non-negative operand,
    // so a positive-only sweep cannot tell them apart and would pass an implementation
    // that truncated. `floorDiv` is exported and its name is a promise; the refund or
    // credit note that `roundHalfUp`'s documentation already anticipates is the caller
    // that would hand it a negative, and it should find floor semantics rather than
    // discover truncation.
    const faults: string[] = [];
    for (let denominator = 1; denominator <= 64; denominator += 1) {
      for (let numerator = -20_000; numerator <= 20_000; numerator += 1) {
        const fault = floorDivisionFault(numerator, denominator);
        if (fault !== null && faults.length < 20) faults.push(fault);
      }
    }
    expect(faults).toEqual([]);
  });

  it('floors a negative numerator, which is the one place floor and trunc differ', () => {
    // `Math.trunc(-7 / 2)` is `-3` and leaves a remainder of `-1`, outside the range
    // the defining property allows. `Math.floor` gives `-4` and a remainder of `1`.
    // Spelled out beside the sweep because the sweep reports a fault string and this
    // reports the two numbers a reader can check by hand.
    expect(floorDiv(-7, 2)).toEqual({ quotient: -4, remainder: 1 });
    expect(floorDiv(-1, 2)).toEqual({ quotient: -1, remainder: 1 });
    expect(floorDiv(-6, 2)).toEqual({ quotient: -3, remainder: 0 });
  });

  it('satisfies it at the magnitudes the engine actually reaches', () => {
    // The divisors that occur in this package: the rate scale, the inclusive
    // divisor at Act 1151's rates, and the pesewas-per-cedi shift.
    for (const denominator of [
      PESEWAS_PER_CEDI,
      RATE_SCALE,
      RATE_SCALE + GRA_RATES.vatRate + GRA_RATES.nhilRate + GRA_RATES.getfundRate,
    ]) {
      for (const numerator of [
        0,
        1,
        denominator - 1,
        denominator,
        denominator + 1,
        MAX_AMOUNT_PESEWAS,
        MAX_AMOUNT_PESEWAS - 1,
        MAX_AMOUNT_PESEWAS * GRA_RATES.vatRate,
        // The largest product `discount.ts` can form, and the one the ceiling was
        // derived to keep exact.
        MAX_AMOUNT_PESEWAS ** 2,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER - 1,
      ]) {
        expectFloorDivision(numerator, denominator);
      }
    }
  });

  it('is checking something, by showing an off-by-one quotient failing the range', () => {
    // Seen-to-fail, in miniature. If `Math.floor(n / d)` ever returned a quotient
    // one out, the remainder computed from it would leave the range — and the two
    // directions leave it in opposite ways, so the sweep cannot miss either.
    const { quotient } = floorDiv(7, 2);
    expect(quotient).toBe(3);
    expect(7 - (quotient + 1) * 2).toBeLessThan(0);
    expect(7 - (quotient - 1) * 2).toBeGreaterThanOrEqual(2);
  });
});

describe('MAX_AMOUNT_PESEWAS', () => {
  it('is below the root of the largest safe integer, which is where it came from', () => {
    // The ceiling is `T` such that `T^2` is still exact, because `apportionDiscount`
    // multiplies a discount bounded by the basket total by a line value bounded by
    // the same total. These two assertions are the derivation, executable: the
    // first says the constant satisfies it, the second says the next round hundred
    // million does not — so 90,000,000 is a consequence and not a preference.
    expect(MAX_AMOUNT_PESEWAS ** 2).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(100_000_000 ** 2).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it('is the largest integer its own derivation allows, to the unit', () => {
    // 94,906,265^2 is the last square below 2^53 and 94,906,266^2 is the first
    // above it. Pinning both ends means the comment in `money.ts` cannot drift away
    // from the constant it explains without one of these going red.
    expect(94_906_265 ** 2).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(94_906_266 ** 2).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(MAX_AMOUNT_PESEWAS).toBeLessThanOrEqual(94_906_265);
  });

  it('is a whole number of cedis, so the refusal is a figure somebody can quote', () => {
    expect(MAX_AMOUNT_PESEWAS % PESEWAS_PER_CEDI).toBe(0);
    expect(MAX_AMOUNT_PESEWAS / PESEWAS_PER_CEDI).toBe(900_000);
  });
});

describe('MAX_TOTAL_PESEWAS', () => {
  it('is numeric(12, 2) at its widest, which is what every money column declares', () => {
    expect(decimalStringFromPesewas(MAX_TOTAL_PESEWAS)).toBe('9999999999.99');
    expect(pesewasFromDecimalString('9999999999.99', 'the amount')).toBe(MAX_TOTAL_PESEWAS);
  });

  it('is still below the largest safe integer, so summed totals stay exact', () => {
    // A basket total is a sum of line totals. Sums are exact only while the running
    // total is representable, so the storage bound has to sit under 2^53 too — it
    // is looser than the arithmetic bound, not independent of it.
    expect(MAX_TOTAL_PESEWAS).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('is looser than the arithmetic bound, and the two checks disagree because of it', () => {
    // The whole point of having two constants. A value between them is storable and
    // must not be multiplied; `assertTotal` accepts it and `assertAmount` refuses
    // it. If a future edit unifies them, one of these two lines goes red and forces
    // the question to be asked.
    const between = MAX_AMOUNT_PESEWAS + 1;
    expect(between).toBeLessThan(MAX_TOTAL_PESEWAS);
    expect(assertTotal(between, 'the basket total')).toBe(between);
    expect(failureOf(() => assertAmount(between, 'the amount')).message).toBe(
      'the amount is larger than this system can price'
    );
  });
});

describe('roundHalfUp', () => {
  it('rounds a half upward', () => {
    expect(roundHalfUp(45, 10)).toBe(5);
    expect(roundHalfUp(25, 10)).toBe(3);
    expect(roundHalfUp(15, 10)).toBe(2);
    expect(roundHalfUp(5, 10)).toBe(1);
  });

  it('rounds below a half down and above a half up', () => {
    expect(roundHalfUp(44, 10)).toBe(4);
    expect(roundHalfUp(46, 10)).toBe(5);
    expect(roundHalfUp(20, 10)).toBe(2);
    expect(roundHalfUp(21, 10)).toBe(2);
  });

  it('is not half-to-even, at the two smallest amounts where the rules differ', () => {
    // Both rules agree at 1.5 and 3.5 — half-even rounds 1.5 to 2 and 3.5 to 4 —
    // which is why the parity vectors use 2.5 and 4.5. These are the cases that
    // discriminate, and asserting the alternative rule's answer beside ours is what
    // makes "we chose half up" a fact about the code rather than about the comment.
    expect(roundHalfUp(25, 10)).toBe(3);
    expect(roundHalfEven(25, 10)).toBe(2);
    expect(roundHalfUp(45, 10)).toBe(5);
    expect(roundHalfEven(45, 10)).toBe(4);
    // And where they agree, they agree.
    expect(roundHalfUp(15, 10)).toBe(roundHalfEven(15, 10));
    expect(roundHalfUp(35, 10)).toBe(roundHalfEven(35, 10));
  });

  it('returns the quotient untouched when the division is exact', () => {
    expect(roundHalfUp(12_000, 12_000)).toBe(1);
    expect(roundHalfUp(0, RATE_SCALE)).toBe(0);
    expect(roundHalfUp(100_000 * GRA_RATES.vatRate, RATE_SCALE)).toBe(GRA_EXAMPLE.vat);
  });

  it('rounds a negative numerator toward positive infinity, which no caller reaches', () => {
    // Pinned rather than left to inference. `roundHalfUp` floors, so `-4.5` goes to
    // `-4`; "away from zero" would go to `-5`. Every amount in this package is
    // asserted non-negative before it is multiplied, so the branch is unreachable
    // today — but a refund or a credit note is the obvious future caller, and it
    // should meet a documented behaviour rather than choose one.
    expect(roundHalfUp(-45, 10)).toBe(-4);
    expect(roundHalfUp(-44, 10)).toBe(-4);
    expect(roundHalfUp(-46, 10)).toBe(-5);
  });
});

describe('applyRate', () => {
  it('reproduces both of GRA\'s levy figures on GRA\'s own amount', () => {
    expect(applyRate(GRA_EXAMPLE.sellingPrice, GRA_RATES.vatRate)).toBe(GRA_EXAMPLE.vat);
    expect(applyRate(GRA_EXAMPLE.sellingPrice, GRA_RATES.nhilRate)).toBe(GRA_EXAMPLE.nhil);
    expect(applyRate(GRA_EXAMPLE.sellingPrice, GRA_RATES.getfundRate)).toBe(GRA_EXAMPLE.getfund);
  });

  it('is the only place a rate meets money, so it is the only place that rounds', () => {
    // 30 pesewas at 15% is exactly 4.5: the smallest exclusive amount at which the
    // rounding rule is visible. This is the figure the `half-up-decides-vat-exclusive`
    // parity vector rests on.
    expect(applyRate(30, 1500)).toBe(5);
    expect(applyRate(29, 1500)).toBe(4);
    expect(applyRate(31, 1500)).toBe(5);
  });

  it('charges nothing at a zero rate and the whole amount at a hundred percent', () => {
    expect(applyRate(12_345, 0)).toBe(0);
    expect(applyRate(0, GRA_RATES.vatRate)).toBe(0);
    expect(applyRate(1_234, RATE_SCALE)).toBe(1_234);
  });

  it('rounds a levy smaller than half a pesewa to nothing rather than to a fraction', () => {
    // 2.5% of one pesewa is 0.025. There is no such coin, and inventing one would
    // put a fraction into a column declared as an integer of pesewas.
    expect(applyRate(1, GRA_RATES.nhilRate)).toBe(0);
    expect(applyRate(19, GRA_RATES.nhilRate)).toBe(0);
    expect(applyRate(20, GRA_RATES.nhilRate)).toBe(1);
  });
});

describe('assertPesewas', () => {
  it('accepts a non-negative whole number of pesewas', () => {
    expect(assertPesewas(0, 'the amount')).toBe(0);
    expect(assertPesewas(1, 'the amount')).toBe(1);
    expect(assertPesewas(123_456, 'the amount')).toBe(123_456);
  });

  it('refuses a fraction of a pesewa', () => {
    expect(failureOf(() => assertPesewas(1.5, 'the amount'))).toEqual({
      code: 'amount_out_of_range',
      message: 'the amount must be a whole number of pesewas',
      field: 'the amount',
    });
  });

  it('refuses a negative, with a message about the sign and not about the format', () => {
    // The distinction matters at the counter: '-1' is a real integer and a counting
    // error, where '1.5' is a broken input. Collapsing them would send an operator
    // looking for a typing mistake that is not there.
    expect(failureOf(() => assertPesewas(-1, 'the discount'))).toEqual({
      code: 'amount_out_of_range',
      message: 'the discount cannot be negative',
      field: 'the discount',
    });
  });

  it('refuses the values that are not numbers at all', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(failureOf(() => assertPesewas(value, 'the amount')).code).toBe('amount_out_of_range');
    }
  });
});

describe('assertAmount', () => {
  it('accepts the ceiling itself', () => {
    expect(assertAmount(MAX_AMOUNT_PESEWAS, 'the amount')).toBe(MAX_AMOUNT_PESEWAS);
  });

  it('refuses one pesewa above it', () => {
    expect(failureOf(() => assertAmount(MAX_AMOUNT_PESEWAS + 1, 'the amount'))).toEqual({
      code: 'amount_out_of_range',
      message: 'the amount is larger than this system can price',
      field: 'the amount',
    });
  });
});

describe('assertTotal', () => {
  it('accepts the storage ceiling itself', () => {
    expect(assertTotal(MAX_TOTAL_PESEWAS, 'the basket total')).toBe(MAX_TOTAL_PESEWAS);
  });

  it('refuses one pesewa above it, saying store rather than price', () => {
    // A different word from `assertAmount`, on purpose: the operator cannot do
    // anything about either, but a developer reading a log can tell which bound was
    // hit, and the two have different causes.
    expect(failureOf(() => assertTotal(MAX_TOTAL_PESEWAS + 1, 'the basket total'))).toEqual({
      code: 'amount_out_of_range',
      message: 'the basket total is larger than this system can store',
      field: 'the basket total',
    });
  });
});

describe('assertRate', () => {
  it('accepts the rates Act 1151 sets and the ends of the range', () => {
    for (const rate of [0, GRA_RATES.getfundRate, GRA_RATES.vatRate, RATE_SCALE]) {
      expect(assertRate(rate)).toBe(rate);
    }
  });

  it('refuses anything outside zero to one, and anything fractional', () => {
    // `numeric(5, 4)` would happily store 9.9999, so a 999.99% VAT is representable
    // in the column and nonsense everywhere else. Refusing it here is what stops a
    // settings-form typo from becoming a receipt charging ten times the price.
    for (const rate of [-1, RATE_SCALE + 1, 1.5, Number.NaN]) {
      expect(failureOf(() => assertRate(rate))).toEqual({
        code: 'rate_out_of_range',
        message: 'A tax rate must be a whole number of ten-thousandths between 0 and 10000',
        field: 'rate',
      });
    }
  });
});

describe('pesewasFromDecimalString', () => {
  it('reads the shapes a money cell arrives in', () => {
    expect(pesewasFromDecimalString('12.50', 'the price')).toBe(1_250);
    // Padded on the right: '12.5' is twelve cedis fifty, not twelve cedi and a
    // fifth of a pesewa.
    expect(pesewasFromDecimalString('12.5', 'the price')).toBe(1_250);
    expect(pesewasFromDecimalString('12', 'the price')).toBe(1_200);
    expect(pesewasFromDecimalString('0', 'the price')).toBe(0);
    expect(pesewasFromDecimalString('0.01', 'the price')).toBe(1);
    expect(pesewasFromDecimalString('0.1', 'the price')).toBe(10);
  });

  it('trims, like every coercer in the backend and like parseRate below', () => {
    // A spreadsheet that right-aligns money produces ' 12.50'. The backend's
    // `toMoneyString` trims before it validates and hands this function the same
    // text, so refusing it here would make acceptance depend on which parser a
    // field happened to reach first.
    expect(pesewasFromDecimalString('  12.50  ', 'the price')).toBe(1_250);
    expect(pesewasFromDecimalString('\t12.50\n', 'the price')).toBe(1_250);
  });

  it('refuses more than two decimal places rather than rounding them away', () => {
    expect(failureOf(() => pesewasFromDecimalString('12.505', 'the cost price'))).toEqual({
      code: 'amount_out_of_range',
      message: 'Enter the cost price as an amount, for example 12.50',
      field: 'the cost price',
    });
  });

  it('refuses the things a spreadsheet produces that are not amounts', () => {
    for (const value of [
      '-1',
      '+12',
      'abc',
      '',
      '1e3',
      '1,000',
      '12.',
      '.5',
      '10000000000.00',
      '0x10',
      '12.5.0',
    ]) {
      expect({ value, failure: failureOf(() => pesewasFromDecimalString(value, 'the price')) }).toEqual(
        {
          value,
          failure: {
            code: 'amount_out_of_range',
            message: 'Enter the price as an amount, for example 12.50',
            field: 'the price',
          },
        }
      );
    }
  });
});

describe('decimalStringFromPesewas', () => {
  it('writes the two decimal places a money column expects', () => {
    expect(decimalStringFromPesewas(1_250)).toBe('12.50');
    expect(decimalStringFromPesewas(1)).toBe('0.01');
    expect(decimalStringFromPesewas(10)).toBe('0.10');
    expect(decimalStringFromPesewas(100)).toBe('1.00');
    expect(decimalStringFromPesewas(0)).toBe('0.00');
    expect(decimalStringFromPesewas(GRA_EXAMPLE.total)).toBe('1200.00');
  });

  it('round-trips, which is the property the receipt and the column share', () => {
    // Two directions over a sweep, because they fail differently: the parse can lose
    // a decimal place and the format can drop a leading zero, and only checking both
    // ways catches the second.
    const faults: string[] = [];
    for (let pesewas = 0; pesewas <= 100_000; pesewas += 1) {
      if (pesewasFromDecimalString(decimalStringFromPesewas(pesewas), 'the amount') !== pesewas) {
        if (faults.length < 20) faults.push(`${pesewas} did not survive the round trip`);
      }
    }
    expect(faults).toEqual([]);

    for (const text of ['0', '0.00', '0.01', '0.10', '1', '1.00', '12.5', '12.50', '1200.00']) {
      const formatted = decimalStringFromPesewas(pesewasFromDecimalString(text, 'the amount'));
      expect(pesewasFromDecimalString(formatted, 'the amount')).toBe(
        pesewasFromDecimalString(text, 'the amount')
      );
      expect(formatted).toMatch(/^\d+\.\d{2}$/u);
    }
  });

  it('refuses a value the column could not hold', () => {
    expect(failureOf(() => decimalStringFromPesewas(MAX_TOTAL_PESEWAS + 1)).message).toBe(
      'the amount is larger than this system can store'
    );
  });
});

describe('parseRate', () => {
  it('reads the strings pg returns for numeric(5, 4)', () => {
    // The literal shape a `pharmacies` row arrives in. `pg-types.ts` overrides only
    // `date`, so these come back as text and this is the door they enter by.
    expect(parseRate(ACT_1151_AS_STORED.vatRate, 'the VAT rate')).toBe(GRA_RATES.vatRate);
    expect(parseRate(ACT_1151_AS_STORED.nhilRate, 'the NHIL rate')).toBe(GRA_RATES.nhilRate);
    expect(parseRate(ACT_1151_AS_STORED.getfundRate, 'the GETFund levy rate')).toBe(
      GRA_RATES.getfundRate
    );
  });

  it('reads a rate written with fewer than four places', () => {
    expect(parseRate('0.15', 'the VAT rate')).toBe(1_500);
    expect(parseRate('0.025', 'the NHIL rate')).toBe(250);
    expect(parseRate('0.1', 'the rate')).toBe(1_000);
    expect(parseRate('0.0001', 'the rate')).toBe(1);
    expect(parseRate('0', 'the rate')).toBe(0);
    expect(parseRate('0.0000', 'the rate')).toBe(0);
  });

  it('pads on the right, because the alternative makes every levy ten times too small', () => {
    // The load-bearing direction. `'025'` is two and a half percent, so 250
    // ten-thousandths; padded on the left it would read as a quarter of one percent.
    // Tied to GRA's own figure rather than to a bare number, so the assertion is
    // that the parsed rate charges the levy GRA published and not merely that it
    // equals 250.
    expect(applyRate(GRA_EXAMPLE.sellingPrice, parseRate('0.0250', 'the NHIL rate'))).toBe(
      GRA_EXAMPLE.nhil
    );
  });

  it('reads a number by way of its decimal text, not by multiplying it', () => {
    expect(parseRate(0.15, 'the VAT rate')).toBe(1_500);
    expect(parseRate(0.025, 'the NHIL rate')).toBe(250);
    expect(parseRate(0, 'the rate')).toBe(0);
    expect(parseRate(1, 'the rate')).toBe(RATE_SCALE);
  });

  it('parses every rate the column can hold, which is 10,001 of them', () => {
    // The sweep the `String()` routing is justified by. For every four-place rate
    // between zero and one — the whole in-range domain of `numeric(5, 4)` — the
    // shortest decimal that reads back as the same double is the rate somebody
    // typed, and `parseRate` recovers it exactly.
    const faults: string[] = [];
    for (let expected = 0; expected <= RATE_SCALE; expected += 1) {
      const asDouble = expected / RATE_SCALE;
      const text = String(asDouble);
      // The claim being tested: the shortest decimal for this double never has more
      // than the four places the schema allows, so nothing is lost by reading it.
      if (!/^\d?(?:\.\d{1,4})?$/u.test(text)) {
        if (faults.length < 20) faults.push(`${expected} renders as '${text}', which has too many places`);
      }
      if (parseRate(asDouble, 'the rate') !== expected) {
        if (faults.length < 20) faults.push(`the double ${asDouble} did not parse back to ${expected}`);
      }
      if (parseRate(text, 'the rate') !== expected) {
        if (faults.length < 20) faults.push(`the string '${text}' did not parse back to ${expected}`);
      }
    }
    expect(faults).toEqual([]);
  });

  it('survives the rates that the multiply-by-scale route gets wrong', () => {
    // Counted, not remembered. `(i / 10000) * 10000` truncates to the wrong integer
    // for 573 of the 10,001 rates, and it errs downward, so the failure is a levy
    // charged smaller than the law sets it. `0.0003` is the smallest such rate and
    // the one the comment in `money.ts` names.
    let wrongByMultiply = 0;
    for (let expected = 0; expected <= RATE_SCALE; expected += 1) {
      if (Math.trunc((expected / RATE_SCALE) * RATE_SCALE) !== expected) wrongByMultiply += 1;
    }
    expect(wrongByMultiply).toBe(573);
    expect(Math.trunc(0.0003 * RATE_SCALE)).toBe(2);
    expect(parseRate(0.0003, 'the rate')).toBe(3);
  });

  it('refuses a rate that has already been through floating-point arithmetic', () => {
    // `String(0.1 + 0.2)` is seventeen digits, so the four-place rule refuses it. A
    // rate that is the *result* of an arithmetic expression is a rate nobody wrote
    // down, and guessing at it would mean accepting a settings value that differs
    // from anything on the form that produced it.
    expect(String(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(failureOf(() => parseRate(0.1 + 0.2, 'the VAT rate')).code).toBe('rate_out_of_range');
    expect(failureOf(() => parseRate(0.07 + 0.08, 'the VAT rate')).code).toBe('rate_out_of_range');
  });

  it('accepts one hundred percent and refuses anything past it', () => {
    expect(parseRate('1', 'the rate')).toBe(RATE_SCALE);
    expect(parseRate('1.0', 'the rate')).toBe(RATE_SCALE);
    expect(parseRate('1.0000', 'the rate')).toBe(RATE_SCALE);
    expect(parseRate(1, 'the rate')).toBe(RATE_SCALE);
  });

  it('refuses a rate above one in two different words, depending on what went wrong', () => {
    // `'1.0001'` is a well-formed decimal that is simply too big, and gets told the
    // range. `'15'` is not a decimal rate at all — it is a percentage typed into a
    // field that wants a fraction — and gets told the format. One message for both
    // would send whoever is fixing the settings form looking in the wrong place.
    expect(failureOf(() => parseRate('1.0001', 'the rate')).message).toBe(
      'Enter the rate as a decimal between 0 and 1'
    );
    for (const value of ['2', '15', '9.9999', '100']) {
      expect({ value, message: failureOf(() => parseRate(value, 'the rate')).message }).toEqual({
        value,
        message: 'Enter the rate as a decimal with at most four places, between 0 and 1',
      });
    }
  });

  it('refuses a shape that is not a decimal rate', () => {
    for (const value of [
      '-0.15',
      '+0.15',
      '.15',
      '0.12345',
      '0.15%',
      '15%',
      'abc',
      '',
      '1e-2',
      '0,15',
    ]) {
      expect({ value, failure: failureOf(() => parseRate(value, 'the VAT rate')) }).toEqual({
        value,
        failure: {
          code: 'rate_out_of_range',
          message: 'Enter the VAT rate as a decimal with at most four places, between 0 and 1',
          field: 'the VAT rate',
        },
      });
    }
  });

  it('trims, so a settings form and a CSV column parse alike', () => {
    expect(parseRate('  0.1500  ', 'the VAT rate')).toBe(1_500);
  });

  it('refuses the values that are neither a string nor a number', () => {
    // TypeScript stops a caller in this repo from reaching this branch. It is tested
    // anyway because `taxSettings` takes its input from an object that arrived as
    // `unknown` at the API boundary, and because a cached offline settings blob is
    // JSON — where `null` for a rate is an ordinary thing to find.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined, true, {}, []]) {
      expect(
        failureOf(() => parseRate(value as string | number, 'the VAT rate')).code
      ).toBe('rate_out_of_range');
    }
  });
});

describe('rateLabel', () => {
  it('names the three rates exactly as GRA\'s receipt rule names them', () => {
    // GRA requires a computer-generated sales receipt to carry a separate line for
    // NHIL at 2.5%, the GETFund levy at 2.5% and the VAT at 15%. These are the
    // strings that satisfy it, and they are asserted against the rates GRA publishes
    // rather than against numbers chosen here.
    expect(rateLabel(GRA_RATES.vatRate)).toBe('15%');
    expect(rateLabel(GRA_RATES.nhilRate)).toBe('2.5%');
    expect(rateLabel(GRA_RATES.getfundRate)).toBe('2.5%');
  });

  it('states a percentage and not the fraction, which is a factor of a hundred apart', () => {
    // The defect this pins: dividing a ten-thousandth rate by `RATE_SCALE` returns
    // the fraction and labelling that with a percent sign prints `0.15%` for the
    // 15% VAT. A receipt that misstates a statutory rate is a compliance failure,
    // and it is invisible to every other test in the package because no figure on
    // the receipt changes.
    expect(rateLabel(1_500)).not.toBe('0.15%');
    expect(rateLabel(250)).not.toBe('0.025%');
  });

  it('writes the ends of the range and the widths in between', () => {
    expect(rateLabel(0)).toBe('0%');
    expect(rateLabel(RATE_SCALE)).toBe('100%');
    expect(rateLabel(1)).toBe('0.01%');
    expect(rateLabel(10)).toBe('0.1%');
    expect(rateLabel(125)).toBe('1.25%');
    expect(rateLabel(1_234)).toBe('12.34%');
    expect(rateLabel(1_230)).toBe('12.3%');
    expect(rateLabel(1_200)).toBe('12%');
  });

  it('strips trailing zeros rather than claiming precision the rate does not have', () => {
    expect(rateLabel(250)).toBe('2.5%');
    expect(rateLabel(250)).not.toBe('2.50%');
    expect(rateLabel(1_500)).toBe('15%');
    expect(rateLabel(1_500)).not.toBe('15.00%');
  });

  it('round-trips back to the rate it was given, across the whole range', () => {
    // Parsed on the right, which is the inverse of how the formatter padded on the
    // left. That the two directions meet is the proof that neither is off by a
    // factor of ten — the exact defect the padding-direction comment warns about.
    const faults: string[] = [];
    for (let rate = 0; rate <= RATE_SCALE; rate += 1) {
      const label = rateLabel(rate);
      if (!label.endsWith('%')) {
        if (faults.length < 20) faults.push(`${rate} rendered as '${label}', with no percent sign`);
        continue;
      }
      const [whole, fraction] = label.slice(0, -1).split('.');
      const reconstructed =
        Number(whole ?? '0') * 100 + Number((fraction ?? '').padEnd(2, '0').slice(0, 2));
      if (reconstructed !== rate && faults.length < 20) {
        faults.push(`${rate} rendered as '${label}', which reads back as ${reconstructed}`);
      }
    }
    expect(faults).toEqual([]);
  });

  it('refuses a rate that is not one this package produced', () => {
    expect(failureOf(() => rateLabel(RATE_SCALE + 1)).code).toBe('rate_out_of_range');
    expect(failureOf(() => rateLabel(-1)).code).toBe('rate_out_of_range');
    expect(failureOf(() => rateLabel(1.5)).code).toBe('rate_out_of_range');
  });
});

describe('rateDecimalString', () => {
  it('writes the four decimal places numeric(5, 4) holds', () => {
    expect(rateDecimalString(GRA_RATES.vatRate)).toBe('0.1500');
    expect(rateDecimalString(GRA_RATES.nhilRate)).toBe('0.0250');
    expect(rateDecimalString(GRA_RATES.getfundRate)).toBe('0.0250');
  });

  it('writes the ends of the range and the narrowest rate in it', () => {
    expect(rateDecimalString(0)).toBe('0.0000');
    expect(rateDecimalString(1)).toBe('0.0001');
    expect(rateDecimalString(RATE_SCALE - 1)).toBe('0.9999');
    expect(rateDecimalString(RATE_SCALE)).toBe('1.0000');
  });

  it('gives back the exact string pg returns for the column', () => {
    // The round trip a settings screen depends on: read the row, show it, save it
    // back. A formatter that trimmed to '0.15' would still be accepted by
    // `parseRate` and nothing arithmetic would change, so the defect would not be a
    // wrong tax figure. It would be a row that looks edited by an operator who only
    // opened it — which is the kind of thing that ends an audit argument badly.
    expect(rateDecimalString(parseRate(ACT_1151_AS_STORED.vatRate, 'the VAT rate'))).toBe(
      ACT_1151_AS_STORED.vatRate
    );
    expect(rateDecimalString(parseRate(ACT_1151_AS_STORED.nhilRate, 'the NHIL rate'))).toBe(
      ACT_1151_AS_STORED.nhilRate
    );
    expect(rateDecimalString(parseRate(ACT_1151_AS_STORED.getfundRate, 'the levy rate'))).toBe(
      ACT_1151_AS_STORED.getfundRate
    );
  });

  it('is not the receipt spelling, because the two serve different readers', () => {
    // GRA requires the receipt to name the rate beside each levy, and it names it as
    // a percentage. The column stores a fraction. Both spellings are correct and
    // neither is interchangeable, which is why there are two functions rather than
    // one with a flag.
    expect(rateDecimalString(GRA_RATES.vatRate)).toBe('0.1500');
    expect(rateLabel(GRA_RATES.vatRate)).toBe('15%');
    expect(rateDecimalString(GRA_RATES.nhilRate)).toBe('0.0250');
    expect(rateLabel(GRA_RATES.nhilRate)).toBe('2.5%');
  });

  it('round-trips the whole range through parseRate, in both directions', () => {
    const faults: string[] = [];
    for (let rate = 0; rate <= RATE_SCALE; rate += 1) {
      const text = rateDecimalString(rate);
      if (!/^\d\.\d{4}$/u.test(text)) {
        if (faults.length < 20) faults.push(`${rate} rendered as '${text}', which is not four places`);
        continue;
      }
      if (parseRate(text, 'the rate') !== rate && faults.length < 20) {
        faults.push(`${rate} rendered as '${text}', which parses as ${parseRate(text, 'the rate')}`);
      }
    }
    expect(faults).toEqual([]);
  });

  it('refuses a rate that is not one this package produced', () => {
    expect(failureOf(() => rateDecimalString(RATE_SCALE + 1)).code).toBe('rate_out_of_range');
    expect(failureOf(() => rateDecimalString(-1)).code).toBe('rate_out_of_range');
    expect(failureOf(() => rateDecimalString(0.15)).code).toBe('rate_out_of_range');
  });
});
