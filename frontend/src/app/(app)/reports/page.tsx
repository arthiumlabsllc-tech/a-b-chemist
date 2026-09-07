'use client';

/**
 * Reports. `/reports`, gated by `reports:read`.
 *
 * One request, one window, eight sections: the headline figures, the breakdown by
 * status, the day-by-day takings, the profit and the products behind it, who served
 * what, how the money was tendered, what the cash drawer should hold, and the VAT
 * position for a return. The API returns them as one bundle for the reason given in
 * `api-types.ts` — a page showing takings from Tuesday beside a VAT return from
 * Monday is not obviously wrong, it is just wrong — so this page never fetches a
 * section on its own.
 *
 * ## Three rules this page is built around
 *
 * **The heading follows the data, not the inputs.** Everything below the range
 * picker describes `report.range`, the window the API resolved, never the two dates
 * in the boxes. An end left empty is filled with today by the server, and a page
 * that showed its own empty input would say nothing about which day it was reading.
 * While a new window is being drawn the previous report stays on screen under its
 * own heading, so the figures and their label cannot drift apart.
 *
 * **No money arithmetic happens here.** Every total, margin and difference is the
 * API's own decimal string, rendered through `Money`. Adding a column of `numeric`
 * strings in the browser means converting them to floats, and that is how a fraction
 * of a pesewa reaches a figure somebody then compares against a drawer count. Where
 * a total is wanted and the API does not send one, the section says so rather than
 * computing it.
 *
 * **A zero is only shown next to what is not in it.** `uncountedSaleCount`,
 * `zeroCostLines` and the `counted` flag on each status exist so a headline of zero
 * cannot be read as a day with no trade, and a gross profit cannot be read as
 * complete when some lots carried no cost price. Those three are notices on the
 * page, not footnotes in a docstring.
 *
 * ## Why tables appear here and nowhere else in the app
 *
 * Every other list in this app is a `<ul>` of cards, because each row is one thing
 * to tap. A report row is eight figures to be read *down a column* and compared
 * across rows, which is what a `<table>` is for: it gives a screen reader the column
 * heading with each cell, it keeps the columns aligned under `tabular-nums`, and it
 * prints as a grid rather than as a stack of fragments. The chart is a second
 * reading of the daily table underneath it and never the only one, so it is hidden
 * from assistive technology instead of duplicating thirty rows of numbers as speech.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { VAT_TREATMENT_WORD } from '@/components/inventory/inventory-words';
import { METHOD_WORD, STATUS_WORD } from '@/components/pos/sale-words';
import { PRESET_WORD, TREATMENT_NOTE, UNSETTLED_NOTE } from '@/components/reports/reports-words';
import { Button } from '@/components/ui/button';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  Money,
  PageHeader,
  Spinner,
  StatusNotice,
  WarningNotice,
} from '@/components/ui/display';
import { Field, Input } from '@/components/ui/field';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api-error-message';
import { REPORT_LIMITS } from '@/lib/api-types';
import type { SalesReport, SalesReportResponse } from '@/lib/api-types';
import { todayIso } from '@/lib/dates';
import { formatCedis, formatDate, formatDateTime } from '@/lib/format';
import { ROLE_LABELS } from '@/lib/navigation';
import {
  dailyPoints,
  EMPTY_REPORT_RANGE,
  marginLabel,
  presetMatching,
  rangeForPreset,
  rangeLabel,
  REPORT_PRESETS,
  reportQueryFrom,
  validateReportRange,
  type ReportRange,
} from '@/lib/reports';

/**
 * One page of the product ranking.
 *
 * Smaller than the list default of 50 on purpose: a ranking is read top-down and
 * the interesting answer is nearly always in the first dozen, while fifty rows
 * would push the tender, drawer and tax sections — the ones an owner closes the day
 * with — off the screen and out of mind.
 */
const PRODUCT_PAGE_SIZE = 25;

/** The palette's own two hues, as hex because recharts cannot read a Tailwind class. */
const REVENUE_COLOUR = '#008753';
const PROFIT_COLOUR = '#a17f0a';

export default function ReportsPage() {
  const { api } = useAuth();

  // Read once, at mount, rather than on every render. A preset applied at ten to
  // midnight must not relabel itself at one minute past while the operator is still
  // reading the day they just closed — the report is a snapshot and its notion of
  // "today" is part of that snapshot.
  const [today] = useState(todayIso);
  const [range, setRange] = useState<ReportRange>(
    () => rangeForPreset('today', today) ?? EMPTY_REPORT_RANGE
  );
  const [productOffset, setProductOffset] = useState(0);

  const [report, setReport] = useState<SalesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  const rangeError = validateReportRange(range);
  const activePreset = presetMatching(range, today);
  const points = useMemo(() => (report === null ? [] : dailyPoints(report.daily)), [report]);

  useEffect(() => {
    // A range the API would refuse is not sent. The report already on screen is
    // left alone under its own heading rather than cleared, because it is still a
    // true statement about the window it names.
    if (rangeError !== null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      void (async () => {
        setLoading(true);
        setLoadError(null);
        try {
          const result = await api.get<SalesReportResponse>('/reports/sales', {
            query: reportQueryFrom(range, PRODUCT_PAGE_SIZE, productOffset),
          });
          if (cancelled) return;
          setReport(result.report);
        } catch (error) {
          if (!cancelled) {
            setLoadError(apiErrorMessage(error, 'Could not draw the report.'));
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [api, range, productOffset, reloadToken, rangeError]);

  function update(patch: Partial<ReportRange>) {
    setRange((current) => ({ ...current, ...patch }));
    setProductOffset(0);
  }

  function applyPreset(name: (typeof REPORT_PRESETS)[number]) {
    const next = rangeForPreset(name, today);
    // Null only when `today` is not a real date, which `todayIso` cannot produce.
    // Leaving the inputs alone is the honest fallback: filling them with something
    // that looks like a date and is not one would be worse than doing nothing.
    if (next === null) return;
    setRange(next);
    setProductOffset(0);
  }

  const uncounted = report?.summary.uncountedSaleCount ?? 0;
  const zeroCostLines = report?.profitability.zeroCostLines ?? 0;

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle={
          report === null
            ? 'Takings, profit, staff, tenders and tax over one window'
            : `${rangeLabel(report.range)} · drawn ${formatDateTime(report.generatedAt)}`
        }
        actions={
          <Button variant="secondary" onClick={reload} disabled={loading}>
            Draw again
          </Button>
        }
      />

      <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
        <Card>
          <div className="flex flex-wrap gap-2">
            {REPORT_PRESETS.map((name) => (
              <Button
                key={name}
                variant={activePreset === name ? 'primary' : 'secondary'}
                onClick={() => applyPreset(name)}
                aria-pressed={activePreset === name}
              >
                {PRESET_WORD[name]}
              </Button>
            ))}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="From" htmlFor="report-from">
              <Input
                id="report-from"
                type="date"
                value={range.from}
                onChange={(event) => update({ from: event.target.value })}
              />
            </Field>
            <Field
              label="To"
              htmlFor="report-to"
              error={rangeError ?? undefined}
              hint={`Both ends are included. Leave one empty and it defaults to today. A report covers at most ${REPORT_LIMITS.rangeDays.max} days.`}
            >
              <Input
                id="report-to"
                type="date"
                value={range.to}
                onChange={(event) => update({ to: event.target.value })}
              />
            </Field>
          </div>
        </Card>

        {rangeError !== null && (
          <ErrorNotice>
            {rangeError}. The figures below still cover{' '}
            {report === null ? 'nothing yet' : rangeLabel(report.range)}.
          </ErrorNotice>
        )}

        {loadError !== null && (
          <div className="space-y-3">
            <ErrorNotice>{loadError}</ErrorNotice>
            <Button variant="secondary" onClick={reload}>
              Try again
            </Button>
          </div>
        )}

        {loading && report === null && loadError === null && (
          <div className="flex justify-center p-12">
            <Spinner label="Drawing the report…" />
          </div>
        )}

        {loading && report !== null && loadError === null && (
          <StatusNotice>Redrawing for the window in the boxes. The figures below still cover {rangeLabel(report.range)}.</StatusNotice>
        )}

        {!loading && loadError === null && report === null && (
          <Card padded={false}>
            <EmptyState
              title="No report drawn yet"
              message="Choose a window above. Today is shown by default."
            />
          </Card>
        )}

        {report !== null && (
          <div className="space-y-4">
            {uncounted > 0 && (
              <WarningNotice>
                {uncounted} {uncounted === 1 ? 'sale' : 'sales'} in this window are not in the
                figures below, because only a completed sale is counted. See the breakdown by
                status for where the money actually is.
              </WarningNotice>
            )}

            {zeroCostLines > 0 && (
              <WarningNotice>
                {zeroCostLines} sale {zeroCostLines === 1 ? 'line' : 'lines'} drew from lots with no
                cost price recorded. Their whole selling price is counted as profit, so gross profit
                here is overstated. Add a cost to those lots to correct it.
              </WarningNotice>
            )}

            <Summary report={report} />

            <Section
              title="By status"
              note="All five statuses, whether or not the window held one. Only a completed sale is in the headline above."
            >
              <TableWrap>
                <table className="w-full text-sm">
                  <HeadRow
                    columns={['Status', 'Sales', 'Value', 'In the headline']}
                    rightFrom={1}
                  />
                  <tbody>
                    {report.byStatus.map((row) => (
                      <tr key={row.status} className="border-b border-surface-100 last:border-0">
                        <Th>
                          <Badge tone={row.counted ? 'positive' : 'neutral'}>
                            {STATUS_WORD[row.status]}
                          </Badge>
                        </Th>
                        <Td right>{row.saleCount}</Td>
                        <Td right>
                          <Money value={row.total} />
                        </Td>
                        <Td right>{row.counted ? 'Yes' : 'No'}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Section>

            <Section
              title="Day by day"
              note="One row per calendar day in the window, on completed sales only."
            >
              {report.daily.length === 0 ? (
                <EmptyState
                  title="No completed sale in this window"
                  message="Nothing to chart. A day with pending or voided sales still appears in the breakdown above."
                />
              ) : (
                <>
                  <div className="h-64 w-full" aria-hidden="true">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="#737373" />
                        <YAxis tick={{ fontSize: 12 }} stroke="#737373" width={72} />
                        <Tooltip formatter={(value) => formatCedisOf(value)} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar dataKey="revenue" name="Revenue" fill={REVENUE_COLOUR} radius={[2, 2, 0, 0]} />
                        <Line
                          dataKey="grossProfit"
                          name="Gross profit"
                          stroke={PROFIT_COLOUR}
                          strokeWidth={2}
                          dot={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>

                  <TableWrap>
                    <table className="w-full text-sm">
                      <HeadRow
                        columns={['Day', 'Sales', 'Revenue', 'Discount', 'Tax', 'Cost', 'Gross profit']}
                        rightFrom={1}
                      />
                      <tbody>
                        {report.daily.map((row) => (
                          <tr key={row.day} className="border-b border-surface-100 last:border-0">
                            <Th>{formatDate(row.day)}</Th>
                            <Td right>{row.saleCount}</Td>
                            <Td right>
                              <Money value={row.revenue} />
                            </Td>
                            <Td right>
                              <Money value={row.discount} />
                            </Td>
                            <Td right>
                              <Money value={row.taxTotal} />
                            </Td>
                            <Td right>
                              <Money value={row.costOfGoods} />
                            </Td>
                            <Td right>
                              <Money value={row.grossProfit} />
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                </>
              )}
            </Section>

            <Section
              title="Profit"
              note="At the sale-line grain, costed from the lots each line actually drew."
            >
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
                <Fact label="Lines sold">{report.profitability.lineCount}</Fact>
                <Fact label="Line revenue">
                  <Money value={report.profitability.lineRevenue} />
                </Fact>
                <Fact label="Cost of goods">
                  <Money value={report.profitability.costOfGoods} />
                </Fact>
                <Fact label="Gross profit">
                  <Money value={report.profitability.grossProfit} />
                </Fact>
                <Fact label="Gross margin">{marginLabel(report.profitability.grossMarginPercent)}</Fact>
                <Fact label="Lines with no cost">{report.profitability.zeroCostLines}</Fact>
              </dl>

              <div className="mt-4">
                <SubHeading>
                  Best and worst products, by gross profit
                  {report.profitability.products.length > 0 &&
                    ` · ${productOffset + 1}–${productOffset + report.profitability.products.length}`}
                </SubHeading>
                {report.profitability.products.length === 0 ? (
                  <EmptyState title="No product sold in this window" />
                ) : (
                  <>
                    <TableWrap>
                      <table className="w-full text-sm">
                        <HeadRow
                          columns={[
                            'Product',
                            'Lines',
                            'Base units',
                            'Revenue',
                            'Cost',
                            'Gross profit',
                            'Margin',
                          ]}
                          rightFrom={1}
                        />
                        <tbody>
                          {report.profitability.products.map((row) => (
                            <tr
                              key={row.productId}
                              className="border-b border-surface-100 last:border-0"
                            >
                              <Th>
                                {row.name}
                                {row.zeroCostLines > 0 && (
                                  <span className="ml-2 text-2xs text-accent-900">
                                    {row.zeroCostLines} with no cost
                                  </span>
                                )}
                              </Th>
                              <Td right>{row.lineCount}</Td>
                              <Td right>{row.baseUnits}</Td>
                              <Td right>
                                <Money value={row.revenue} />
                              </Td>
                              <Td right>
                                <Money value={row.costOfGoods} />
                              </Td>
                              <Td right>
                                <Money value={row.grossProfit} />
                              </Td>
                              <Td right>{marginLabel(row.grossMarginPercent)}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableWrap>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <Button
                        variant="secondary"
                        onClick={() =>
                          setProductOffset((current) => Math.max(0, current - PRODUCT_PAGE_SIZE))
                        }
                        disabled={productOffset === 0 || loading}
                      >
                        Previous
                      </Button>
                      <span className="text-2xs text-neutral-500">
                        Base units, not selling units: a product sold by the strip and by the tablet
                        appears as both.
                      </span>
                      <Button
                        variant="secondary"
                        onClick={() => setProductOffset((current) => current + PRODUCT_PAGE_SIZE)}
                        disabled={!report.profitability.hasMoreProducts || loading}
                      >
                        Next
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </Section>

            <Section
              title="Who served"
              note="Everybody who served at least one sale in the window — not the whole roster with zeros beside most of it."
            >
              {report.staff.length === 0 ? (
                <EmptyState title="Nobody served a sale in this window" />
              ) : (
                <TableWrap>
                  <table className="w-full text-sm">
                    <HeadRow
                      columns={[
                        'Name',
                        'Role',
                        'Sales',
                        'Revenue',
                        'Discount given',
                        'Pending',
                        'Voided',
                      ]}
                      rightFrom={2}
                    />
                    <tbody>
                      {report.staff.map((row) => (
                        <tr key={row.userId} className="border-b border-surface-100 last:border-0">
                          <Th>{row.fullName}</Th>
                          <Td>{ROLE_LABELS[row.role]}</Td>
                          <Td right>{row.saleCount}</Td>
                          <Td right>
                            <Money value={row.revenue} />
                          </Td>
                          <Td right>
                            <Money value={row.discount} />
                          </Td>
                          <Td right>{row.pendingCount}</Td>
                          <Td right>{row.voidedCount}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Section>

            <Section title="How it was paid" note={UNSETTLED_NOTE}>
              <TableWrap>
                <table className="w-full text-sm">
                  <HeadRow
                    columns={['Method', 'Settled', 'Amount', 'Not settled', 'Amount']}
                    rightFrom={1}
                  />
                  <tbody>
                    {report.tenders.map((row) => (
                      <tr key={row.method} className="border-b border-surface-100 last:border-0">
                        <Th>{METHOD_WORD[row.method]}</Th>
                        <Td right>{row.settledCount}</Td>
                        <Td right>
                          <Money value={row.settledAmount} />
                        </Td>
                        <Td right>{row.unsettledCount}</Td>
                        <Td right>
                          <Money value={row.unsettledAmount} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>

              <div className="mt-4 border-t border-surface-200 pt-3">
                <SubHeading>What the cash drawer should hold</SubHeading>
                <dl className="grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
                  <Fact label="Cash handed over">
                    <Money value={report.drawer.cashTaken} />
                  </Fact>
                  <Fact label="Change given">
                    <Money value={report.drawer.changeGiven} />
                  </Fact>
                  <Fact label="Cash retained">
                    <Money value={report.drawer.cashRetained} />
                  </Fact>
                </dl>
                <p className="mt-2 text-2xs text-neutral-500">
                  Cash handed over is the note the customer passed, not the sale total: a GHS 50 note
                  against a GHS 45 basket is 50.00 handed over and 5.00 given back. Count the drawer
                  against cash retained, and a shortfall the size of the change is the change rather
                  than something to investigate.
                </p>
              </div>
            </Section>

            <Section
              title="Tax position"
              note="Stored amounts, not rates applied now: a return for June read in September still says what June charged."
            >
              <TableWrap>
                <table className="w-full text-sm">
                  <HeadRow
                    columns={[
                      'Treatment',
                      'Lines',
                      'Taxable base',
                      'Gross',
                      'Discount',
                      'VAT',
                      'NHIL',
                      'GETFund',
                      'Total',
                    ]}
                    rightFrom={1}
                  />
                  <tbody>
                    {report.vat.map((row) => (
                      <tr key={row.treatment} className="border-b border-surface-100 last:border-0">
                        <Th>{VAT_TREATMENT_WORD[row.treatment]}</Th>
                        <Td right>{row.lineCount}</Td>
                        <Td right>
                          <Money value={row.taxableBase} />
                        </Td>
                        <Td right>
                          <Money value={row.gross} />
                        </Td>
                        <Td right>
                          <Money value={row.discount} />
                        </Td>
                        <Td right>
                          <Money value={row.vatAmount} />
                        </Td>
                        <Td right>
                          <Money value={row.nhilAmount} />
                        </Td>
                        <Td right>
                          <Money value={row.getfundAmount} />
                        </Td>
                        <Td right>
                          <Money value={row.lineTotal} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <ul className="mt-3 space-y-1 text-2xs text-neutral-600">
                {report.vat.map((row) => (
                  <li key={row.treatment}>
                    <span className="font-medium text-neutral-800">
                      {VAT_TREATMENT_WORD[row.treatment]}:
                    </span>{' '}
                    {TREATMENT_NOTE[row.treatment]}
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The tooltip's money formatter.
 *
 * Recharts hands a `ValueType` — a number, a string or an array of either — because
 * a chart can plot a range. This chart plots single values, so anything else is
 * rendered as missing rather than stringified into something that looks like a
 * figure. The money it formats is already a `Number` from `dailyPoints`, so it goes
 * back through `String()` and the formatter that every other amount on the page
 * uses: one rule for what GHS looks like, chart included.
 */
function formatCedisOf(value: number | string | Array<number | string>): string {
  if (Array.isArray(value)) return '—';
  return formatCedis(String(value));
}

/** The headline figures, all of them the API's own. */
function Summary({ report }: { report: SalesReport }) {
  const { summary } = report;
  return (
    <Card>
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="Completed sales" value={String(summary.saleCount)} />
        <Stat label="Revenue" value={formatCedis(summary.revenue)} emphasis />
        <Stat label="Average basket" value={formatCedis(summary.averageSale)} />
        <Stat label="Discounts given" value={formatCedis(summary.discount)} />
        <Stat label="Cost of goods" value={formatCedis(report.profitability.costOfGoods)} />
        <Stat
          label="Gross profit"
          value={formatCedis(report.profitability.grossProfit)}
          emphasis
        />
        <Stat label="Gross margin" value={marginLabel(report.profitability.grossMarginPercent)} />
        <Stat label="Sales with a patient" value={String(summary.patientSaleCount)} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-surface-200 pt-3 text-sm sm:grid-cols-4">
        <Fact label="VAT">
          <Money value={summary.vatAmount} />
        </Fact>
        <Fact label="NHIL">
          <Money value={summary.nhilAmount} />
        </Fact>
        <Fact label="GETFund">
          <Money value={summary.getfundAmount} />
        </Fact>
        <Fact label="Tax collected">
          <Money value={summary.taxTotal} />
        </Fact>
      </dl>

      <p className="mt-2 text-2xs text-neutral-500">
        Subtotal before tax <span className="money">{formatCedis(summary.subtotal)}</span>. Tax
        collected is money held for GRA, NHIA and the Trust, not takings.
      </p>
    </Card>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <Card>
      <h2 className="text-base font-semibold text-neutral-900">{title}</h2>
      {note !== undefined && <p className="mt-0.5 text-2xs text-neutral-500">{note}</p>}
      <div className="mt-3">{children}</div>
    </Card>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-sm font-semibold text-neutral-800">{children}</h3>;
}

/** A headline figure, large. `emphasis` is the two a day is judged on. */
function Stat({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div>
      <p className="text-2xs font-medium uppercase tracking-wide text-neutral-500">{label}</p>
      <p
        className={[
          'money mt-1',
          emphasis ? 'text-xl font-semibold text-neutral-900' : 'text-lg text-neutral-800',
        ].join(' ')}
      >
        {value}
      </p>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-2xs text-neutral-500">{label}</dt>
      <dd className="money mt-0.5 font-medium text-neutral-900">{children}</dd>
    </div>
  );
}

/**
 * A wide table on a narrow screen scrolls rather than squashes.
 *
 * Squeezing nine money columns into a tablet width would wrap figures onto two
 * lines, and a column of amounts that no longer lines up is a column nobody can
 * read down — which is the only reason to lay a report out as a table at all.
 */
function TableWrap({ children }: { children: ReactNode }) {
  return <div className="-mx-1 overflow-x-auto px-1">{children}</div>;
}

/**
 * A header row, told where the numbers start.
 *
 * One component rather than nine hand-written `<th>` lists, because the alignment
 * of a column and of its cells is one decision made in two places otherwise — and a
 * right-aligned figure under a left-aligned heading is the small wrongness that
 * makes a column unreadable downwards.
 */
function HeadRow({ columns, rightFrom }: { columns: string[]; rightFrom: number }) {
  return (
    <thead>
      <tr className="border-b border-surface-200 text-2xs uppercase tracking-wide text-neutral-500">
        {columns.map((column, index) => (
          <th
            key={column}
            scope="col"
            className={[
              'py-2 font-medium',
              index === 0 ? 'pr-3 text-left' : 'px-3',
              index >= rightFrom ? 'text-right' : 'text-left',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {column}
          </th>
        ))}
      </tr>
    </thead>
  );
}

/** A row header: the first cell of a report row names the row, it is not data. */
function Th({ children }: { children: ReactNode }) {
  return (
    <th scope="row" className="py-2 pr-3 text-left font-medium text-neutral-800">
      {children}
    </th>
  );
}

function Td({ children, right = false }: { children: ReactNode; right?: boolean }) {
  return (
    <td
      className={[
        'py-2 px-3 text-neutral-700',
        right ? 'money text-right' : 'text-left',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </td>
  );
}
