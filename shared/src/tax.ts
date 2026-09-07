import { TaxError } from './errors';
import {
  RATE_SCALE,
  applyRate,
  assertAmount,
  assertRate,
  parseRate,
  roundHalfUp,
} from './money';

/**
 * Ghana's VAT, NHIL and GETFund levy, under the Value Added Tax Act 2025
 * (Act 1151), in force from 1 January 2026.
 *
 * The three charges are computed **on the same base**. That is the reform. Before
 * it, the levies were added to the price first and VAT was charged on the sum —
 * GRA's own comparison for a 1,000 cedi item is 1,000 + 60 levies = 1,060, then
 * 15% of 1,060 = 159, total 1,219. Under Act 1151 the same item is 1,000 + 25 +
 * 25 + 150 = 1,200. Anyone who has implemented Ghanaian VAT before 2026 has
 * implemented the cascade, and the cascade is the single most likely way for this
 * module to be wrong. `__tests__/tax.test.ts` asserts the pre-reform figures are
 * *not* produced, so a change back to them fails the suite rather than quietly
 * overcharging every customer by 19 cedis in every 1,000.
 *
 * Nothing here knows the date. The rates arrive as arguments from the pharmacy's
 * own settings row, so this module applies whatever it is given and never has to
 * decide which side of 1 January 2026 a sale falls on — which also means it has
 * no timezone, no calendar and nothing that differs between the server and a
 * phone. See `shared/jest.config.js` for why the suite still runs in a non-UTC
 * zone.
 */

/**
 * `vat_treatment`, in the order `database/init.sql` declares the enum.
 *
 * Owned here rather than in the backend, and re-exported from
 * `backend/src/utils/schema-enums.ts`. Two lists in two packages is two lists
 * that drift; the backend's `schema-enums.test.ts` reads `init.sql` and compares
 * it against this one, so the copy is still pinned to the database.
 *
 * Medicines in HS Chapter 30 are exempt, which is why the schema defaults
 * `inventory.vat_treatment` to `exempt` and why a product created without saying
 * is sold without VAT. That default is safe for a pharmacy and wrong for its
 * toiletries, so it is an explicit editable field with a warning in the UI for
 * non-drug categories rather than something inferred from the category.
 */
export const VAT_TREATMENTS = ['standard', 'exempt', 'zero_rated'] as const;
export type VatTreatment = (typeof VAT_TREATMENTS)[number];

/** The pharmacy's tax configuration, in the engine's own units. */
export interface TaxSettings {
  /**
   * True when shelf prices already carry the tax, so the tax is extracted from
   * what the customer pays rather than added to it.
   *
   * `database/init.sql` defaults this to true, which is how a Ghanaian shop
   * prices: the label on the box is the price at the till. Exclusive pricing
   * exists for the receipt side of GRA's illustration and for a pharmacy that
   * chooses to show tax on top.
   */
  taxInclusivePricing: boolean;
  /** VAT, in ten-thousandths. Act 1151 sets this at 15%, so `1500`. */
  vatRate: number;
  /** National Health Insurance Levy, ten-thousandths. 2.5%, so `250`. */
  nhilRate: number;
  /** Ghana Education Trust Fund Levy, ten-thousandths. 2.5%, so `250`. */
  getfundRate: number;
}

/** What a single line owes, and why. */
export interface TaxSplit {
  /**
   * The value the three charges were computed on — the "value of the supply",
   * which GRA requires to be stated excluding the levies and the VAT.
   */
  taxableBase: number;
  vat: number;
  nhil: number;
  getfund: number;
  /** `vat + nhil + getfund`. Always exactly that sum, never independently rounded. */
  taxTotal: number;
  /** The treatment that produced these numbers, echoed so a receipt can state it. */
  treatment: VatTreatment;
  /**
   * Whether input tax on the purchases behind this line is recoverable.
   *
   * True for `standard` and for `zero_rated`, false for `exempt`. Derived purely
   * from the treatment, so it is redundant with it — and surfaced anyway, because
   * `exempt` and `zero_rated` produce *identical* numbers and the only thing that
   * distinguishes them on a VAT return is this. GRA is explicit that a zero-rated
   * item also attracts a zero rate of GETFund and NHIL, and that the 2025
   * re-coupling restored input tax deduction on the two levies. A report that
   * reads `taxTotal === 0` and concludes "exempt" would put zero-rated turnover
   * in the wrong box and lose A&B the input credit on it.
   */
  inputTaxCreditable: boolean;
}

/**
 * Validates and normalises a tax settings object.
 *
 * The one door rates enter the engine through. Both consumers build their
 * settings from different places — the API from a `pharmacies` row where
 * `numeric(5, 4)` arrives as a string, the offline till from a cached JSON copy of
 * the same row — and normalising here means the two cannot disagree about what
 * `'0.0250'` and `0.025` mean.
 */
export function taxSettings(input: {
  taxInclusivePricing: boolean;
  vatRate: string | number;
  nhilRate: string | number;
  getfundRate: string | number;
}): TaxSettings {
  if (typeof input.taxInclusivePricing !== 'boolean') {
    throw new TaxError(
      'rate_out_of_range',
      'Tax-inclusive pricing must be true or false',
      'taxInclusivePricing'
    );
  }
  return Object.freeze({
    taxInclusivePricing: input.taxInclusivePricing,
    vatRate: assertRate(parseRate(input.vatRate, 'the VAT rate')),
    nhilRate: assertRate(parseRate(input.nhilRate, 'the NHIL rate')),
    getfundRate: assertRate(parseRate(input.getfundRate, 'the GETFund levy rate')),
  });
}

/** The three rates added to the whole, as the divisor for extracting tax from a gross. */
function inclusiveDivisor(settings: TaxSettings): number {
  return RATE_SCALE + settings.vatRate + settings.nhilRate + settings.getfundRate;
}

/**
 * Whether input tax on the purchases behind a supply of this treatment is
 * recoverable: false for `exempt`, true for `standard` and for `zero_rated`.
 *
 * One function rather than an expression at each of the two construction sites
 * below, and the reason is that the two sites were spelling the same rule two
 * different ways — `treatment === 'zero_rated'` in one, `treatment !== 'exempt'`
 * in the other. They agreed, but only by accident of which treatments each site
 * can be reached with: `zeroSplit` never sees `standard`, and `splitOf` never sees
 * anything else. Mutation testing found the consequence, which is that flipping
 * `splitOf`'s expression to `true` changed no output at all and so no test could
 * see it. A rule that cannot be observed cannot be tested, and a rule written twice
 * is a rule that can drift. Written once, a change to it is visible from both paths.
 */
function creditable(treatment: VatTreatment): boolean {
  return treatment !== 'exempt';
}

function zeroSplit(treatment: VatTreatment, base: number): TaxSplit {
  return Object.freeze({
    taxableBase: base,
    vat: 0,
    nhil: 0,
    getfund: 0,
    taxTotal: 0,
    treatment,
    inputTaxCreditable: creditable(treatment),
  });
}

function splitOf(
  treatment: VatTreatment,
  taxableBase: number,
  vat: number,
  nhil: number,
  getfund: number
): TaxSplit {
  return Object.freeze({
    taxableBase,
    vat,
    nhil,
    getfund,
    taxTotal: vat + nhil + getfund,
    treatment,
    inputTaxCreditable: creditable(treatment),
  });
}

/**
 * Asserts a treatment is one of the three, and narrows it.
 *
 * A treatment that arrives from a database column is already valid, but one that
 * arrives from a JSON body, a CSV cell or a cached offline catalogue has been
 * through a serialisation boundary, and `switch` on an unknown string falls
 * through to whatever the default does. Refusing it here means the failure is a
 * named error at the point of entry rather than a line silently priced as exempt.
 */
export function assertTreatment(value: string, field = 'the VAT treatment'): VatTreatment {
  const found = VAT_TREATMENTS.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new TaxError(
      'unknown_treatment',
      `Enter ${field} as one of: ${VAT_TREATMENTS.join(', ')}`,
      field
    );
  }
  return found;
}

/**
 * Tax on a base that excludes it — GRA's illustration read forwards.
 *
 * `taxOnExclusiveBase(100000, ACT_1151_RATES, 'standard')` returns NHIL 2500,
 * GETFund 2500, VAT 15000 and a gross of 120000 pesewas: GHS 1,000 becomes
 * GHS 1,200, which is the worked example on gra.gov.gh to the pesewa.
 */
export function taxOnExclusiveBase(
  basePesewas: number,
  settings: TaxSettings,
  treatment: VatTreatment
): TaxSplit {
  const base = assertAmount(basePesewas, 'the taxable base');

  if (treatment !== 'standard') {
    // Both non-standard treatments charge nothing. The arithmetic would produce
    // that anyway if the rates were zero, but a zero-rated line under a pharmacy
    // whose `vatRate` is 1500 must still be zero — the treatment decides, not the
    // settings.
    return zeroSplit(treatment, base);
  }

  return splitOf(
    treatment,
    base,
    applyRate(base, settings.vatRate),
    applyRate(base, settings.nhilRate),
    applyRate(base, settings.getfundRate)
  );
}

/**
 * Tax extracted from an amount that already includes it — GRA's illustration read
 * backwards, and the path a Ghanaian shelf price actually takes.
 *
 * The three charges are computed from the gross using each rate's share of the
 * whole, and the taxable base is then whatever is left:
 *
 *     vat   = gross × vatRate   / (10000 + vatRate + nhilRate + getfundRate)
 *     base  = gross − (vat + nhil + getfund)
 *
 * For GRA's 1,200 that is 120000 × 1500 / 12000 = 15000, and a base of
 * 120000 − 20000 = 100000. All five of the published numbers come back, which is
 * what makes the same example able to test both directions.
 *
 * **The base is the residual, and that ordering is deliberate.** Computing the base
 * first and the taxes from it would be the other natural reading, and it breaks
 * the only invariant a receipt has to satisfy: that the net and the three charges
 * add up to what the customer actually paid. Deriving the base last makes that
 * true by construction rather than by luck.
 *
 * One consequence, stated plainly because it looks like a bug and is not: the
 * returned `vat` is not always `roundHalfUp(taxableBase × vatRate)`. At a gross of
 * 100 pesewas this returns VAT 13 and a base of 83, and 15% of 83 is 12.45. No
 * rounding of a fraction can make "tax is a rate of the net" and "net is the gross
 * less the tax" both exact at once, so every VAT system picks one. This picks the
 * inclusive fraction, which is how tax is extracted from a gross price everywhere
 * it is done, and which keeps the receipt's own addition correct — the thing a
 * customer, and an auditor holding the receipt, can actually check.
 */
export function taxFromInclusiveGross(
  grossPesewas: number,
  settings: TaxSettings,
  treatment: VatTreatment
): TaxSplit {
  const gross = assertAmount(grossPesewas, 'the amount');

  if (treatment !== 'standard') {
    // An exempt shelf price has no tax inside it to extract, so the base is the
    // whole amount and nothing is owed. Falling through to the fraction
    // arithmetic with all three numerators at zero produces exactly this, but
    // returning it directly keeps the reason visible at the point it matters.
    return zeroSplit(treatment, gross);
  }

  const divisor = inclusiveDivisor(settings);
  const vat = roundHalfUp(gross * settings.vatRate, divisor);
  const nhil = roundHalfUp(gross * settings.nhilRate, divisor);
  const getfund = roundHalfUp(gross * settings.getfundRate, divisor);
  const taxTotal = vat + nhil + getfund;

  return splitOf(treatment, gross - taxTotal, vat, nhil, getfund);
}

/**
 * Tax on one line, in whichever mode the pharmacy prices in.
 *
 * The mode dispatch lives here rather than at each call site so that a caller
 * cannot apply the exclusive rule to an inclusive price. That mistake is
 * invisible on a receipt — every figure on it is plausible — and it charges the
 * customer tax on top of a price that already contained it.
 */
export function taxOnLine(
  amountPesewas: number,
  settings: TaxSettings,
  treatment: VatTreatment
): TaxSplit {
  return settings.taxInclusivePricing
    ? taxFromInclusiveGross(amountPesewas, settings, treatment)
    : taxOnExclusiveBase(amountPesewas, settings, treatment);
}
