/**
 * The pure logic behind `/reports`: the window a report covers, the presets that
 * fill it, the query that asks for it, and the few things the page derives from
 * the eight sections that come back.
 *
 * Kept out of the page for the reason `lib/sales.ts` gives, and here the reason is
 * sharper. A report is the document the owner reconciles a drawer against and the
 * one an accountant reads beside a GRA return, so the two ways it can go quietly
 * wrong are both about *which days it covers*: a range that is off by one at an
 * end, and a range the API refuses after the operator has waited for it. Both are
 * arithmetic, both are invisible on the screen, and both are testable here in a way
 * they are not inside a `useEffect`.
 *
 * Nothing here reads the clock. Every function takes `today` as an argument so a
 * test can pin a month end, a leap February and the widest range the API accepts
 * without its answer depending on the day it happens to run.
 */

import { REPORT_LIMITS } from './api-types';
import type { DailyRow, ReportWindow } from './api-types';
import { inclusiveDayCount, shiftDays } from './dates';
import { formatDate, formatShortDate, MISSING } from './format';

/**
 * The two date inputs on `/reports`.
 *
 * The empty string means "not set" rather than "unset", because that is what an
 * `<input type="date">` yields when it is cleared, and `reportQueryFrom` is what
 * turns it into an omitted parameter. The API defaults an omitted end to today,
 * so a half-filled range is a real question — "from the 1st until now" — and not
 * an error to be refused here.
 */
export interface ReportRange {
  /** `YYYY-MM-DD`, as a date input yields. Empty means the API's default. */
  from: string;
  to: string;
}

export const EMPTY_REPORT_RANGE: ReportRange = { from: '', to: '' };

/**
 * The shortcuts beside the date inputs.
 *
 * Six rather than a free choice alone, because the questions a pharmacy asks of a
 * report are the same six every time — how did today go, how did yesterday close,
 * what is the week, what is the month, and what was last month for the return —
 * and typing a month's two ends by hand is how a range comes to cover 28 days of
 * a 31-day month without anybody noticing.
 */
export type ReportPreset =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'thisMonth'
  | 'lastMonth';

export const REPORT_PRESETS: ReportPreset[] = [
  'today',
  'yesterday',
  'last7',
  'last30',
  'thisMonth',
  'lastMonth',
];

/** The first day of the month a `'YYYY-MM-DD'` date falls in. */
function monthStart(dateOnly: string): string {
  return `${dateOnly.slice(0, 7)}-01`;
}

/**
 * The window a preset names, or null when `today` is not a real date — in which
 * case no preset can be honest about what it covers and the page leaves the two
 * inputs alone rather than filling them with something that reads like a date.
 *
 * Both ends are always filled in. A preset that left one to the API's default
 * would be answering a question the operator did not ask, and the answer would
 * change under them if the clock moved between the click and the request.
 *
 * "Last 7 days" is six days back and today, so it counts seven days inclusive —
 * the same counting the API's ceiling uses, which is what keeps the widest preset
 * inside the widest allowed range instead of one day over it.
 */
export function rangeForPreset(preset: ReportPreset, today: string): ReportRange | null {
  const yesterday = shiftDays(today, -1);
  if (yesterday === null) return null;

  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: yesterday, to: yesterday };
    case 'last7':
      return { from: shiftDays(today, -6) ?? today, to: today };
    case 'last30':
      return { from: shiftDays(today, -29) ?? today, to: today };
    case 'thisMonth':
      return { from: monthStart(today), to: today };
    case 'lastMonth': {
      // The day before this month's first day is last month's last day, however
      // long that month was — no table of month lengths and no leap-year rule to
      // keep in step with the calendar.
      const lastDay = shiftDays(monthStart(today), -1);
      return lastDay === null ? null : { from: monthStart(lastDay), to: lastDay };
    }
  }
}

/**
 * Which preset a range is, or null when it is one the operator made themselves.
 *
 * Compared against `today` rather than remembered as state, so the chip that is
 * lit is always the one whose window is actually on screen: a range applied as
 * "Today" and left open past midnight is no longer today, and a highlight that
 * still claimed it would be the page agreeing with itself instead of with the
 * figures below.
 */
export function presetMatching(range: ReportRange, today: string): ReportPreset | null {
  if (range.from === '' || range.to === '') return null;
  for (const preset of REPORT_PRESETS) {
    const candidate = rangeForPreset(preset, today);
    if (candidate !== null && candidate.from === range.from && candidate.to === range.to) {
      return preset;
    }
  }
  return null;
}

/**
 * The query for `GET /reports/sales`.
 *
 * Only `limit` and `offset` are always present. An unset end is left out entirely
 * rather than sent empty, because `api-client`'s `buildQuery` drops `undefined`
 * and `null` but not `''` — and `?from=` is a value the route would then have to
 * interpret, where a missing `from` is one it already knows to default.
 */
export function reportQueryFrom(
  range: ReportRange,
  limit: number,
  offset: number
): Record<string, string | number> {
  const query: Record<string, string | number> = { limit, offset };
  if (range.from !== '') query.from = range.from;
  if (range.to !== '') query.to = range.to;
  return query;
}

/**
 * Whether a range is worth sending, as the sentence to put on the screen.
 *
 * The two refusals are the API's own, checked before the round trip. A reversed
 * range would come back as a 400 naming both dates; a range wider than the
 * ceiling would come back as a 400 after the operator waited for eight aggregates
 * to be refused. Neither is a secret — the page says the same thing the server
 * would have, only without the wait and without it reading as the app being
 * broken.
 *
 * An open end is not an error and returns null: half a range is a normal question
 * and the API fills the other half with today.
 */
export function validateReportRange(range: ReportRange): string | null {
  if (range.from === '' || range.to === '') return null;

  const days = inclusiveDayCount(range.from, range.to);
  if (days === null) {
    return 'Enter both dates as YYYY-MM-DD';
  }
  if (days < REPORT_LIMITS.rangeDays.min) {
    return 'The start date is after the end date';
  }
  if (days > REPORT_LIMITS.rangeDays.max) {
    return `A report covers at most ${REPORT_LIMITS.rangeDays.max} days — this range is ${days}`;
  }
  return null;
}

/**
 * The window in words, for the heading: one day reads as one date and a span as
 * the two ends.
 *
 * Taken from `report.range` — the window the API resolved — and never from the
 * two inputs, so the heading says which days the figures below actually cover
 * even when an input was left empty for the API to fill.
 */
export function rangeLabel(window: ReportWindow): string {
  const from = formatDate(window.from);
  const to = formatDate(window.to);
  return window.from === window.to ? from : `${from} – ${to}`;
}

/**
 * A margin as a percentage, or an em dash when there was no revenue to take one
 * of.
 *
 * The null is the point. `Number(null)` is 0 and a template literal renders it as
 * `"0%"`, so a product that sold nothing at all would sit in the table beside one
 * that sold at exactly cost and look identical — and "no margin" is not the same
 * claim as "no sales". The API sends one decimal place and it is passed through
 * untouched: this is a percentage, not money, so `formatMoney` would be wrong to
 * pad it to two.
 */
export function marginLabel(percent: string | null): string {
  if (percent === null) return MISSING;
  const trimmed = percent.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return MISSING;
  return `${trimmed}%`;
}

export interface DailyPoint {
  /** The wire date, for the key and for anything that has to name the day. */
  day: string;
  /** `'5 Sep'`, for an axis tick that has no room for a year. */
  label: string;
  saleCount: number;
  revenue: number;
  grossProfit: number;
}

/**
 * The daily rows as chart points.
 *
 * `Number()` on a money string is normally the wrong thing to do — it is how a
 * fraction of a pesewa creeps into a figure somebody then types into a drawer. A
 * chart axis is the exception: it plots pixels, not money, and every figure beside
 * the chart is still the API's own decimal string rendered through `Money`. The
 * daily table under the chart holds the same rows as text, so the chart is a
 * second reading of data that is already on the page and never the only one.
 *
 * A row that is not a number becomes 0 rather than `NaN`, because one unreadable
 * value would take the whole axis with it and the rest of the window would
 * disappear from the chart while still being listed below it.
 */
export function dailyPoints(rows: DailyRow[]): DailyPoint[] {
  return rows.map((row) => ({
    day: row.day,
    label: formatShortDate(row.day),
    saleCount: row.saleCount,
    revenue: asAxisNumber(row.revenue),
    grossProfit: asAxisNumber(row.grossProfit),
  }));
}

function asAxisNumber(decimal: string): number {
  const value = Number(decimal);
  return Number.isFinite(value) ? value : 0;
}
