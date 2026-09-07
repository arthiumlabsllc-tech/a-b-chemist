jest.mock('../database/pool', () => ({
  poolSql: { query: jest.fn() },
  withTransaction: jest.fn(),
}));

jest.mock('../repositories/reports.repository', () => ({
  reportDaily: jest.fn(),
  reportDrawer: jest.fn(),
  reportProductProfit: jest.fn(),
  reportProfitTotals: jest.fn(),
  reportStaff: jest.fn(),
  reportStatusTotals: jest.fn(),
  reportTenders: jest.fn(),
  reportVat: jest.fn(),
}));

import { poolSql } from '../database/pool';
import {
  reportDaily,
  reportDrawer,
  reportProductProfit,
  reportProfitTotals,
  reportStaff,
  reportStatusTotals,
  reportTenders,
  reportVat,
  type DailyRow,
  type DrawerRow,
  type ProductProfitRow,
  type ProfitTotalRow,
  type StaffRow,
  type StatusTotalRow,
  type TenderRow,
  type VatRow,
} from '../repositories/reports.repository';
import { REPORT_LIMITS, resolveReportWindow, salesReport } from '../services/reports.service';
import { HttpError } from '../utils/http';
import { SALE_PAYMENT_METHODS, SALE_STATUSES, VAT_TREATMENTS } from '../utils/schema-enums';

/**
 * What a report includes, and what it says about what it left out.
 *
 * The repository is mocked and `utils/fefo` deliberately is not. The window rule —
 * which end defaults to what, how far apart two ends may be, whether a date is a
 * real one — is the half of this service that makes a decision, and stubbing
 * `daysBetween` to agree with the test would assert the boundaries against a
 * fiction. That the eight statements are valid SQL is `reports.repository.test.ts`.
 *
 * Two failure modes live here and nowhere else, and both answer with a plausible
 * page rather than an error:
 *
 *   - A section that is empty because the window had none of it and a section that
 *     is empty because it was dropped are the same JSON. Zero-filling against the
 *     exported enum lists is what makes the difference, and a member added to
 *     `sale_status` without appearing in `byStatus` is invisible on a page that
 *     renders whatever it was given.
 *   - A summary taken from the wrong row — from all five statuses rather than the
 *     completed one — reports money that is not in the drawer, and the total still
 *     looks like a total.
 */

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const TODAY = '2026-09-05';
const GENERATED_AT = '2026-09-05T18:04:00.000Z';
const PAGE = { limit: 50, offset: 0 };

const statusMock = reportStatusTotals as jest.Mock;
const dailyMock = reportDaily as jest.Mock;
const profitMock = reportProfitTotals as jest.Mock;
const productMock = reportProductProfit as jest.Mock;
const staffMock = reportStaff as jest.Mock;
const tenderMock = reportTenders as jest.Mock;
const drawerMock = reportDrawer as jest.Mock;
const vatMock = reportVat as jest.Mock;

const ALL_MOCKS: jest.Mock[] = [
  statusMock,
  dailyMock,
  profitMock,
  productMock,
  staffMock,
  tenderMock,
  drawerMock,
  vatMock,
];

/**
 * Complete rows rather than partial ones cast to the interfaces: if a row type
 * grows a field this file stops compiling instead of quietly feeding the service
 * something no database would return.
 */
function statusRow(overrides: Partial<StatusTotalRow> = {}): StatusTotalRow {
  return {
    status: 'completed',
    saleCount: 12,
    subtotal: '1000.00',
    discount: '20.00',
    vatAmount: '0.00',
    nhilAmount: '0.00',
    getfundAmount: '0.00',
    taxTotal: '0.00',
    total: '980.00',
    averageTotal: '81.67',
    patientSaleCount: 3,
    ...overrides,
  };
}

function dailyRow(overrides: Partial<DailyRow> = {}): DailyRow {
  return {
    day: '2026-09-03',
    saleCount: 4,
    revenue: '210.00',
    discount: '5.00',
    taxTotal: '0.00',
    costOfGoods: '140.00',
    grossProfit: '70.00',
    ...overrides,
  };
}

function profitRow(overrides: Partial<ProfitTotalRow> = {}): ProfitTotalRow {
  return {
    lineCount: 20,
    lineRevenue: '980.00',
    costOfGoods: '600.00',
    grossProfit: '380.00',
    grossMarginPercent: '38.8',
    zeroCostLines: 0,
    ...overrides,
  };
}

function productRow(overrides: Partial<ProductProfitRow> = {}): ProductProfitRow {
  return {
    productId: 'a0000000-0000-4000-8000-000000000010',
    name: 'Paracetamol 500mg',
    lineCount: 6,
    baseUnits: 60,
    revenue: '120.00',
    costOfGoods: '72.00',
    grossProfit: '48.00',
    grossMarginPercent: '40.0',
    zeroCostLines: 0,
    ...overrides,
  };
}

function staffRow(overrides: Partial<StaffRow> = {}): StaffRow {
  return {
    userId: 'a0000000-0000-4000-8000-000000000002',
    fullName: 'Ama Mensah',
    role: 'pharmacist',
    saleCount: 8,
    revenue: '640.00',
    discount: '10.00',
    pendingCount: 1,
    voidedCount: 0,
    ...overrides,
  };
}

function tenderRow(overrides: Partial<TenderRow> = {}): TenderRow {
  return {
    method: 'cash',
    settledCount: 9,
    settledAmount: '700.00',
    unsettledCount: 0,
    unsettledAmount: '0.00',
    ...overrides,
  };
}

function drawerRow(overrides: Partial<DrawerRow> = {}): DrawerRow {
  return { cashTaken: '750.00', changeGiven: '50.00', cashRetained: '700.00', ...overrides };
}

function vatRow(overrides: Partial<VatRow> = {}): VatRow {
  return {
    treatment: 'exempt',
    lineCount: 20,
    taxableBase: '980.00',
    gross: '1000.00',
    discount: '20.00',
    vatAmount: '0.00',
    nhilAmount: '0.00',
    getfundAmount: '0.00',
    lineTotal: '980.00',
    ...overrides,
  };
}

/** A window that has one of everything, so a section that vanishes is visible. */
function aFullWindow(): void {
  statusMock.mockResolvedValue([
    statusRow(),
    statusRow({ status: 'pending', saleCount: 2, total: '90.00', averageTotal: '45.00' }),
    statusRow({ status: 'voided', saleCount: 1, total: '35.00', averageTotal: '35.00' }),
  ]);
  dailyMock.mockResolvedValue([dailyRow(), dailyRow({ day: '2026-09-04', revenue: '300.00' })]);
  profitMock.mockResolvedValue(profitRow());
  productMock.mockResolvedValue([productRow(), productRow({ name: 'Amoxicillin 250mg' })]);
  staffMock.mockResolvedValue([staffRow()]);
  tenderMock.mockResolvedValue([
    tenderRow(),
    tenderRow({ method: 'momo', settledCount: 3, settledAmount: '280.00' }),
  ]);
  drawerMock.mockResolvedValue(drawerRow());
  vatMock.mockResolvedValue([vatRow()]);
}

/** A window with nothing in it at all. */
function anEmptyWindow(): void {
  statusMock.mockResolvedValue([]);
  dailyMock.mockResolvedValue([]);
  profitMock.mockResolvedValue({
    lineCount: 0,
    lineRevenue: '0.00',
    costOfGoods: '0.00',
    grossProfit: '0.00',
    grossMarginPercent: null,
    zeroCostLines: 0,
  });
  productMock.mockResolvedValue([]);
  staffMock.mockResolvedValue([]);
  tenderMock.mockResolvedValue([]);
  drawerMock.mockResolvedValue({
    cashTaken: '0.00',
    changeGiven: '0.00',
    cashRetained: '0.00',
  });
  vatMock.mockResolvedValue([]);
}

function report(overrides: Partial<Parameters<typeof salesReport>[1]> = {}) {
  return salesReport(
    PHARMACY,
    { from: null, to: null, ...PAGE, ...overrides },
    TODAY,
    GENERATED_AT
  );
}

beforeEach(() => {
  for (const mock of ALL_MOCKS) mock.mockReset();
  aFullWindow();
});

describe('the window a report covers', () => {
  it('defaults both ends to the day it was given, and to nothing wider', () => {
    // Not the last thirty days. A report that opened on a month would answer a
    // question nobody asked and take thirty times the scan to do it.
    expect(resolveReportWindow({ from: null, to: null }, TODAY)).toEqual({
      from: TODAY,
      to: TODAY,
    });
  });

  it('takes today from its caller rather than from a clock in the module', () => {
    // The route reads the clock once and passes it down. A second read here would
    // let a request arriving a millisecond before midnight default to one day and
    // stamp itself the next — and the two figures would disagree on a page whose
    // whole job is to be believed.
    expect(resolveReportWindow({ from: null, to: null }, '2026-12-31')).toEqual({
      from: '2026-12-31',
      to: '2026-12-31',
    });
  });

  it('fills either end on its own, so one date can be sent without the other', () => {
    expect(resolveReportWindow({ from: '2026-09-01', to: null }, TODAY)).toEqual({
      from: '2026-09-01',
      to: TODAY,
    });
    expect(resolveReportWindow({ from: null, to: '2026-09-05' }, TODAY)).toEqual({
      from: TODAY,
      to: '2026-09-05',
    });
  });

  it('refuses a half-sent range whose filled-in end lands after the one it was given', () => {
    // `from` defaults to today, so a `to` in the past arrives as a reversed range
    // and is refused with both dates named. The alternative — quietly swapping the
    // two, or reaching `from` back to meet `to` — would answer a different question
    // from the one asked and return figures that looked right for it.
    try {
      resolveReportWindow({ from: null, to: '2026-09-01' }, TODAY);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      const refusal = error as HttpError;
      expect(refusal.code).toBe('invalid_range');
      expect(refusal.message).toContain(TODAY);
      expect(refusal.message).toContain('2026-09-01');
    }
  });

  it('accepts the widest window it advertises and refuses the day after it', () => {
    // 2026-01-01 to 2027-01-01 is 366 inclusive days, and a leap year is the only
    // reason the ceiling is 366 rather than 365.
    const widest = { from: '2026-01-01', to: '2027-01-01' };
    expect(resolveReportWindow(widest, TODAY)).toEqual(widest);

    const oneDayWider = { from: '2026-01-01', to: '2027-01-02' };
    try {
      resolveReportWindow(oneDayWider, TODAY);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      const refusal = error as HttpError;
      expect(refusal.status).toBe(400);
      expect(refusal.code).toBe('range_too_wide');
      // Both numbers in the sentence: the ceiling and what was asked for. A
      // refusal that says only "too wide" leaves the caller guessing by one day.
      expect(refusal.message).toContain(String(REPORT_LIMITS.rangeDays.max));
      expect(refusal.message).toContain('367');
    }
  });

  it('refuses a reversed range, and names both dates so the typo is findable', () => {
    try {
      resolveReportWindow({ from: '2026-09-05', to: '2026-09-01' }, TODAY);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      const refusal = error as HttpError;
      expect(refusal.status).toBe(400);
      expect(refusal.code).toBe('invalid_range');
      expect(refusal.message).toContain('2026-09-05');
      expect(refusal.message).toContain('2026-09-01');
    }
  });

  it('refuses an impossible date with a 400 rather than letting it reach the arithmetic', () => {
    // `daysBetween` throws a plain `Error` on `2026-02-30`, and the error handler
    // answers anything that is not an `HttpError` as a 500 with its message
    // withheld. The check here is what turns a typo in a date picker into a
    // sentence at the counter — and Phase 9's cache warmer will not be a request
    // `express-validator` has already looked at.
    for (const impossible of ['2026-02-30', '2026-13-01', '2026-04-31']) {
      for (const input of [
        { from: impossible, to: null },
        { from: null, to: impossible },
      ]) {
        expect(() => resolveReportWindow(input, TODAY)).toThrow(HttpError);
      }
    }
  });

  it('refuses a datetime, a reordered date and an empty string, all of which a looser check would wave through', () => {
    for (const notADate of ['', '2026-9-5', '05/09/2026', '2026-09-05T00:00:00Z', '5 Sep 2026']) {
      expect(() => resolveReportWindow({ from: notADate, to: null }, TODAY)).toThrow(HttpError);
      expect(() => resolveReportWindow({ from: null, to: notADate }, TODAY)).toThrow(HttpError);
    }
  });

  it('queries nothing at all when the window is refused', async () => {
    // Eight aggregates over an unbounded range is the expensive half of a bad
    // request. Refusing before the first one is issued is the difference between a
    // 400 and a pool connection held for as long as a full scan takes.
    await expect(report({ from: '2026-09-05', to: '2026-09-01' })).rejects.toBeInstanceOf(
      HttpError
    );
    for (const mock of ALL_MOCKS) expect(mock).not.toHaveBeenCalled();
  });
});

describe('the eight reads, asked about one window', () => {
  it('issues all eight, once each, against the pool and the caller’s pharmacy', async () => {
    await report({ from: '2026-09-01', to: '2026-09-05' });

    for (const mock of ALL_MOCKS) expect(mock).toHaveBeenCalledTimes(1);
    // Every one goes to the pool and not to a checked-out client: there is nothing
    // to be atomic about, and a sale landing halfway through is the pharmacy
    // trading while somebody reads yesterday.
    for (const mock of ALL_MOCKS) expect(mock.mock.calls[0]?.[0]).toBe(poolSql);
    for (const mock of ALL_MOCKS) expect(mock.mock.calls[0]?.[1]).toBe(PHARMACY);
  });

  it('hands the same resolved window to every one of them', async () => {
    // The reason there is one endpoint rather than five. A page showing takings
    // from Tuesday and a VAT return from Monday is not obviously wrong; it is just
    // wrong, and nothing else in the response would give it away.
    await report({ from: '2026-09-01', to: '2026-09-05' });

    const windows = ALL_MOCKS.map((mock) => mock.mock.calls[0]?.[2]);
    for (const window of windows) expect(window).toEqual({ from: '2026-09-01', to: '2026-09-05' });
  });

  it('defaults the window before asking, so an omitted range still reaches the statements as two dates', async () => {
    await report();
    expect(statusMock.mock.calls[0]?.[2]).toEqual({ from: TODAY, to: TODAY });
  });

  it('pages only the product list, and passes the page through to it', async () => {
    await report({ from: '2026-09-01', to: '2026-09-05', limit: 20, offset: 40 });
    expect(productMock).toHaveBeenCalledWith(
      poolSql,
      PHARMACY,
      { from: '2026-09-01', to: '2026-09-05' },
      20,
      40
    );
  });
});

describe('what the summary counts', () => {
  it('takes every headline figure from the completed row and from no other', async () => {
    const bundle = await report();

    expect(bundle.summary).toEqual({
      saleCount: 12,
      revenue: '980.00',
      subtotal: '1000.00',
      discount: '20.00',
      vatAmount: '0.00',
      nhilAmount: '0.00',
      getfundAmount: '0.00',
      taxTotal: '0.00',
      averageSale: '81.67',
      patientSaleCount: 3,
      uncountedSaleCount: 3,
    });
    // The pending 90.00 and the voided 35.00 are on the page, in `byStatus`, and
    // are not in the takings. Summing the five rows is the mistake this pins: it
    // would report 1105.00 and still look like a total.
    expect(bundle.summary.revenue).not.toBe('1105.00');
  });

  it('counts what it left out, so a zero on the headline is never the whole story', async () => {
    const bundle = await report();
    expect(bundle.summary.uncountedSaleCount).toBe(3);
    // Built from the zero-filled rows rather than from what came back, so a status
    // the window has none of contributes a counted zero instead of being absent
    // from the arithmetic.
    const uncounted = bundle.byStatus
      .filter((row) => !row.counted)
      .reduce((sum, row) => sum + row.saleCount, 0);
    expect(uncounted).toBe(bundle.summary.uncountedSaleCount);
  });

  it('counts nothing at all when the window held no completed sale, however much pending money it held', async () => {
    // `reportStatusTotals` orders by status, so `completed` sorts first on every day
    // that has one. A summary read off whichever row arrived first would therefore
    // look right for all of them — and would report five unsettled mobile-money
    // charges as takings on the one day the till had nothing else, which is exactly
    // the day somebody counts the drawer and finds it short.
    statusMock.mockResolvedValue([
      statusRow({
        status: 'pending',
        saleCount: 5,
        subtotal: '450.00',
        total: '450.00',
        averageTotal: '90.00',
        patientSaleCount: 1,
      }),
      statusRow({ status: 'voided', saleCount: 1, total: '35.00', averageTotal: '35.00' }),
    ]);

    const bundle = await report();
    expect(bundle.summary.saleCount).toBe(0);
    expect(bundle.summary.revenue).toBe('0.00');
    expect(bundle.summary.averageSale).toBeNull();
    expect(bundle.summary.patientSaleCount).toBe(0);
    // The pending money is still on the page, as five uncounted sales.
    expect(bundle.summary.uncountedSaleCount).toBe(6);
    expect(bundle.byStatus.map((row) => row.status)).toEqual([...SALE_STATUSES]);
    expect(bundle.byStatus.find((row) => row.status === 'pending')).toEqual({
      status: 'pending',
      saleCount: 5,
      total: '450.00',
      counted: false,
    });
  });

  it('answers an empty window with zeros rather than with a blank it has to explain', async () => {
    anEmptyWindow();
    const bundle = await report();

    expect(bundle.summary.saleCount).toBe(0);
    expect(bundle.summary.revenue).toBe('0.00');
    expect(bundle.summary.uncountedSaleCount).toBe(0);
    // Null and not `'0.00'`: an average over no sales is not zero cedis, and a
    // mean basket of GHS 0.00 reads as "sold, for nothing".
    expect(bundle.summary.averageSale).toBeNull();
    expect(bundle.daily).toEqual([]);
    expect(bundle.staff).toEqual([]);
  });

  it('reports the range and the moment it was assembled, so a cached copy can say how old it is', async () => {
    const bundle = await report({ from: '2026-09-01', to: '2026-09-05' });
    expect(bundle.range).toEqual({ from: '2026-09-01', to: '2026-09-05' });
    expect(bundle.generatedAt).toBe(GENERATED_AT);
  });
});

describe('the sections that are zero-filled rather than dropped', () => {
  it('lists every sale status in enum order, including the ones the window has none of', async () => {
    const bundle = await report();

    expect(bundle.byStatus.map((row) => row.status)).toEqual([...SALE_STATUSES]);
    // `refunded` and `partially_refunded` are members of the enum that nothing in
    // this build writes. They are on the page anyway, at zero, because a status
    // added to the enum and silently missing from the report is invisible on a page
    // that renders whatever it was given.
    expect(bundle.byStatus).toHaveLength(SALE_STATUSES.length);
    const refunded = bundle.byStatus.find((row) => row.status === 'refunded');
    expect(refunded).toEqual({
      status: 'refunded',
      saleCount: 0,
      total: '0.00',
      counted: false,
    });
  });

  it('marks one status as counted and the other four as not', async () => {
    const bundle = await report();
    expect(bundle.byStatus.filter((row) => row.counted).map((row) => row.status)).toEqual([
      'completed',
    ]);
    expect(bundle.byStatus.filter((row) => !row.counted)).toHaveLength(SALE_STATUSES.length - 1);
  });

  it('lists both tender methods and all three VAT treatments, zero-filled in enum order', async () => {
    anEmptyWindow();
    const bundle = await report();

    expect(bundle.tenders.map((row) => row.method)).toEqual([...SALE_PAYMENT_METHODS]);
    expect(bundle.tenders).toEqual([
      { method: 'cash', settledCount: 0, settledAmount: '0.00', unsettledCount: 0, unsettledAmount: '0.00' },
      { method: 'momo', settledCount: 0, settledAmount: '0.00', unsettledCount: 0, unsettledAmount: '0.00' },
    ]);

    expect(bundle.vat.map((row) => row.treatment)).toEqual([...VAT_TREATMENTS]);
    expect(bundle.vat).toHaveLength(VAT_TREATMENTS.length);
    // A return that omits the zero-rated line reads as "no zero-rated supplies"
    // only if the reader knows the line should have been there.
    expect(bundle.vat.find((row) => row.treatment === 'zero_rated')).toEqual({
      treatment: 'zero_rated',
      lineCount: 0,
      taxableBase: '0.00',
      gross: '0.00',
      discount: '0.00',
      vatAmount: '0.00',
      nhilAmount: '0.00',
      getfundAmount: '0.00',
      lineTotal: '0.00',
    });
  });

  it('keeps a tender row the window did have, beside the one it zero-filled', async () => {
    tenderMock.mockResolvedValue([tenderRow({ method: 'momo', settledAmount: '280.00' })]);
    const bundle = await report();

    expect(bundle.tenders).toEqual([
      { method: 'cash', settledCount: 0, settledAmount: '0.00', unsettledCount: 0, unsettledAmount: '0.00' },
      { method: 'momo', settledCount: 9, settledAmount: '280.00', unsettledCount: 0, unsettledAmount: '0.00' },
    ]);
  });
});

describe('the profitability section', () => {
  it('passes a negative gross profit through rather than clamping it', async () => {
    profitMock.mockResolvedValue(
      profitRow({ lineRevenue: '500.00', costOfGoods: '620.00', grossProfit: '-120.00', grossMarginPercent: '-24.0' })
    );
    const bundle = await report();

    // A below-cost week is a fact about the pharmacy. Clamping it to zero, or
    // refusing it, would both be a report that cannot say the thing that most
    // needs saying — and `decimalStringFromPesewas` in the shared package would
    // throw on a negative pesewa, which is why the subtraction is in SQL.
    expect(bundle.profitability.grossProfit).toBe('-120.00');
    expect(bundle.profitability.grossMarginPercent).toBe('-24.0');
  });

  it('carries a null margin through as null, not as a zero that reads as "sold at cost"', async () => {
    profitMock.mockResolvedValue(profitRow({ grossMarginPercent: null }));
    const bundle = await report();
    expect(bundle.profitability.grossMarginPercent).toBeNull();
  });

  it('surfaces the lines whose cost nobody entered, at the window grain', async () => {
    profitMock.mockResolvedValue(profitRow({ zeroCostLines: 4 }));
    const bundle = await report();
    // A margin of 100% that nobody charged is the kind of figure an owner acts on,
    // and absorbing it into the total would hide exactly the batch that was
    // received without a cost price.
    expect(bundle.profitability.zeroCostLines).toBe(4);
  });

  it('says there is another page of products only when the page came back full', async () => {
    productMock.mockResolvedValue(new Array(20).fill(productRow()));
    expect((await report({ limit: 20 })).profitability.hasMoreProducts).toBe(true);

    productMock.mockResolvedValue(new Array(19).fill(productRow()));
    expect((await report({ limit: 20 })).profitability.hasMoreProducts).toBe(false);

    productMock.mockResolvedValue([]);
    expect((await report({ limit: 20 })).profitability.hasMoreProducts).toBe(false);
  });

  it('echoes the page it actually used, so a caller paging the list can hold window and page in one place', async () => {
    const bundle = await report({ from: '2026-09-01', to: '2026-09-05', limit: 20, offset: 40 });
    expect(bundle.profitability.limit).toBe(20);
    expect(bundle.profitability.offset).toBe(40);
    expect(bundle.profitability.products).toHaveLength(2);
  });
});

describe('the sections passed straight through', () => {
  it('does not re-declare the daily, staff or drawer rows it was given', async () => {
    const daily = [dailyRow(), dailyRow({ day: '2026-09-04' })];
    const staff = [staffRow()];
    const drawer = drawerRow();
    dailyMock.mockResolvedValue(daily);
    staffMock.mockResolvedValue(staff);
    drawerMock.mockResolvedValue(drawer);

    const bundle = await report();
    expect(bundle.daily).toBe(daily);
    expect(bundle.staff).toBe(staff);
    expect(bundle.drawer).toBe(drawer);
  });

  it('reports the staff who served, and does not fill in a roster', async () => {
    // The list is the people who sold in the window, not every user with zeros
    // beside most of it. A performance report listing four staff who sold nothing
    // looks like a complete staff list, and it is not one.
    staffMock.mockResolvedValue([]);
    const bundle = await report();
    expect(bundle.staff).toEqual([]);
  });

  it('lets a database failure travel rather than answering an empty report', async () => {
    const failure = new Error('connection terminated');
    drawerMock.mockRejectedValue(failure);

    // An empty report and a failed one look identical on the page unless the
    // failure travels, and "no sales today" is the one thing a report must not say
    // by accident.
    await expect(report()).rejects.toBe(failure);
  });
});
