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
  type ReportWindow,
  type StaffRow,
  type StatusTotalRow,
  type TenderRow,
  type VatRow,
} from '../repositories/reports.repository';
import { daysBetween, isDateOnly } from '../utils/fefo';
import { HttpError } from '../utils/http';
import {
  SALE_PAYMENT_METHODS,
  SALE_STATUSES,
  VAT_TREATMENTS,
  type SalePaymentMethod,
  type SaleStatus,
  type VatTreatment,
} from '../utils/schema-enums';

/**
 * The sales report: one read, one bundle, one round trip.
 *
 * Every figure is an aggregate the repository computed in `numeric`. This module
 * decides *what to include*, and the decisions are all of one kind: which status
 * counts as takings, which tenders count as settled, which calendar a day belongs
 * to. None of them is arithmetic, and that is deliberate — see the header of
 * `repositories/reports.repository.ts` for why no money is added, subtracted or
 * divided here.
 *
 * ## Eight queries, issued together
 *
 * They are independent reads over the same window, so `Promise.all` rather than a
 * waterfall: a report page that waited for each in turn would take eight round
 * trips' worth of latency to answer one question. All eight go to the pool rather
 * than to one checked-out client, because there is nothing to be atomic *about* —
 * a report is a read, and a sale landing halfway through is not an inconsistency
 * to roll back but the pharmacy continuing to trade while somebody looks at
 * yesterday.
 *
 * ## What is excluded is reported, never dropped
 *
 * A takings figure is only trustworthy if the reader can see what is not in it.
 * `byStatus` therefore carries all five members of `sale_status` whether or not the
 * window has any of them, zero-filled here against the exported list, so a status
 * added to the enum and not to the report is a compile error in this file rather
 * than a row that quietly stops appearing. Same for the two tender methods and the
 * three VAT treatments.
 */

/**
 * The bounds a report answers within.
 *
 * `rangeDays` is the inclusive calendar-day count, so a single day is 1 and the
 * widest window is a year plus a leap day. The ceiling is not a business rule —
 * nobody asks for four years of daily takings — it is what keeps the response
 * bounded: `daily` is one row per day in the window, and an uncapped range is an
 * uncapped JSON body built by an aggregate that scans every sale the pharmacy has
 * ever made. Refusing it is a sentence; answering it is a pool connection held for
 * as long as the scan takes.
 *
 * Mirrored into the frontend as `REPORT_LIMITS` and checked against this object by
 * `api-types.mirror.test.ts`, so the date picker cannot offer a range the API will
 * refuse.
 */
export const REPORT_LIMITS = {
  rangeDays: { min: 1, max: 366 },
} as const;

/**
 * The status whose money a report counts.
 *
 * One constant, named, because it appears in three places below — the summary, the
 * `counted` flag on each status row, and the count of what was left out — and the
 * failure mode of those three disagreeing is a report whose headline says one thing
 * and whose own breakdown says another.
 */
const COUNTED_STATUS: SaleStatus = 'completed';

/**
 * A money figure with nothing in it.
 *
 * `'0.00'` and not `'0'`, because a `numeric(12, 2)` column and every aggregate
 * over one arrives with two decimal places, and a zero-filled row that spelled its
 * zeros differently from a real one would be visible in any UI that right-aligns
 * money by string length.
 */
const ZERO_MONEY = '0.00';

export interface ReportSummary {
  /** Completed sales in the window. */
  saleCount: number;
  /** Σ `sales.total` over the completed ones. The takings figure. */
  revenue: string;
  subtotal: string;
  discount: string;
  vatAmount: string;
  nhilAmount: string;
  getfundAmount: string;
  taxTotal: string;
  /** Mean basket, or null when the window has no completed sale to average. */
  averageSale: string | null;
  /** Completed sales attached to a patient record. */
  patientSaleCount: number;
  /**
   * Sales in the window that are not counted as takings, across every other
   * status. Present so a zero on the headline is never the whole story: five
   * mobile-money charges still settling is a `pending` count of five.
   */
  uncountedSaleCount: number;
}

export interface StatusBreakdownRow {
  status: SaleStatus;
  saleCount: number;
  total: string;
  /** False for everything but `completed`: this row's money is not in `summary.revenue`. */
  counted: boolean;
}

export interface ReportProfitability {
  /** Receipt lines sold in the window. */
  lineCount: number;
  /**
   * Σ `sale_items.line_total` — the same money as `summary.revenue`, from the line
   * grain the cost is available at. Reported beside the profit rather than hidden
   * inside it, because a difference nobody can see the two halves of is a figure
   * nobody can check.
   */
  lineRevenue: string;
  costOfGoods: string;
  /** Negative when the window sold below cost. Never clamped. */
  grossProfit: string;
  grossMarginPercent: string | null;
  /** Lines whose lots carry no cost price, whose profit is therefore overstated. */
  zeroCostLines: number;
  products: ProductProfitRow[];
  limit: number;
  offset: number;
  /** False when the product list was cut short and there is another page. */
  hasMoreProducts: boolean;
}

export interface SalesReport {
  range: ReportWindow;
  /** When the bundle was assembled, so a cached copy can say how old it is. */
  generatedAt: string;
  summary: ReportSummary;
  /** Every member of `sale_status`, in enum order, whether or not the window has one. */
  byStatus: StatusBreakdownRow[];
  daily: DailyRow[];
  profitability: ReportProfitability;
  /** Staff who served at least one sale in the window — not the whole roster. */
  staff: StaffRow[];
  /** Every member of `sale_payment_method`, in enum order. */
  tenders: TenderRow[];
  drawer: DrawerRow;
  /** Every member of `vat_treatment`, in enum order. */
  vat: VatRow[];
}

export interface SalesReportInput {
  /** `'YYYY-MM-DD'` or null for today. */
  from: string | null;
  /** `'YYYY-MM-DD'` or null for today. */
  to: string | null;
  /** Pages the product list and nothing else. */
  limit: number;
  offset: number;
}

function zeroStatusTotals(status: SaleStatus): StatusTotalRow {
  return {
    status,
    saleCount: 0,
    subtotal: ZERO_MONEY,
    discount: ZERO_MONEY,
    vatAmount: ZERO_MONEY,
    nhilAmount: ZERO_MONEY,
    getfundAmount: ZERO_MONEY,
    taxTotal: ZERO_MONEY,
    total: ZERO_MONEY,
    // Null rather than `'0.00'`, matching what the SQL returns for a group that
    // exists but is empty of money: an average over no sales is not zero cedis.
    averageTotal: null,
    patientSaleCount: 0,
  };
}

function zeroTenderRow(method: SalePaymentMethod): TenderRow {
  return {
    method,
    settledCount: 0,
    settledAmount: ZERO_MONEY,
    unsettledCount: 0,
    unsettledAmount: ZERO_MONEY,
  };
}

function zeroVatRow(treatment: VatTreatment): VatRow {
  return {
    treatment,
    lineCount: 0,
    taxableBase: ZERO_MONEY,
    gross: ZERO_MONEY,
    discount: ZERO_MONEY,
    vatAmount: ZERO_MONEY,
    nhilAmount: ZERO_MONEY,
    getfundAmount: ZERO_MONEY,
    lineTotal: ZERO_MONEY,
  };
}

/**
 * The window a request asked for, with the two ends filled in and both checked.
 *
 * Exported separately from `salesReport` because it is the half with a decision in
 * it and the half a test can drive without a database.
 *
 * Both ends default to `today` rather than to something wider. A report that
 * opened on the last thirty days would answer a question nobody asked on the eight
 * days a month an owner opens it to check the drawer, and would take thirty times
 * the scan to do it. `today` comes from the caller, not from a clock in here, for
 * the reason `utils/clock.ts` gives: one definition of "today", or the boundary
 * moves for part of every day.
 */
export function resolveReportWindow(
  input: { from: string | null; to: string | null },
  today: string
): ReportWindow {
  const from = input.from ?? today;
  const to = input.to ?? today;

  // Checked here as well as at the route, and not as a belt-and-braces duplicate:
  // `daysBetween` throws a plain `Error` on an impossible date, which the error
  // handler would answer as a 500. A malformed range is a 400 with a sentence,
  // whatever path it arrived by — and Phase 9's cache warmer will not be an HTTP
  // request that `express-validator` has already looked at.
  if (!isDateOnly(from) || !isDateOnly(to)) {
    throw new HttpError(400, 'Enter both dates as YYYY-MM-DD', { code: 'invalid_range' });
  }

  // ISO date-only strings order as text, so this is a calendar comparison with no
  // `Date` in it — and no chance of a timezone moving one end by a day.
  if (to < from) {
    throw new HttpError(400, `The end date ${to} is before the start date ${from}`, {
      code: 'invalid_range',
    });
  }

  const days = daysBetween(from, to) + 1;
  if (days > REPORT_LIMITS.rangeDays.max) {
    throw new HttpError(
      400,
      `A report covers at most ${REPORT_LIMITS.rangeDays.max} days. ` +
        `That range is ${days} — narrow it, or read it in two parts.`,
      { code: 'range_too_wide' }
    );
  }

  return { from, to };
}

/**
 * Assembles the bundle.
 *
 * `today` and `generatedAt` are parameters rather than reads, so the whole service
 * is drivable from a test with a fixed date: the boundary cases that matter here —
 * a window of one day, a window ending today, a window a day too wide — are all
 * about which day it is, and a module that asks the clock itself cannot be put on
 * the interesting day.
 */
export async function salesReport(
  pharmacyId: string,
  input: SalesReportInput,
  today: string,
  generatedAt: string
): Promise<SalesReport> {
  const range = resolveReportWindow(input, today);

  const [statusTotals, daily, profitTotals, products, staff, tenders, drawer, vat] =
    await Promise.all([
      reportStatusTotals(poolSql, pharmacyId, range),
      reportDaily(poolSql, pharmacyId, range),
      reportProfitTotals(poolSql, pharmacyId, range),
      reportProductProfit(poolSql, pharmacyId, range, input.limit, input.offset),
      reportStaff(poolSql, pharmacyId, range),
      reportTenders(poolSql, pharmacyId, range),
      reportDrawer(poolSql, pharmacyId, range),
      reportVat(poolSql, pharmacyId, range),
    ]);

  const totals = new Map(statusTotals.map((row) => [row.status, row]));
  const statusRows = SALE_STATUSES.map((status) => totals.get(status) ?? zeroStatusTotals(status));
  const counted = totals.get(COUNTED_STATUS) ?? zeroStatusTotals(COUNTED_STATUS);

  const tenderTotals = new Map(tenders.map((row) => [row.method, row]));
  const vatTotals = new Map(vat.map((row) => [row.treatment, row]));

  return {
    range,
    generatedAt,
    summary: {
      saleCount: counted.saleCount,
      revenue: counted.total,
      subtotal: counted.subtotal,
      discount: counted.discount,
      vatAmount: counted.vatAmount,
      nhilAmount: counted.nhilAmount,
      getfundAmount: counted.getfundAmount,
      taxTotal: counted.taxTotal,
      averageSale: counted.averageTotal,
      patientSaleCount: counted.patientSaleCount,
      // Integer addition, so this is the one sum in the module and it cannot lose
      // a pesewa. Built from the zero-filled rows rather than from `statusTotals`,
      // so a status the window has none of contributes a counted zero instead of
      // being absent from the arithmetic.
      uncountedSaleCount: statusRows
        .filter((row) => row.status !== COUNTED_STATUS)
        .reduce((sum, row) => sum + row.saleCount, 0),
    },
    byStatus: statusRows.map((row) => ({
      status: row.status,
      saleCount: row.saleCount,
      total: row.total,
      counted: row.status === COUNTED_STATUS,
    })),
    daily,
    profitability: {
      lineCount: profitTotals.lineCount,
      lineRevenue: profitTotals.lineRevenue,
      costOfGoods: profitTotals.costOfGoods,
      grossProfit: profitTotals.grossProfit,
      grossMarginPercent: profitTotals.grossMarginPercent,
      zeroCostLines: profitTotals.zeroCostLines,
      products,
      limit: input.limit,
      offset: input.offset,
      // The list endpoints elsewhere infer this the same way: no `count(*)` comes
      // back with a page, and a short page is the only signal that it was the last.
      hasMoreProducts: products.length === input.limit,
    },
    // Passed through rather than aliased field by field. The repository's row is
    // already the wire shape, and re-declaring it here would be a second copy of a
    // list of eight field names for a reader to compare against the first.
    staff,
    tenders: SALE_PAYMENT_METHODS.map(
      (method) => tenderTotals.get(method) ?? zeroTenderRow(method)
    ),
    drawer,
    vat: VAT_TREATMENTS.map((treatment) => vatTotals.get(treatment) ?? zeroVatRow(treatment)),
  };
}
