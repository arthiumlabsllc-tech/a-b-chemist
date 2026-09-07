/**
 * The on-device pricer, against the shared parity vectors.
 *
 * BRIEF.md §4.5 asks for an offline pricer "whose output must match the server
 * engine exactly", verified "with shared parity vectors, not by eye". The vectors
 * live in `a-and-b-chemist-shared`, and `shared/src/__tests__/parity.test.ts`
 * proves the *engine* reproduces them. This suite makes the same claim about the
 * *till*, which is not the same claim: the till never calls the engine directly.
 * It gets there through two bridges of its own —
 *
 *  - `taxSettingsFromView`, from the rates `GET /tax/settings` sends (a
 *    ten-thousandths number with a decimal *string* spelled beside it) to the
 *    engine's `TaxSettings`;
 *  - `priceTillBasket`'s line mapping, from a `BasketLine`'s `baseUnitPrice` —
 *    also a decimal string, because `pg` hands `numeric` back as one — through
 *    `pesewasFromDecimalString` and the pack rule to the engine's
 *    `unitPricePesewas`.
 *
 * Both are string-to-integer conversions on money. A rounding or truncation fault
 * in either changes what a customer is charged during an outage without changing
 * anything the engine does, so the engine's own suite cannot see it: it never
 * handles a decimal string. This is the suite that can.
 *
 * The assertions below are therefore `parity.test.ts`'s, field for field, over the
 * same twelve vectors read from the same module — with every number routed through
 * the till on the way there. One array, two consumers, no second copy to drift.
 */

import {
  GRA_IN_FORCE_FROM,
  GRA_INSTRUMENT,
  GRA_RATES,
  GRA_RETRIEVED,
  GRA_SOURCE,
  TAX_PARITY_VECTORS,
  decimalStringFromPesewas,
  rateDecimalString,
  rateLabel,
  type PricedBasket,
  type TaxParityVector,
} from 'a-and-b-chemist-shared';

import type { TaxSettingsView } from '../api-types';
import { offlineTotalFromBasket } from '../offline/offline-pricing';
import { priceTillBasket, taxSettingsFromView } from '../pricing';
import type { BasketLine } from '../pricing';

function rateView(rate: number): TaxSettingsView['vat'] {
  return { rate, label: rateLabel(rate), decimal: rateDecimalString(rate) };
}

/**
 * The API's settings shape, built from a vector's engine settings.
 *
 * Built rather than borrowed from `pricing.test.ts`'s `act1151View`, because that
 * one hardcodes GRA's rates and one of the twelve vectors is a pharmacy below the
 * registration threshold with all three at zero. Feeding it Act 1151's rates would
 * silently test eight vectors twice and never test the unregistered one — which is
 * the configuration A&B might actually be in.
 */
function viewFor(vector: TaxParityVector): TaxSettingsView {
  const { vatRate, nhilRate, getfundRate, taxInclusivePricing } = vector.settings;
  const combinedRate = vatRate + nhilRate + getfundRate;

  return {
    taxInclusivePricing,
    vat: rateView(vatRate),
    nhil: rateView(nhilRate),
    getfund: rateView(getfundRate),
    combinedRate,
    combinedLabel: rateLabel(combinedRate),
    // Computed from the rates rather than written as `true`: the field means "these
    // are GRA's", and a fixture that asserted it for the all-zero vector would be a
    // false value in the one suite whose whole job is catching false values.
    matchesAct1151:
      vatRate === GRA_RATES.vatRate &&
      nhilRate === GRA_RATES.nhilRate &&
      getfundRate === GRA_RATES.getfundRate,
    act1151: {
      instrument: GRA_INSTRUMENT,
      inForceFrom: GRA_IN_FORCE_FROM,
      source: GRA_SOURCE,
      retrieved: GRA_RETRIEVED,
      vatRate: GRA_RATES.vatRate,
      nhilRate: GRA_RATES.nhilRate,
      getfundRate: GRA_RATES.getfundRate,
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * A vector's engine lines as till lines.
 *
 * One base unit per selling unit, which makes the pack rule the identity and leaves
 * the decimal-string round trip as the only thing between the vector's
 * `unitPricePesewas` and the engine's. That is deliberate: a pack size above one
 * would put two conversions in the path at once, and a failure would not say which
 * one moved the money. The pack rule has its own tests in `pricing.test.ts`.
 */
function tillLines(vector: TaxParityVector): BasketLine[] {
  return vector.lines.map((line, position) => ({
    lineId: line.id,
    productId: `product-${position}`,
    name: `Parity vector ${vector.name}, line ${position}`,
    code: `VEC-${position}`,
    quantity: line.quantity,
    sellUnit: 'single' as const,
    packSize: 1,
    baseUnitPrice: decimalStringFromPesewas(line.unitPricePesewas),
    vatTreatment: line.vatTreatment,
    requiresPrescription: false,
  }));
}

/**
 * The eight fields a vector pins, projected out of a priced line.
 *
 * The same projection `parity.test.ts` uses, for the same reason: `PricedLine`
 * carries four more fields the vectors deliberately do not repeat, and those are
 * asserted against the vector's own inputs below instead.
 */
function project(basket: PricedBasket) {
  return basket.lines.map((line) => ({
    id: line.id,
    lineDiscount: line.lineDiscount,
    taxableBase: line.taxableBase,
    vatAmount: line.vatAmount,
    nhilAmount: line.nhilAmount,
    getfundAmount: line.getfundAmount,
    lineTotal: line.lineTotal,
    inputTaxCreditable: line.inputTaxCreditable,
  }));
}

describe('the settings bridge', () => {
  it('gives the engine exactly the settings every vector pinned', () => {
    // The bridge takes `view.vat.decimal`, a string. Were it to take `view.vat.rate`
    // instead — the same figure in ten-thousandths — every rate would arrive a
    // factor of ten thousand out and the totals below would be wrong by far more
    // than a rounding. All twelve are checked rather than one, because eight of
    // them share Act 1151's rates and the unregistered vector has all three at
    // zero, where the two spellings are indistinguishable and a fault would hide.
    for (const vector of TAX_PARITY_VECTORS) {
      expect(taxSettingsFromView(viewFor(vector))).toEqual(vector.settings);
    }
  });
});

describe('the till reproduces every parity vector', () => {
  for (const vector of TAX_PARITY_VECTORS) {
    // One test per vector rather than one loop over all of them, so a failure names
    // the basket instead of pointing at a line number in a sweep.
    it(vector.name, () => {
      const priced = priceTillBasket(tillLines(vector), taxSettingsFromView(viewFor(vector)), {
        discountPesewas: vector.discountPesewas,
        discountReason: vector.discountReason,
      });

      // A refusal here would be the till's error-as-value wrapper turning a valid
      // basket into something the operator cannot fix — which offline, with no
      // server to contradict it, is a sale that simply cannot be rung up.
      expect(priced.ok).toBe(true);
      if (!priced.ok) return;

      const basket = priced.basket;
      const { expected } = vector;

      expect(basket.subtotal).toBe(expected.subtotal);
      expect(basket.discount).toBe(expected.discount);
      expect(basket.discountReason).toBe(vector.discountReason);
      expect(basket.vatAmount).toBe(expected.vatAmount);
      expect(basket.nhilAmount).toBe(expected.nhilAmount);
      expect(basket.getfundAmount).toBe(expected.getfundAmount);
      expect(basket.taxTotal).toBe(expected.taxTotal);
      expect(basket.taxableBase).toBe(expected.taxableBase);
      expect(basket.total).toBe(expected.total);
      expect(project(basket)).toEqual(expected.lines);

      // The four fields no vector pins. `unitPricePesewas` is the one that matters
      // most here: it is the figure that came back out of the decimal string, so
      // this is the round trip stated directly rather than inferred from a total
      // that happened to land.
      expect(basket.lines.map((line) => line.unitPricePesewas)).toEqual(
        vector.lines.map((line) => line.unitPricePesewas)
      );
      expect(basket.lines.map((line) => line.vatTreatment)).toEqual(
        vector.lines.map((line) => line.vatTreatment)
      );
      expect(basket.lines.map((line) => line.quantity)).toEqual(
        vector.lines.map((line) => line.quantity)
      );
      expect(basket.lines.map((line) => line.lineGross)).toEqual(
        vector.lines.map((line) => line.quantity * line.unitPricePesewas)
      );

      // The rates the receipt will print, snapshotted beside the money — reached
      // through the view bridge, so this is that bridge's output pinned end to end.
      expect(basket.rates).toEqual({
        vatRate: vector.settings.vatRate,
        nhilRate: vector.settings.nhilRate,
        getfundRate: vector.settings.getfundRate,
        taxInclusivePricing: vector.settings.taxInclusivePricing,
      });
    });
  }
});

describe('what the offline total does with the same vectors', () => {
  it('carries every vector total and none of any vector split', () => {
    // `offline-pricing.ts` has its own suite on one hand-built basket. Run over all
    // twelve, this is the check that BRIEF.md §4.5's "never fabricate a tax split"
    // holds for a basket whose split is genuinely non-zero — eight of the vectors
    // have one — and not only for the exempt case where a split of zeros would have
    // looked identical to no split at all.
    for (const vector of TAX_PARITY_VECTORS) {
      const priced = priceTillBasket(tillLines(vector), taxSettingsFromView(viewFor(vector)), {
        discountPesewas: vector.discountPesewas,
        discountReason: vector.discountReason,
      });
      if (!priced.ok) throw new Error(`${vector.name}: ${priced.failure.code}`);

      const offline = offlineTotalFromBasket(priced.basket);
      expect(offline.totalPesewas).toBe(vector.expected.total);
      expect(offline.taxSplit).toBeNull();
      expect(Object.keys(offline).sort()).toEqual(['taxSplit', 'totalPesewas']);
    }
  });
});
