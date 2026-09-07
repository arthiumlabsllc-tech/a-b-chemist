import {
  type BasketLineInput,
  MAX_LINE_QUANTITY,
  priceBasket,
} from '../basket';
import { isTaxError } from '../errors';
import {
  ACT_1151_EXCLUSIVE,
  ACT_1151_INCLUSIVE,
  GRA_EXAMPLE,
  NOT_VAT_REGISTERED,
} from '../fixtures/gra-worked-example';
import { MAX_AMOUNT_PESEWAS } from '../money';
import type { TaxSettings } from '../tax';

/**
 * Pricing a whole basket.
 *
 * This is the function both consumers call, so it is where the two identities that
 * make a receipt defensible have to hold: every basket figure is the sum of its
 * lines, and what the customer pays is what the lines say they pay. The mode
 * matters — inclusive pricing gives `total = subtotal − discount`, exclusive gives
 * `total = subtotal − discount + tax` — and applying one to the other is a mistake
 * that produces a receipt on which every figure looks plausible.
 *
 * The sweep at the bottom asserts those identities over a few thousand randomly
 * shaped baskets rather than over the dozen examples above, because the examples
 * were chosen by the same person who wrote the engine and share whatever
 * assumption that person had.
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

/** Deterministic pseudo-random, so a failure can be reproduced from its message. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state;
  };
}

/**
 * Indexed access with the undefined removed.
 *
 * `noUncheckedIndexedAccess` is on, and a non-null assertion is banned by the lint
 * config. This makes the narrowing explicit and in one place, and it throws rather
 * than substituting a default — a sweep that quietly priced `undefined` as exempt
 * would be worse than a sweep that stopped.
 */
function pick<T>(items: readonly T[], index: number): T {
  const found = items[index];
  if (found === undefined) {
    throw new Error(`no item at index ${index} of ${items.length}`);
  }
  return found;
}

const ONE_STANDARD: BasketLineInput = {
  id: 'a',
  quantity: 1,
  unitPricePesewas: 1_000,
  vatTreatment: 'standard',
};

describe('priceBasket against GRA\'s worked example', () => {
  it('turns a 1,000 cedi supply into a 1,200 cedi sale, exclusive', () => {
    const basket = priceBasket({
      settings: ACT_1151_EXCLUSIVE,
      lines: [{ id: 'gra-item', quantity: 1, unitPricePesewas: 100_000, vatTreatment: 'standard' }],
    });
    expect(basket.subtotal).toBe(GRA_EXAMPLE.sellingPrice);
    expect(basket.taxableBase).toBe(GRA_EXAMPLE.sellingPrice);
    expect(basket.vatAmount).toBe(GRA_EXAMPLE.vat);
    expect(basket.nhilAmount).toBe(GRA_EXAMPLE.nhil);
    expect(basket.getfundAmount).toBe(GRA_EXAMPLE.getfund);
    expect(basket.taxTotal).toBe(GRA_EXAMPLE.total - GRA_EXAMPLE.sellingPrice);
    expect(basket.total).toBe(GRA_EXAMPLE.total);
    expect(basket.discount).toBe(0);
    expect(basket.discountReason).toBeNull();
  });

  it('finds the same 1,000 cedi supply inside a 1,200 cedi shelf price, inclusive', () => {
    const basket = priceBasket({
      settings: ACT_1151_INCLUSIVE,
      lines: [{ id: 'gra-item', quantity: 1, unitPricePesewas: 120_000, vatTreatment: 'standard' }],
    });
    expect(basket.subtotal).toBe(GRA_EXAMPLE.total);
    expect(basket.taxableBase).toBe(GRA_EXAMPLE.sellingPrice);
    expect(basket.vatAmount).toBe(GRA_EXAMPLE.vat);
    expect(basket.nhilAmount).toBe(GRA_EXAMPLE.nhil);
    expect(basket.getfundAmount).toBe(GRA_EXAMPLE.getfund);
    expect(basket.taxTotal).toBe(GRA_EXAMPLE.total - GRA_EXAMPLE.sellingPrice);
    expect(basket.total).toBe(GRA_EXAMPLE.total);
  });

  it('is what a receipt has to show: three separate lines, named, and their total', () => {
    // GRA requires a computer-generated sales receipt to carry a separate line for
    // NHIL, one for the GETFund levy, one for the VAT, and their total. The basket
    // carries all four as distinct fields rather than one tax figure, which is the
    // structural reason the receipt can be compliant.
    const basket = priceBasket({
      settings: ACT_1151_INCLUSIVE,
      lines: [{ id: 'gra-item', quantity: 1, unitPricePesewas: 120_000, vatTreatment: 'standard' }],
    });
    expect(basket.nhilAmount).not.toBe(basket.vatAmount);
    expect(basket.getfundAmount).toBe(basket.nhilAmount);
    expect(basket.taxTotal).toBe(basket.nhilAmount + basket.getfundAmount + basket.vatAmount);
    expect(basket.taxTotal).toBeGreaterThan(0);
  });
});

describe('priceBasket', () => {
  it('multiplies quantity by unit price, so a box of twelve is one line and not twelve', () => {
    const basket = priceBasket({
      settings: ACT_1151_INCLUSIVE,
      lines: [{ id: 'paracetamol', quantity: 12, unitPricePesewas: 150, vatTreatment: 'exempt' }],
    });
    expect(pick(basket.lines, 0).lineGross).toBe(1_800);
    expect(pick(basket.lines, 0).unitPricePesewas).toBe(150);
    expect(pick(basket.lines, 0).quantity).toBe(12);
    expect(basket.subtotal).toBe(1_800);
  });

  it('taxes each line on its own treatment, which is why there is no basket-level tax step', () => {
    const basket = priceBasket({
      settings: ACT_1151_INCLUSIVE,
      lines: [
        { id: 'amoxicillin', quantity: 1, unitPricePesewas: 4_800, vatTreatment: 'exempt' },
        { id: 'shampoo', quantity: 2, unitPricePesewas: 3_500, vatTreatment: 'standard' },
      ],
    });
    // A basket holding an exempt medicine and a standard-rated toiletry has no
    // single taxable value. Computing one would charge VAT on the medicine or lose
    // it on the shampoo, and there is no way to be right about both.
    expect(pick(basket.lines, 0).vatAmount).toBe(0);
    expect(pick(basket.lines, 0).inputTaxCreditable).toBe(false);
    expect(pick(basket.lines, 1).vatAmount).toBe(875);
    expect(pick(basket.lines, 1).inputTaxCreditable).toBe(true);
    expect(basket.vatAmount).toBe(875);
    expect(basket.taxableBase).toBe(4_800 + 5_833);
  });

  it('charges nothing at all for a pharmacy that is not VAT-registered', () => {
    const basket = priceBasket({
      settings: NOT_VAT_REGISTERED,
      lines: [ONE_STANDARD],
    });
    expect(basket.taxTotal).toBe(0);
    expect(basket.total).toBe(basket.subtotal);
  });

  it('returns the rates it used, so a sale can snapshot them beside the money', () => {
    // A receipt shows the tax actually charged. Snapshotting the rates next to the
    // amounts is what makes that still true six months later, when the settings row
    // has moved on and the only record of what was charged is the sale itself.
    const basket = priceBasket({ settings: ACT_1151_INCLUSIVE, lines: [ONE_STANDARD] });
    expect(basket.rates).toEqual({
      vatRate: 1_500,
      nhilRate: 250,
      getfundRate: 250,
      taxInclusivePricing: true,
    });
    expect(Object.isFrozen(basket.rates)).toBe(true);
  });

  it('returns lines in the order they were given, which is the order a receipt prints', () => {
    const basket = priceBasket({
      settings: ACT_1151_INCLUSIVE,
      lines: [
        { id: 'third', quantity: 1, unitPricePesewas: 300, vatTreatment: 'standard' },
        { id: 'first', quantity: 1, unitPricePesewas: 100, vatTreatment: 'standard' },
        { id: 'second', quantity: 1, unitPricePesewas: 200, vatTreatment: 'standard' },
      ],
    });
    expect(basket.lines.map((line) => line.id)).toEqual(['third', 'first', 'second']);
    // Sorting by value would put the drift on a different line than the receipt
    // shows it, and the two have to agree.
    expect(basket.lines.map((line) => line.lineGross)).toEqual([300, 100, 200]);
  });

  it('freezes what it returns, so a caller cannot adjust a total after pricing it', () => {
    const basket = priceBasket({ settings: ACT_1151_INCLUSIVE, lines: [ONE_STANDARD] });
    expect(Object.isFrozen(basket)).toBe(true);
    expect(Object.isFrozen(basket.lines)).toBe(true);
    expect(Object.isFrozen(pick(basket.lines, 0))).toBe(true);
  });

  it('echoes the treatment that produced each line\'s figures', () => {
    const basket = priceBasket({
      settings: ACT_1151_INCLUSIVE,
      lines: [
        { id: 'a', quantity: 1, unitPricePesewas: 100, vatTreatment: 'exempt' },
        { id: 'b', quantity: 1, unitPricePesewas: 100, vatTreatment: 'zero_rated' },
      ],
    });
    expect(pick(basket.lines, 0).vatTreatment).toBe('exempt');
    expect(pick(basket.lines, 1).vatTreatment).toBe('zero_rated');
  });
});

describe('the discount reason', () => {
  it('is demanded whenever money was taken off', () => {
    // An unexplained discount is the shape of a leak, and it is enforced here rather
    // than in the API because the offline till in Phase 9 prices a sale with no
    // server in reach. A check that lives only behind an HTTP route is a check that
    // does not exist for every sale taken during an outage.
    expect(
      failureOf(() =>
        priceBasket({
          settings: ACT_1151_INCLUSIVE,
          lines: [ONE_STANDARD],
          discountPesewas: 100,
        })
      )
    ).toEqual({
      code: 'discount_reason_required',
      message: 'A discount needs a reason recorded against it',
      field: 'discountReason',
    });
  });

  it('is not satisfied by whitespace, a hyphen or the word null', () => {
    for (const discountReason of ['', '   ', '\t\n']) {
      expect({
        discountReason,
        code: failureOf(() =>
          priceBasket({
            settings: ACT_1151_INCLUSIVE,
            lines: [ONE_STANDARD],
            discountPesewas: 100,
            discountReason,
          })
        ).code,
      }).toEqual({ discountReason, code: 'discount_reason_required' });
    }
  });

  it('is not demanded when nothing was taken off', () => {
    // Asking for one on a zero discount would make the common case into a form the
    // till operator has to satisfy, and a required field everybody fills with "-"
    // teaches everybody that required fields are noise.
    expect(
      priceBasket({
        settings: ACT_1151_INCLUSIVE,
        lines: [ONE_STANDARD],
        discountPesewas: 0,
        discountReason: null,
      }).discountReason
    ).toBeNull();
    expect(priceBasket({ settings: ACT_1151_INCLUSIVE, lines: [ONE_STANDARD] }).discountReason)
      .toBeNull();
  });

  it('drops a reason given against no discount, rather than storing one with nothing beside it', () => {
    const basket = priceBasket({
      settings: ACT_1151_INCLUSIVE,
      lines: [ONE_STANDARD],
      discountReason: 'loyalty card',
    });
    expect(basket.discount).toBe(0);
    expect(basket.discountReason).toBeNull();
  });

  it('is trimmed and stored, and is the only free text the engine accepts', () => {
    const basket = priceBasket({
      settings: ACT_1151_INCLUSIVE,
      lines: [ONE_STANDARD],
      discountPesewas: 100,
      discountReason: '  loyalty card  ',
    });
    expect(basket.discountReason).toBe('loyalty card');
    expect(basket.discount).toBe(100);
  });
});

describe('priceBasket refusals', () => {
  it('refuses an empty basket', () => {
    expect(failureOf(() => priceBasket({ settings: ACT_1151_INCLUSIVE, lines: [] }))).toEqual({
      code: 'basket_has_no_value',
      message: 'There is nothing in the basket',
      field: undefined,
    });
  });

  it('refuses a line with no identifier', () => {
    for (const id of ['', '   ']) {
      expect(
        failureOf(() =>
          priceBasket({
            settings: ACT_1151_INCLUSIVE,
            lines: [{ id, quantity: 1, unitPricePesewas: 100, vatTreatment: 'standard' }],
          })
        )
      ).toEqual({
        code: 'line_out_of_range',
        message: 'line 1 has no identifier',
        field: 'line 1',
      });
    }
  });

  it('refuses two lines answering to one identifier', () => {
    // Worse than a refusal to price: a caller matching results back to inputs by id
    // would silently pick one of the two, so the receipt shows one line and the
    // stock movement deducts from another.
    expect(
      failureOf(() =>
        priceBasket({
          settings: ACT_1151_INCLUSIVE,
          lines: [
            { id: 'a', quantity: 1, unitPricePesewas: 100, vatTreatment: 'standard' },
            { id: 'a', quantity: 2, unitPricePesewas: 200, vatTreatment: 'standard' },
          ],
        })
      )
    ).toEqual({
      code: 'line_out_of_range',
      message: 'line 2 repeats the identifier of an earlier line',
      field: 'line 2',
    });
  });

  it('refuses a quantity that is not a whole number of units, at least one', () => {
    // `sale_items.quantity integer check (quantity > 0)`. One message covering both,
    // because 1.5 is above one and still wrong, and "must be at least one unit"
    // would point an operator at the size of a number that is not the problem.
    for (const quantity of [0, -1, 1.5, 2.0001]) {
      expect({
        quantity,
        failure: failureOf(() =>
          priceBasket({
            settings: ACT_1151_INCLUSIVE,
            lines: [{ id: 'a', quantity, unitPricePesewas: 100, vatTreatment: 'standard' }],
          })
        ),
      }).toEqual({
        quantity,
        failure: {
          code: 'line_out_of_range',
          message: 'line 1 must be a whole number of units, at least one',
          field: 'line 1',
        },
      });
    }
  });

  it('refuses more units than the arithmetic can multiply, and accepts exactly the ceiling', () => {
    expect(
      failureOf(() =>
        priceBasket({
          settings: ACT_1151_INCLUSIVE,
          lines: [
            {
              id: 'a',
              quantity: MAX_LINE_QUANTITY + 1,
              unitPricePesewas: 1,
              vatTreatment: 'standard',
            },
          ],
        })
      ).message
    ).toBe(`line 1 cannot be more than ${MAX_LINE_QUANTITY} units`);

    const atCeiling = priceBasket({
      settings: ACT_1151_INCLUSIVE,
      lines: [{ id: 'a', quantity: MAX_LINE_QUANTITY, unitPricePesewas: 1, vatTreatment: 'exempt' }],
    });
    expect(atCeiling.subtotal).toBe(MAX_LINE_QUANTITY);
  });

  it('refuses a line whose quantity times unit price passes the arithmetic ceiling', () => {
    // Both factors are individually acceptable and their product is not, which is
    // why the product is checked on its own rather than inferred from them. A line
    // priced past the ceiling would be multiplied by a rate later, and that product
    // is the one the whole integer-exactness argument depends on.
    expect(
      failureOf(() =>
        priceBasket({
          settings: ACT_1151_INCLUSIVE,
          lines: [
            {
              id: 'a',
              quantity: MAX_LINE_QUANTITY,
              unitPricePesewas: 100,
              vatTreatment: 'standard',
            },
          ],
        })
      ).message
    ).toBe('line 1 total is larger than this system can price');
  });

  it('refuses a unit price above the ceiling', () => {
    expect(
      failureOf(() =>
        priceBasket({
          settings: ACT_1151_INCLUSIVE,
          lines: [
            {
              id: 'a',
              quantity: 1,
              unitPricePesewas: MAX_AMOUNT_PESEWAS + 1,
              vatTreatment: 'standard',
            },
          ],
        })
      ).message
    ).toBe('line 1 unit price is larger than this system can price');
  });

  it('refuses a unit price that is not a whole number of pesewas', () => {
    expect(
      failureOf(() =>
        priceBasket({
          settings: ACT_1151_INCLUSIVE,
          lines: [{ id: 'a', quantity: 1, unitPricePesewas: 10.5, vatTreatment: 'standard' }],
        })
      ).message
    ).toBe('line 1 unit price must be a whole number of pesewas');
  });

  it('refuses an unrecognised VAT treatment, which TypeScript alone cannot stop', () => {
    // A caller in this repo cannot pass anything but a `VatTreatment`. A caller
    // reading a cached catalogue out of IndexedDB, or a JSON body, can pass any
    // string — and an unrecognised treatment falling through to a default would
    // price the line as exempt, silently, in the direction that loses revenue.
    const line = {
      id: 'a',
      quantity: 1,
      unitPricePesewas: 1_000,
      vatTreatment: 'STANDARD',
    } as unknown as BasketLineInput;
    expect(
      failureOf(() => priceBasket({ settings: ACT_1151_INCLUSIVE, lines: [line] }))
    ).toEqual({
      code: 'unknown_treatment',
      message: 'Enter line 1 VAT treatment as one of: standard, exempt, zero_rated',
      field: 'line 1 VAT treatment',
    });
  });

  it('refuses a discount larger than the basket', () => {
    expect(
      failureOf(() =>
        priceBasket({
          settings: ACT_1151_INCLUSIVE,
          lines: [ONE_STANDARD],
          discountPesewas: 1_001,
          discountReason: 'too generous',
        })
      ).code
    ).toBe('discount_exceeds_basket');
  });
});

describe('priceBasket over a sweep of baskets', () => {
  /**
   * Every identity a receipt has to satisfy, over a few thousand baskets.
   *
   * The examples above were chosen by the same person who wrote the engine, so they
   * share that person's assumptions. This does not: it builds baskets at random,
   * in both pricing modes, with all three treatments, zero-value lines and
   * discounts at both ends of the range, and then checks the relationships that
   * have to hold whichever numbers came out.
   */
  function identityFaults(
    settings: TaxSettings,
    lines: readonly BasketLineInput[],
    discount: number
  ): string[] {
    const where = `${settings.taxInclusivePricing ? 'inclusive' : 'exclusive'} ${JSON.stringify(
      lines
    )} discount ${discount}`;
    const faults: string[] = [];
    const note = (message: string): void => {
      if (faults.length < 20) faults.push(`${where}: ${message}`);
    };

    let basket;
    try {
      basket = priceBasket({
        settings,
        lines,
        discountPesewas: discount,
        discountReason: discount > 0 ? 'sweep' : null,
      });
    } catch (error) {
      note(
        `threw ${isTaxError(error) ? `${error.code}: ${error.message}` : String(error)}`
      );
      return faults;
    }

    const across = (field: keyof (typeof basket.lines)[number]): number =>
      basket.lines.reduce((sum, line) => sum + (line[field] as number), 0);

    const grossOf = lines.reduce(
      (sum, line) => sum + line.quantity * line.unitPricePesewas,
      0
    );

    if (basket.subtotal !== grossOf) note(`subtotal ${basket.subtotal} is not the lines' ${grossOf}`);
    if (basket.subtotal !== across('lineGross')) note('subtotal is not the sum of the line grosses');
    if (basket.discount !== discount) note(`discount came back as ${basket.discount}`);
    if (basket.discount !== across('lineDiscount')) {
      note(`discount ${basket.discount} is not the sum of the line discounts ${across('lineDiscount')}`);
    }
    if (basket.vatAmount !== across('vatAmount')) note('VAT is not the sum of the line VAT');
    if (basket.nhilAmount !== across('nhilAmount')) note('NHIL is not the sum of the line NHIL');
    if (basket.getfundAmount !== across('getfundAmount')) {
      note('GETFund is not the sum of the line GETFund');
    }
    if (basket.taxTotal !== basket.vatAmount + basket.nhilAmount + basket.getfundAmount) {
      note('tax total is not the sum of the three charges');
    }
    if (basket.taxableBase !== across('taxableBase')) {
      note('taxable base is not the sum of the line bases');
    }
    if (basket.total !== across('lineTotal')) {
      note(`total ${basket.total} is not the sum of the line totals ${across('lineTotal')}`);
    }

    // The mode identity, and the one a caller is most likely to apply to the wrong
    // mode. Inclusive: the shelf price already carried the tax, so what is owed is
    // the subtotal less the discount. Exclusive: the tax is added at the till.
    const owed = settings.taxInclusivePricing
      ? basket.subtotal - basket.discount
      : basket.subtotal - basket.discount + basket.taxTotal;
    if (basket.total !== owed) note(`total ${basket.total} is not ${owed} for this pricing mode`);

    for (const line of basket.lines) {
      const charged = line.lineGross - line.lineDiscount;
      if (line.lineDiscount > line.lineGross) {
        note(`${line.id} carries ${line.lineDiscount} of discount on a ${line.lineGross} line`);
      }
      if (line.lineTotal < 0) note(`${line.id} has a negative total`);
      if (line.taxableBase < 0) note(`${line.id} has a negative taxable base`);
      if (line.vatAmount < 0 || line.nhilAmount < 0 || line.getfundAmount < 0) {
        note(`${line.id} has a negative charge`);
      }
      if (line.vatTreatment !== 'standard') {
        if (line.vatAmount + line.nhilAmount + line.getfundAmount !== 0) {
          note(`${line.id} is ${line.vatTreatment} but was charged tax`);
        }
        if (line.taxableBase !== charged) {
          note(`${line.id} is ${line.vatTreatment} but its base is not what was charged`);
        }
      }
      if (line.inputTaxCreditable !== (line.vatTreatment !== 'exempt')) {
        note(`${line.id} has the wrong input-tax flag for ${line.vatTreatment}`);
      }
      if (settings.taxInclusivePricing) {
        // The receipt's own addition, per line: what was charged is the net plus the
        // three charges. True by construction in the inclusive direction, and the
        // reason the base is derived as the residual.
        if (line.taxableBase + line.vatAmount + line.nhilAmount + line.getfundAmount !== charged) {
          note(`${line.id} base plus tax is ${line.taxableBase + line.vatAmount + line.nhilAmount + line.getfundAmount}, not the ${charged} charged`);
        }
        if (line.lineTotal !== charged) note(`${line.id} total is not what was charged`);
      } else {
        if (line.taxableBase !== charged) {
          note(`${line.id} base ${line.taxableBase} is not the ${charged} charged`);
        }
        if (
          line.lineTotal !==
          line.taxableBase + line.vatAmount + line.nhilAmount + line.getfundAmount
        ) {
          note(`${line.id} total is not its base plus its three charges`);
        }
      }
    }

    return faults;
  }

  it('holds for randomly shaped baskets in both pricing modes', () => {
    const next = lcg(1_151_202_601);
    const treatments = ['standard', 'exempt', 'zero_rated'] as const;
    const faults: string[] = [];

    for (let trial = 0; trial < 2_000 && faults.length < 20; trial += 1) {
      const settings = trial % 2 === 0 ? ACT_1151_INCLUSIVE : ACT_1151_EXCLUSIVE;
      const lineCount = 1 + (next() % 6);
      const lines: BasketLineInput[] = [];
      for (let index = 0; index < lineCount; index += 1) {
        lines.push({
          id: `line-${index}`,
          quantity: 1 + (next() % 5),
          // Roughly one line in eight is free, which is where a zero-value line
          // meets a discount and the capacity waterfall has to cope.
          unitPricePesewas: next() % 8 === 0 ? 0 : next() % 20_000,
          vatTreatment: pick(treatments, next() % treatments.length),
        });
      }
      const subtotal = lines.reduce(
        (sum, line) => sum + line.quantity * line.unitPricePesewas,
        0
      );
      const discount = subtotal === 0 ? 0 : next() % (subtotal + 1);
      faults.push(...identityFaults(settings, lines, discount));
    }

    expect(faults).toEqual([]);
  });

  it('holds at the extremes of the range the engine accepts', () => {
    const faults: string[] = [];
    const treatments = ['standard', 'exempt', 'zero_rated'] as const;
    for (const settings of [ACT_1151_INCLUSIVE, ACT_1151_EXCLUSIVE, NOT_VAT_REGISTERED]) {
      for (const treatment of treatments) {
        for (const unitPricePesewas of [0, 1, MAX_AMOUNT_PESEWAS]) {
          for (const quantity of [1, MAX_LINE_QUANTITY]) {
            if (quantity * unitPricePesewas > MAX_AMOUNT_PESEWAS) continue;
            faults.push(
              ...identityFaults(
                settings,
                [{ id: 'edge', quantity, unitPricePesewas, vatTreatment: treatment }],
                quantity * unitPricePesewas
              )
            );
          }
        }
      }
    }
    expect(faults).toEqual([]);
  });
});
