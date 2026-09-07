/**
 * The till's local pricing.
 *
 * The headline assertions are GRA's own published figures, arrived at through this
 * module's path rather than the engine's: a `TaxSettingsView` of the shape the API
 * actually sends, bridged by `taxSettingsFromView`, pricing a basket of till lines.
 * Testing the bridge against numbers somebody else published is what makes it
 * evidence — a bridge tested against figures its author also computed can be wrong
 * in both places at once and still be green.
 *
 * Both directions are covered because A&B is seeded inclusive
 * (`pharmacies.tax_inclusive_pricing` defaults to true and the seed omits the
 * column) while GRA's illustration is worked exclusive. One published example, two
 * configurations, and the one this pharmacy runs is the one GRA never printed.
 */

import * as shared from 'a-and-b-chemist-shared';

import type { TaxSettingsView, TillProduct } from '../api-types';
import {
  basketLineFor,
  basketToRequest,
  cediText,
  lineBaseUnits,
  lineUnitPrice,
  maxQuantityFor,
  moneyText,
  newClientSaleId,
  parseCediInput,
  priceTillBasket,
  taxSettingsFromView,
  unitPricePesewas,
} from '../pricing';
import type { BasketLine } from '../pricing';

function rateView(rate: number): TaxSettingsView['vat'] {
  return { rate, label: shared.rateLabel(rate), decimal: shared.rateDecimalString(rate) };
}

/** Act 1151's rates, as `GET /tax/settings` sends them. */
function act1151View(taxInclusivePricing: boolean): TaxSettingsView {
  return {
    taxInclusivePricing,
    vat: rateView(shared.GRA_RATES.vatRate),
    nhil: rateView(shared.GRA_RATES.nhilRate),
    getfund: rateView(shared.GRA_RATES.getfundRate),
    combinedRate: shared.GRA_RATES.vatRate + shared.GRA_RATES.nhilRate + shared.GRA_RATES.getfundRate,
    combinedLabel: '20%',
    matchesAct1151: true,
    act1151: {
      instrument: shared.GRA_INSTRUMENT,
      inForceFrom: shared.GRA_IN_FORCE_FROM,
      source: shared.GRA_SOURCE,
      retrieved: shared.GRA_RETRIEVED,
      vatRate: shared.GRA_RATES.vatRate,
      nhilRate: shared.GRA_RATES.nhilRate,
      getfundRate: shared.GRA_RATES.getfundRate,
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * A strip of ten tablets at GHS 1.20 each, standard-rated.
 *
 * `baseUnitPrice` is per tablet, so a pack is GHS 12.00 — the product whose pack
 * rule is easiest to get wrong by a factor of ten in either direction.
 */
function paracetamol(overrides: Partial<TillProduct> = {}): TillProduct {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Paracetamol 500mg',
    code: 'PARA-500',
    genericName: 'paracetamol',
    category: 'Analgesics',
    manufacturer: 'Kwame Pharma',
    shelfLocation: 'A2',
    barcode: null,
    packSize: 10,
    defaultSellUnit: 'single',
    baseUnitPrice: '1.20',
    vatTreatment: 'standard',
    requiresPrescription: false,
    quantity: 240,
    batchNumber: 'LOT-9',
    expiryDate: '2027-03-31',
    available: 200,
    ...overrides,
  };
}

/** GHS 1,000.00 on one standard-rated line — GRA's illustration as a till basket. */
function graLine(): BasketLine {
  return {
    lineId: 'line-1',
    productId: '22222222-2222-4222-8222-222222222222',
    name: 'GRA illustration item',
    code: 'GRA-1000',
    quantity: 1,
    sellUnit: 'single',
    packSize: 1,
    baseUnitPrice: '1000.00',
    vatTreatment: 'standard',
    requiresPrescription: false,
  };
}

describe('the tax settings bridge', () => {
  it('produces exactly the engine settings for the rates the API reports', () => {
    expect(taxSettingsFromView(act1151View(false))).toEqual(shared.ACT_1151_EXCLUSIVE);
    expect(taxSettingsFromView(act1151View(true))).toEqual(shared.ACT_1151_INCLUSIVE);
  });

  it('reads the decimal spelling, and not the two beside it', () => {
    const view = act1151View(false);
    // Deliberately inconsistent, to pin which of the three spellings is read.
    // `rate` is whole ten-thousandths and `label` is a percentage; neither is what
    // the engine's parser takes, and `decimal` is also what the server prices with.
    const corrupted: TaxSettingsView = {
      ...view,
      vat: { ...view.vat, rate: 9999, label: 'not a rate' },
      nhil: { ...view.nhil, rate: 9999, label: 'nope' },
      getfund: { ...view.getfund, rate: 9999, label: 'nope' },
    };

    expect(taxSettingsFromView(corrupted)).toEqual(shared.ACT_1151_EXCLUSIVE);
  });

  it('would refuse the ten-thousandths spelling, which is why it is not passed', () => {
    // The regression this suite exists to keep fixed. `RateView.rate` and
    // `TaxSettings.vatRate` are *both* whole ten-thousandths, so feeding one to the
    // other's parser looks like a straight pass-through and is actually a rate of
    // 15,000%: `taxSettings()` parses a decimal into ten-thousandths, so its input
    // and output are in different units.
    expect(() =>
      shared.taxSettings({
        taxInclusivePricing: false,
        vatRate: shared.GRA_RATES.vatRate,
        nhilRate: shared.GRA_RATES.nhilRate,
        getfundRate: shared.GRA_RATES.getfundRate,
      })
    ).toThrow(/between 0 and 1/);
  });

  it('does not price with the combined rate', () => {
    const view = act1151View(false);
    // A combined rate is the three added, for display. Pricing with it would
    // collapse a basket holding an exempt medicine and a standard-rated shampoo
    // into one taxable value, which is the way this module could be badly wrong
    // rather than slightly wrong.
    const absurd: TaxSettingsView = { ...view, combinedRate: 9999, combinedLabel: null };
    const priced = priceTillBasket([graLine()], taxSettingsFromView(absurd));

    expect(priced.ok).toBe(true);
    if (!priced.ok) {
      return;
    }
    expect(priced.basket.vatAmount).toBe(shared.GRA_EXAMPLE.vat);
    expect(priced.basket.total).toBe(shared.GRA_EXAMPLE.total);
  });
});

describe('GRA worked example, through the till', () => {
  it('reproduces all five published figures in exclusive mode', () => {
    const priced = priceTillBasket([graLine()], taxSettingsFromView(act1151View(false)));

    expect(priced.ok).toBe(true);
    if (!priced.ok) {
      return;
    }
    const { basket } = priced;
    expect(basket.subtotal).toBe(shared.GRA_EXAMPLE.sellingPrice);
    expect(basket.taxableBase).toBe(shared.GRA_EXAMPLE.sellingPrice);
    expect(basket.nhilAmount).toBe(shared.GRA_EXAMPLE.nhil);
    expect(basket.getfundAmount).toBe(shared.GRA_EXAMPLE.getfund);
    expect(basket.vatAmount).toBe(shared.GRA_EXAMPLE.vat);
    expect(basket.total).toBe(shared.GRA_EXAMPLE.total);
  });

  it('extracts the same five figures from an inclusive shelf price', () => {
    // The configuration A&B actually runs: the label on the box is GHS 1,200 and
    // the tax comes out of it. GRA publishes no inclusive illustration, so this is
    // their example read backwards — total in, value of the supply out.
    const inclusive: BasketLine = { ...graLine(), baseUnitPrice: '1200.00' };
    const priced = priceTillBasket([inclusive], taxSettingsFromView(act1151View(true)));

    expect(priced.ok).toBe(true);
    if (!priced.ok) {
      return;
    }
    const { basket } = priced;
    expect(basket.subtotal).toBe(shared.GRA_EXAMPLE.total);
    expect(basket.vatAmount).toBe(shared.GRA_EXAMPLE.vat);
    expect(basket.nhilAmount).toBe(shared.GRA_EXAMPLE.nhil);
    expect(basket.getfundAmount).toBe(shared.GRA_EXAMPLE.getfund);
    expect(basket.taxableBase).toBe(shared.GRA_EXAMPLE.sellingPrice);
    // The customer pays the shelf price. In inclusive mode the tax is inside it,
    // so a total above the shelf price is the cascade showing up again.
    expect(basket.total).toBe(shared.GRA_EXAMPLE.total);
  });

  it('is not the pre-reform cascade', () => {
    const priced = priceTillBasket([graLine()], taxSettingsFromView(act1151View(false)));

    expect(priced.ok).toBe(true);
    if (!priced.ok) {
      return;
    }
    // GHS 19 wrong in every 1,000, charged to the customer, is what the pre-2026
    // rule produces. Asserting the published total is not enough on its own: the
    // cascade's *vat* figure is the part that looks plausible on a receipt.
    expect(priced.basket.vatAmount).not.toBe(shared.GRA_PRE_REFORM.vat);
    expect(priced.basket.total).not.toBe(shared.GRA_PRE_REFORM.total);
  });

  it('snapshots the rates beside the money, for the receipt', () => {
    const priced = priceTillBasket([graLine()], taxSettingsFromView(act1151View(false)));

    expect(priced.ok).toBe(true);
    if (!priced.ok) {
      return;
    }
    expect(priced.basket.rates).toEqual({
      vatRate: shared.GRA_RATES.vatRate,
      nhilRate: shared.GRA_RATES.nhilRate,
      getfundRate: shared.GRA_RATES.getfundRate,
      taxInclusivePricing: false,
    });
  });
});

describe('the pack rule', () => {
  it('prices a pack at pack_size times the base unit', () => {
    expect(unitPricePesewas('1.20', 10, 'pack')).toBe(1200);
    expect(unitPricePesewas('1.20', 10, 'single')).toBe(120);
  });

  it('converts the quantity in the matching direction', () => {
    const strips = basketLineFor(paracetamol({ defaultSellUnit: 'pack' }), 'l1', 'pack', 2);
    const tablets = basketLineFor(paracetamol(), 'l2', 'single', 3);

    // Two strips of ten is twenty tablets leaving the drawer, and three singles is
    // three. Price and quantity derived from different readings of `pack_size`
    // would still balance on the receipt and still be wrong on the shelf.
    expect(lineBaseUnits(strips)).toBe(20);
    expect(lineBaseUnits(tablets)).toBe(3);
    expect(lineUnitPrice(strips)).toBe(1200);
    expect(lineUnitPrice(tablets)).toBe(120);
  });

  it('prices two strips of ten as twenty tablets, not two', () => {
    const settings = taxSettingsFromView(act1151View(false));
    const line = basketLineFor(paracetamol({ defaultSellUnit: 'pack' }), 'l1', 'pack', 2);
    const priced = priceTillBasket([line], settings);

    expect(priced.ok).toBe(true);
    if (!priced.ok) {
      return;
    }
    // 2 packs × GHS 12.00, exclusive: 2400 + 15% + 2.5% + 2.5%.
    expect(priced.basket.subtotal).toBe(2400);
    expect(priced.basket.vatAmount).toBe(360);
    expect(priced.basket.nhilAmount).toBe(60);
    expect(priced.basket.getfundAmount).toBe(60);
    expect(priced.basket.total).toBe(2880);
  });

  it('returns null for a price it cannot use, rather than throwing', () => {
    // Total, because the product grid calls it for every tile: one corrupt
    // `unit_price` must not take the catalogue down with it.
    expect(unitPricePesewas('not-a-price', 10, 'single')).toBeNull();
    expect(unitPricePesewas('1.234', 10, 'single')).toBeNull();
    expect(unitPricePesewas('-1.20', 10, 'single')).toBeNull();
    expect(unitPricePesewas('1.20', 0, 'pack')).toBeNull();
  });

  it('snapshots the price when the line is added', () => {
    const product = paracetamol();
    const line = basketLineFor(product, 'l1');

    // A grid refresh must not re-price a basket somebody is halfway through
    // ringing. The operator tapped a tile that said GHS 1.20; if the price has
    // moved, `/quote` before the payment modal is what says so in words.
    product.baseUnitPrice = '99.00';
    product.vatTreatment = 'exempt';

    expect(line.baseUnitPrice).toBe('1.20');
    expect(line.vatTreatment).toBe('standard');
    expect(lineUnitPrice(line)).toBe(120);
  });

  it('defaults the selling unit to the product own', () => {
    expect(basketLineFor(paracetamol(), 'l1').sellUnit).toBe('single');
    expect(basketLineFor(paracetamol({ defaultSellUnit: 'pack' }), 'l1').sellUnit).toBe('pack');
  });
});

describe('availability', () => {
  it('gives a maximum when the units match, and says nothing when they do not', () => {
    const product = paracetamol({ defaultSellUnit: 'single', available: 34 });

    expect(maxQuantityFor(product, 'single')).toBe(34);
    // `available` is floored to whole packs, so converting it to another unit
    // gives a lower bound — and a cap built from a lower bound refuses sales the
    // server would accept. Null is the honest answer; `/quote` is the authority.
    expect(maxQuantityFor(product, 'pack')).toBeNull();
  });
});

describe('mixed treatments and discounts', () => {
  const settings = taxSettingsFromView(act1151View(false));

  /** An exempt medicine and a standard-rated shampoo, in one basket. */
  function mixedBasket(): BasketLine[] {
    return [
      { ...graLine(), lineId: 'medicine', baseUnitPrice: '100.00', vatTreatment: 'exempt' },
      { ...graLine(), lineId: 'shampoo', baseUnitPrice: '100.00', vatTreatment: 'standard' },
    ];
  }

  it('taxes each line by its own treatment, not the basket as a whole', () => {
    const priced = priceTillBasket(mixedBasket(), settings);

    expect(priced.ok).toBe(true);
    if (!priced.ok) {
      return;
    }
    const medicine = priced.basket.lines.find((line) => line.id === 'medicine');
    const shampoo = priced.basket.lines.find((line) => line.id === 'shampoo');

    expect(medicine?.vatAmount).toBe(0);
    expect(medicine?.nhilAmount).toBe(0);
    expect(medicine?.getfundAmount).toBe(0);
    // 15%, 2.5% and 2.5% of GHS 100.00 on the shampoo alone.
    expect(shampoo?.vatAmount).toBe(1500);
    expect(shampoo?.nhilAmount).toBe(250);
    expect(shampoo?.getfundAmount).toBe(250);
    expect(priced.basket.vatAmount).toBe(1500);
  });

  it('distinguishes exempt from zero-rated by input tax, not by the amounts', () => {
    const zeroRated: BasketLine = { ...graLine(), vatTreatment: 'zero_rated' };
    const exempt: BasketLine = { ...graLine(), vatTreatment: 'exempt' };

    const first = priceTillBasket([zeroRated], settings);
    const second = priceTillBasket([exempt], settings);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    // Identical numbers, and the only thing that tells them apart on a VAT return
    // is the credit. A report reading `taxTotal === 0` and concluding "exempt"
    // would put zero-rated turnover in the wrong box.
    expect(first.basket.lines[0]?.vatAmount).toBe(second.basket.lines[0]?.vatAmount);
    expect(first.basket.lines[0]?.inputTaxCreditable).toBe(true);
    expect(second.basket.lines[0]?.inputTaxCreditable).toBe(false);
  });

  it('apportions a discount across lines before taxing them', () => {
    const priced = priceTillBasket(mixedBasket(), settings, {
      discountPesewas: 2000,
      discountReason: 'Regular customer',
    });

    expect(priced.ok).toBe(true);
    if (!priced.ok) {
      return;
    }
    // The discount is exactly what was asked for, and the total is the sum of the
    // lines after it — never a discount applied to a tax-inclusive grand total.
    expect(priced.basket.discount).toBe(2000);
    expect(priced.basket.discountReason).toBe('Regular customer');
    expect(priced.basket.subtotal).toBe(20000);
    // GHS 200 less a GHS 20 discount is GHS 180, and only the shampoo's GHS 90
    // carries tax: 15% + 2.5% + 2.5% of 9,000 pesewas is 1,800. The total is not
    // 18,000 plus the discount — the discount came off first and the tax is on
    // what is left of one line only.
    expect(priced.basket.taxTotal).toBe(1800);
    expect(priced.basket.total).toBe(19800);
  });

  it('refuses a discount with no reason, as a value rather than a throw', () => {
    const priced = priceTillBasket(mixedBasket(), settings, { discountPesewas: 500 });

    // `field` is forwarded so the UI can focus the right input. The message is
    // asserted only as a string: it is the engine's prose, and the UI branches on
    // `code` precisely so that a copy edit there cannot change control flow here.
    expect(priced).toEqual({
      ok: false,
      failure: {
        code: 'discount_reason_required',
        message: expect.any(String),
        field: 'discountReason',
      },
    });
  });

  it('refuses a discount larger than the basket', () => {
    const priced = priceTillBasket(mixedBasket(), settings, {
      discountPesewas: 99999,
      discountReason: 'Goodwill',
    });

    expect(priced.ok).toBe(false);
    if (priced.ok) {
      return;
    }
    expect(priced.failure.code).toBe('discount_exceeds_basket');
  });

  it('refuses an empty basket', () => {
    const priced = priceTillBasket([], settings);

    expect(priced.ok).toBe(false);
    if (priced.ok) {
      return;
    }
    expect(priced.failure.code).toBe('basket_has_no_value');
  });

  it('rethrows anything that is not the engine refusing', () => {
    const spy = jest.spyOn(shared, 'priceBasket').mockImplementation(() => {
      throw new Error('a bug, not a refusal');
    });

    try {
      // Swallowing this would leave the till showing a stale total and nothing in
      // the console, which is the worst outcome available: money wrong, silently.
      expect(() => priceTillBasket([graLine()], settings)).toThrow('a bug, not a refusal');
      expect(spy).toHaveBeenCalled();
    } finally {
      // Restored by hand. `clearMocks` in jest.config clears call records but not
      // implementations, so a spy left installed would keep throwing into every
      // later suite in this file — and would do it from a module other tests
      // import, which reads as a bug in them.
      spy.mockRestore();
    }
  });
});

describe('money as text', () => {
  it('groups thousands and always shows two places', () => {
    expect(moneyText(0)).toBe('0.00');
    expect(moneyText(5)).toBe('0.05');
    expect(moneyText(123450)).toBe('1,234.50');
    expect(moneyText(100000000)).toBe('1,000,000.00');
    expect(cediText(123450)).toBe('GHS 1,234.50');
  });

  it('does not depend on the runtime locale data', () => {
    // `Intl.NumberFormat` would answer differently on a build without full ICU,
    // and a receipt that prints differently per device is one nobody can
    // reconcile. This is the assertion that the output is ours.
    expect(cediText(shared.GRA_EXAMPLE.total)).toBe('GHS 1,200.00');
  });
});

describe('an amount typed at the counter', () => {
  it('reads cedis into pesewas', () => {
    expect(parseCediInput('5')).toBe(500);
    expect(parseCediInput('5.5')).toBe(550);
    expect(parseCediInput('5.50')).toBe(550);
    expect(parseCediInput('  12.50  ')).toBe(1250);
    expect(parseCediInput('0')).toBe(0);
  });

  it('answers null for what is not an amount, including mid-keystroke', () => {
    // Runs on every keystroke of the discount field, so `'5.'` and `'-'` are
    // states a person passes through on the way to `'5.50'` and must not flash an
    // error for.
    for (const text of ['', '   ', '5.', '-', '-5', '5.555', 'abc', '1e3', '5,00', '+5', '.5']) {
      expect(parseCediInput(text)).toBeNull();
    }
  });

  it('answers null for an amount too large to store', () => {
    expect(parseCediInput('99999999999.99')).toBeNull();
  });
});

describe('the sale request', () => {
  const lines = [basketLineFor(paracetamol(), 'l1', 'single', 2)];

  it('sends quantities and no prices, because the server derives the money', () => {
    const body = basketToRequest(lines, { clientSaleId: 'client-1' });

    // Exact equality, so a stray `unitPrice` or `vatAmount` key fails. Sending a
    // price would be sending a suggestion the server ignores, and reading the code
    // later would not tell you which side won.
    expect(body).toEqual({
      lines: [
        {
          productId: '11111111-1111-4111-8111-111111111111',
          quantity: 2,
          sellUnit: 'single',
        },
      ],
      clientSaleId: 'client-1',
    });
  });

  it('crosses the pesewas boundary once, on the discount', () => {
    const body = basketToRequest(lines, {
      clientSaleId: 'client-1',
      discountPesewas: 500,
      discountReason: 'Regular customer',
    });

    // 500 pesewas is GHS 5.00. Sent as pesewas it would be a GHS 500 discount on
    // a GHS 2.40 basket, which the server would refuse — and an offline replay
    // would refuse it again, forever, with the sale stuck in the queue.
    expect(body.discount).toBe('5.00');
    expect(body.discountReason).toBe('Regular customer');
  });

  it('omits the discount entirely when there is none', () => {
    const body = basketToRequest(lines, { clientSaleId: 'client-1', discountPesewas: 0 });

    // Not `'0.00'`. A stored zero with no reason reads afterwards as though
    // something was given away; absence is the honest record of "nothing was".
    expect('discount' in body).toBe(false);
    expect('discountReason' in body).toBe(false);
  });

  it('passes through the caller own client sale id', () => {
    // Required and never minted here: the caller generates it once before the
    // first attempt and reuses it on every retry, which is the entire mechanism.
    const id = newClientSaleId();
    expect(basketToRequest(lines, { clientSaleId: id }).clientSaleId).toBe(id);
  });

  it('carries the tenders, patient and approver only when given', () => {
    expect(basketToRequest(lines, { clientSaleId: 'c' }).payments).toBeUndefined();

    const body = basketToRequest(lines, {
      clientSaleId: 'c',
      payments: [{ method: 'momo', amount: '2.40' }],
      approvedBy: 'pharmacist-1',
    });
    expect(body.payments).toEqual([{ method: 'momo', amount: '2.40' }]);
    expect(body.approvedBy).toBe('pharmacist-1');
    expect('patientId' in body).toBe(false);
  });
});

describe('the client sale id', () => {
  it('is a version 4 uuid, and never repeats', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const id = newClientSaleId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it('prefers randomUUID when the browser has it, which jsdom does not', () => {
    // Discovered, not assumed: jsdom implements `crypto.getRandomValues` but not
    // `crypto.randomUUID`, so without this test every other test here exercises the
    // fallback and the primary branch is the untested one. That is the wrong way
    // round, and it is how it stayed unnoticed — a deliberate break to
    // `newClientSaleId` turned twelve tests red through a *different* throw, and
    // two of those tests were masking failures this file should have reported.
    const realCrypto = globalThis.crypto;
    const randomUUID = jest.fn(() => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    const withRandomUUID = {
      randomUUID,
      getRandomValues: (array: Uint8Array) => realCrypto.getRandomValues(array),
    } as unknown as Crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: withRandomUUID,
      configurable: true,
    });

    try {
      expect(newClientSaleId()).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
      // Called, and only once. A `randomUUID` in a try block that also fell through
      // to the manual path would still return the right string and would burn two
      // reads of the entropy pool per sale.
      expect(randomUUID).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true });
    }
  });

  it('still works without randomUUID, which a till on plain http does not have', () => {
    // `crypto.randomUUID` exists only in a secure context. A counter tablet
    // served over http from a router on the pharmacy LAN has `crypto` and
    // `getRandomValues` but no `randomUUID`, and this id is what makes a lost
    // response replayable instead of a second sale — so the fallback is not a
    // nicety, it is the difference between one sale and two.
    const realCrypto = globalThis.crypto;
    // Only `getRandomValues` is offered, and only for the one call this module
    // makes. `as unknown as` rather than `as`: a partial object does not overlap
    // `Crypto` enough for a direct cast to be allowed.
    const withoutRandomUUID = {
      getRandomValues: (array: Uint8Array) => realCrypto.getRandomValues(array),
    } as unknown as Crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: withoutRandomUUID,
      configurable: true,
    });

    try {
      const id = newClientSaleId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(newClientSaleId()).not.toBe(id);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true });
    }
  });

  it('refuses rather than inventing an id with no randomness at all', () => {
    const realCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });

    try {
      // `Math.random` would produce something that looked like an id and collided
      // between the two tills this pharmacy is likely to run. Refusing is louder
      // than a duplicate sale appearing in next month's reconciliation.
      expect(() => newClientSaleId()).toThrow(/no source of randomness/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true });
    }
  });
});
