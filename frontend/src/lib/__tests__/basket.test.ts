/**
 * The basket reducer, driven through every transition.
 *
 * The reducer is pure and holds no money, so the interesting assertions are about
 * identity and stock, not arithmetic — `pricing.test.ts` already covers the
 * arithmetic on the lines this produces. What has to be right here:
 *
 *  - a re-tap increments rather than duplicating, and the key that makes a pack
 *    line and a single line of the same product *two* lines is the same key that
 *    makes a second tap of one tile *one* line;
 *  - the stock cap is applied exactly when `maxQuantityFor` can state it, and not
 *    when converting a floored pack figure would be a guess;
 *  - changing a unit onto a unit already in the basket merges instead of leaving
 *    two lines with the same key;
 *  - nothing mutates the state it was handed, because `useReducer` compares by
 *    reference and a mutation would either lose an update or re-render forever.
 */

import {
  EMPTY_BASKET,
  basketIsEmpty,
  basketLineCount,
  basketReducer,
  lineIdFor,
} from '../basket';
import type { BasketState } from '../basket';
import type { TillProduct } from '../api-types';

function product(overrides: Partial<TillProduct> = {}): TillProduct {
  return {
    id: 'p1',
    name: 'Paracetamol 500mg',
    code: 'PARA-500',
    genericName: 'paracetamol',
    category: 'Analgesic',
    manufacturer: 'Lab',
    shelfLocation: 'A1',
    barcode: null,
    packSize: 10,
    defaultSellUnit: 'pack',
    baseUnitPrice: '0.50',
    vatTreatment: 'exempt',
    requiresPrescription: false,
    quantity: 100,
    batchNumber: 'B1',
    expiryDate: '2027-01-01',
    available: 8,
    ...overrides,
  };
}

function linesOf(state: BasketState): Array<{ lineId: string; quantity: number; sellUnit: string }> {
  return state.lines.map((line) => ({
    lineId: line.lineId,
    quantity: line.quantity,
    sellUnit: line.sellUnit,
  }));
}

describe('adding to the basket', () => {
  it('adds a line at quantity one, keyed by product and unit', () => {
    const next = basketReducer(EMPTY_BASKET, { type: 'add', product: product() });
    expect(linesOf(next)).toEqual([{ lineId: 'p1:pack', quantity: 1, sellUnit: 'pack' }]);
  });

  it('snapshots the pricing fields off the product, not a reference to it', () => {
    const next = basketReducer(EMPTY_BASKET, { type: 'add', product: product() });
    const line = next.lines[0];
    expect({
      name: line?.name,
      code: line?.code,
      packSize: line?.packSize,
      baseUnitPrice: line?.baseUnitPrice,
      vatTreatment: line?.vatTreatment,
      requiresPrescription: line?.requiresPrescription,
    }).toEqual({
      name: 'Paracetamol 500mg',
      code: 'PARA-500',
      packSize: 10,
      baseUnitPrice: '0.50',
      vatTreatment: 'exempt',
      requiresPrescription: false,
    });
  });

  it('increments the line already there on a second tap', () => {
    let state = basketReducer(EMPTY_BASKET, { type: 'add', product: product() });
    state = basketReducer(state, { type: 'add', product: product() });
    expect(linesOf(state)).toEqual([{ lineId: 'p1:pack', quantity: 2, sellUnit: 'pack' }]);
  });

  it('keeps a pack line and a single line of one product apart', () => {
    let state = basketReducer(EMPTY_BASKET, { type: 'add', product: product() });
    state = basketReducer(state, { type: 'add', product: product(), sellUnit: 'single' });
    expect(linesOf(state)).toEqual([
      { lineId: 'p1:pack', quantity: 1, sellUnit: 'pack' },
      { lineId: 'p1:single', quantity: 1, sellUnit: 'single' },
    ]);
  });

  it('stops at the available figure when the unit is the product default', () => {
    const two = product({ available: 2 });
    let state = basketReducer(EMPTY_BASKET, { type: 'add', product: two });
    state = basketReducer(state, { type: 'add', product: two });
    state = basketReducer(state, { type: 'add', product: two });
    // The third tap is at the ceiling and returns the state unchanged.
    expect(linesOf(state)).toEqual([{ lineId: 'p1:pack', quantity: 2, sellUnit: 'pack' }]);
  });

  it('does not add a product it knows cannot be filled', () => {
    const none = product({ available: 0 });
    const state = basketReducer(EMPTY_BASKET, { type: 'add', product: none });
    expect(basketIsEmpty(state)).toBe(true);
  });

  it('leaves a non-default unit uncapped, because the till cannot state its ceiling', () => {
    // `available` counts default-unit (pack) figures, floored to whole packs. A
    // single-unit line derived from it would be a guess, so `maxQuantityFor`
    // returns null and the stepper is unbounded — `/quote` reports any shortfall.
    const two = product({ available: 2 });
    let state = basketReducer(EMPTY_BASKET, { type: 'add', product: two, sellUnit: 'single' });
    state = basketReducer(state, { type: 'add', product: two, sellUnit: 'single' });
    state = basketReducer(state, { type: 'add', product: two, sellUnit: 'single' });
    expect(linesOf(state)).toEqual([{ lineId: 'p1:single', quantity: 3, sellUnit: 'single' }]);
  });
});

describe('setting a quantity', () => {
  const withOne = basketReducer(EMPTY_BASKET, { type: 'add', product: product() });

  it('changes the quantity of the named line', () => {
    const state = basketReducer(withOne, { type: 'set-quantity', lineId: 'p1:pack', quantity: 5 });
    expect(linesOf(state)).toEqual([{ lineId: 'p1:pack', quantity: 5, sellUnit: 'pack' }]);
  });

  it('treats a quantity below one as a removal', () => {
    const state = basketReducer(withOne, { type: 'set-quantity', lineId: 'p1:pack', quantity: 0 });
    expect(basketIsEmpty(state)).toBe(true);
  });

  it('ignores a line that is not in the basket', () => {
    const state = basketReducer(withOne, { type: 'set-quantity', lineId: 'nope:pack', quantity: 5 });
    expect(linesOf(state)).toEqual([{ lineId: 'p1:pack', quantity: 1, sellUnit: 'pack' }]);
  });
});

describe('changing a selling unit', () => {
  it('re-keys the line when the new unit is not already in the basket', () => {
    const withOne = basketReducer(EMPTY_BASKET, { type: 'add', product: product() });
    const state = basketReducer(withOne, { type: 'set-sell-unit', lineId: 'p1:pack', sellUnit: 'single' });
    expect(linesOf(state)).toEqual([{ lineId: 'p1:single', quantity: 1, sellUnit: 'single' }]);
  });

  it('merges into the line already on that unit rather than leaving a duplicate key', () => {
    let state = basketReducer(EMPTY_BASKET, { type: 'add', product: product() });
    state = basketReducer(state, { type: 'set-quantity', lineId: 'p1:pack', quantity: 2 });
    state = basketReducer(state, { type: 'add', product: product(), sellUnit: 'single' });
    state = basketReducer(state, { type: 'set-quantity', lineId: 'p1:single', quantity: 3 });

    state = basketReducer(state, { type: 'set-sell-unit', lineId: 'p1:pack', sellUnit: 'single' });

    // The pack line is gone and its two are folded into the single line's three.
    expect(linesOf(state)).toEqual([{ lineId: 'p1:single', quantity: 5, sellUnit: 'single' }]);
  });

  it('does nothing when the line is already on that unit', () => {
    const withOne = basketReducer(EMPTY_BASKET, { type: 'add', product: product() });
    const state = basketReducer(withOne, { type: 'set-sell-unit', lineId: 'p1:pack', sellUnit: 'pack' });
    expect(state).toBe(withOne);
  });
});

describe('removing and clearing', () => {
  it('removes the named line and leaves the rest', () => {
    let state = basketReducer(EMPTY_BASKET, { type: 'add', product: product() });
    state = basketReducer(state, { type: 'add', product: product({ id: 'p2' }), sellUnit: 'pack' });
    state = basketReducer(state, { type: 'remove', lineId: 'p1:pack' });
    expect(state.lines.map((line) => line.lineId)).toEqual(['p2:pack']);
  });

  it('clears back to the empty basket', () => {
    let state = basketReducer(EMPTY_BASKET, { type: 'add', product: product() });
    state = basketReducer(state, { type: 'set-discount', pesewas: 500, reason: 'goodwill' });
    state = basketReducer(state, { type: 'clear' });
    expect(state).toEqual(EMPTY_BASKET);
  });
});

describe('the discount', () => {
  it('stores the pesewas and the reason', () => {
    const state = basketReducer(EMPTY_BASKET, {
      type: 'set-discount',
      pesewas: 1250,
      reason: 'regular customer',
    });
    expect({ pesewas: state.discountPesewas, reason: state.discountReason }).toEqual({
      pesewas: 1250,
      reason: 'regular customer',
    });
  });

  it('clamps a negative discount to zero rather than recording a surcharge', () => {
    const state = basketReducer(EMPTY_BASKET, { type: 'set-discount', pesewas: -500, reason: 'x' });
    expect(state.discountPesewas).toBe(0);
  });
});

describe('the derived counts', () => {
  it('counts selling units across every line', () => {
    let state = basketReducer(EMPTY_BASKET, { type: 'add', product: product() });
    state = basketReducer(state, { type: 'set-quantity', lineId: 'p1:pack', quantity: 3 });
    state = basketReducer(state, { type: 'add', product: product({ id: 'p2' }) });
    expect(basketLineCount(state)).toBe(4);
  });

  it('reports emptiness by lines, not by discount', () => {
    const discounted = basketReducer(EMPTY_BASKET, {
      type: 'set-discount',
      pesewas: 100,
      reason: 'goodwill',
    });
    expect(basketIsEmpty(discounted)).toBe(true);
  });
});

describe('purity', () => {
  it('does not mutate the state it was given', () => {
    const before = basketReducer(EMPTY_BASKET, { type: 'add', product: product() });
    const snapshot = linesOf(before);
    basketReducer(before, { type: 'add', product: product() });
    basketReducer(before, { type: 'set-quantity', lineId: 'p1:pack', quantity: 9 });
    basketReducer(before, { type: 'remove', lineId: 'p1:pack' });
    // `useReducer` compares by reference; a mutation would corrupt the previous
    // state and, with it, every render that read it.
    expect(linesOf(before)).toEqual(snapshot);
    expect(EMPTY_BASKET.lines).toEqual([]);
  });

  it('returns the same reference when an action changes nothing', () => {
    const withOne = basketReducer(EMPTY_BASKET, { type: 'add', product: product() });
    expect(basketReducer(withOne, { type: 'remove', lineId: 'absent:pack' })).toBe(withOne);
  });
});

describe('the line key', () => {
  it('is the product id and the unit', () => {
    expect(lineIdFor('abc', 'single')).toBe('abc:single');
  });
});
