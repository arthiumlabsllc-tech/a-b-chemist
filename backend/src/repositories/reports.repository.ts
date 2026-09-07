import type { Sql } from '../database/pool';
import type { UserRole } from '../utils/permissions';
import type { SalePaymentMethod, SaleStatus, VatTreatment } from '../utils/schema-enums';

/**
 * The aggregate reads behind `/reports`.
 *
 * Eight statements, one grain each, and the separation is the design rather than
 * an accident of how they were written. A sale, a sale line and a lot draw are
 * three different grains, and joining them into one statement multiplies rows:
 * `sum(si.line_total)` across a join to `sale_item_batches` counts a line once
 * per lot it was drawn from, so a strip of ten tablets paid for out of two lots
 * would report twice its revenue. Every query below that needs two grains
 * aggregates each one in its own CTE and joins the *aggregates*, which is the only
 * way the fan-out stays out of the money.
 *
 * ## Every figure is computed in SQL, in `numeric`
 *
 * Nothing here is summed in JavaScript, and nothing is *subtracted* in JavaScript
 * either. `pg` hands a `numeric` back as a decimal string and this project does not
 * override that (see `database/pg-types.ts`, which overrides only `date`), so the
 * alternative to a SQL aggregate is parsing those strings into doubles and adding
 * them — which is how a takings report arrives a pesewa away from the drawer and
 * sends somebody looking for a theft that is a floating-point remainder.
 *
 * The subtraction half has a second reason. `a-and-b-chemist-shared` works in whole
 * pesewas and `decimalStringFromPesewas` refuses a negative one, correctly, because
 * a payment cannot be negative. A gross profit can be: a clearance line, a discount
 * that went past cost, a batch received at the wrong price. A report that could not
 * represent a loss would have to answer a below-cost week with either a wrong
 * positive figure or an exception, so every difference, percentage and rounding of
 * a four-decimal cost to a two-decimal figure below is a `numeric` operation and
 * stays exact and signed.
 *
 * ## The window is UTC, explicitly
 *
 * `created_at` is a `timestamptz`, so which calendar day a sale belongs to
 * depends on a timezone. Both bounds and the day bucket below say `at time zone
 * 'UTC'` rather than leaving it to the connection's `TimeZone` setting, for the
 * reason `utils/clock.ts` records: Ghana is UTC+0 with no daylight saving, so UTC
 * *is* the date on the wall in Accra, and `todayDateOnly()` — which is what the
 * browser sends as `from` and `to` — is a UTC date. Deriving the bucket from the
 * session timezone instead would make the two disagree on any host whose
 * `TimeZone` is not UTC, and the disagreement is invisible: a report whose first
 * and last days are short by a few hours still adds up to a plausible number.
 *
 * ## Enum comparisons here are literals, not parameters
 *
 * The landmine in the header of `sales.repository.ts` is a *parameter* compared
 * against an enum column. Nothing below takes a status or a treatment as input —
 * a report always counts `completed` money and always groups by every treatment —
 * so every enum comparison is a literal cast (`'completed'::sale_status`) against
 * a column of that type. Both sides are known at parse time and there is no `$n`
 * for the parser to deduce. The casts are written anyway, to match the house
 * spelling and to stay correct if a filter parameter is ever added beside them.
 */

/**
 * The window a report covers, in the shape the API accepts and the browser sends.
 *
 * Both ends are inclusive calendar days. `to` is widened to the start of the
 * following day inside the SQL rather than here, so the interface says what the
 * caller means and not what the statement needs.
 */
export interface ReportWindow {
  /** `'YYYY-MM-DD'`, inclusive. */
  from: string;
  /** `'YYYY-MM-DD'`, inclusive. */
  to: string;
}

/**
 * The parameter list and its `$n` allocator, as one object.
 *
 * The same `values`/`push` pair `listSales` builds inline, lifted because eight
 * statements here need it. Eight copies of a closure over one array is eight
 * chances to push a value and interpolate the wrong index, and the failure is a
 * report that answers with somebody else's date range rather than an error.
 *
 * `$1` is always the pharmacy id. Every statement is scoped by it and there is no
 * default: a report that forgot the tenant filter would not look wrong, it would
 * look like a good month.
 */
interface Params {
  readonly values: unknown[];
  push(value: unknown): string;
}

function paramsStartingWith(pharmacyId: string): Params {
  const values: unknown[] = [pharmacyId];
  return {
    values,
    push(value: unknown): string {
      values.push(value);
      return `$${values.length}`;
    },
  };
}

/**
 * The date window as one predicate on `<alias>.created_at`.
 *
 * The closing bound adds a day and compares with `<`. `created_at <= '2026-09-04'`
 * means midnight at the *start* of the 4th, so it quietly drops every sale made
 * that day — which on a report read at close of business is the whole point of
 * reading it. `listSales` does the same thing and for the same reason.
 */
function windowOn(alias: string, params: Params, window: ReportWindow): string {
  return [
    `${alias}.created_at >= (${params.push(window.from)}::date)::timestamp at time zone 'UTC'`,
    `${alias}.created_at < ((((${params.push(window.to)})::date) + 1)::timestamp at time zone 'UTC')`,
  ].join(' and ');
}

/** The calendar day a `timestamptz` falls on, in UTC. See the file header. */
function utcDay(alias: string): string {
  return `(${alias}.created_at at time zone 'UTC')::date`;
}

/**
 * The one status a report counts as money.
 *
 * A whitelist on `completed` rather than a blacklist on `voided`, for the reason
 * `refuseUnlessOpen` in `services/sales.service.ts` gives: `refunded` and
 * `partially_refunded` are members of `sale_status` that nothing in this build
 * writes, and a blacklist would admit them the day a refund path lands — counting
 * as takings a sale whose money has been handed back.
 *
 * `pending` is excluded and not hidden. A pending sale has stock already drawn
 * and payment not arrived, so counting it would report money that is not in the
 * drawer; dropping it silently would leave an owner staring at a zero on a day
 * five mobile-money charges are still settling. `reportStatusTotals` therefore
 * groups by *every* status and the service zero-fills the ones absent, so all
 * five are always on the page and the reader can see what was left out.
 */
const COMPLETED = `s.status = 'completed'::sale_status`;

/** One row per status present in the window. Drives both the summary and the exclusions. */
export interface StatusTotalRow {
  status: SaleStatus;
  /** `count(*)` is a bigint and arrives as a string; mapped to a number here. */
  saleCount: number;
  /** Decimal strings, as every `numeric` aggregate arrives. Never a double. */
  subtotal: string;
  discount: string;
  vatAmount: string;
  nhilAmount: string;
  getfundAmount: string;
  taxTotal: string;
  total: string;
  /**
   * Mean basket, or null when the status has no sales. Computed here rather than
   * divided in the service: a mean of two decimal strings is money arithmetic in
   * JavaScript, and `null` is the honest answer for an empty group where `'0.00'`
   * would read as "sold, for nothing".
   */
  averageTotal: string | null;
  patientSaleCount: number;
}

/** One calendar day of completed sales. */
export interface DailyRow {
  /** `'YYYY-MM-DD'`, because `database/pg-types.ts` stops the driver making it a `Date`. */
  day: string;
  saleCount: number;
  revenue: string;
  discount: string;
  taxTotal: string;
  costOfGoods: string;
  grossProfit: string;
}

/**
 * The window's profit, at the sale-line grain, in one row.
 *
 * Carries the revenue it took the profit from, because the two have to be read
 * together: `grossProfit` is `lineRevenue - costOfGoods` and a reader who is given
 * the difference without the minuend cannot check it. The takings half of the
 * summary comes from `reportStatusTotals` at the *sale* grain instead, and the two
 * revenues are the same money — `shared/src/basket.ts` builds `sales.total` as the
 * sum of its lines' totals and `basket.test.ts` pins that — but they are reported
 * from the grain each was computed at rather than one being derived from the other
 * in TypeScript.
 */
export interface ProfitTotalRow {
  lineCount: number;
  /** Σ `sale_items.line_total` over the window. */
  lineRevenue: string;
  costOfGoods: string;
  /** Negative when the window sold below cost. Never clamped to zero. */
  grossProfit: string;
  /** One decimal place, or null when there was no revenue to take a margin of. */
  grossMarginPercent: string | null;
  /**
   * Lines whose lots carry no cost at all. A batch received without a cost price
   * is stored at zero — `inventory.routes.ts` passes `costPrice ?? 0` — and its
   * profit is then the whole selling price. Reported rather than absorbed, because
   * a margin of 100% that nobody charged is the kind of figure an owner acts on.
   */
  zeroCostLines: number;
}

/** One product's contribution over the window. */
export interface ProductProfitRow {
  productId: string;
  /** The name the shelf carries now, not the receipt's snapshot. See the query. */
  name: string;
  lineCount: number;
  /**
   * Base units drawn from the lots — `sale_item_batches.quantity`, not
   * `sale_items.quantity`. The selling unit varies line to line (a product sold
   * both by the strip and by the tablet appears as both), so summing selling units
   * across lines would add strips to tablets. Base units are the one count that
   * means the same thing on every line of the same product.
   */
  baseUnits: number;
  revenue: string;
  costOfGoods: string;
  grossProfit: string;
  /** One decimal place, or null when there was no revenue to take a margin of. */
  grossMarginPercent: string | null;
  zeroCostLines: number;
}

/** One member of staff who served at least one sale in the window. */
export interface StaffRow {
  userId: string;
  fullName: string;
  role: UserRole;
  saleCount: number;
  revenue: string;
  discount: string;
  pendingCount: number;
  voidedCount: number;
}

/** One tender method, split by whether the money has arrived. */
export interface TenderRow {
  method: SalePaymentMethod;
  settledCount: number;
  settledAmount: string;
  /**
   * Charges asked for and not confirmed: a mobile-money tender still `pending`,
   * or one that `failed` or was `reversed`. Shown beside the settled figure
   * rather than folded into it, because a wallet debit that never arrived is the
   * one number a till operator is most likely to have already counted by hand.
   */
  unsettledCount: number;
  unsettledAmount: string;
}

/** What the cash drawer should hold at the end of the window. */
export interface DrawerRow {
  /** Σ settled cash tenders. The notes handed over, including any overpayment. */
  cashTaken: string;
  /** Σ `sales.change_given`. Only ever non-zero on a lone cash tender that overpaid. */
  changeGiven: string;
  /** `cashTaken - changeGiven`, and the figure a drawer count is compared against. */
  cashRetained: string;
}

/** One VAT treatment, for the return. */
export interface VatRow {
  treatment: VatTreatment;
  lineCount: number;
  /** The value the three charges were computed on. `sale_items.taxable_base`. */
  taxableBase: string;
  gross: string;
  discount: string;
  vatAmount: string;
  nhilAmount: string;
  getfundAmount: string;
  lineTotal: string;
}

/**
 * Every status in the window, with its money.
 *
 * Grouped by status and *not* filtered by it, so the summary and the list of
 * excluded sales come from one scan of `sales` and cannot disagree about what was
 * in the window. A second query for the pending figure would be a second
 * definition of "in this range", and the way two definitions differ is a report
 * whose parts add up to something the drawer does not.
 *
 * Every aggregate here is over a non-empty group — `group by` produces no row for
 * a status with no sales — so none of them can be NULL and none is coalesced.
 * Zero-filling the absent statuses is the service's job, in TypeScript, against
 * the exported `SALE_STATUSES` list, where a status added to the enum and not to
 * the report is a compile error rather than a missing row.
 */
export async function reportStatusTotals(
  sql: Sql,
  pharmacyId: string,
  window: ReportWindow
): Promise<StatusTotalRow[]> {
  const params = paramsStartingWith(pharmacyId);

  const result = await sql.query(
    `select s.status,
            count(*)                                         as sale_count,
            sum(s.subtotal)                                  as subtotal,
            sum(s.discount)                                  as discount,
            sum(s.vat_amount)                                as vat_amount,
            sum(s.nhil_amount)                               as nhil_amount,
            sum(s.getfund_amount)                            as getfund_amount,
            sum(s.tax_total)                                 as tax_total,
            sum(s.total)                                     as total,
            round(sum(s.total) / nullif(count(*), 0), 2)     as average_total,
            count(*) filter (where s.patient_id is not null) as patient_sale_count
       from sales s
      where s.pharmacy_id = $1
        and ${windowOn('s', params, window)}
   group by s.status
   order by s.status`,
    params.values
  );

  return result.rows.map((row) => ({
    status: row.status as SaleStatus,
    saleCount: Number(row.sale_count as string | number),
    subtotal: row.subtotal as string,
    discount: row.discount as string,
    vatAmount: row.vat_amount as string,
    nhilAmount: row.nhil_amount as string,
    getfundAmount: row.getfund_amount as string,
    taxTotal: row.tax_total as string,
    total: row.total as string,
    averageTotal: row.average_total === null ? null : (row.average_total as string),
    patientSaleCount: Number(row.patient_sale_count as string | number),
  }));
}

/**
 * Completed sales by calendar day, with the day's cost beside them.
 *
 * Three CTEs and two joins, because three grains are involved: the money is at the
 * sale grain, the cost is at the lot-draw grain, and the day is at neither. Each is
 * aggregated to its own key before anything is joined, which is the only way the
 * fan-out stays out of the figures — joining `sale_item_batches` straight onto
 * `sales` would count a sale's total once per lot any of its lines drew from.
 *
 * Cost is rounded to the pesewa *per sale line*, in `line_costs`, and every sum
 * above it is a sum of those rounded values. That is what makes the daily figures,
 * the per-product figures and the window total three views of one set of numbers
 * rather than three roundings of one set: rounding once per day here and once per
 * line in `reportProfitTotals` would leave a day and its own products a pesewa
 * apart, and an owner reconciling one against the other would find a difference
 * that is not there.
 *
 * The left join is complete by construction — a day cannot have a lot draw without
 * a completed sale — so `coalesce` on the cost is for a day whose lines all drew
 * nothing, not for a missing day.
 */
export async function reportDaily(
  sql: Sql,
  pharmacyId: string,
  window: ReportWindow
): Promise<DailyRow[]> {
  const params = paramsStartingWith(pharmacyId);

  const result = await sql.query(
    `with money as (
       select ${utcDay('s')} as day,
              count(*)         as sale_count,
              sum(s.total)     as revenue,
              sum(s.discount)  as discount,
              sum(s.tax_total) as tax_total
         from sales s
        where s.pharmacy_id = $1
          and ${COMPLETED}
          and ${windowOn('s', params, window)}
     group by ${utcDay('s')}
     ),
     line_costs as (
       select sib.sale_item_id,
              ${utcDay('s')}                            as day,
              round(sum(sib.quantity * sib.unit_cost), 2) as cost
         from sale_item_batches sib
         join sale_items si on si.id = sib.sale_item_id
         join sales s on s.id = si.sale_id
        where s.pharmacy_id = $1
          and ${COMPLETED}
          and ${windowOn('s', params, window)}
     group by sib.sale_item_id, ${utcDay('s')}
     ),
     cost as (
       select day, sum(cost) as cost_of_goods
         from line_costs
     group by day
     )
     select m.day,
            m.sale_count,
            m.revenue,
            m.discount,
            m.tax_total,
            coalesce(c.cost_of_goods, 0.00)             as cost_of_goods,
            m.revenue - coalesce(c.cost_of_goods, 0.00) as gross_profit
       from money m
       left join cost c on c.day = m.day
   order by m.day`,
    params.values
  );

  return result.rows.map((row) => ({
    day: row.day as string,
    saleCount: Number(row.sale_count as string | number),
    revenue: row.revenue as string,
    discount: row.discount as string,
    taxTotal: row.tax_total as string,
    costOfGoods: row.cost_of_goods as string,
    grossProfit: row.gross_profit as string,
  }));
}

/**
 * The window's revenue, cost, profit and margin, at the sale-line grain.
 *
 * An aggregate with no `group by` always returns exactly one row, so an empty
 * window is `lineCount` 0 and `'0.00'` rather than no answer — which is what lets
 * the service report a quiet day without a branch for it, and the page show a zero
 * rather than a blank it has to explain.
 *
 * Cost is rounded to the pesewa per line, inside the CTE, and every figure above
 * it is a sum of those rounded values. That is what makes this row, the daily rows
 * and the per-product rows three views of one set of numbers instead of three
 * roundings of one set: rounding once at the end of each grain separately would
 * leave them a pesewa apart, and an owner reconciling a day against its products
 * would find a difference that is not there.
 *
 * `raw_cost` is carried beside the rounded `cost` purely to answer the zero-cost
 * question honestly. Testing the rounded figure would count a line of one tablet
 * costing 0.004 cedis as having no cost at all, and the warning this feeds is
 * about a cost price nobody entered.
 */
export async function reportProfitTotals(
  sql: Sql,
  pharmacyId: string,
  window: ReportWindow
): Promise<ProfitTotalRow> {
  const params = paramsStartingWith(pharmacyId);

  const result = await sql.query(
    `with lines as (
       select si.id, si.line_total
         from sale_items si
         join sales s on s.id = si.sale_id
        where s.pharmacy_id = $1
          and ${COMPLETED}
          and ${windowOn('s', params, window)}
     ),
     line_costs as (
       select sib.sale_item_id,
              round(sum(sib.quantity * sib.unit_cost), 2) as cost,
              sum(sib.quantity * sib.unit_cost)           as raw_cost
         from sale_item_batches sib
        where sib.sale_item_id in (select id from lines)
     group by sib.sale_item_id
     ),
     totals as (
       select count(*)                                            as line_count,
              coalesce(sum(l.line_total), 0.00)                   as line_revenue,
              coalesce(sum(c.cost), 0.00)                         as cost_of_goods,
              count(*) filter (where coalesce(c.raw_cost, 0) = 0) as zero_cost_lines
         from lines l
         left join line_costs c on c.sale_item_id = l.id
     )
     select t.line_count,
            t.line_revenue,
            t.cost_of_goods,
            t.line_revenue - t.cost_of_goods as gross_profit,
            round(
              100 * (t.line_revenue - t.cost_of_goods) / nullif(t.line_revenue, 0),
              1
            )                                as gross_margin_percent,
            t.zero_cost_lines
       from totals t`,
    params.values
  );

  // One row, always. `rows[0]` is `| undefined` only because
  // `noUncheckedIndexedAccess` does not know what an ungrouped aggregate returns.
  const row = result.rows[0];
  return {
    lineCount: Number((row?.line_count ?? 0) as string | number),
    lineRevenue: (row?.line_revenue ?? '0.00') as string,
    costOfGoods: (row?.cost_of_goods ?? '0.00') as string,
    grossProfit: (row?.gross_profit ?? '0.00') as string,
    grossMarginPercent:
      row?.gross_margin_percent === null || row?.gross_margin_percent === undefined
        ? null
        : (row.gross_margin_percent as string),
    zeroCostLines: Number((row?.zero_cost_lines ?? 0) as string | number),
  };
}

/**
 * Products by gross profit over the window, most profitable first.
 *
 * Named from `inventory.name` rather than from `sale_items.description`. The
 * description is a snapshot and exists so a printed receipt cannot be rewritten
 * by a rename; a report read next month is the opposite case, because the owner
 * is looking for the product as the shelf names it today and a rename would
 * otherwise split one product's history across two labels. Grouping is by
 * `inventory_id`, so a rename merges the figures and changes only the word beside
 * them.
 *
 * The ordering ends in the product id, which makes it total. Without a final
 * tie-break, two products on the same profit come back in whatever order the
 * aggregate happened to produce, and the same report requested twice shows them
 * swapped — which reads as a bug in the numbers rather than in the sort.
 *
 * `limit`/`offset` page this list and nothing else: every other section is bounded
 * by something other than the data (five statuses, three treatments, two tenders,
 * one row per member of staff, one row per day in a window that
 * `services/reports.service.ts` caps at a year).
 */
export async function reportProductProfit(
  sql: Sql,
  pharmacyId: string,
  window: ReportWindow,
  limit: number,
  offset: number
): Promise<ProductProfitRow[]> {
  const params = paramsStartingWith(pharmacyId);

  const result = await sql.query(
    `with lines as (
       select si.id, si.inventory_id, si.line_total
         from sale_items si
         join sales s on s.id = si.sale_id
        where s.pharmacy_id = $1
          and ${COMPLETED}
          and ${windowOn('s', params, window)}
     ),
     line_costs as (
       select sib.sale_item_id,
              round(sum(sib.quantity * sib.unit_cost), 2) as cost,
              sum(sib.quantity * sib.unit_cost)           as raw_cost,
              sum(sib.quantity)                           as base_units
         from sale_item_batches sib
        where sib.sale_item_id in (select id from lines)
     group by sib.sale_item_id
     )
     select l.inventory_id                       as product_id,
            i.name,
            count(*)                             as line_count,
            coalesce(sum(c.base_units), 0)       as base_units,
            sum(l.line_total)                    as revenue,
            coalesce(sum(c.cost), 0.00)          as cost_of_goods,
            sum(l.line_total) - coalesce(sum(c.cost), 0.00) as gross_profit,
            round(
              100 * (sum(l.line_total) - coalesce(sum(c.cost), 0.00))
                  / nullif(sum(l.line_total), 0),
              1
            )                                    as gross_margin_percent,
            count(*) filter (where coalesce(c.raw_cost, 0) = 0) as zero_cost_lines
       from lines l
       left join line_costs c on c.sale_item_id = l.id
       join inventory i on i.id = l.inventory_id
   group by l.inventory_id, i.name
   order by gross_profit desc, revenue desc, i.name, l.inventory_id
      limit ${params.push(limit)} offset ${params.push(offset)}`,
    params.values
  );

  return result.rows.map((row) => ({
    productId: row.product_id as string,
    name: row.name as string,
    lineCount: Number(row.line_count as string | number),
    baseUnits: Number(row.base_units as string | number),
    revenue: row.revenue as string,
    costOfGoods: row.cost_of_goods as string,
    grossProfit: row.gross_profit as string,
    // NULL from the `nullif`, which is the honest answer for a product sold
    // entirely at zero: there is no revenue to take a percentage of, and 0% would
    // read as "sold at cost".
    grossMarginPercent: row.gross_margin_percent === null ? null : (row.gross_margin_percent as string),
    zeroCostLines: Number(row.zero_cost_lines as string | number),
  }));
}

/**
 * Per member of staff, every status counted separately.
 *
 * Reached from `sales` rather than from `users`, so the list is the people who
 * actually served in the window and not the whole roster with zeros beside most
 * of it. A performance report listing four staff who sold nothing is not more
 * informative than one listing the two who did — but it does look like a complete
 * staff list, and `services/reports.service.ts` says in the response that it is
 * not one.
 *
 * Voided and pending counts are per person because they are the two figures an
 * owner actually asks about: a till with an unusual number of voids is either a
 * training problem or a dishonesty problem, and neither is visible in takings
 * alone, because a void removes the takings.
 */
export async function reportStaff(
  sql: Sql,
  pharmacyId: string,
  window: ReportWindow
): Promise<StaffRow[]> {
  const params = paramsStartingWith(pharmacyId);

  const result = await sql.query(
    `select u.id          as user_id,
            u.full_name,
            u.role,
            count(*) filter (where s.status = 'completed'::sale_status) as sale_count,
            coalesce(
              sum(s.total) filter (where s.status = 'completed'::sale_status),
              0.00
            ) as revenue,
            coalesce(
              sum(s.discount) filter (where s.status = 'completed'::sale_status),
              0.00
            ) as discount,
            count(*) filter (where s.status = 'pending'::sale_status) as pending_count,
            count(*) filter (where s.status = 'voided'::sale_status)  as voided_count
       from sales s
       join users u on u.id = s.served_by
      where s.pharmacy_id = $1
        and ${windowOn('s', params, window)}
   group by u.id, u.full_name, u.role
   order by revenue desc, u.full_name, u.id`,
    params.values
  );

  return result.rows.map((row) => ({
    userId: row.user_id as string,
    fullName: row.full_name as string,
    role: row.role as UserRole,
    saleCount: Number(row.sale_count as string | number),
    revenue: row.revenue as string,
    discount: row.discount as string,
    pendingCount: Number(row.pending_count as string | number),
    voidedCount: Number(row.voided_count as string | number),
  }));
}

/**
 * Tender totals by method, split into money that has arrived and money that has
 * not.
 *
 * Over completed sales only. A `pending` sale's tenders are unsettled by
 * definition and its revenue is not counted either, so including them here would
 * report a wallet charge against takings the same report says were not taken.
 *
 * `succeeded` is the split rather than "not failed". A mobile-money tender still
 * `pending` is neither arrived nor refused — the gateway has been asked and has
 * not answered — and putting it in the settled column is how a drawer stops
 * reconciling at close of business with no visible reason.
 */
export async function reportTenders(
  sql: Sql,
  pharmacyId: string,
  window: ReportWindow
): Promise<TenderRow[]> {
  const params = paramsStartingWith(pharmacyId);

  const result = await sql.query(
    `select sp.method,
            count(*) filter (where sp.status = 'succeeded'::sale_payment_status) as settled_count,
            coalesce(
              sum(sp.amount) filter (where sp.status = 'succeeded'::sale_payment_status),
              0.00
            ) as settled_amount,
            count(*) filter (where sp.status <> 'succeeded'::sale_payment_status) as unsettled_count,
            coalesce(
              sum(sp.amount) filter (where sp.status <> 'succeeded'::sale_payment_status),
              0.00
            ) as unsettled_amount
       from sale_payments sp
       join sales s on s.id = sp.sale_id
      where s.pharmacy_id = $1
        and ${COMPLETED}
        and ${windowOn('s', params, window)}
   group by sp.method
   order by sp.method`,
    params.values
  );

  return result.rows.map((row) => ({
    method: row.method as SalePaymentMethod,
    settledCount: Number(row.settled_count as string | number),
    settledAmount: row.settled_amount as string,
    unsettledCount: Number(row.unsettled_count as string | number),
    unsettledAmount: row.unsettled_amount as string,
  }));
}

/**
 * What the cash drawer should hold, and the two figures it is made of.
 *
 * A cash tender is stored at the amount handed over, not the amount applied: a
 * GHS 50 note against a GHS 45 basket is a `sale_payments` row of 50.00 and a
 * `sales.change_given` of 5.00, because `utils/settlement.ts` decides change for
 * the whole basket rather than per tender. Summing the tenders alone therefore
 * overstates the drawer by exactly the change given back, and the overstatement is
 * invisible on any day that had a single overpaid cash sale — which is most days.
 *
 * All three figures come out of one statement, in `numeric`, so the difference is
 * exact and can be negative without anybody in TypeScript having to format a
 * negative amount. The two CTEs are cross-joined because each returns exactly one
 * row: one is an aggregate over the tenders and the other over the sales, and a
 * cross join of two single-row relations is a single row.
 *
 * Both halves are over `completed` sales in the same window, so a void removes its
 * tender and its change together. Counting one and not the other is the only way
 * this figure could drift, and it would drift by the change on exactly the sales
 * that were cancelled.
 */
export async function reportDrawer(
  sql: Sql,
  pharmacyId: string,
  window: ReportWindow
): Promise<DrawerRow> {
  const params = paramsStartingWith(pharmacyId);

  const result = await sql.query(
    `with taken as (
       select coalesce(
                sum(sp.amount) filter (
                  where sp.method = 'cash'::sale_payment_method
                    and sp.status = 'succeeded'::sale_payment_status
                ),
                0.00
              ) as cash_taken
         from sale_payments sp
         join sales s on s.id = sp.sale_id
        where s.pharmacy_id = $1
          and ${COMPLETED}
          and ${windowOn('s', params, window)}
     ),
     given_back as (
       select coalesce(sum(s.change_given), 0.00) as change_given
         from sales s
        where s.pharmacy_id = $1
          and ${COMPLETED}
          and ${windowOn('s', params, window)}
     )
     select t.cash_taken,
            g.change_given,
            t.cash_taken - g.change_given as cash_retained
       from taken t
       cross join given_back g`,
    params.values
  );

  const row = result.rows[0];
  return {
    cashTaken: (row?.cash_taken ?? '0.00') as string,
    changeGiven: (row?.change_given ?? '0.00') as string,
    cashRetained: (row?.cash_retained ?? '0.00') as string,
  };
}

/**
 * The output-tax side of a VAT return, grouped by treatment.
 *
 * Every figure is a stored column, not a rate applied now. `sale_items` carries
 * the amounts the till computed at the moment of sale from the rates snapshotted
 * onto `sales`, so a return for June read in September still says what June
 * charged — which is the only thing a return to GRA can say. Recomputing from
 * today's `pharmacies` settings would restate history every time the owner
 * changed a rate, and the restatement would be invisible: the numbers would all
 * still look right.
 *
 * Grouped by treatment and not filtered by it, so an exempt-only pharmacy gets one
 * row and a pharmacy that has started selling standard-rated goods gets two, from
 * the same statement. The service zero-fills the treatments absent from the window
 * against the shared `VAT_TREATMENTS` list, because a return that omits the
 * zero-rated line reads as "no zero-rated supplies" only if the reader knows the
 * line should have been there.
 */
export async function reportVat(
  sql: Sql,
  pharmacyId: string,
  window: ReportWindow
): Promise<VatRow[]> {
  const params = paramsStartingWith(pharmacyId);

  const result = await sql.query(
    `select si.vat_treatment,
            count(*)                 as line_count,
            sum(si.taxable_base)     as taxable_base,
            sum(si.line_gross)       as gross,
            sum(si.line_discount)    as discount,
            sum(si.vat_amount)       as vat_amount,
            sum(si.nhil_amount)      as nhil_amount,
            sum(si.getfund_amount)   as getfund_amount,
            sum(si.line_total)       as line_total
       from sale_items si
       join sales s on s.id = si.sale_id
      where s.pharmacy_id = $1
        and ${COMPLETED}
        and ${windowOn('s', params, window)}
   group by si.vat_treatment
   order by si.vat_treatment`,
    params.values
  );

  return result.rows.map((row) => ({
    treatment: row.vat_treatment as VatTreatment,
    lineCount: Number(row.line_count as string | number),
    taxableBase: row.taxable_base as string,
    gross: row.gross as string,
    discount: row.discount as string,
    vatAmount: row.vat_amount as string,
    nhilAmount: row.nhil_amount as string,
    getfundAmount: row.getfund_amount as string,
    lineTotal: row.line_total as string,
  }));
}
