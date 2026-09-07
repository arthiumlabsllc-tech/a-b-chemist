import { type PricedBasket, priceBasket } from '../basket';
import { GRA_EXAMPLE, GRA_RATES } from '../fixtures/gra-worked-example';
import {
  PARITY_VECTOR_SOURCE,
  TAX_PARITY_VECTORS,
  type TaxParityVector,
} from '../fixtures/tax-parity';

/**
 * The golden values, and the proof that they are golden.
 *
 * Two things are tested here and they are not the same thing.
 *
 * The first is that the engine reproduces every pinned figure. That is half the
 * parity claim the plan asks for; the other half is
 * `frontend/src/lib/__tests__/pricing-parity.test.ts`, which runs the same vectors
 * through the till's own pricing path. Both import `TAX_PARITY_VECTORS` from this
 * one module, so a difference between the engine and the till is impossible rather
 * than merely unlikely — there is no second copy to drift. What these vectors
 * therefore have to be is *hard*: a change to the rounding rule, the treatment
 * logic or the apportionment turns this file red, and the change then has to be
 * made deliberately and its numbers rewritten by hand.
 *
 * The second is that the figures are right. A golden value is an assertion with no
 * runtime behind it, and a wrong one is worse than a wrong line of code: the code
 * has a test, the fixture is the test. So each vector is also checked against
 * itself — its own inputs, its own arithmetic, the rules the source states in prose
 * — without the engine being run at all. If the fixture and the rules disagree, one
 * of them is wrong and either way this suite goes red. That is the check that would
 * have caught a transposed digit in a hand-computed vector, which is the failure
 * mode this whole file is most exposed to and the one nothing else can see.
 */

/**
 * Indexed access with the undefined removed.
 *
 * `noUncheckedIndexedAccess` is on and a non-null assertion is banned by the lint
 * config. This throws rather than substituting a default, because a parity check
 * that quietly compared `undefined` against a pinned figure would report agreement
 * where there was none.
 */
function pick<T>(items: readonly T[], index: number): T {
  const found = items[index];
  if (found === undefined) {
    throw new Error(`no item at index ${index} of ${items.length}`);
  }
  return found;
}

/**
 * `Array.prototype.flatMap`, which `lib: ["ES2017"]` does not have.
 *
 * This package compiles against ES2017 because the emitted JavaScript has to run in
 * every browser the till is opened in, so the suite is written to the same library
 * the source is. Writing it against a newer one would let a test use an API the
 * shipped module cannot.
 */
function flat<T, U>(items: readonly T[], project: (item: T) => readonly U[]): U[] {
  const out: U[] = [];
  for (const item of items) {
    out.push(...project(item));
  }
  return out;
}

function price(vector: TaxParityVector): PricedBasket {
  return priceBasket({
    settings: vector.settings,
    lines: vector.lines,
    discountPesewas: vector.discountPesewas,
    discountReason: vector.discountReason,
  });
}

/**
 * The eight fields a vector pins, projected out of a priced line.
 *
 * Projected rather than compared whole, because `PricedLine` carries four more
 * fields — quantity, unit price, gross and treatment — that the vectors
 * deliberately do not repeat. Those are asserted separately below against the
 * vector's own inputs, which is a stronger check than pinning them twice.
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

describe('the engine reproduces every parity vector', () => {
  for (const vector of TAX_PARITY_VECTORS) {
    // One test per vector rather than one loop over all of them, so a failure names
    // the vector instead of pointing at a line number in a sweep.
    it(vector.name, () => {
      const basket = price(vector);
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

      // The four fields no vector pins, checked against the vector's own inputs. A
      // receipt carries them, so a basket that priced them wrongly would be wrong in
      // a way the eight pinned figures cannot show.
      expect(basket.lines.map((line) => line.vatTreatment)).toEqual(
        vector.lines.map((line) => line.vatTreatment)
      );
      expect(basket.lines.map((line) => line.quantity)).toEqual(
        vector.lines.map((line) => line.quantity)
      );
      expect(basket.lines.map((line) => line.unitPricePesewas)).toEqual(
        vector.lines.map((line) => line.unitPricePesewas)
      );
      expect(basket.lines.map((line) => line.lineGross)).toEqual(
        vector.lines.map((line) => line.quantity * line.unitPricePesewas)
      );

      // The rates are snapshotted beside the money, and every vector uses one of the
      // three settings objects, so the snapshot has to be the settings it was given.
      expect(basket.rates).toEqual({
        vatRate: vector.settings.vatRate,
        nhilRate: vector.settings.nhilRate,
        getfundRate: vector.settings.getfundRate,
        taxInclusivePricing: vector.settings.taxInclusivePricing,
      });
    });
  }
});

describe('each vector is consistent with itself, without the engine', () => {
  /**
   * The rules the source states in prose, applied to a vector's own numbers.
   *
   * Nothing here calls `priceBasket`. Every figure is derived from the vector's
   * inputs and its pinned outputs and compared against the other pinned outputs, so
   * a transcription error in the fixture is caught by the fixture.
   */
  function faults(vector: TaxParityVector): string[] {
    const problems: string[] = [];
    const note = (message: string): void => {
      problems.push(message);
    };
    const { expected } = vector;
    const inclusive = vector.settings.taxInclusivePricing;

    if (expected.lines.length !== vector.lines.length) {
      note(`${expected.lines.length} pinned lines for ${vector.lines.length} inputs`);
      return problems;
    }

    const subtotal = vector.lines.reduce(
      (sum, line) => sum + line.quantity * line.unitPricePesewas,
      0
    );
    if (expected.subtotal !== subtotal) {
      note(`subtotal ${expected.subtotal} is not the inputs' ${subtotal}`);
    }
    if (expected.discount !== vector.discountPesewas) {
      note(`discount ${expected.discount} is not the ${vector.discountPesewas} asked for`);
    }
    if (expected.taxTotal !== expected.vatAmount + expected.nhilAmount + expected.getfundAmount) {
      note('tax total is not the sum of the three charges');
    }
    if ((vector.discountReason === null) !== (vector.discountPesewas === 0)) {
      note('a reason is pinned against no discount, or none against a discount');
    }

    const sumOf = (field: keyof (typeof expected.lines)[number]): number =>
      expected.lines.reduce((total, line) => total + (line[field] as number), 0);

    // Written out rather than zipped against a list of field names: the basket label
    // and the line field are two vocabularies for the same six sums, and a lookup
    // between them is exactly the indirection that ends up comparing the wrong pair.
    if (expected.discount !== sumOf('lineDiscount')) {
      note('discount is not the sum of the line discounts');
    }
    if (expected.vatAmount !== sumOf('vatAmount')) note('VAT is not the sum of the line VAT');
    if (expected.nhilAmount !== sumOf('nhilAmount')) note('NHIL is not the sum of the line NHIL');
    if (expected.getfundAmount !== sumOf('getfundAmount')) {
      note('GETFund is not the sum of the line GETFund');
    }
    if (expected.taxableBase !== sumOf('taxableBase')) {
      note('taxable base is not the sum of the line bases');
    }
    if (expected.total !== sumOf('lineTotal')) note('total is not the sum of the line totals');

    // The identity that depends on the pricing mode, and the one a caller is most
    // likely to apply to the wrong mode. Inclusive: the shelf price already carried
    // the tax, so what is owed is the subtotal less the discount. Exclusive: the tax
    // is added at the till.
    const owed = inclusive
      ? expected.subtotal - expected.discount
      : expected.subtotal - expected.discount + expected.taxTotal;
    if (expected.total !== owed) note(`total ${expected.total} is not ${owed} for this mode`);

    for (let index = 0; index < vector.lines.length; index += 1) {
      const input = pick(vector.lines, index);
      const line = pick(expected.lines, index);
      const gross = input.quantity * input.unitPricePesewas;
      const charged = gross - line.lineDiscount;

      if (line.id !== input.id) note(`line ${index + 1} is pinned as ${line.id}, input is ${input.id}`);
      if (line.lineDiscount > gross) {
        note(`${line.id} carries ${line.lineDiscount} of discount on a ${gross} line`);
      }
      if (line.lineDiscount < 0 || line.taxableBase < 0 || line.lineTotal < 0) {
        note(`${line.id} has a negative figure`);
      }
      if (line.vatAmount < 0 || line.nhilAmount < 0 || line.getfundAmount < 0) {
        note(`${line.id} has a negative charge`);
      }
      if (line.inputTaxCreditable !== (input.vatTreatment !== 'exempt')) {
        note(`${line.id} has the wrong input-tax flag for ${input.vatTreatment}`);
      }
      if (input.vatTreatment !== 'standard') {
        if (line.vatAmount + line.nhilAmount + line.getfundAmount !== 0) {
          note(`${line.id} is ${input.vatTreatment} but was charged tax`);
        }
        if (line.taxableBase !== charged) {
          note(`${line.id} is ${input.vatTreatment} but its base is not what was charged`);
        }
      }
      if (inclusive) {
        // The receipt's own addition, per line: what was charged is the net plus the
        // three charges. This is the invariant that makes deriving the base as the
        // residual the right ordering, and it is checkable on the fixture alone.
        if (line.taxableBase + line.vatAmount + line.nhilAmount + line.getfundAmount !== charged) {
          note(`${line.id} base plus its three charges is not the ${charged} charged`);
        }
        if (line.lineTotal !== charged) note(`${line.id} total is not what was charged`);
      } else {
        if (line.taxableBase !== charged) {
          note(`${line.id} base ${line.taxableBase} is not the ${charged} charged`);
        }
        if (line.lineTotal !== charged + line.vatAmount + line.nhilAmount + line.getfundAmount) {
          note(`${line.id} total is not its base plus its three charges`);
        }
      }
    }

    return problems;
  }

  it('finds no vector whose own figures disagree with each other', () => {
    // One assertion over all twelve rather than twelve tests, because a fixture
    // fault is a fault in the file and not in a basket — and the report names the
    // vector either way.
    const found = flat(TAX_PARITY_VECTORS, (vector) =>
      faults(vector).map((problem) => `${vector.name}: ${problem}`)
    );
    expect(found).toEqual([]);
  });

  it('would notice a single altered digit, which is the whole point of checking', () => {
    // A vacuous-pass guard. The block above asserts an empty list, and an empty list
    // is also what a checker that never checks anything returns. Taking one pinned
    // figure and moving it by one pesewa has to produce a fault, or the block proves
    // nothing.
    const vector = pick(TAX_PARITY_VECTORS, 0);
    const edited: TaxParityVector = {
      ...vector,
      expected: { ...vector.expected, total: vector.expected.total + 1 },
    };
    expect(faults(edited).length).toBeGreaterThan(0);

    const editedLine: TaxParityVector = {
      ...vector,
      expected: {
        ...vector.expected,
        lines: [{ ...pick(vector.expected.lines, 0), lineTotal: 1 }],
      },
    };
    expect(faults(editedLine).length).toBeGreaterThan(0);
  });
});

describe('provenance', () => {
  const counts = TAX_PARITY_VECTORS.reduce<Record<string, number>>((tally, vector) => {
    tally[vector.provenance] = (tally[vector.provenance] ?? 0) + 1;
    return tally;
  }, {});

  it('says where the numbers came from, and only two vectors came from GRA', () => {
    // GRA published exactly one worked example. Marking more vectors "gra" than that
    // would be a claim the source does not support, and would hide which assertions
    // carry external evidence and which carry only ours against a rounding rule GRA
    // does not publish.
    expect(counts).toEqual({ gra: 2, 'derived-from-gra': 2, 'hand-computed': 8 });
    expect(TAX_PARITY_VECTORS.length).toBe(12);
  });

  it('ties both GRA vectors back to the published figures, field by field', () => {
    const gra = TAX_PARITY_VECTORS.filter((vector) => vector.provenance === 'gra');
    expect(gra.map((vector) => vector.name)).toEqual([
      'gra-exclusive-single-standard-line',
      'gra-inclusive-single-standard-line',
    ]);

    // One example read in both directions. Exclusive: the selling price is the
    // subtotal. Inclusive: it is inside the shelf price, so the subtotal is the
    // total and the selling price comes back as the taxable base.
    for (const vector of gra) {
      const inclusive = vector.settings.taxInclusivePricing;
      expect(vector.expected.subtotal).toBe(
        inclusive ? GRA_EXAMPLE.total : GRA_EXAMPLE.sellingPrice
      );
      expect(vector.expected.taxableBase).toBe(GRA_EXAMPLE.sellingPrice);
      expect(vector.expected.vatAmount).toBe(GRA_EXAMPLE.vat);
      expect(vector.expected.nhilAmount).toBe(GRA_EXAMPLE.nhil);
      expect(vector.expected.getfundAmount).toBe(GRA_EXAMPLE.getfund);
      expect(vector.expected.taxTotal).toBe(GRA_EXAMPLE.total - GRA_EXAMPLE.sellingPrice);
      expect(vector.expected.total).toBe(GRA_EXAMPLE.total);
      expect(vector.settings.vatRate).toBe(GRA_RATES.vatRate);
      expect(vector.settings.nhilRate).toBe(GRA_RATES.nhilRate);
      expect(vector.settings.getfundRate).toBe(GRA_RATES.getfundRate);
    }
  });

  it('claims GRA for the two levies\' exemption rule, which GRA does state in words', () => {
    // "derived-from-gra" is not a weaker version of "gra" and not a stronger version
    // of "hand-computed": it is a rule GRA publishes as prose, applied to numbers
    // nobody published. Both vectors here are the zero-tax treatments, and GRA says
    // exempt supplies are exempt from all three charges and that zero-rated items
    // attract a zero rate of GETFund and NHIL.
    const derived = TAX_PARITY_VECTORS.filter((v) => v.provenance === 'derived-from-gra');
    expect(derived.map((v) => pick(v.lines, 0).vatTreatment)).toEqual(['exempt', 'zero_rated']);
    for (const vector of derived) {
      expect(vector.expected.taxTotal).toBe(0);
    }
  });

  it('names the one module both consumers read', () => {
    // Pinned as a literal so the provenance string cannot quietly stop naming a
    // suite that exists. It named a consumer that did not — "the API suite" — for
    // the whole of Phase 9 until the till's own parity suite was written; a string
    // nobody asserts against the filesystem is a claim, not a fact.
    expect(PARITY_VECTOR_SOURCE).toBe(
      'shared/src/fixtures/tax-parity.ts — read by shared/src/__tests__/parity.test.ts and by frontend/src/lib/__tests__/pricing-parity.test.ts'
    );
  });
});

describe('coverage', () => {
  const treatments = flat(TAX_PARITY_VECTORS, (vector) =>
    vector.lines.map((line) => line.vatTreatment)
  );

  it('exercises all three VAT treatments', () => {
    expect(new Set(treatments)).toEqual(new Set(['standard', 'exempt', 'zero_rated']));
  });

  it('exercises both pricing modes', () => {
    const modes = new Set(TAX_PARITY_VECTORS.map((vector) => vector.settings.taxInclusivePricing));
    expect(modes).toEqual(new Set([true, false]));
  });

  it('exercises a pharmacy that charges no tax at all', () => {
    // Act 1151 raised the registration threshold to GHS 750,000, which puts a small
    // community pharmacy on either side of it. Whether A&B is registered is a fact
    // about A&B, so both answers have to be tested configurations.
    const unregistered = TAX_PARITY_VECTORS.filter(
      (vector) => vector.settings.vatRate === 0 && vector.settings.nhilRate === 0
    );
    expect(unregistered.length).toBe(1);
    expect(pick(unregistered, 0).expected.taxTotal).toBe(0);
    // A standard-rated product under zero rates still charges nothing, which is the
    // part that would break if the treatment decided the arithmetic instead of the
    // settings deciding it.
    expect(pick(pick(unregistered, 0).lines, 0).vatTreatment).toBe('standard');
  });

  it('exercises a basket of mixed treatments, where per-line taxation is not optional', () => {
    const mixed = TAX_PARITY_VECTORS.filter(
      (vector) => new Set(vector.lines.map((line) => line.vatTreatment)).size > 1
    );
    expect(mixed.length).toBeGreaterThanOrEqual(2);
  });

  it('exercises discount drift that lands, and drift that has to move on', () => {
    // Detected from the engine's own output rather than from vector names, so this
    // keeps holding if a vector is renamed or replaced. Drift that lands is the
    // ordinary case: one pesewa onto the largest line. Drift that moves on is the
    // capacity waterfall, where the largest line is too narrow to absorb it and the
    // remainder has to go to the next one — the case that produces a negative
    // taxable base if the waterfall is missing.
    const drifted = TAX_PARITY_VECTORS.map((vector) => ({
      name: vector.name,
      basket: price(vector),
    })).filter((entry) => entry.basket.discountDrift > 0);

    expect(drifted.length).toBeGreaterThanOrEqual(2);
    expect(drifted.some((entry) => entry.basket.discountDriftLines.length === 1)).toBe(true);
    expect(drifted.some((entry) => entry.basket.discountDriftLines.length > 1)).toBe(true);

    for (const { basket } of drifted) {
      expect(basket.lines.every((line) => line.taxableBase >= 0)).toBe(true);
      expect(basket.lines.every((line) => line.lineDiscount <= line.lineGross)).toBe(true);
    }
  });

  it('names every vector uniquely, so a failure points at one basket', () => {
    const names = TAX_PARITY_VECTORS.map((vector) => vector.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.trim()).not.toBe('');
    }
  });

  it('gives every vector a note saying what it is here to catch', () => {
    // A golden value with no stated purpose is a golden value nobody can tell is
    // redundant, and a set of vectors that stops covering anything is indistinguishable
    // from one that does.
    for (const vector of TAX_PARITY_VECTORS) {
      expect(vector.note.trim().length).toBeGreaterThan(20);
    }
  });
});

describe('the vectors as shared state', () => {
  it('is frozen at every level, so a consumer cannot rewrite a golden value', () => {
    // Both suites read this one array. If a golden value could be changed at runtime,
    // the two consumers would still agree with each other while both were wrong, and
    // parity would be a property of the corruption rather than of the engine.
    expect(Object.isFrozen(TAX_PARITY_VECTORS)).toBe(true);
    for (const vector of TAX_PARITY_VECTORS) {
      expect(Object.isFrozen(vector)).toBe(true);
      expect(Object.isFrozen(vector.expected)).toBe(true);
      expect(Object.isFrozen(vector.settings)).toBe(true);
      expect(Object.isFrozen(vector.lines)).toBe(true);
      expect(Object.isFrozen(vector.expected.lines)).toBe(true);
      for (const line of vector.lines) expect(Object.isFrozen(line)).toBe(true);
      for (const line of vector.expected.lines) expect(Object.isFrozen(line)).toBe(true);
    }
  });

  it('prices every vector the same way twice', () => {
    for (const vector of TAX_PARITY_VECTORS) {
      expect(price(vector)).toEqual(price(vector));
    }
  });

  it('leaves the vector it was given exactly as it found it', () => {
    // The engine receives the shared array's own objects, not copies. Mutating an
    // input would be invisible to the consumer that did it and fatal to the next one.
    for (const vector of TAX_PARITY_VECTORS) {
      const before = JSON.stringify(vector);
      price(vector);
      expect(JSON.stringify(vector)).toBe(before);
    }
  });
});
