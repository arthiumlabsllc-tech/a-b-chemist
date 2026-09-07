import type { TaxSettings } from '../tax';

/**
 * Ghana Revenue Authority's own published figures, transcribed.
 *
 * The plan requires the tax tests to be written against a GRA worked example
 * rather than against our own arithmetic, and this file is why that requirement
 * is worth having. A tax engine tested against numbers its author computed is a
 * test that agrees with itself: write `1000 * 0.15 = 150` into the engine and the
 * same into the test and both are green, whichever of them is wrong. GRA's
 * illustration is five numbers somebody else published, and reproducing all five
 * to the pesewa is evidence that cannot be manufactured by making the same
 * mistake twice.
 *
 * Source: Ghana Revenue Authority, "Value Added Tax", the section "VAT Reforms —
 * 2026" and its subsection "Sample Illustration of VAT Computation &
 * Interpretation".
 *
 *     https://gra.gov.gh/domestic-tax/tax-types/vat/
 *
 * Retrieved September 2026. The reforms were passed as the Value Added Tax Act,
 * 2025 (Act 1151) and took effect on 1 January 2026.
 *
 * Every number below is a literal read off that page. Nothing here is derived,
 * computed or rounded by us — if a figure needed converting from cedis to pesewas
 * that is stated beside it, and the conversion is a shift of two decimal places
 * with no arithmetic in it.
 */
export const GRA_SOURCE = 'https://gra.gov.gh/domestic-tax/tax-types/vat/';
export const GRA_RETRIEVED = '2026-09';
export const GRA_INSTRUMENT = 'Value Added Tax Act, 2025 (Act 1151)';
export const GRA_IN_FORCE_FROM = '2026-01-01';

/**
 * The rates GRA publishes under "Rates For VAT Computation (After Reforms)":
 *
 *     Value Added Tax (VAT) Rate = 15%
 *     National Health Insurance Levy (NHIL) = 2.5%
 *     Ghana Education Trust Fund Levy (GETFund) = 2.5%
 *
 * and, under "Simplified VAT Computation":
 *
 *     the VAT, the NHIL and the GETFund Levy are all charged on the same base or
 *     value
 *
 * Expressed in the engine's units: ten-thousandths, which is exactly what
 * `numeric(5, 4)` in `database/init.sql` holds.
 */
export const GRA_RATES = {
  /** 15% */
  vatRate: 1500,
  /** 2.5% */
  nhilRate: 250,
  /** 2.5% */
  getfundRate: 250,
} as const;

/**
 * GRA's illustration, exclusive.
 *
 * Transcribed from "VAT computation after reforms (NOW)":
 *
 *     Selling price         = 1,000
 *     NHIL                  = 2.5% of 1,000 = GHS 25
 *     GETFund Levy          = 2.5% of 1,000 = GHS 25
 *     VAT                   = 15% of 1,000 = GHS 150
 *     Selling price (1000) + levies (50) + VAT (150) = GHS 1,200
 *
 * In pesewas, so GHS 1,000 is 100,000 and GHS 25 is 2,500.
 *
 * The selling price here is the *value of the supply*, which GRA requires to be
 * "stated excluding values of levies and VAT". That is what makes this the
 * exclusive direction, and what makes its inverse — 1,200 in, 1,000 out — the
 * inclusive direction. One published illustration tests both modes, which is
 * fortunate because GRA publishes no inclusive example of its own.
 */
export interface GraIllustration {
  /** The value of the supply, excluding levies and VAT. */
  sellingPrice: number;
  nhil: number;
  getfund: number;
  vat: number;
  /** What the customer pays: selling price plus levies plus VAT. */
  total: number;
}

export const GRA_EXAMPLE: GraIllustration = {
  sellingPrice: 100_000,
  nhil: 2_500,
  getfund: 2_500,
  vat: 15_000,
  total: 120_000,
};

/**
 * The same basket under the law as it stood before 1 January 2026, from "II. VAT
 * computation before reforms".
 *
 *     Selling price = GHS 1,000
 *     NHIL = 2.5% x 1,000 = 25
 *     GETFund Levy = 2.5% x 1,000 = 25
 *     COVID-19 Levy = 1% x 1,000 = 10
 *     Total levies = 25 + 25 + 10 = 60
 *     VAT-able value = 1,000 + 60 = 1,060
 *     VAT = 1,060 x 0.15 = 159
 *     Total = 1,060 + 159 = 1,219
 *
 * This is kept as data, not as a footnote, because it is the shape of the mistake
 * that matters. Anyone who implemented Ghanaian VAT before 2026 implemented this
 * cascade: levies added to the price first, VAT charged on the sum. It is what
 * most existing Ghanaian code in the wild still does, it is plausible-looking, and
 * it is 19 cedis wrong in every 1,000 — charged to the customer, on every sale,
 * every day. `tax.test.ts` asserts these figures are NOT what the engine returns,
 * so a change back to the cascade fails the suite instead of shipping.
 *
 * `tax.test.ts` also checks this object against the arithmetic GRA states beside
 * it — that the three levies add to `leviesTotal`, that the vatable value is the
 * price plus them, that VAT is 15% of that, and that the total is their sum. That
 * test exists because transcribing these figures is itself an arithmetic act, and
 * an error in a fixture is worse than an error in code: every test that trusts it
 * passes. It caught two wrong decimal shifts the first time this block was
 * written.
 */
export const GRA_PRE_REFORM = {
  sellingPrice: 100_000,
  nhil: 2_500,
  getfund: 2_500,
  /** GHS 10. Abolished by Act 1151; kept only as the number the old law produced. */
  covid19: 1_000,
  /** GHS 60: the three levies above added together. */
  leviesTotal: 6_000,
  /** The cascade: levies added to the price before VAT was computed on the sum. */
  vatableValue: 106_000,
  vat: 15_900,
  total: 121_900,
} as const;

/**
 * Act 1151's rates as settings, in the exclusive mode GRA's illustration uses.
 *
 * Written as literals rather than built by calling `taxSettings()`. A fixture that
 * depends on the code it is used to test cannot tell the difference between "the
 * arithmetic is wrong" and "the parsing is wrong", and both would surface as the
 * same red GRA test. `taxSettings()` is tested separately, and one of those tests
 * is that parsing the strings `pg` returns for `numeric(5, 4)` produces exactly
 * this object.
 */
export const ACT_1151_EXCLUSIVE: TaxSettings = Object.freeze({
  taxInclusivePricing: false,
  vatRate: GRA_RATES.vatRate,
  nhilRate: GRA_RATES.nhilRate,
  getfundRate: GRA_RATES.getfundRate,
});

/**
 * The same rates in inclusive mode.
 *
 * This is the mode `database/init.sql` defaults `pharmacies.tax_inclusive_pricing`
 * to, because it is how a Ghanaian shop prices: the figure on the shelf is the
 * figure at the till. GRA recognises it — "Where the amount is inclusive of NHIL,
 * GETFund Levy & VAT, you must indicate the amount in the field labelled total tax
 * inclusive value" — without publishing an inclusive illustration, so the numbers
 * this mode is tested against are `GRA_EXAMPLE` read backwards.
 */
export const ACT_1151_INCLUSIVE: TaxSettings = Object.freeze({
  taxInclusivePricing: true,
  vatRate: GRA_RATES.vatRate,
  nhilRate: GRA_RATES.nhilRate,
  getfundRate: GRA_RATES.getfundRate,
});

/**
 * The three rates exactly as `pg` returns them for a `numeric(5, 4)` column,
 * paired with the exclusive mode GRA's illustration is worked in.
 *
 * `pg` parses `numeric` to a string and this project does not override that —
 * `backend/src/database/pg-types.ts` overrides only `date` — so the three rate
 * strings are the literal shape those columns arrive in, and `tax.test.ts` asserts
 * that feeding them to `taxSettings()` produces `ACT_1151_EXCLUSIVE`. That
 * assertion is the link between the rate defaults in `init.sql` and the rates GRA
 * publishes.
 *
 * `taxInclusivePricing` is the exception, and it is worth being exact about
 * because the mistake is easy to make in either direction. It is `false` here to
 * match the exclusive illustration, so this object is **not** the row A&B Chemist
 * is seeded with: `init.sql` defaults `pharmacies.tax_inclusive_pricing` to `true`
 * and the seed omits the column, so the seeded pharmacy prices inclusive. Read
 * this as "the rates as stored, in the mode GRA's example uses", never as "the
 * seeded row" — that row is `ACT_1151_INCLUSIVE`.
 *
 * What pins the seeded row is ASSERT 8e in `database/tests/assertions.sql`, and it
 * has to be SQL rather than a test here: every jest test on either side reads the
 * rates from this file, so a default changed in `init.sql` and not here would
 * leave the whole suite green while the pharmacy charged a different tax — and the
 * receipt would agree with itself, because it prints the rate that was charged.
 */
export const ACT_1151_AS_STORED = Object.freeze({
  taxInclusivePricing: false,
  vatRate: '0.1500',
  nhilRate: '0.0250',
  getfundRate: '0.0250',
});

/**
 * A pharmacy that is not VAT-registered, or one whose rates have been set to zero.
 *
 * Act 1151 raised the registration threshold for businesses dealing in goods from
 * GHS 200,000 to GHS 750,000, which puts a small community pharmacy on either side
 * of the line depending on its turnover. Whether A&B Chemist is registered is a
 * fact about A&B Chemist and not something this codebase can decide, so it is a
 * setting. This object is what that setting looks like when the answer is no, and
 * it is exercised by the parity vectors so the unregistered case is a tested
 * configuration rather than an untested assumption.
 *
 * It is not the same as marking every product `exempt`. Zero rates mean the
 * pharmacy charges no VAT on anything; `exempt` is a statement about a particular
 * supply, and the two land in different boxes on a return.
 */
export const NOT_VAT_REGISTERED: TaxSettings = Object.freeze({
  taxInclusivePricing: true,
  vatRate: 0,
  nhilRate: 0,
  getfundRate: 0,
});
