import type { QueryResult, QueryResultRow } from 'pg';
import type { Sql } from '../database/pool';
import {
  reportDaily,
  reportDrawer,
  reportProductProfit,
  reportProfitTotals,
  reportStaff,
  reportStatusTotals,
  reportTenders,
  reportVat,
  type ReportWindow,
} from '../repositories/reports.repository';

/**
 * The SQL the reports repository emits.
 *
 * `services/reports.service.ts` decides what a report includes; this module decides
 * whether the figures it includes are the figures the database holds. Three of the
 * failures pinned here are invisible in every other suite, and all three answer with
 * a plausible number rather than an error:
 *
 *   - A join across two grains multiplies rows. `sum(si.line_total)` over a join to
 *     `sale_item_batches` counts a line once per lot it was drawn from, so a strip of
 *     ten tablets paid for out of two lots reports twice its revenue. No exception,
 *     no NULL — a takings figure that is simply twice what the drawer holds.
 *   - A closing bound written as `created_at <= '2026-09-05'` means midnight at the
 *     *start* of the 5th, so a report read at close of business quietly excludes the
 *     whole day it was asked for. Again no error: every other day is right.
 *   - A day bucket derived from the session timezone rather than UTC disagrees with
 *     the window bounds on any host whose `TimeZone` is not UTC, and the disagreement
 *     is a first and last day short by a few hours — which still adds up to something
 *     that looks like a month.
 *
 * All three are proved against a real server by `database/tests/assertions.sql`; what
 * is asserted here is the statement text, because a shape that is right today and
 * edited wrong tomorrow has to fail somewhere a reviewer will see it.
 */

interface Call {
  text: string;
  params: unknown[];
}

/** Collapses whitespace, so a reformat is not a failure but a rewrite is. */
function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

type Outcome = { rows: Record<string, unknown>[] } | { error: unknown };

interface Recorder {
  sql: Sql;
  calls: Call[];
  queueRows: (rows: Record<string, unknown>[]) => void;
  queueError: (error: unknown) => void;
  alwaysEmpty: () => void;
}

/**
 * Records every call and then decides what to answer.
 *
 * The same harness `notifications.repository.test.ts` uses. One implementation
 * rather than `mockResolvedValueOnce` replacing it, because a replacement would
 * skip the recording and half of what is asserted here is how many parameters a
 * statement carries and in what order.
 */
function recorder(): Recorder {
  const calls: Call[] = [];
  const scripted: Outcome[] = [];
  let fallback: Record<string, unknown>[] = [];

  const sql: Sql = {
    query<T extends QueryResultRow>(
      text: string,
      values?: readonly unknown[]
    ): Promise<QueryResult<T>> {
      calls.push({ text: normalise(text), params: [...(values ?? [])] });

      const outcome = scripted.shift();
      if (outcome !== undefined && 'error' in outcome) {
        return Promise.reject(outcome.error);
      }
      const rows = outcome !== undefined ? outcome.rows : fallback;
      return Promise.resolve({
        rows: rows as unknown as T[],
        rowCount: rows.length,
        oid: 0,
        fields: [],
        command: '',
      });
    },
  };

  return {
    sql,
    calls,
    queueRows: (rows) => scripted.push({ rows }),
    queueError: (error) => scripted.push({ error }),
    alwaysEmpty: () => {
      fallback = [];
    },
  };
}

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const PRODUCT = 'a0000000-0000-4000-8000-000000000010';
const USER = 'a0000000-0000-4000-8000-000000000002';

/** Five days, so an off-by-one on either bound moves a figure the test can see. */
const WINDOW: ReportWindow = { from: '2026-09-01', to: '2026-09-05' };

function onlyCall(calls: Call[]): Call {
  if (calls.length !== 1) {
    throw new Error(`expected exactly one query, saw ${calls.length}: ${JSON.stringify(calls)}`);
  }
  const first = calls[0];
  if (first === undefined) throw new Error('unreachable: the length was checked above');
  return first;
}

/** One statement per function, driven once each, in a fixed order. */
async function everyStatement(): Promise<Call[]> {
  const calls: Call[] = [];

  const take = async (run: (sql: Sql) => Promise<unknown>): Promise<Call> => {
    const { sql, calls: recorded } = recorder();
    await run(sql);
    return onlyCall(recorded);
  };

  calls.push(await take((sql) => reportStatusTotals(sql, PHARMACY, WINDOW)));
  calls.push(await take((sql) => reportDaily(sql, PHARMACY, WINDOW)));
  calls.push(await take((sql) => reportProfitTotals(sql, PHARMACY, WINDOW)));
  calls.push(await take((sql) => reportProductProfit(sql, PHARMACY, WINDOW, 50, 0)));
  calls.push(await take((sql) => reportStaff(sql, PHARMACY, WINDOW)));
  calls.push(await take((sql) => reportTenders(sql, PHARMACY, WINDOW)));
  calls.push(await take((sql) => reportDrawer(sql, PHARMACY, WINDOW)));
  calls.push(await take((sql) => reportVat(sql, PHARMACY, WINDOW)));

  return calls;
}

/** The six statements that report money as taken, and must therefore count `completed` only. */
async function takingsStatements(): Promise<Call[]> {
  const all = await everyStatement();
  // Index 0 is `reportStatusTotals` and index 4 is `reportStaff`, the two that read
  // every status on purpose. Named by position against `everyStatement` so that a
  // function added there without a decision here shows up as a wrong slice rather
  // than as a silently uncovered statement.
  return [all[1], all[2], all[3], all[5], all[6], all[7]].filter(
    (call): call is Call => call !== undefined
  );
}

function statusRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'completed',
    // A bigint, as `pg` hands one back.
    sale_count: '12',
    subtotal: '1000.00',
    discount: '20.00',
    vat_amount: '0.00',
    nhil_amount: '0.00',
    getfund_amount: '0.00',
    tax_total: '0.00',
    total: '980.00',
    average_total: '81.67',
    patient_sale_count: '3',
    ...overrides,
  };
}

function dailyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // A `date`, which `database/pg-types.ts` deliberately leaves as the string it
    // came over the wire as rather than turning into a `Date` at local midnight.
    day: '2026-09-03',
    sale_count: '4',
    revenue: '210.00',
    discount: '5.00',
    tax_total: '0.00',
    cost_of_goods: '140.00',
    gross_profit: '70.00',
    ...overrides,
  };
}

function productRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product_id: PRODUCT,
    name: 'Paracetamol 500mg',
    line_count: '6',
    base_units: '60',
    revenue: '120.00',
    cost_of_goods: '72.00',
    gross_profit: '48.00',
    gross_margin_percent: '40.0',
    zero_cost_lines: '0',
    ...overrides,
  };
}

/**
 * One row of the staff report, shaped as `pg` hands it back.
 *
 * Every count is a string, because `count(*)` is a bigint and node-postgres
 * parses bigints as strings rather than risk losing precision above 2^53. Three
 * of this mapper's fields depend on that being converted, and both suites that
 * read a staff report mock this module — so this fixture is the only place the
 * conversion is ever exercised.
 */
function staffRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: USER,
    full_name: 'Ama Mensah',
    role: 'pharmacist',
    sale_count: '8',
    revenue: '640.00',
    discount: '10.00',
    pending_count: '1',
    voided_count: '2',
    ...overrides,
  };
}

describe('the window every statement is bounded by', () => {
  it('puts the pharmacy id first, in all eight statements, and never pushes it twice', async () => {
    // A second push of the pharmacy id would shift every later index by one, and
    // the statements would still parse: the dates would land where the id was and
    // the report would answer for a range nobody asked for.
    const calls = await everyStatement();
    expect(calls.length).toBe(8);
    for (const call of calls) {
      expect(call.params[0]).toBe(PHARMACY);
      expect(call.text).toContain('s.pharmacy_id = $1');
      expect(call.params.filter((value) => value === PHARMACY)).toHaveLength(1);
    }
  });

  it('passes the two dates as date-only strings, in the order the caller gave them', async () => {
    const calls = await everyStatement();
    for (const call of calls) {
      expect(call.params[1]).toBe('2026-09-01');
      expect(call.params[2]).toBe('2026-09-05');
    }
  });

  it('opens the window at the start of the first day and closes it at the start of the day after the last', async () => {
    const calls = await everyStatement();
    for (const call of calls) {
      expect(call.text).toContain(`s.created_at >= ($2::date)::timestamp at time zone 'UTC'`);
      // `+ 1` and `<`, not `<=` on the closing day. `created_at <= '2026-09-05'` is
      // midnight at the start of the 5th and drops every sale made that day.
      expect(call.text).toContain(
        `s.created_at < (((($3)::date) + 1)::timestamp at time zone 'UTC')`
      );
      expect(call.text).not.toContain('created_at <=');
    }
  });

  it('pins both bounds to UTC rather than to the connection timezone', async () => {
    // `at time zone 'UTC'` on both sides. Without it the bounds follow the server's
    // `TimeZone` setting and the report a container in one region produces is not
    // the report the same data produces in another.
    const calls = await everyStatement();
    for (const call of calls) {
      const bounds = call.text.match(/created_at [<>]=?[^,]*?at time zone 'UTC'/g) ?? [];
      expect(bounds.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('buckets days in the same UTC the bounds use, so a daily row cannot fall outside its own window', async () => {
    const { sql, calls } = recorder();
    await reportDaily(sql, PHARMACY, WINDOW);

    const text = onlyCall(calls).text;
    expect(text).toContain(`(s.created_at at time zone 'UTC')::date as day`);
    // `date_trunc('day', ...)` is the obvious thing to write and the wrong one: it
    // truncates in the session timezone, so on a host east of UTC the first and
    // last days of the report are short by the offset.
    expect(text).not.toContain('date_trunc');
  });

  it('asks for a second window where a statement needs two, rather than reusing the first parameters', async () => {
    // `reportDaily` and `reportDrawer` each hold two aggregates over the same range,
    // in separate CTEs. Both must be bounded; a CTE that forgot its window would
    // scan the pharmacy's whole history and still return a plausible figure.
    for (const run of [
      (sql: Sql) => reportDaily(sql, PHARMACY, WINDOW),
      (sql: Sql) => reportDrawer(sql, PHARMACY, WINDOW),
    ]) {
      const { sql, calls } = recorder();
      await run(sql);
      const call = onlyCall(calls);
      expect(call.params).toEqual([PHARMACY, WINDOW.from, WINDOW.to, WINDOW.from, WINDOW.to]);
      expect(call.text).toContain('$4::date');
      expect(call.text).toContain('$5)::date');
    }
  });
});

describe('what counts as money', () => {
  it('counts completed sales, and only completed sales, in every statement that reports takings', async () => {
    const calls = await takingsStatements();
    expect(calls).toHaveLength(6);
    for (const call of calls) {
      expect(call.text).toContain(`s.status = 'completed'::sale_status`);
    }
  });

  it('casts every enum literal it compares, so no comparison is left for the parser to deduce', async () => {
    // The landmine in `sales.repository.ts`'s header is a *parameter* beside an enum
    // column. These are literals, so nothing can go wrong today — and the casts are
    // asserted anyway, because the edit that introduces a status filter parameter is
    // the edit that stops being safe, and it should not also have to remember this.
    const calls = await everyStatement();
    for (const call of calls) {
      const bare = call.text.match(/status\s*(?:=|<>)\s*'[a-z_]+'(?!::)/g) ?? [];
      expect(bare).toEqual([]);
    }
  });

  it('groups by every status rather than filtering, so what a report leaves out is on the report', async () => {
    const { sql, calls } = recorder();
    await reportStatusTotals(sql, PHARMACY, WINDOW);

    const text = onlyCall(calls).text;
    expect(text).toContain('group by s.status');
    // No status is named here. Naming `completed` in this statement is how the
    // pending and voided counts disappear, and they are the figures that explain a
    // takings total lower than the day felt.
    expect(text).not.toContain("'completed'");
    expect(text).not.toContain("'voided'");
    expect(text).not.toContain("'pending'");
  });

  it('filters no status at all for staff, so a void is attributable to whoever made it', async () => {
    const { sql, calls } = recorder();
    await reportStaff(sql, PHARMACY, WINDOW);

    const text = onlyCall(calls).text;
    const whereClause = text.slice(text.indexOf('where s.pharmacy_id'), text.indexOf('group by'));
    expect(whereClause).not.toContain('s.status');
    expect(text).toContain(`count(*) filter (where s.status = 'voided'::sale_status)`);
    expect(text).toContain(`count(*) filter (where s.status = 'pending'::sale_status)`);
  });

  it('splits tenders by whether the money arrived, rather than by whether the charge failed', async () => {
    const { sql, calls } = recorder();
    await reportTenders(sql, PHARMACY, WINDOW);

    const text = onlyCall(calls).text;
    // `<> 'succeeded'` and not `= 'pending'`: a `failed` or `reversed` charge is
    // neither arrived nor awaiting, and a split that named only `pending` would put
    // both in the settled column.
    expect(text).toContain(`sp.status <> 'succeeded'::sale_payment_status`);
    expect(text).toContain(`sp.status = 'succeeded'::sale_payment_status`);
    expect(text).not.toContain("'pending'");
  });

  it('takes the change out of the cash drawer figure, in the same statement that counts the cash', async () => {
    const { sql, calls } = recorder();
    await reportDrawer(sql, PHARMACY, WINDOW);

    const text = onlyCall(calls).text;
    // A cash tender is stored at the note handed over, so the drawer is the tenders
    // less the change. Both halves over `completed` sales, so a void removes its
    // tender and its change together.
    expect(text).toContain('t.cash_taken - g.change_given as cash_retained');
    expect(text).toContain(`sp.method = 'cash'::sale_payment_method`);
    expect(text).toContain('coalesce(sum(s.change_given), 0.00) as change_given');
    expect(text.match(/s\.status = 'completed'::sale_status/g) ?? []).toHaveLength(2);
  });

  it('reads the VAT return from the stored amounts, never from a rate applied now', async () => {
    const { sql, calls } = recorder();
    await reportVat(sql, PHARMACY, WINDOW);

    const text = onlyCall(calls).text;
    expect(text).toContain('group by si.vat_treatment');
    for (const column of [
      'sum(si.taxable_base)',
      'sum(si.vat_amount)',
      'sum(si.nhil_amount)',
      'sum(si.getfund_amount)',
    ]) {
      expect(text).toContain(column);
    }
    // Recomputing from `pharmacies.vat_rate` would restate every past return the
    // moment the owner changed a rate, and the restated figures would still look
    // right — which is what makes it worth pinning the columns instead.
    expect(text).not.toContain('pharmacies');
    expect(text).not.toContain('vat_rate');
  });
});

describe('the fan-out two grains invite', () => {
  /**
   * The three statements that read two grains at once, and the join each one must
   * make after aggregating.
   *
   * The join is named per statement rather than matched with one regex wide enough
   * for all three. `reportDaily` aggregates to a third grain as well — the day — so
   * its outer join is on the day and not on the line, and a pattern loose enough to
   * accept both shapes would also accept a join that is neither. A test that can
   * pass against a rewrite is not pinning the shape it claims to.
   */
  const twoGrainStatements = [
    {
      name: 'reportDaily',
      run: (sql: Sql) => reportDaily(sql, PHARMACY, WINDOW),
      join: 'left join cost c on c.day = m.day',
    },
    {
      name: 'reportProfitTotals',
      run: (sql: Sql) => reportProfitTotals(sql, PHARMACY, WINDOW),
      join: 'left join line_costs c on c.sale_item_id = l.id',
    },
    {
      name: 'reportProductProfit',
      run: (sql: Sql) => reportProductProfit(sql, PHARMACY, WINDOW, 50, 0),
      join: 'left join line_costs c on c.sale_item_id = l.id',
    },
  ];

  it.each(twoGrainStatements)(
    '$name aggregates the lot draws before joining them to the sale lines',
    async ({ run, join }) => {
      const { sql, calls } = recorder();
      await run(sql);
      const text = onlyCall(calls).text;

      // The junction is summed to one row per sale line inside its own CTE...
      expect(text).toContain('group by sib.sale_item_id');
      // ...and only that aggregate is joined to the money. Joining `sale_item_batches`
      // straight onto `sale_items` would repeat a line once per lot it drew from and
      // multiply its revenue by the number of lots.
      expect(text).toContain(join);
      const outer = text.slice(text.lastIndexOf('select'));
      expect(outer).not.toContain('sale_item_batches');
    }
  );

  it.each(twoGrainStatements)(
    '$name rounds a lot cost to the pesewa once, per line, before any sum above it',
    async ({ run }) => {
      const { sql, calls } = recorder();
      await run(sql);
      const text = onlyCall(calls).text;

      // `unit_cost` is `numeric(12, 4)`. Rounded inside the per-line aggregate, so
      // the daily rows, the product rows and the window total are three views of one
      // set of numbers rather than three roundings of one set — rounding at each
      // grain separately leaves them a pesewa apart, and an owner reconciling a day
      // against its products would find a difference that is not there.
      expect(text).toContain('round(sum(sib.quantity * sib.unit_cost), 2)');
    }
  );

  it('carries the unrounded cost beside the rounded one, and uses only the unrounded one to decide a line had no cost', async () => {
    const { sql, calls } = recorder();
    await reportProfitTotals(sql, PHARMACY, WINDOW);

    const text = onlyCall(calls).text;
    expect(text).toContain('sum(sib.quantity * sib.unit_cost) as raw_cost');
    // Testing the rounded figure would call a line of one tablet at 0.004 cedis a
    // line with no cost price, and the warning this feeds is about a price nobody
    // entered.
    expect(text).toContain('count(*) filter (where coalesce(c.raw_cost, 0) = 0)');
  });

  it('counts base units and not selling units, because a product sold both ways has two of them', async () => {
    const { sql, calls } = recorder();
    await reportProductProfit(sql, PHARMACY, WINDOW, 50, 0);

    const text = onlyCall(calls).text;
    expect(text).toContain('sum(sib.quantity) as base_units');
    // `sale_items.quantity` is selling units. Summing it across lines of one product
    // adds strips to tablets; the base units from the junction are the one count that
    // means the same thing on every line.
    expect(text).not.toContain('sum(l.quantity)');
    expect(text).not.toContain('sum(si.quantity)');
  });

  it('names a product from the shelf, and groups it by id, so a rename merges the history instead of splitting it', async () => {
    const { sql, calls } = recorder();
    await reportProductProfit(sql, PHARMACY, WINDOW, 50, 0);

    const text = onlyCall(calls).text;
    expect(text).toContain('join inventory i on i.id = l.inventory_id');
    expect(text).toContain('group by l.inventory_id, i.name');
    expect(text).not.toContain('si.description');
  });

  it('ends every ordering with something unique, so the same report read twice lists the same order', async () => {
    const { sql, calls } = recorder();
    await reportProductProfit(sql, PHARMACY, WINDOW, 50, 0);

    const text = onlyCall(calls).text;
    // Two products on the same profit are a tie, and a tie with no final key comes
    // back in whatever order the aggregate produced — so the page reshuffles between
    // refreshes and reads as a bug in the numbers.
    expect(text).toContain('order by gross_profit desc, revenue desc, i.name, l.inventory_id');
  });
});

describe('the mappers', () => {
  it('turns a bigint count into a number and leaves a numeric amount as the string it arrived as', async () => {
    const { sql, queueRows } = recorder();
    queueRows([statusRow()]);

    const [row] = await reportStatusTotals(sql, PHARMACY, WINDOW);
    expect(row?.saleCount).toBe(12);
    expect(row?.patientSaleCount).toBe(3);
    // Not `980`, not `980.0`. A double here is how a takings report arrives a pesewa
    // away from the drawer.
    expect(row?.total).toBe('980.00');
    expect(row?.subtotal).toBe('1000.00');
    expect(row?.discount).toBe('20.00');
  });

  it('maps a staff row, converting all three bigint counts and keeping the money as strings', async () => {
    const { sql, queueRows } = recorder();
    queueRows([staffRow()]);

    const [row] = await reportStaff(sql, PHARMACY, WINDOW);

    // `toEqual` is what makes this an assertion about types and not just values:
    // a `saleCount` of `'8'` does not equal `8`. Replacing the mapper's `Number()`
    // with a cast compiles, because the cast asserts what the mapper wants rather
    // than what the driver produced, and the report then ships a string into every
    // sum the service does over it.
    expect(row).toEqual({
      userId: USER,
      fullName: 'Ama Mensah',
      role: 'pharmacist',
      saleCount: 8,
      revenue: '640.00',
      discount: '10.00',
      pendingCount: 1,
      voidedCount: 2,
    });
  });

  it('hands a date bucket back as the string the driver produced, not as a `Date`', async () => {
    const { sql, queueRows } = recorder();
    queueRows([dailyRow()]);

    const [row] = await reportDaily(sql, PHARMACY, WINDOW);
    expect(row?.day).toBe('2026-09-03');
  });

  it('maps a NULL margin to null rather than to a zero that reads as "sold at cost"', async () => {
    const { sql, queueRows } = recorder();
    queueRows([productRow({ gross_margin_percent: null })]);

    const [row] = await reportProductProfit(sql, PHARMACY, WINDOW, 50, 0);
    expect(row?.grossMarginPercent).toBeNull();
  });

  it('keeps a negative gross profit negative', async () => {
    const { sql, queueRows } = recorder();
    queueRows([productRow({ revenue: '50.00', cost_of_goods: '62.00', gross_profit: '-12.00' })]);

    const [row] = await reportProductProfit(sql, PHARMACY, WINDOW, 50, 0);
    // A below-cost week is a fact about the pharmacy. Clamping it, or refusing it,
    // would both be a report that cannot say the thing that most needs saying.
    expect(row?.grossProfit).toBe('-12.00');
  });

  it('answers a zeroed row from the two single-row statements when the window is empty', async () => {
    const profit = recorder();
    profit.alwaysEmpty();
    expect(await reportProfitTotals(profit.sql, PHARMACY, WINDOW)).toEqual({
      lineCount: 0,
      lineRevenue: '0.00',
      costOfGoods: '0.00',
      grossProfit: '0.00',
      grossMarginPercent: null,
      zeroCostLines: 0,
    });

    const drawer = recorder();
    drawer.alwaysEmpty();
    expect(await reportDrawer(drawer.sql, PHARMACY, WINDOW)).toEqual({
      cashTaken: '0.00',
      changeGiven: '0.00',
      cashRetained: '0.00',
    });
  });

  it('returns no row for a status the window has none of, and leaves the zero-filling to the service', async () => {
    const { sql, queueRows } = recorder();
    queueRows([statusRow({ status: 'completed' })]);

    const rows = await reportStatusTotals(sql, PHARMACY, WINDOW);
    expect(rows.map((row) => row.status)).toEqual(['completed']);
  });

  it('passes a database error through rather than answering an empty report', async () => {
    const { sql, queueError } = recorder();
    const failure = new Error('connection terminated');
    queueError(failure);

    // An empty report and a failed one look identical on the page unless the failure
    // travels, and "no sales today" is the one thing a report must not say by accident.
    await expect(reportStatusTotals(sql, PHARMACY, WINDOW)).rejects.toBe(failure);
  });
});

describe('the page a product list is cut to', () => {
  it('binds limit and offset after the window, in that order', async () => {
    const { sql, calls } = recorder();
    await reportProductProfit(sql, PHARMACY, WINDOW, 20, 40);

    const call = onlyCall(calls);
    expect(call.params).toEqual([PHARMACY, WINDOW.from, WINDOW.to, 20, 40]);
    expect(call.text).toContain('limit $4 offset $5');
  });

  it('pages the product list and no other section', async () => {
    // Every other section is bounded by something other than the data: five
    // statuses, three treatments, two tenders, one row per member of staff, one row
    // per day in a window the service caps at a year. A `limit` on any of them would
    // be a report that silently omits a line.
    const calls = await everyStatement();
    const paged = calls.filter((call) => call.text.includes('limit'));
    expect(paged).toHaveLength(1);
    expect(paged[0]?.text).toContain('group by l.inventory_id, i.name');
  });
});
