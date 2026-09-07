import {
  EXPIRY_ALERT_WINDOW_DAYS,
  allocate,
  daysBetween,
  daysUntilExpiry,
  expiringWithin,
  inFefoOrder,
  isDateOnly,
  isSellable,
  leadingBatch,
  sellableUnits,
  type BatchStock,
} from '../utils/fefo';

/**
 * The FEFO allocator and the shared expiry rule.
 *
 * `today` is a constant in this file and every function under test takes it as
 * an argument. Nothing here reads the clock, so the suite answers the same way
 * in March and in December, and the boundaries that matter — the expiry date
 * itself, and day 90 of the alert window — can be asserted as exact dates rather
 * than as "roughly three months".
 *
 * The dates below were computed once and checked against Date.UTC arithmetic;
 * they are written out as literals so a reader can see the boundary rather than
 * having to trust a helper that adds days.
 */

const TODAY = '2026-03-15';

/** TODAY - 1. The last day this batch was sellable. */
const YESTERDAY = '2026-03-14';
/** TODAY + 1. The first day it is not. */
const TOMORROW = '2026-03-16';
/** TODAY + 90. Inside the alert window. */
const DAY_90 = '2026-06-13';
/** TODAY + 91. Outside it. */
const DAY_91 = '2026-06-14';

function batch(overrides: Partial<BatchStock> = {}): BatchStock {
  return {
    id: 'batch-1',
    lotNumber: 'LOT-1',
    expiryDate: '2027-01-31',
    receivedAt: '2026-01-01T00:00:00.000Z',
    quantity: 10,
    // A decimal string, exactly as Postgres returns a `numeric`. The allocator
    // copies it rather than computing with it, so the assertion below is that
    // the exact digits came through, not that a double was near them.
    costPrice: '2.0000',
    ...overrides,
  };
}

describe('isDateOnly', () => {
  it('accepts a plain calendar date and refuses everything else', () => {
    expect(isDateOnly('2026-03-15')).toBe(true);
    expect(isDateOnly('2026-3-15')).toBe(false);
    expect(isDateOnly('15/03/2026')).toBe(false);
    expect(isDateOnly('2026-03-15T00:00:00Z')).toBe(false);
    expect(isDateOnly('')).toBe(false);
  });

  it('refuses a date that matches the pattern but does not exist', () => {
    // Date.UTC rolls these forward: 2026-02-30 becomes 2 March, month 13
    // becomes next January. A pattern match alone accepts all three, and an
    // expiry date that is not a real day then sorts against a day nobody meant.
    expect(isDateOnly('2026-02-30')).toBe(false);
    expect(isDateOnly('2026-02-29')).toBe(false);
    expect(isDateOnly('2026-13-01')).toBe(false);
    expect(isDateOnly('2026-00-10')).toBe(false);
  });

  it('accepts a real leap day', () => {
    // The control for the test above: refusing every 29 February would also
    // pass it, and would silently reject one valid day every four years.
    expect(isDateOnly('2028-02-29')).toBe(true);
  });
});

describe('the expiry rule', () => {
  it('is sellable ON the expiry date and not the day after', () => {
    // The whole reason this module exists. Off by one in either direction and
    // the pharmacy is either throwing away a day of sellable stock or handing a
    // customer medicine that expired overnight.
    expect(isSellable(TODAY, TODAY)).toBe(true);
    expect(isSellable(TOMORROW, TODAY)).toBe(true);
    expect(isSellable(YESTERDAY, TODAY)).toBe(false);
  });

  it('treats an undated batch as always sellable', () => {
    expect(isSellable(null, TODAY)).toBe(true);
    // Including on a date far in the future: there is no date to be past.
    expect(isSellable(null, '2099-12-31')).toBe(true);
  });

  it('counts days until expiry, negative once past, null when undated', () => {
    expect(daysUntilExpiry(TODAY, TODAY)).toBe(0);
    expect(daysUntilExpiry(TOMORROW, TODAY)).toBe(1);
    expect(daysUntilExpiry(YESTERDAY, TODAY)).toBe(-1);
    expect(daysUntilExpiry(DAY_90, TODAY)).toBe(EXPIRY_ALERT_WINDOW_DAYS);
    expect(daysUntilExpiry(null, TODAY)).toBeNull();
  });

  it('refuses a timestamp where a date was expected', () => {
    // Comparing '2026-03-15T09:00:00Z' against a date-only column is how a
    // boundary moves by a day, and the move is invisible until stock that
    // should have been blocked is sold. Refusing is cheaper than guessing.
    expect(() => isSellable(null, '2026-03-15T09:00:00Z')).toThrow(/YYYY-MM-DD/);
    expect(() => isSellable(null, '15/03/2026')).toThrow(/YYYY-MM-DD/);
    expect(() => daysUntilExpiry(TODAY, '')).toThrow(/YYYY-MM-DD/);
  });

  it('refuses an impossible expiry date rather than rolling it forward', () => {
    expect(() => isSellable('2026-02-30', TODAY)).toThrow(/not a real date/);
  });
});

describe('inFefoOrder', () => {
  it('orders by earliest expiry first', () => {
    const ordered = inFefoOrder([
      batch({ id: 'c', expiryDate: '2027-06-30' }),
      batch({ id: 'a', expiryDate: '2026-06-30' }),
      batch({ id: 'b', expiryDate: '2027-01-31' }),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('puts undated stock last, behind every dated batch', () => {
    const ordered = inFefoOrder([
      batch({ id: 'undated', expiryDate: null }),
      batch({ id: 'far', expiryDate: '2099-12-31' }),
      batch({ id: 'near', expiryDate: '2026-04-01' }),
    ]);
    // A dated batch is always sold before an undated one, however distant the
    // date: undated usually means the date was never captured, and selling the
    // batch with a known deadline first protects it.
    expect(ordered.map((item) => item.id)).toEqual(['near', 'far', 'undated']);
  });

  it('breaks a tie on the expiry date by earliest receipt', () => {
    const ordered = inFefoOrder([
      batch({ id: 'later', expiryDate: '2026-12-31', receivedAt: '2026-02-01T00:00:00.000Z' }),
      batch({ id: 'earlier', expiryDate: '2026-12-31', receivedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(['earlier', 'later']);
  });

  it('breaks a tie on both by id, so the order is total', () => {
    // The same delivery entered twice: same lot pattern, same expiry, same
    // receipt timestamp. Without the id the order depends on how the query
    // planner fetched the rows, and the derived batch_number on the product
    // row flickers between two lots while nothing has been sold.
    const shared = { expiryDate: '2026-12-31', receivedAt: '2026-01-01T00:00:00.000Z' };
    const ordered = inFefoOrder([batch({ id: 'z', ...shared }), batch({ id: 'a', ...shared })]);
    expect(ordered.map((item) => item.id)).toEqual(['a', 'z']);

    // And the same answer from the opposite starting order, which a stable
    // sort of an already-ordered array would also produce.
    const reversed = inFefoOrder([batch({ id: 'a', ...shared }), batch({ id: 'z', ...shared })]);
    expect(reversed.map((item) => item.id)).toEqual(['a', 'z']);
  });

  it('does not reorder the array it was given', () => {
    const input = [
      batch({ id: 'c', expiryDate: '2027-06-30' }),
      batch({ id: 'a', expiryDate: '2026-06-30' }),
    ];
    const before = input.map((item) => item.id);
    inFefoOrder(input);
    expect(input.map((item) => item.id)).toEqual(before);
  });

  it('orders by the same rule the SQL index and the recompute trigger use', () => {
    // The canonical fixture. database/tests/assertions.sql section 10 runs the
    // equivalent ORDER BY over these same six batches on a real Postgres 16 and
    // asserts this same sequence, so the TypeScript rule and the SQL rule are
    // two witnesses to one answer rather than two copies that can drift.
    const fixture = [
      batch({ id: 'f', lotNumber: 'LOT-F', expiryDate: null, receivedAt: '2026-01-01T00:00:00.000Z' }),
      batch({ id: 'e', lotNumber: 'LOT-E', expiryDate: '2027-12-31', receivedAt: '2026-01-05T00:00:00.000Z' }),
      batch({ id: 'd', lotNumber: 'LOT-D', expiryDate: '2026-12-31', receivedAt: '2026-01-04T00:00:00.000Z' }),
      batch({ id: 'c', lotNumber: 'LOT-C', expiryDate: '2026-06-30', receivedAt: '2026-01-03T00:00:00.000Z' }),
      batch({ id: 'b', lotNumber: 'LOT-B', expiryDate: '2026-06-30', receivedAt: '2026-01-02T00:00:00.000Z' }),
      batch({ id: 'a', lotNumber: 'LOT-A', expiryDate: '2026-03-01', receivedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(inFefoOrder(fixture).map((item) => item.lotNumber)).toEqual([
      'LOT-A', // earliest expiry, and already past it
      'LOT-B', // same expiry as LOT-C, received earlier
      'LOT-C',
      'LOT-D',
      'LOT-E',
      'LOT-F', // undated, last
    ]);
  });
});

describe('leadingBatch', () => {
  it('is the first batch holding stock in FEFO order', () => {
    const batches = [
      batch({ id: 'late', expiryDate: '2027-06-30', quantity: 5 }),
      batch({ id: 'early', expiryDate: '2026-06-30', quantity: 5 }),
      batch({ id: 'empty', expiryDate: '2026-01-01', quantity: 0 }),
    ];
    expect(leadingBatch(batches)?.id).toBe('early');
  });

  it('skips an empty batch even when it is earliest to expire', () => {
    const batches = [
      batch({ id: 'drained', expiryDate: '2026-01-01', quantity: 0 }),
      batch({ id: 'holding', expiryDate: '2027-01-01', quantity: 3 }),
    ];
    expect(leadingBatch(batches)?.id).toBe('holding');
  });

  it('is null when nothing holds stock', () => {
    expect(leadingBatch([])).toBeNull();
    expect(leadingBatch([batch({ quantity: 0 })])).toBeNull();
  });

  it('names an expired lot rather than looking past it', () => {
    // Deliberately NOT the same question `allocate` answers. This is what the
    // product row displays, and it must show the expired lot: skipping past it
    // would put a future date on the product card while out-of-date stock sits
    // in the drawer, hiding the one thing the display exists to surface.
    const batches = [
      batch({ id: 'expired', lotNumber: 'LOT-EXPIRED', expiryDate: YESTERDAY, quantity: 4 }),
      batch({ id: 'good', lotNumber: 'LOT-GOOD', expiryDate: '2027-01-01', quantity: 4 }),
    ];
    expect(leadingBatch(batches)?.lotNumber).toBe('LOT-EXPIRED');

    // And the till still sells the good one.
    expect(allocate(batches, 1, TODAY).allocations[0]?.lotNumber).toBe('LOT-GOOD');
  });
});

describe('sellableUnits', () => {
  it('counts what may be sold today, which is not the physical count', () => {
    const batches = [
      batch({ id: 'a', quantity: 10, expiryDate: '2027-01-01' }),
      batch({ id: 'b', quantity: 5, expiryDate: YESTERDAY }),
      batch({ id: 'c', quantity: 7, expiryDate: null }),
      batch({ id: 'd', quantity: 0, expiryDate: '2027-01-01' }),
    ];
    // inventory.quantity is 22 — the drawer's contents, expired stock included,
    // because the ledger has to answer that honestly. The till sells 17.
    expect(batches.reduce((total, item) => total + item.quantity, 0)).toBe(22);
    expect(sellableUnits(batches, TODAY)).toBe(17);
  });

  it('includes a batch on its expiry date', () => {
    expect(sellableUnits([batch({ quantity: 6, expiryDate: TODAY })], TODAY)).toBe(6);
  });
});

describe('expiringWithin', () => {
  it('uses a 90-day window', () => {
    expect(EXPIRY_ALERT_WINDOW_DAYS).toBe(90);
  });

  it('includes day 90 and excludes day 91', () => {
    const batches = [
      batch({ id: 'day90', expiryDate: DAY_90 }),
      batch({ id: 'day91', expiryDate: DAY_91 }),
    ];
    expect(expiringWithin(batches, TODAY).map((item) => item.id)).toEqual(['day90']);
  });

  it('includes stock that has already expired', () => {
    // An expiry alert that stops firing the day after the date passes hides
    // exactly the stock that most needs pulling off the shelf.
    const batches = [
      batch({ id: 'gone', expiryDate: '2026-01-01' }),
      batch({ id: 'soon', expiryDate: DAY_90 }),
      batch({ id: 'safe', expiryDate: '2028-01-01' }),
    ];
    expect(expiringWithin(batches, TODAY).map((item) => item.id)).toEqual(['gone', 'soon']);
  });

  it('never includes an undated batch, an empty one, or a window that is not a whole number of days', () => {
    expect(expiringWithin([batch({ expiryDate: null })], TODAY)).toEqual([]);
    expect(expiringWithin([batch({ quantity: 0, expiryDate: TODAY })], TODAY)).toEqual([]);
    expect(() => expiringWithin([], TODAY, -1)).toThrow(/non-negative integer/);
    expect(() => expiringWithin([], TODAY, 1.5)).toThrow(/non-negative integer/);
  });

  it('returns them earliest first', () => {
    const batches = [
      batch({ id: 'later', expiryDate: '2026-05-01' }),
      batch({ id: 'sooner', expiryDate: '2026-04-01' }),
    ];
    expect(expiringWithin(batches, TODAY).map((item) => item.id)).toEqual(['sooner', 'later']);
  });
});

describe('allocate', () => {
  const shelf = [
    batch({ id: 'near', lotNumber: 'LOT-NEAR', expiryDate: '2026-06-30', receivedAt: '2026-01-02T00:00:00.000Z', quantity: 4, costPrice: '3.0000' }),
    batch({ id: 'far', lotNumber: 'LOT-FAR', expiryDate: '2027-06-30', receivedAt: '2026-01-01T00:00:00.000Z', quantity: 6, costPrice: '2.0000' }),
  ];

  it('takes from the earliest expiry first', () => {
    // `far` was received earlier, and still loses: expiry outranks receipt.
    const result = allocate(shelf, 3, TODAY);
    expect(result.allocations).toEqual([
      { batchId: 'near', lotNumber: 'LOT-NEAR', expiryDate: '2026-06-30', quantity: 3, unitCost: '3.0000' },
    ]);
    expect(result.allocated).toBe(3);
    expect(result.shortfall).toBe(0);
  });

  it('spills into the next batch when the first runs out', () => {
    const result = allocate(shelf, 7, TODAY);
    expect(result.allocations.map((line) => [line.batchId, line.quantity])).toEqual([
      ['near', 4],
      ['far', 3],
    ]);
    expect(result.allocated).toBe(7);
    expect(result.shortfall).toBe(0);
    // The whole point of returning one row per batch rather than a total: these
    // are the rows Phase 6 snapshots into sale_item_batches, and they are what
    // a void restores units to. The costs come through as the digits Postgres
    // sent, so no rounding decision was made on the way.
    expect(result.allocations.map((line) => line.unitCost)).toEqual(['3.0000', '2.0000']);
  });

  it('never takes more than a batch holds', () => {
    const result = allocate(shelf, 10, TODAY);
    expect(result.allocations.map((line) => line.quantity)).toEqual([4, 6]);
    expect(result.shortfall).toBe(0);
  });

  it('reports a shortfall rather than reaching into expired stock', () => {
    const withExpired = [
      ...shelf,
      batch({ id: 'expired', lotNumber: 'LOT-OLD', expiryDate: YESTERDAY, quantity: 100 }),
    ];
    const result = allocate(withExpired, 11, TODAY);
    expect(result.allocated).toBe(10);
    expect(result.shortfall).toBe(1);
    // Selling out of date medicine because a basket was one unit short is not a
    // substitution the allocator gets to make quietly. The shortfall is the
    // answer and the till has to face it.
    expect(result.allocations.map((line) => line.batchId)).toEqual(['near', 'far']);
  });

  it('skips an expired batch entirely and sells the next one', () => {
    const result = allocate([batch({ id: 'expired', expiryDate: YESTERDAY, quantity: 10 }), ...shelf], 2, TODAY);
    expect(result.allocations.map((line) => line.batchId)).toEqual(['near']);
  });

  it('sells a batch on its expiry date', () => {
    const result = allocate([batch({ id: 'today', expiryDate: TODAY, quantity: 5 })], 5, TODAY);
    expect(result.shortfall).toBe(0);
    expect(result.allocated).toBe(5);
  });

  it('refuses an empty request instead of reporting success', () => {
    // "allocated 0, shortfall 0" for a request of zero is indistinguishable
    // from a fulfilled sale, and a negative one is stock arriving through the
    // selling path. Both are caller bugs and neither may pass.
    expect(() => allocate(shelf, 0, TODAY)).toThrow(/positive whole number/);
    expect(() => allocate(shelf, -3, TODAY)).toThrow(/positive whole number/);
    expect(() => allocate(shelf, 2.5, TODAY)).toThrow(/positive whole number/);
  });

  it('is pure: the same shelf gives the same answer twice and is left as it was', () => {
    const before = shelf.map((item) => ({ ...item }));
    const first = allocate(shelf, 7, TODAY);
    const second = allocate(shelf, 7, TODAY);
    expect(second).toEqual(first);
    expect(shelf).toEqual(before);
    expect(shelf.map((item) => item.id)).toEqual(['near', 'far']);
  });

  it('allocates once from a batch id that appears twice in the input', () => {
    const duplicated = [batch({ id: 'same', quantity: 5 }), batch({ id: 'same', quantity: 5 })];
    const result = allocate(duplicated, 8, TODAY);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocated).toBe(5);
    expect(result.shortfall).toBe(3);
  });

  it('reports the whole request as a shortfall when there is no sellable stock at all', () => {
    const result = allocate([batch({ quantity: 0 }), batch({ id: 'b', expiryDate: YESTERDAY })], 4, TODAY);
    expect(result.allocations).toEqual([]);
    expect(result.allocated).toBe(0);
    expect(result.shortfall).toBe(4);
  });

  it('allocations always sum to allocated, and allocated plus shortfall always equals the request', () => {
    for (const requested of [1, 3, 4, 5, 9, 10, 11, 40]) {
      const result = allocate(shelf, requested, TODAY);
      expect(result.allocations.reduce((total, line) => total + line.quantity, 0)).toBe(result.allocated);
      expect(result.allocated + result.shortfall).toBe(requested);
    }
  });
});

describe('daysBetween', () => {
  /**
   * The day count a report window is measured in.
   *
   * It is asserted against the same literals the expiry rule uses, and against the
   * expiry rule itself, because the reason it lives in this module rather than in
   * `services/reports.service.ts` is that there is one copy of the arithmetic. A
   * second implementation deriving days by subtracting two `Date` objects would
   * agree with this one for most inputs and differ by one across a DST boundary or
   * a local-midnight rounding — and "is this range at most a year" is exactly the
   * question whose answer moves.
   */
  it('counts a single day as no days apart', () => {
    expect(daysBetween(TODAY, TODAY)).toBe(0);
  });

  it('counts forward, and agrees with the expiry rule about the same two dates', () => {
    expect(daysBetween(TODAY, TOMORROW)).toBe(1);
    expect(daysBetween(TODAY, DAY_90)).toBe(90);
    expect(daysBetween(TODAY, DAY_91)).toBe(91);
    // One arithmetic, two callers. If this ever diverges the copy is back.
    expect(daysBetween(TODAY, DAY_90)).toBe(daysUntilExpiry(DAY_90, TODAY));
    expect(daysBetween(TODAY, YESTERDAY)).toBe(daysUntilExpiry(YESTERDAY, TODAY));
  });

  it('goes negative for a reversed pair rather than answering with a distance', () => {
    // `Math.abs` here would make a caller's swapped arguments look like a valid
    // window, and `resolveReportWindow` refuses a reversed range on the strength of
    // the sign. A distance is a different question and this does not answer it.
    expect(daysBetween(DAY_90, TODAY)).toBe(-90);
    expect(daysBetween(TOMORROW, YESTERDAY)).toBe(-2);
  });

  it('crosses a month and a year end by the calendar, not by thirty-day months', () => {
    expect(daysBetween('2026-01-31', '2026-02-01')).toBe(1);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
    // The window `REPORT_LIMITS.rangeDays.max` is checked against: a whole calendar
    // year, inclusive of both ends, is 364 days between them and 365 counted.
    expect(daysBetween('2026-01-01', '2026-12-31')).toBe(364);
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365);
  });

  it('adds the leap day in a leap year and does not in a year that is not one', () => {
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    // 2000 was a leap year; a century rule applied too eagerly would say otherwise.
    expect(daysBetween('2000-02-28', '2000-03-01')).toBe(2);
  });

  it('refuses an impossible date instead of rolling it forward into a wider window', () => {
    // `new Date(2026, 1, 30)` is 2 March. Rolled forward, a report asked for
    // February would silently widen itself by a day nobody requested — and both
    // arguments are checked, because the one that moves the window depends on which
    // end the typo landed on.
    for (const impossible of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31']) {
      expect(() => daysBetween(impossible, TODAY)).toThrow(/not a real date/);
      expect(() => daysBetween(TODAY, impossible)).toThrow(/not a real date/);
    }
  });

  it('refuses a datetime, an empty string and a reordered date, all of which a looser pattern would accept', () => {
    for (const notADate of ['', '2026-3-5', '15/03/2026', '2026-03-15T00:00:00Z', '2026-03-15 ']) {
      expect(() => daysBetween(notADate, TODAY)).toThrow(/not a real date/);
    }
  });
});
