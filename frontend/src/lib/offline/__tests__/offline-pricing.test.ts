/**
 * The offline pricer's honesty rule, from BRIEF.md §4.5: a total, and no tax
 * split. These are written to fail if a split ever leaks into the offline money —
 * the fabrication the rule exists to prevent.
 */

import { priceBasket, taxSettings } from 'a-and-b-chemist-shared';

import { offlineTotalFromBasket } from '../offline-pricing';

// Exclusive pricing so the engine has to compute a real split: 15% VAT on a
// standard-rated line is non-zero, which is what makes "the offline total carries
// none of it" a meaningful assertion rather than a trivial one on an exempt basket.
const settings = taxSettings({
  taxInclusivePricing: false,
  vatRate: '0.1500',
  nhilRate: '0.0250',
  getfundRate: '0.0250',
});

const basket = priceBasket({
  settings,
  lines: [{ id: 'line-1', quantity: 2, unitPricePesewas: 1000, vatTreatment: 'standard' }],
});

describe('the offline total', () => {
  it('carries the total the shared engine computed, unchanged', () => {
    // Not reimplemented and not rounded again: the same figure the online till
    // would show, because it comes from the same `priceBasket`.
    expect(basket.total).toBe(2400);
    expect(offlineTotalFromBasket(basket).totalPesewas).toBe(basket.total);
  });

  it('represents the tax split as null even though the engine computed a real one', () => {
    // The engine did the arithmetic — this is the split the offline total refuses
    // to carry, because the split of record is the server's, made when it writes
    // the sale. Null, and never the engine's 300 pesewas of VAT.
    expect(basket.vatAmount).toBe(300);
    expect(offlineTotalFromBasket(basket).taxSplit).toBeNull();
  });

  it('holds only a total and a null split — no tax field can ride along', () => {
    // The shape is the guarantee. A `vatAmount: 0` sneaking in here would be the
    // fabrication the rule forbids, dressed as a zero; this fails the moment any
    // tax field is added to `OfflineTotal`.
    expect(Object.keys(offlineTotalFromBasket(basket)).sort()).toEqual([
      'taxSplit',
      'totalPesewas',
    ]);
  });
});
