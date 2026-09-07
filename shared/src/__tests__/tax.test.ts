import { isTaxError } from '../errors';
import {
  ACT_1151_AS_STORED,
  ACT_1151_EXCLUSIVE,
  ACT_1151_INCLUSIVE,
  GRA_EXAMPLE,
  GRA_IN_FORCE_FROM,
  GRA_INSTRUMENT,
  GRA_PRE_REFORM,
  GRA_RATES,
  GRA_SOURCE,
  NOT_VAT_REGISTERED,
} from '../fixtures/gra-worked-example';
import { MAX_AMOUNT_PESEWAS, PESEWAS_PER_CEDI, applyRate } from '../money';
import {
  VAT_TREATMENTS,
  assertTreatment,
  taxFromInclusiveGross,
  taxOnExclusiveBase,
  taxOnLine,
  taxSettings,
} from '../tax';

/**
 * Ghana's VAT, NHIL and GETFund levy under Act 1151.
 *
 * The plan asks for these tests to be written against a GRA worked example rather
 * than against our own arithmetic, and the first block below is the part of that
 * requirement which is easy to skip. GRA's figures are transcribed into
 * `fixtures/gra-worked-example.ts` by a person, and transcribing is itself an
 * arithmetic act: this file was first written with GHS 10 recorded as 10,000
 * pesewas and GHS 60 as `6_000 * 10`. Both are wrong, and every test that trusted
 * them passed. So the fixture is checked against the arithmetic GRA states beside
 * its own numbers before anything is checked against the fixture.
 *
 * The second thing this suite does is assert what the engine must NOT produce. The
 * pre-reform cascade — levies added to the price, then VAT charged on the sum — is
 * what most existing Ghanaian code in the wild still does, it is plausible, and it
 * overcharges by 19 cedis in every 1,000. GRA publishes both sets of figures, so
 * the wrong answer is available as data rather than having to be invented here.
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

describe('the GRA fixture, checked against the arithmetic GRA states beside it', () => {
  it('is cited, so a reader can go and disagree with the source rather than with us', () => {
    expect(GRA_SOURCE).toBe('https://gra.gov.gh/domestic-tax/tax-types/vat/');
    expect(GRA_INSTRUMENT).toBe('Value Added Tax Act, 2025 (Act 1151)');
    expect(GRA_IN_FORCE_FROM).toBe('2026-01-01');
  });

  it('is transcribed in pesewas, and the shift is two decimal places with nothing else in it', () => {
    // The unit is what was wrong twice. Asserting every figure as cedis times a
    // hundred means a decimal shift cannot survive into a test that passes.
    expect(GRA_EXAMPLE.sellingPrice).toBe(1_000 * PESEWAS_PER_CEDI);
    expect(GRA_EXAMPLE.nhil).toBe(25 * PESEWAS_PER_CEDI);
    expect(GRA_EXAMPLE.getfund).toBe(25 * PESEWAS_PER_CEDI);
    expect(GRA_EXAMPLE.vat).toBe(150 * PESEWAS_PER_CEDI);
    expect(GRA_EXAMPLE.total).toBe(1_200 * PESEWAS_PER_CEDI);
    expect(GRA_PRE_REFORM.covid19).toBe(10 * PESEWAS_PER_CEDI);
    expect(GRA_PRE_REFORM.leviesTotal).toBe(60 * PESEWAS_PER_CEDI);
    expect(GRA_PRE_REFORM.vatableValue).toBe(1_060 * PESEWAS_PER_CEDI);
    expect(GRA_PRE_REFORM.vat).toBe(159 * PESEWAS_PER_CEDI);
    expect(GRA_PRE_REFORM.total).toBe(1_219 * PESEWAS_PER_CEDI);
  });

  it('has each published levy equal to its published rate applied to the published price', () => {
    // "NHIL = 2.5% of 1,000 = GHS 25". The rate, the amount and the result are all
    // GRA's; only `applyRate` is ours, and it is under test in `money.test.ts`.
    expect(applyRate(GRA_EXAMPLE.sellingPrice, GRA_RATES.nhilRate)).toBe(GRA_EXAMPLE.nhil);
    expect(applyRate(GRA_EXAMPLE.sellingPrice, GRA_RATES.getfundRate)).toBe(GRA_EXAMPLE.getfund);
    expect(applyRate(GRA_EXAMPLE.sellingPrice, GRA_RATES.vatRate)).toBe(GRA_EXAMPLE.vat);
  });

  it('totals the post-reform basket from the four figures GRA prints', () => {
    // "Selling price (1000) + levies (50) + VAT (150) = GHS 1,200"
    expect(GRA_EXAMPLE.nhil + GRA_EXAMPLE.getfund).toBe(50 * PESEWAS_PER_CEDI);
    expect(
      GRA_EXAMPLE.sellingPrice + GRA_EXAMPLE.nhil + GRA_EXAMPLE.getfund + GRA_EXAMPLE.vat
    ).toBe(GRA_EXAMPLE.total);
  });

  it('totals the pre-reform basket the way GRA totals it, step by step', () => {
    // "Total levies = 25 + 25 + 10 = 60"
    expect(GRA_PRE_REFORM.nhil + GRA_PRE_REFORM.getfund + GRA_PRE_REFORM.covid19).toBe(
      GRA_PRE_REFORM.leviesTotal
    );
    // "VAT-able value = 1,000 + 60 = 1,060"
    expect(GRA_PRE_REFORM.sellingPrice + GRA_PRE_REFORM.leviesTotal).toBe(
      GRA_PRE_REFORM.vatableValue
    );
    // "VAT = 1,060 x 0.15 = 159"
    expect(applyRate(GRA_PRE_REFORM.vatableValue, GRA_RATES.vatRate)).toBe(GRA_PRE_REFORM.vat);
    // "Total = 1,060 + 159 = 1,219"
    expect(GRA_PRE_REFORM.vatableValue + GRA_PRE_REFORM.vat).toBe(GRA_PRE_REFORM.total);
  });

  it('puts the two regimes 19 cedis apart on a 1,000 cedi sale, which is the size of the mistake', () => {
    expect(GRA_PRE_REFORM.total - GRA_EXAMPLE.total).toBe(19 * PESEWAS_PER_CEDI);
    expect(GRA_PRE_REFORM.vat - GRA_EXAMPLE.vat).toBe(9 * PESEWAS_PER_CEDI);
  });
});

describe('taxOnExclusiveBase', () => {
  it("reproduces all five of GRA's published figures, to the pesewa", () => {
    // The requirement the plan names. GRA published one illustration; this is it,
    // read forwards, and nothing in the expected object below was computed here.
    expect(taxOnExclusiveBase(GRA_EXAMPLE.sellingPrice, ACT_1151_EXCLUSIVE, 'standard')).toEqual({
      taxableBase: GRA_EXAMPLE.sellingPrice,
      vat: GRA_EXAMPLE.vat,
      nhil: GRA_EXAMPLE.nhil,
      getfund: GRA_EXAMPLE.getfund,
      taxTotal: GRA_EXAMPLE.total - GRA_EXAMPLE.sellingPrice,
      treatment: 'standard',
      inputTaxCreditable: true,
    });
  });

  it('charges all three on the same base, which is the reform', () => {
    // GRA: "the VAT, the NHIL and the GETFund Levy are all charged on the same base
    // or value". Asserted as a property of the returned split rather than as three
    // separate figures, because a cascade implementation can reproduce the VAT
    // figure on a small basket and still be wrong.
    const split = taxOnExclusiveBase(GRA_EXAMPLE.sellingPrice, ACT_1151_EXCLUSIVE, 'standard');
    expect(applyRate(split.taxableBase, GRA_RATES.vatRate)).toBe(split.vat);
    expect(applyRate(split.taxableBase, GRA_RATES.nhilRate)).toBe(split.nhil);
    expect(applyRate(split.taxableBase, GRA_RATES.getfundRate)).toBe(split.getfund);
    expect(split.taxableBase).toBe(GRA_EXAMPLE.sellingPrice);
  });

  it('does not produce the pre-reform cascade', () => {
    const split = taxOnExclusiveBase(GRA_EXAMPLE.sellingPrice, ACT_1151_EXCLUSIVE, 'standard');
    // GRA's own figures for the same item under the old law: VAT 159 rather than
    // 150, and a total of 1,219 rather than 1,200. These are not numbers chosen to
    // be different — they are the numbers the wrong implementation produces, taken
    // from the same page as the right ones.
    expect(split.vat).not.toBe(GRA_PRE_REFORM.vat);
    expect(split.vat + split.nhil + split.getfund).not.toBe(
      GRA_PRE_REFORM.total - GRA_PRE_REFORM.sellingPrice
    );
    expect(GRA_EXAMPLE.sellingPrice + split.taxTotal).not.toBe(GRA_PRE_REFORM.total);
    // The direction, so that a regression is recognisable in a log rather than
    // merely different.
    expect(split.vat).toBeLessThan(GRA_PRE_REFORM.vat);
  });

  it('never adds the levies to the base before charging VAT, at any amount', () => {
    // The cascade as a formula rather than as one example: VAT charged on
    // `base + levies` instead of on `base`. Swept, because an implementation could
    // reproduce GRA's round 1,000 by coincidence of its divisors and still cascade
    // elsewhere.
    //
    // The sweep asserts the correct property — VAT is fifteen percent of the base —
    // rather than trying to detect a cascade by comparing against the cascaded
    // figure. Detecting it does not work at small amounts, where the levies are a
    // pesewa or two and rounding collapses the two answers into one: at a base of 20
    // the cascade and the reform both give VAT 3. Comparing them would report a
    // false cascade at those amounts, so the discrimination is left to GRA's own
    // 1,000 cedi example above, where the two are 159 and 150 and cannot coincide.
    const faults: string[] = [];
    for (let base = 0; base <= 100_000; base += 1) {
      const split = taxOnExclusiveBase(base, ACT_1151_EXCLUSIVE, 'standard');
      if (split.vat !== applyRate(base, GRA_RATES.vatRate) && faults.length < 20) {
        faults.push(
          `base ${base}: VAT ${split.vat} is not 15% of it (that is ${applyRate(base, GRA_RATES.vatRate)})`
        );
      }
    }
    expect(faults).toEqual([]);
  });

  it('charges nothing on an exempt or zero-rated line, whatever the pharmacy rates are', () => {
    // The treatment decides, not the settings: a zero-rated line under a pharmacy
    // whose `vatRate` is 1500 still owes nothing.
    for (const treatment of ['exempt', 'zero_rated'] as const) {
      const split = taxOnExclusiveBase(5_000, ACT_1151_EXCLUSIVE, treatment);
      expect(split).toEqual({
        taxableBase: 5_000,
        vat: 0,
        nhil: 0,
        getfund: 0,
        taxTotal: 0,
        treatment,
        inputTaxCreditable: treatment === 'zero_rated',
      });
    }
  });

  it('returns a split whose taxTotal is the sum of its three parts, always', () => {
    const faults: string[] = [];
    for (let base = 0; base <= 50_000; base += 7) {
      const split = taxOnExclusiveBase(base, ACT_1151_EXCLUSIVE, 'standard');
      if (split.taxTotal !== split.vat + split.nhil + split.getfund && faults.length < 20) {
        faults.push(`base ${base}: taxTotal ${split.taxTotal} is not the sum of its parts`);
      }
    }
    expect(faults).toEqual([]);
  });

  it('prices the arithmetic ceiling and refuses one pesewa above it', () => {
    expect(taxOnExclusiveBase(MAX_AMOUNT_PESEWAS, ACT_1151_EXCLUSIVE, 'standard').vat).toBe(
      applyRate(MAX_AMOUNT_PESEWAS, GRA_RATES.vatRate)
    );
    expect(
      failureOf(() => taxOnExclusiveBase(MAX_AMOUNT_PESEWAS + 1, ACT_1151_EXCLUSIVE, 'standard'))
        .message
    ).toBe('the taxable base is larger than this system can price');
  });
});

describe('taxFromInclusiveGross', () => {
  it("reads GRA's illustration backwards and returns the same five figures", () => {
    // GRA publishes no inclusive example, so this is the exclusive one inverted: a
    // shelf price of 1,200 contains a value of supply of 1,000. One published
    // illustration testing both directions is fortunate and not by design.
    const split = taxFromInclusiveGross(GRA_EXAMPLE.total, ACT_1151_INCLUSIVE, 'standard');
    expect(split.taxableBase).toBe(GRA_EXAMPLE.sellingPrice);
    expect(split.vat).toBe(GRA_EXAMPLE.vat);
    expect(split.nhil).toBe(GRA_EXAMPLE.nhil);
    expect(split.getfund).toBe(GRA_EXAMPLE.getfund);
    expect(split.taxTotal).toBe(GRA_EXAMPLE.total - GRA_EXAMPLE.sellingPrice);
  });

  it('keeps base plus tax equal to what the customer paid, at every amount', () => {
    // The invariant that decides the ordering of the two steps, and the only one a
    // receipt has to satisfy. Deriving the base last makes it true by construction;
    // deriving the base first and the taxes from it would break it at some amounts,
    // and the break is invisible on a receipt where every figure looks plausible.
    const faults: string[] = [];
    for (let gross = 0; gross <= 100_000; gross += 1) {
      const split = taxFromInclusiveGross(gross, ACT_1151_INCLUSIVE, 'standard');
      if (split.taxableBase + split.taxTotal !== gross && faults.length < 20) {
        faults.push(`gross ${gross}: base ${split.taxableBase} + tax ${split.taxTotal}`);
      }
    }
    expect(faults).toEqual([]);
  });

  it('is not the same as charging the rate on the base it returns, and says so', () => {
    // Documented in `tax.ts` as a consequence rather than a bug. No rounding makes
    // "tax is a rate of the net" and "net is the gross less the tax" both exact at
    // once. Pinning the disagreement is what stops a future reader from "fixing" it
    // and silently breaking the receipt's own addition.
    const split = taxFromInclusiveGross(100, ACT_1151_INCLUSIVE, 'standard');
    expect(split.vat).toBe(13);
    expect(split.taxableBase).toBe(83);
    expect(applyRate(split.taxableBase, GRA_RATES.vatRate)).toBe(12);
    expect(split.taxableBase + split.taxTotal).toBe(100);
  });

  it('contains no tax to extract from a non-standard line, so the base is the whole amount', () => {
    for (const treatment of ['exempt', 'zero_rated'] as const) {
      const split = taxFromInclusiveGross(5_000, ACT_1151_INCLUSIVE, treatment);
      expect(split.taxableBase).toBe(5_000);
      expect(split.taxTotal).toBe(0);
      expect(split.inputTaxCreditable).toBe(treatment === 'zero_rated');
    }
  });

  it('refuses one pesewa above the ceiling', () => {
    expect(
      failureOf(() => taxFromInclusiveGross(MAX_AMOUNT_PESEWAS + 1, ACT_1151_INCLUSIVE, 'standard'))
        .message
    ).toBe('the amount is larger than this system can price');
  });
});

describe('the difference between exempt and zero-rated', () => {
  it('is not a number, which is exactly why it is surfaced separately', () => {
    const exempt = taxOnExclusiveBase(5_000, ACT_1151_EXCLUSIVE, 'exempt');
    const zeroRated = taxOnExclusiveBase(5_000, ACT_1151_EXCLUSIVE, 'zero_rated');
    // Every figure identical. A report that reads a zero tax total and concludes
    // "exempt" would put zero-rated turnover in the wrong box on the return and lose
    // A&B the input credit behind it, and nothing in the numbers would show it.
    expect(exempt.taxableBase).toBe(zeroRated.taxableBase);
    expect(exempt.vat).toBe(zeroRated.vat);
    expect(exempt.nhil).toBe(zeroRated.nhil);
    expect(exempt.getfund).toBe(zeroRated.getfund);
    expect(exempt.taxTotal).toBe(zeroRated.taxTotal);
    expect(exempt.inputTaxCreditable).toBe(false);
    expect(zeroRated.inputTaxCreditable).toBe(true);
  });

  it('holds in the inclusive direction too, where a zero total is even easier to misread', () => {
    expect(taxFromInclusiveGross(5_000, ACT_1151_INCLUSIVE, 'exempt').inputTaxCreditable).toBe(
      false
    );
    expect(
      taxFromInclusiveGross(5_000, ACT_1151_INCLUSIVE, 'zero_rated').inputTaxCreditable
    ).toBe(true);
  });

  it('credits input tax on a standard-rated line as well', () => {
    expect(
      taxOnExclusiveBase(5_000, ACT_1151_EXCLUSIVE, 'standard').inputTaxCreditable
    ).toBe(true);
  });
});

describe('taxOnLine', () => {
  it("dispatches on the pharmacy's pricing mode", () => {
    expect(taxOnLine(100_000, ACT_1151_EXCLUSIVE, 'standard')).toEqual(
      taxOnExclusiveBase(100_000, ACT_1151_EXCLUSIVE, 'standard')
    );
    expect(taxOnLine(120_000, ACT_1151_INCLUSIVE, 'standard')).toEqual(
      taxFromInclusiveGross(120_000, ACT_1151_INCLUSIVE, 'standard')
    );
  });

  it('is the function a caller has to use, because the two modes are not interchangeable', () => {
    // Applying the exclusive rule to an inclusive price charges tax on top of a
    // price that already contained it: GHS 240 of tax on a GHS 1,200 sale instead of
    // GHS 200. That is why the dispatch lives in the engine rather than at each call
    // site, where the mistake is one wrong function name away and produces a receipt
    // on which every figure looks plausible.
    const right = taxOnLine(GRA_EXAMPLE.total, ACT_1151_INCLUSIVE, 'standard');
    const wrong = taxOnExclusiveBase(GRA_EXAMPLE.total, ACT_1151_INCLUSIVE, 'standard');
    expect(right.taxTotal).toBe(20_000);
    expect(wrong.taxTotal).toBe(24_000);
    expect(wrong.taxTotal).toBeGreaterThan(right.taxTotal);
  });
});

describe('taxSettings', () => {
  it('parses the rate strings a pharmacies row arrives in into the rates GRA publishes', () => {
    // The link between `database/init.sql`'s rate defaults and GRA's page. `pg`
    // hands back `numeric` as text and this project does not override that, so the
    // three rate literals are the shape those columns arrive in. If this breaks,
    // every figure in this package stays right and every figure in production is
    // wrong.
    //
    // The fourth value is not from a real row. `taxInclusivePricing` is `false`
    // here because GRA's illustration is worked exclusively, while the seeded
    // pharmacy prices inclusive. ASSERT 8e in `database/tests/assertions.sql` pins
    // the seeded row, and it has to be SQL rather than a test here: every test in
    // this package reads the rates from the fixture, so none of them can notice a
    // default that moved in the schema.
    expect(taxSettings(ACT_1151_AS_STORED)).toEqual(ACT_1151_EXCLUSIVE);
  });

  it('reads the same rates from a settings form, where they arrive as numbers', () => {
    expect(
      taxSettings({
        taxInclusivePricing: false,
        vatRate: 0.15,
        nhilRate: 0.025,
        getfundRate: 0.025,
      })
    ).toEqual(ACT_1151_EXCLUSIVE);
  });

  it('gives the same answer whichever shape arrived, which is why it is the only door', () => {
    const fromDatabase = taxSettings(ACT_1151_AS_STORED);
    const fromForm = taxSettings({
      taxInclusivePricing: false,
      vatRate: 0.15,
      nhilRate: 0.025,
      getfundRate: 0.025,
    });
    const fromCachedJson = taxSettings(
      JSON.parse(JSON.stringify(ACT_1151_AS_STORED)) as typeof ACT_1151_AS_STORED
    );
    expect(fromDatabase).toEqual(fromForm);
    expect(fromDatabase).toEqual(fromCachedJson);
  });

  it('freezes what it returns, so a caller cannot move the rates mid-basket', () => {
    expect(Object.isFrozen(taxSettings(ACT_1151_AS_STORED))).toBe(true);
  });

  it('refuses a pricing mode that is not a boolean', () => {
    // Truthiness would read `'false'` from a CSV cell as inclusive pricing.
    expect(
      failureOf(() =>
        taxSettings({
          ...ACT_1151_AS_STORED,
          taxInclusivePricing: 'yes' as unknown as boolean,
        })
      )
    ).toEqual({
      code: 'rate_out_of_range',
      message: 'Tax-inclusive pricing must be true or false',
      field: 'taxInclusivePricing',
    });
  });

  it('refuses a rate the column would hold but the law cannot mean', () => {
    // Two different refusals, and the difference is useful: a value that is not a
    // decimal at all is a broken field, where a decimal above one is a plausible
    // typo — `15` for `0.15`, or a percent sign dropped — and gets the message that
    // says what range was expected.
    for (const vatRate of ['2', '-0.15', '15%', 15]) {
      expect({
        vatRate,
        failure: failureOf(() => taxSettings({ ...ACT_1151_AS_STORED, vatRate })),
      }).toEqual({
        vatRate,
        failure: {
          code: 'rate_out_of_range',
          message: 'Enter the VAT rate as a decimal with at most four places, between 0 and 1',
          field: 'the VAT rate',
        },
      });
    }
    for (const vatRate of ['1.0001', 1.5]) {
      expect({
        vatRate,
        failure: failureOf(() => taxSettings({ ...ACT_1151_AS_STORED, vatRate })),
      }).toEqual({
        vatRate,
        failure: {
          code: 'rate_out_of_range',
          message: 'Enter the VAT rate as a decimal between 0 and 1',
          field: 'the VAT rate',
        },
      });
    }
  });

  it('names each rate separately, so a refusal points at one field', () => {
    expect(
      failureOf(() => taxSettings({ ...ACT_1151_AS_STORED, nhilRate: 'nope' })).field
    ).toBe('the NHIL rate');
    expect(
      failureOf(() => taxSettings({ ...ACT_1151_AS_STORED, getfundRate: 'nope' })).field
    ).toBe('the GETFund levy rate');
  });
});

describe('assertTreatment', () => {
  it('accepts the three the schema declares, in the order it declares them', () => {
    // The order is part of the contract: `backend/src/utils/schema-enums.ts`
    // re-exports this list and `schema-enums.test.ts` compares it against the
    // `create type` in `database/init.sql`, so a reordering here has to be a
    // deliberate change in two places.
    expect(VAT_TREATMENTS).toEqual(['standard', 'exempt', 'zero_rated']);
    for (const treatment of VAT_TREATMENTS) {
      expect(assertTreatment(treatment)).toBe(treatment);
    }
  });

  it('refuses a value that came through a serialisation boundary', () => {
    // A `switch` on an unrecognised string falls through to whatever the default
    // does, and the natural default here prices the line as exempt — silently, and
    // in the direction that loses revenue. Case and punctuation are the two ways a
    // CSV column differs from an enum.
    for (const value of ['STANDARD', 'Exempt', 'zero-rated', 'zerorated', 'Zero_Rated', '', 'null']) {
      expect({ value, failure: failureOf(() => assertTreatment(value)) }).toEqual({
        value,
        failure: {
          code: 'unknown_treatment',
          message: 'Enter the VAT treatment as one of: standard, exempt, zero_rated',
          field: 'the VAT treatment',
        },
      });
    }
  });

  it('names the field it was given, so a basket says which line is wrong', () => {
    expect(failureOf(() => assertTreatment('nope', 'line 3 VAT treatment')).message).toBe(
      'Enter line 3 VAT treatment as one of: standard, exempt, zero_rated'
    );
  });
});

describe('NOT_VAT_REGISTERED', () => {
  it('charges nothing on a standard-rated line, which is not the same as exempting it', () => {
    const split = taxOnExclusiveBase(5_000, NOT_VAT_REGISTERED, 'standard');
    expect(split.vat).toBe(0);
    expect(split.nhil).toBe(0);
    expect(split.getfund).toBe(0);
    expect(split.taxableBase).toBe(5_000);
    // Zero rates are a statement about the pharmacy; `exempt` is a statement about
    // the supply. They land in different boxes on a return, so the credit flag
    // follows the treatment and not the amount.
    expect(split.inputTaxCreditable).toBe(true);
  });

  it('extracts nothing from an inclusive shelf price either', () => {
    const split = taxFromInclusiveGross(5_000, NOT_VAT_REGISTERED, 'standard');
    expect(split.taxableBase).toBe(5_000);
    expect(split.taxTotal).toBe(0);
  });
});

describe('the engine has no calendar', () => {
  it('is running in a zone that is not UTC, so the rest of this block is observable', () => {
    // The vacuous-pass guard, in the shape `backend/src/__tests__/clock.test.ts`
    // uses. If Node ever stopped honouring the TZ assignment in `jest.config.js`,
    // the test below would still pass and would be testing nothing.
    expect(new Date('2026-03-15T20:00:00.000Z').getTimezoneOffset()).not.toBe(0);
  });

  it('returns the same pesewas whatever the clock says, because it never reads one', () => {
    // Act 1151 replaced the cascade on 1 January 2026, so a date-aware engine would
    // have to decide which side of that line a sale fell on — and would have to
    // decide it identically on a server in UTC and a phone in Accra. This one is
    // handed its rates, so the question cannot arise.
    const expected = taxOnExclusiveBase(GRA_EXAMPLE.sellingPrice, ACT_1151_EXCLUSIVE, 'standard');
    jest.useFakeTimers();
    try {
      for (const instant of [
        '1999-12-31T23:59:59.000Z',
        '2025-12-31T23:59:59.000Z',
        GRA_IN_FORCE_FROM + 'T00:00:00.000Z',
        '2030-06-15T12:00:00.000Z',
      ]) {
        jest.setSystemTime(new Date(instant));
        expect(
          taxOnExclusiveBase(GRA_EXAMPLE.sellingPrice, ACT_1151_EXCLUSIVE, 'standard')
        ).toEqual(expected);
      }
    } finally {
      jest.useRealTimers();
    }
  });
});
