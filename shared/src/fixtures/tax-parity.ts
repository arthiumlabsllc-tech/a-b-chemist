import type { BasketLineInput } from '../basket';
import type { TaxSettings } from '../tax';

/**
 * The shared parity vectors.
 *
 * This file is the deliverable the plan asks for by name: "parity vectors shared
 * with the offline pricer and proven identical". It is exported from the package
 * both consumers already depend on, and two suites read it:
 *
 *  - `shared/src/__tests__/parity.test.ts` — the engine reproduces every figure.
 *  - `frontend/src/lib/__tests__/pricing-parity.test.ts` — the *till* reproduces
 *    them too, with each number routed through the two bridges the frontend adds
 *    on the way to the engine (`taxSettingsFromView`, and `priceTillBasket`'s
 *    decimal-string price mapping). Those conversions are where an offline total
 *    could drift from an online one without the engine changing at all, and the
 *    engine's own suite never sees a decimal string.
 *
 * The API is covered transitively rather than by reading this array: `sales.service.ts`
 * prices through this package's `priceBasket`, which is the function the first suite
 * pins. One array, so there is no second copy to drift, no generated file to forget
 * to regenerate, and nothing to compare — the vectors are identical because they are
 * one thing.
 *
 * What that makes these vectors is a set of **golden values**: the engine's output
 * for each basket is pinned here, so changing the rounding rule, the treatment
 * logic or the apportionment turns this suite red and forces the change to be
 * deliberate and written down. That is a real test with a real failure mode, not a
 * tautology — `parity.test.ts` mutates the engine and confirms it goes red.
 *
 * `provenance` on each vector says where its numbers came from, and the
 * distinction is the honest part of this file. GRA published exactly one worked
 * example, so only some vectors can be GRA's; the rest are hand-computed against a
 * rounding rule GRA does not publish. Marking them all "GRA" would be a claim the
 * source does not support, and would hide which assertions carry external evidence
 * and which carry only ours.
 */

export const PARITY_VECTOR_SOURCE =
  'shared/src/fixtures/tax-parity.ts — read by shared/src/__tests__/parity.test.ts and by frontend/src/lib/__tests__/pricing-parity.test.ts';

export type VectorProvenance =
  /** Every figure transcribed from gra.gov.gh. */
  | 'gra'
  /** GRA's figures, read through the other pricing mode, or a rule GRA states in words. */
  | 'derived-from-gra'
  /** Computed by hand against a rule GRA does not publish. Ours, and labelled as such. */
  | 'hand-computed';

export interface TaxParityVector {
  /** Stable name. A failure points at this, not at an index. */
  name: string;
  provenance: VectorProvenance;
  /** What this vector is here to catch. */
  note: string;
  settings: TaxSettings;
  lines: readonly BasketLineInput[];
  discountPesewas: number;
  discountReason: string | null;
  expected: {
    subtotal: number;
    discount: number;
    vatAmount: number;
    nhilAmount: number;
    getfundAmount: number;
    taxTotal: number;
    taxableBase: number;
    total: number;
    lines: readonly {
      id: string;
      lineDiscount: number;
      taxableBase: number;
      vatAmount: number;
      nhilAmount: number;
      getfundAmount: number;
      lineTotal: number;
      /** Not money, but the one non-numeric output a VAT return depends on. */
      inputTaxCreditable: boolean;
    }[];
  };
}

const EXCLUSIVE: TaxSettings = Object.freeze({
  taxInclusivePricing: false,
  vatRate: 1500,
  nhilRate: 250,
  getfundRate: 250,
});

const INCLUSIVE: TaxSettings = Object.freeze({
  taxInclusivePricing: true,
  vatRate: 1500,
  nhilRate: 250,
  getfundRate: 250,
});

const UNREGISTERED: TaxSettings = Object.freeze({
  taxInclusivePricing: true,
  vatRate: 0,
  nhilRate: 0,
  getfundRate: 0,
});

/**
 * Freezes every level of a value, and returns it.
 *
 * `Object.freeze` is shallow, and on a file of golden values that is not enough.
 * Freezing the array alone would leave `TAX_PARITY_VECTORS[0].expected.total = 999`
 * permitted and silent — and the failure it produces is the worst kind for this
 * file specifically, because both consumers read the *same* object. One suite
 * corrupts a vector and the other still agrees with it, so the two stay identical
 * while both are wrong. Deep freezing makes a golden value unable to stop being
 * golden.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

export const TAX_PARITY_VECTORS: readonly TaxParityVector[] = deepFreeze([
  {
    name: 'gra-exclusive-single-standard-line',
    provenance: 'gra',
    note:
      'GRA\'s illustration read forwards: a 1,000 cedi supply becomes 1,200. All five published ' +
      'figures — NHIL 25, GETFund 25, VAT 150, total 1,200 — must come back to the pesewa.',
    settings: EXCLUSIVE,
    lines: [{ id: 'gra-item', quantity: 1, unitPricePesewas: 100_000, vatTreatment: 'standard' }],
    discountPesewas: 0,
    discountReason: null,
    expected: {
      subtotal: 100_000,
      discount: 0,
      vatAmount: 15_000,
      nhilAmount: 2_500,
      getfundAmount: 2_500,
      taxTotal: 20_000,
      taxableBase: 100_000,
      total: 120_000,
      lines: [
        {
          id: 'gra-item',
          lineDiscount: 0,
          taxableBase: 100_000,
          vatAmount: 15_000,
          nhilAmount: 2_500,
          getfundAmount: 2_500,
          lineTotal: 120_000,
          inputTaxCreditable: true,
        },
      ],
    },
  },
  {
    name: 'gra-inclusive-single-standard-line',
    provenance: 'gra',
    note:
      'The same five figures read backwards, which is the mode the schema defaults to and the one ' +
      'GRA illustrates only in words. A shelf price of 1,200 contains a value of supply of 1,000. ' +
      'One published example testing both directions is fortunate, because GRA publishes no ' +
      'inclusive illustration.',
    settings: INCLUSIVE,
    lines: [{ id: 'gra-item', quantity: 1, unitPricePesewas: 120_000, vatTreatment: 'standard' }],
    discountPesewas: 0,
    discountReason: null,
    expected: {
      subtotal: 120_000,
      discount: 0,
      vatAmount: 15_000,
      nhilAmount: 2_500,
      getfundAmount: 2_500,
      taxTotal: 20_000,
      taxableBase: 100_000,
      total: 120_000,
      lines: [
        {
          id: 'gra-item',
          lineDiscount: 0,
          taxableBase: 100_000,
          vatAmount: 15_000,
          nhilAmount: 2_500,
          getfundAmount: 2_500,
          lineTotal: 120_000,
          inputTaxCreditable: true,
        },
      ],
    },
  },
  {
    name: 'exempt-line-charges-nothing',
    provenance: 'derived-from-gra',
    note:
      'GRA: "Supplies exempted from VAT are also exempted from NHIL and GetFund Levy." The shelf ' +
      'price is the whole amount, and no input tax is recoverable behind it. This is the treatment ' +
      'the schema defaults every product to, so it is the path most A&B lines will take.',
    settings: INCLUSIVE,
    lines: [{ id: 'amoxicillin', quantity: 2, unitPricePesewas: 2_500, vatTreatment: 'exempt' }],
    discountPesewas: 0,
    discountReason: null,
    expected: {
      subtotal: 5_000,
      discount: 0,
      vatAmount: 0,
      nhilAmount: 0,
      getfundAmount: 0,
      taxTotal: 0,
      taxableBase: 5_000,
      total: 5_000,
      lines: [
        {
          id: 'amoxicillin',
          lineDiscount: 0,
          taxableBase: 5_000,
          vatAmount: 0,
          nhilAmount: 0,
          getfundAmount: 0,
          lineTotal: 5_000,
          inputTaxCreditable: false,
        },
      ],
    },
  },
  {
    name: 'zero-rated-charges-nothing-but-keeps-the-input-credit',
    provenance: 'derived-from-gra',
    note:
      'GRA: "Items that attract a zero (0%) rate of VAT also attract a zero rate of GETFund and the ' +
      'NHIL." Every figure is the same as the exempt vector above, and that is the point — the only ' +
      'difference is recoverability, which is what separates the two boxes on a VAT return. A report ' +
      'that reads a zero tax total and concludes "exempt" would lose A&B the input credit.',
    settings: INCLUSIVE,
    lines: [{ id: 'sanitary-towel', quantity: 2, unitPricePesewas: 2_500, vatTreatment: 'zero_rated' }],
    discountPesewas: 0,
    discountReason: null,
    expected: {
      subtotal: 5_000,
      discount: 0,
      vatAmount: 0,
      nhilAmount: 0,
      getfundAmount: 0,
      taxTotal: 0,
      taxableBase: 5_000,
      total: 5_000,
      lines: [
        {
          id: 'sanitary-towel',
          lineDiscount: 0,
          taxableBase: 5_000,
          vatAmount: 0,
          nhilAmount: 0,
          getfundAmount: 0,
          lineTotal: 5_000,
          inputTaxCreditable: true,
        },
      ],
    },
  },
  {
    name: 'mixed-treatments-one-basket',
    provenance: 'hand-computed',
    note:
      'The basket that makes per-line taxation non-optional: an exempt medicine, a standard-rated ' +
      'toiletry and a zero-rated line in one sale. There is no single taxable value for this basket, ' +
      'and computing one would charge VAT on the medicine or lose it on the shampoo. Note the ' +
      'standard line is consistent both ways — 875 is 15% of 5,833 as well as the inclusive fraction ' +
      'of 7,000 — which is not true of every amount.',
    settings: INCLUSIVE,
    lines: [
      { id: 'amoxicillin', quantity: 1, unitPricePesewas: 4_800, vatTreatment: 'exempt' },
      { id: 'shampoo', quantity: 2, unitPricePesewas: 3_500, vatTreatment: 'standard' },
      { id: 'ors-sachet', quantity: 3, unitPricePesewas: 1_200, vatTreatment: 'zero_rated' },
    ],
    discountPesewas: 0,
    discountReason: null,
    expected: {
      subtotal: 15_400,
      discount: 0,
      vatAmount: 875,
      nhilAmount: 146,
      getfundAmount: 146,
      taxTotal: 1_167,
      taxableBase: 14_233,
      total: 15_400,
      lines: [
        {
          id: 'amoxicillin',
          lineDiscount: 0,
          taxableBase: 4_800,
          vatAmount: 0,
          nhilAmount: 0,
          getfundAmount: 0,
          lineTotal: 4_800,
          inputTaxCreditable: false,
        },
        {
          id: 'shampoo',
          lineDiscount: 0,
          taxableBase: 5_833,
          vatAmount: 875,
          nhilAmount: 146,
          getfundAmount: 146,
          lineTotal: 7_000,
          inputTaxCreditable: true,
        },
        {
          id: 'ors-sachet',
          lineDiscount: 0,
          taxableBase: 3_600,
          vatAmount: 0,
          nhilAmount: 0,
          getfundAmount: 0,
          lineTotal: 3_600,
          inputTaxCreditable: true,
        },
      ],
    },
  },
  {
    name: 'discount-drift-lands-on-the-largest-line',
    provenance: 'hand-computed',
    note:
      'A one-cedi discount across 10.50, 10.50 and 30.00. Flooring the shares gives 20, 20 and 58 — ' +
      '98 of the 100 pesewas — and the two left over go to the 30.00 line, which is the largest and ' +
      'has room for them. The third line also lands exactly on a half at 367.5 VAT and rounds up, so ' +
      'this vector pins the rounding rule inside a realistic basket as well as the apportionment.',
    settings: INCLUSIVE,
    lines: [
      { id: 'a', quantity: 1, unitPricePesewas: 1_050, vatTreatment: 'standard' },
      { id: 'b', quantity: 1, unitPricePesewas: 1_050, vatTreatment: 'standard' },
      { id: 'c', quantity: 1, unitPricePesewas: 3_000, vatTreatment: 'standard' },
    ],
    discountPesewas: 100,
    discountReason: 'loyalty',
    expected: {
      subtotal: 5_100,
      discount: 100,
      vatAmount: 626,
      nhilAmount: 103,
      getfundAmount: 103,
      taxTotal: 832,
      taxableBase: 4_168,
      total: 5_000,
      lines: [
        {
          id: 'a',
          lineDiscount: 20,
          taxableBase: 859,
          vatAmount: 129,
          nhilAmount: 21,
          getfundAmount: 21,
          lineTotal: 1_030,
          inputTaxCreditable: true,
        },
        {
          id: 'b',
          lineDiscount: 20,
          taxableBase: 859,
          vatAmount: 129,
          nhilAmount: 21,
          getfundAmount: 21,
          lineTotal: 1_030,
          inputTaxCreditable: true,
        },
        {
          id: 'c',
          lineDiscount: 60,
          taxableBase: 2_450,
          vatAmount: 368,
          nhilAmount: 61,
          getfundAmount: 61,
          lineTotal: 2_940,
          inputTaxCreditable: true,
        },
      ],
    },
  },
  {
    name: 'discount-drift-overflows-the-largest-line',
    provenance: 'hand-computed',
    note:
      'Three one-pesewa lines with a two-pesewa discount. Flooring gives every line zero, so the ' +
      'whole discount is drift and the largest line is one pesewa wide — it cannot absorb it without ' +
      'its own discount exceeding its own value and its taxable base going negative. The remainder ' +
      'moves to the next largest. Two lines end up free and one is charged, and no line is negative.',
    settings: INCLUSIVE,
    lines: [
      { id: 'a', quantity: 1, unitPricePesewas: 1, vatTreatment: 'standard' },
      { id: 'b', quantity: 1, unitPricePesewas: 1, vatTreatment: 'standard' },
      { id: 'c', quantity: 1, unitPricePesewas: 1, vatTreatment: 'standard' },
    ],
    discountPesewas: 2,
    discountReason: 'rounding test',
    expected: {
      subtotal: 3,
      discount: 2,
      vatAmount: 0,
      nhilAmount: 0,
      getfundAmount: 0,
      taxTotal: 0,
      taxableBase: 1,
      total: 1,
      lines: [
        {
          id: 'a',
          lineDiscount: 1,
          taxableBase: 0,
          vatAmount: 0,
          nhilAmount: 0,
          getfundAmount: 0,
          lineTotal: 0,
          inputTaxCreditable: true,
        },
        {
          id: 'b',
          lineDiscount: 1,
          taxableBase: 0,
          vatAmount: 0,
          nhilAmount: 0,
          getfundAmount: 0,
          lineTotal: 0,
          inputTaxCreditable: true,
        },
        {
          id: 'c',
          lineDiscount: 0,
          taxableBase: 1,
          vatAmount: 0,
          nhilAmount: 0,
          getfundAmount: 0,
          lineTotal: 1,
          inputTaxCreditable: true,
        },
      ],
    },
  },
  {
    name: 'unregistered-pharmacy-charges-nothing',
    provenance: 'hand-computed',
    note:
      'Act 1151 raised the registration threshold for goods from GHS 200,000 to GHS 750,000, which ' +
      'puts a small community pharmacy on either side of it. All three rates at zero is what that ' +
      'looks like as a setting, and a standard-rated product still charges nothing. Whether A&B ' +
      'Chemist is registered is a fact about A&B Chemist, so it is configuration and this is the ' +
      'tested configuration for one answer to it.',
    settings: UNREGISTERED,
    lines: [{ id: 'shampoo', quantity: 1, unitPricePesewas: 3_500, vatTreatment: 'standard' }],
    discountPesewas: 0,
    discountReason: null,
    expected: {
      subtotal: 3_500,
      discount: 0,
      vatAmount: 0,
      nhilAmount: 0,
      getfundAmount: 0,
      taxTotal: 0,
      taxableBase: 3_500,
      total: 3_500,
      lines: [
        {
          id: 'shampoo',
          lineDiscount: 0,
          taxableBase: 3_500,
          vatAmount: 0,
          nhilAmount: 0,
          getfundAmount: 0,
          lineTotal: 3_500,
          inputTaxCreditable: true,
        },
      ],
    },
  },
  {
    name: 'exclusive-basket-with-a-discount',
    provenance: 'hand-computed',
    note:
      'Tax added on top rather than extracted, with a discount that leaves one pesewa of drift. The ' +
      'exempt line takes its share of the discount and still contributes no tax, so the basket total ' +
      'is subtotal less discount plus tax — a different identity from the inclusive mode, and the one ' +
      'a caller is most likely to apply to the wrong mode.',
    settings: EXCLUSIVE,
    lines: [
      { id: 'a', quantity: 2, unitPricePesewas: 5_000, vatTreatment: 'standard' },
      { id: 'b', quantity: 1, unitPricePesewas: 2_500, vatTreatment: 'exempt' },
    ],
    discountPesewas: 501,
    discountReason: 'damaged pack',
    expected: {
      subtotal: 12_500,
      discount: 501,
      vatAmount: 1_440,
      nhilAmount: 240,
      getfundAmount: 240,
      taxTotal: 1_920,
      taxableBase: 11_999,
      total: 13_919,
      lines: [
        {
          id: 'a',
          lineDiscount: 401,
          taxableBase: 9_599,
          vatAmount: 1_440,
          nhilAmount: 240,
          getfundAmount: 240,
          lineTotal: 11_519,
          inputTaxCreditable: true,
        },
        {
          id: 'b',
          lineDiscount: 100,
          taxableBase: 2_400,
          vatAmount: 0,
          nhilAmount: 0,
          getfundAmount: 0,
          lineTotal: 2_400,
          inputTaxCreditable: false,
        },
      ],
    },
  },
  {
    name: 'half-up-decides-vat-exclusive',
    provenance: 'hand-computed',
    note:
      'GRA publishes no rounding rule, so this vector pins ours and nothing else. 30 pesewas at 15% ' +
      'is exactly 4.5, and half-up returns 5 where half-to-even would return 4 — the smallest ' +
      'exclusive amount at which the two rules disagree. Changing the rule turns this red, which is ' +
      'the point: the rule is a decision, and a decision that can be changed silently is not a ' +
      'decision anybody is making.',
    settings: EXCLUSIVE,
    lines: [{ id: 'tiny', quantity: 1, unitPricePesewas: 30, vatTreatment: 'standard' }],
    discountPesewas: 0,
    discountReason: null,
    expected: {
      subtotal: 30,
      discount: 0,
      vatAmount: 5,
      nhilAmount: 1,
      getfundAmount: 1,
      taxTotal: 7,
      taxableBase: 30,
      total: 37,
      lines: [
        {
          id: 'tiny',
          lineDiscount: 0,
          taxableBase: 30,
          vatAmount: 5,
          nhilAmount: 1,
          getfundAmount: 1,
          lineTotal: 37,
          inputTaxCreditable: true,
        },
      ],
    },
  },
  {
    name: 'half-up-decides-vat-inclusive',
    provenance: 'hand-computed',
    note:
      'The same rule from the other direction. A gross of 20 pesewas divides by 8 to exactly 2.5, ' +
      'where half-up gives 3 and half-to-even gives 2. The base is then the residual 17 rather than ' +
      '18, and base plus tax still equals what the customer paid — the invariant that makes the ' +
      'residual ordering the right choice.',
    settings: INCLUSIVE,
    lines: [{ id: 'tiny', quantity: 1, unitPricePesewas: 20, vatTreatment: 'standard' }],
    discountPesewas: 0,
    discountReason: null,
    expected: {
      subtotal: 20,
      discount: 0,
      vatAmount: 3,
      nhilAmount: 0,
      getfundAmount: 0,
      taxTotal: 3,
      taxableBase: 17,
      total: 20,
      lines: [
        {
          id: 'tiny',
          lineDiscount: 0,
          taxableBase: 17,
          vatAmount: 3,
          nhilAmount: 0,
          getfundAmount: 0,
          lineTotal: 20,
          inputTaxCreditable: true,
        },
      ],
    },
  },
  {
    name: 'realistic-counter-basket',
    provenance: 'hand-computed',
    note:
      'The shape of an actual A&B sale: quantities above one, all three treatments, and a GHS 15 ' +
      'discount with a reason against it. Drift of one pesewa onto the largest line, a levy that ' +
      'rounds up from 155.5625, and every identity holding at both line and basket level.',
    settings: INCLUSIVE,
    lines: [
      { id: 'paracetamol', quantity: 3, unitPricePesewas: 1_500, vatTreatment: 'exempt' },
      { id: 'vitamin-c', quantity: 2, unitPricePesewas: 4_000, vatTreatment: 'standard' },
      { id: 'sanitary-pad', quantity: 4, unitPricePesewas: 2_500, vatTreatment: 'zero_rated' },
    ],
    discountPesewas: 1_500,
    discountReason: 'wholesale customer',
    expected: {
      subtotal: 22_500,
      discount: 1_500,
      vatAmount: 933,
      nhilAmount: 156,
      getfundAmount: 156,
      taxTotal: 1_245,
      taxableBase: 19_755,
      total: 21_000,
      lines: [
        {
          id: 'paracetamol',
          lineDiscount: 300,
          taxableBase: 4_200,
          vatAmount: 0,
          nhilAmount: 0,
          getfundAmount: 0,
          lineTotal: 4_200,
          inputTaxCreditable: false,
        },
        {
          id: 'vitamin-c',
          lineDiscount: 533,
          taxableBase: 6_222,
          vatAmount: 933,
          nhilAmount: 156,
          getfundAmount: 156,
          lineTotal: 7_467,
          inputTaxCreditable: true,
        },
        {
          id: 'sanitary-pad',
          lineDiscount: 667,
          taxableBase: 9_333,
          vatAmount: 0,
          nhilAmount: 0,
          getfundAmount: 0,
          lineTotal: 9_333,
          inputTaxCreditable: true,
        },
      ],
    },
  },
]);
