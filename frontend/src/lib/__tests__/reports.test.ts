/**
 * The report's window, checked as the arithmetic it is.
 *
 * Two properties carry most of the weight here, and neither is a single case:
 *
 *  - Every preset, on every day of a year, must produce a range the API accepts.
 *    A shortcut that offers a window the server refuses is worse than no shortcut:
 *    the operator taps "Last month" and is told they asked for something
 *    impossible, by a button the app itself wrote.
 *  - A month's preset must cover that month's days, all twelve of them, in a leap
 *    year and in one that is not. A hand-written table of month lengths would pass
 *    the easy months and be one day short in February, once a year, in the report
 *    the owner hands to an accountant.
 */

import { REPORT_LIMITS } from '../api-types';
import type { DailyRow, ReportWindow } from '../api-types';
import { inclusiveDayCount, shiftDays } from '../dates';
import { MISSING } from '../format';
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
  type ReportPreset,
} from '../reports';

const TODAY = '2026-09-05';

function preset(name: ReportPreset, today: string = TODAY): { from: string; to: string } {
  const range = rangeForPreset(name, today);
  if (range === null) {
    throw new Error(`rangeForPreset('${name}', '${today}') returned null`);
  }
  return range;
}

/** Every day of a year, as `'YYYY-MM-DD'`, walked without date-fns. */
function everyDayOf(year: number): string[] {
  const days: string[] = [];
  let cursor: string | null = `${year}-01-01`;
  const end = `${year + 1}-01-01`;
  while (cursor !== null && cursor < end) {
    days.push(cursor);
    cursor = shiftDays(cursor, 1);
  }
  return days;
}

describe('rangeForPreset', () => {
  it('fills both ends, so a shortcut never leaves a half to the API', () => {
    for (const name of REPORT_PRESETS) {
      const range = preset(name);
      expect({ preset: name, range }).toEqual({
        preset: name,
        range: { from: expect.any(String), to: expect.any(String) },
      });
      expect(range.from).not.toBe('');
      expect(range.to).not.toBe('');
    }
  });

  it('names the obvious six windows against a mid-month day', () => {
    expect(preset('today')).toEqual({ from: '2026-09-05', to: '2026-09-05' });
    expect(preset('yesterday')).toEqual({ from: '2026-09-04', to: '2026-09-04' });
    expect(preset('last7')).toEqual({ from: '2026-08-30', to: '2026-09-05' });
    expect(preset('last30')).toEqual({ from: '2026-08-07', to: '2026-09-05' });
    expect(preset('thisMonth')).toEqual({ from: '2026-09-01', to: '2026-09-05' });
    expect(preset('lastMonth')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });

  it('counts the rolling windows inclusively, so "last 7 days" is seven days of trading', () => {
    expect(inclusiveDayCount(preset('today').from, preset('today').to)).toBe(1);
    expect(inclusiveDayCount(preset('yesterday').from, preset('yesterday').to)).toBe(1);
    expect(inclusiveDayCount(preset('last7').from, preset('last7').to)).toBe(7);
    expect(inclusiveDayCount(preset('last30').from, preset('last30').to)).toBe(30);
  });

  it('steps back over a month end, a year end and into a leap February', () => {
    expect(preset('yesterday', '2026-03-01')).toEqual({ from: '2026-02-28', to: '2026-02-28' });
    expect(preset('yesterday', '2024-03-01')).toEqual({ from: '2024-02-29', to: '2024-02-29' });
    expect(preset('yesterday', '2026-01-01')).toEqual({ from: '2025-12-31', to: '2025-12-31' });
    expect(preset('thisMonth', '2026-01-01')).toEqual({ from: '2026-01-01', to: '2026-01-01' });
  });

  it('takes last month from the calendar rather than from a table of month lengths', () => {
    expect(preset('lastMonth', '2026-03-15')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(preset('lastMonth', '2024-03-15')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(preset('lastMonth', '2026-01-10')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(preset('lastMonth', '2026-05-31')).toEqual({ from: '2026-04-01', to: '2026-04-30' });
  });

  it.each([
    [2026, [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]],
    [2024, [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]],
  ])('covers every day of every month of %i when asked from the month after', (year, lengths) => {
    // The whole point of deriving the last day by stepping back from the first of
    // the next month. Asserted for all twelve months of a common year and of a leap
    // one, because a table would be right eleven times and wrong in February.
    const daysIn = lengths as number[];
    for (let month = 0; month < 12; month += 1) {
      const following = month === 11 ? `${year + 1}-01-15` : `${year}-${String(month + 2).padStart(2, '0')}-15`;
      const range = preset('lastMonth', following);
      expect({ year, month: month + 1, range }).toEqual({
        year,
        month: month + 1,
        range: {
          from: `${year}-${String(month + 1).padStart(2, '0')}-01`,
          to: `${year}-${String(month + 1).padStart(2, '0')}-${daysIn[month]}`,
        },
      });
      expect(inclusiveDayCount(range.from, range.to)).toBe(daysIn[month]);
    }
  });

  it('is null for a day that is not a real date, rather than a plausible wrong window', () => {
    expect(rangeForPreset('today', '2026-02-30')).toBeNull();
    expect(rangeForPreset('lastMonth', '')).toBeNull();
    expect(rangeForPreset('last7', 'not-a-date')).toBeNull();
  });
});

describe('every preset on every day of a year', () => {
  it.each([2026, 2024])('offers nothing the API would refuse, on any day of %i', (year) => {
    const refusals: string[] = [];
    for (const day of everyDayOf(year)) {
      for (const name of REPORT_PRESETS) {
        const range = rangeForPreset(name, day);
        if (range === null) {
          refusals.push(`${day} ${name}: no range`);
          continue;
        }
        const problem = validateReportRange(range);
        if (problem !== null) {
          refusals.push(`${day} ${name}: ${problem}`);
        }
      }
    }
    // Collected rather than asserted per day, so one run names every day a
    // shortcut breaks instead of the first of three hundred.
    expect(refusals).toEqual([]);
  });

  it.each([2026, 2024])('keeps every preset inside the widest range allowed, on any day of %i', (year) => {
    const tooWide: string[] = [];
    for (const day of everyDayOf(year)) {
      for (const name of REPORT_PRESETS) {
        const range = rangeForPreset(name, day);
        const days = range === null ? null : inclusiveDayCount(range.from, range.to);
        if (days === null || days > REPORT_LIMITS.rangeDays.max) {
          tooWide.push(`${day} ${name}: ${String(days)} days`);
        }
      }
    }
    expect(tooWide).toEqual([]);
  });
});

describe('presetMatching', () => {
  it('recognises each preset by the window it names', () => {
    for (const name of REPORT_PRESETS) {
      expect({ name, matched: presetMatching(preset(name), TODAY) }).toEqual({
        name,
        matched: name,
      });
    }
  });

  it('is null for a window the operator made themselves', () => {
    expect(presetMatching({ from: '2026-08-03', to: '2026-09-02' }, TODAY)).toBeNull();
    expect(presetMatching({ from: '2026-09-02', to: '2026-09-04' }, TODAY)).toBeNull();
  });

  it('re-reads a window against today rather than remembering which button made it', () => {
    // The consequence of comparing rather than storing. A range applied as "Today"
    // and left open past midnight stops being today and becomes yesterday — which
    // is the truth about the window on screen. A highlight remembered in state
    // would still say "Today" over a day of figures that is no longer today, and
    // the operator would be reading yesterday's takings believing them to be the
    // day's.
    expect(presetMatching({ from: '2026-09-05', to: '2026-09-05' }, '2026-09-06')).toBe('yesterday');
    expect(presetMatching(preset('today'), '2026-09-06')).toBe('yesterday');
    expect(presetMatching(preset('today', '2026-09-06'), '2026-09-06')).toBe('today');
  });

  it('is null for an open end, which no preset has', () => {
    expect(presetMatching(EMPTY_REPORT_RANGE, TODAY)).toBeNull();
    expect(presetMatching({ from: '2026-09-05', to: '' }, TODAY)).toBeNull();
  });
});

describe('reportQueryFrom', () => {
  it('always carries the page, and nothing else when neither end is set', () => {
    expect(reportQueryFrom(EMPTY_REPORT_RANGE, 50, 0)).toEqual({ limit: 50, offset: 0 });
  });

  it('omits an unset end entirely rather than sending it empty', () => {
    // `buildQuery` drops `undefined` and `null` but not `''`, so `?from=` would
    // reach the route as a value it then has to interpret, where a missing `from`
    // is one it already defaults to today.
    expect(reportQueryFrom({ from: '2026-09-01', to: '' }, 50, 0)).toEqual({
      limit: 50,
      offset: 0,
      from: '2026-09-01',
    });
    expect(reportQueryFrom({ from: '', to: '2026-09-05' }, 50, 0)).toEqual({
      limit: 50,
      offset: 0,
      to: '2026-09-05',
    });
  });

  it('sends both ends and the page when the range is whole', () => {
    expect(reportQueryFrom({ from: '2026-09-01', to: '2026-09-05' }, 25, 50)).toEqual({
      limit: 25,
      offset: 50,
      from: '2026-09-01',
      to: '2026-09-05',
    });
  });
});

describe('validateReportRange', () => {
  it('lets an open end through, because the API fills it with today', () => {
    expect(validateReportRange(EMPTY_REPORT_RANGE)).toBeNull();
    expect(validateReportRange({ from: '2026-09-01', to: '' })).toBeNull();
    expect(validateReportRange({ from: '', to: '2026-09-05' })).toBeNull();
  });

  it('lets a whole range through, up to and including the widest one allowed', () => {
    expect(validateReportRange({ from: '2026-09-05', to: '2026-09-05' })).toBeNull();
    expect(validateReportRange(preset('last30'))).toBeNull();
    expect(validateReportRange({ from: '2026-01-01', to: '2027-01-01' })).toBeNull();
    expect(inclusiveDayCount('2026-01-01', '2027-01-01')).toBe(REPORT_LIMITS.rangeDays.max);
  });

  it('names a reversed range rather than letting it come back as an empty report', () => {
    // An empty list is the wrong answer to a backwards range: it reads as "no
    // sales this week" and the operator goes looking for a problem in the trade
    // instead of in the two dates they typed.
    expect(validateReportRange({ from: '2026-09-06', to: '2026-09-05' })).toBe(
      'The start date is after the end date'
    );
    expect(validateReportRange({ from: '2027-01-01', to: '2026-01-01' })).toBe(
      'The start date is after the end date'
    );
  });

  it('refuses a range one day wider than the ceiling, and says both figures', () => {
    const message = validateReportRange({ from: '2026-01-01', to: '2027-01-02' });
    expect(message).not.toBeNull();
    expect(message).toContain(String(REPORT_LIMITS.rangeDays.max));
    expect(message).toContain('367');
  });

  it('refuses a date that is not a real one, before asking how wide the range is', () => {
    expect(validateReportRange({ from: '2026-02-30', to: '2026-03-05' })).toBe(
      'Enter both dates as YYYY-MM-DD'
    );
    expect(validateReportRange({ from: '2026-09-01', to: '05/09/2026' })).toBe(
      'Enter both dates as YYYY-MM-DD'
    );
  });
});

describe('rangeLabel', () => {
  it('reads one day as one date', () => {
    expect(rangeLabel({ from: '2026-09-05', to: '2026-09-05' })).toBe('5 Sep 2026');
  });

  it('reads a span as its two ends', () => {
    expect(rangeLabel({ from: '2026-09-01', to: '2026-09-05' })).toBe('1 Sep 2026 – 5 Sep 2026');
    expect(rangeLabel({ from: '2025-12-31', to: '2026-01-01' })).toBe('31 Dec 2025 – 1 Jan 2026');
  });

  it('leaves a gap for a date it cannot read, rather than inventing one', () => {
    const window: ReportWindow = { from: 'not-a-date', to: 'not-a-date' };
    expect(rangeLabel(window)).toBe(MISSING);
  });
});

describe('marginLabel', () => {
  it('passes the API\'s one decimal place through untouched', () => {
    // Not money, so `formatMoney` would be wrong: it pads to two places, and a
    // margin the API computed as 24.5% would arrive on screen as 24.50%.
    expect(marginLabel('24.5')).toBe('24.5%');
    expect(marginLabel('0')).toBe('0%');
    expect(marginLabel('100')).toBe('100%');
  });

  it('keeps the sign on a margin earned by selling below cost', () => {
    expect(marginLabel('-4.2')).toBe('-4.2%');
  });

  it('leaves a gap for no revenue, which is not the same claim as a margin of zero', () => {
    // `Number(null)` is 0 and a template literal renders that as "0%", so a
    // product that sold nothing at all would sit in the table beside one that sold
    // at exactly cost and look identical. Those are opposite findings.
    expect(marginLabel(null)).toBe(MISSING);
    expect(marginLabel('0')).not.toBe(MISSING);
  });

  it('leaves a gap for a value it cannot read', () => {
    expect(marginLabel('')).toBe(MISSING);
    expect(marginLabel('abc')).toBe(MISSING);
    expect(marginLabel('24.5%')).toBe(MISSING);
  });
});

describe('dailyPoints', () => {
  function row(overrides: Partial<DailyRow> = {}): DailyRow {
    return {
      day: '2026-09-05',
      saleCount: 3,
      revenue: '450.00',
      discount: '0.00',
      taxTotal: '62.31',
      costOfGoods: '300.00',
      grossProfit: '150.00',
      ...overrides,
    };
  }

  it('maps a row to a point, with the short label for the axis', () => {
    expect(dailyPoints([row()])).toEqual([
      { day: '2026-09-05', label: '5 Sep', saleCount: 3, revenue: 450, grossProfit: 150 },
    ]);
  });

  it('keeps a day that sold below cost below zero', () => {
    // The chart is the one place a negative money string becomes a `Number`, and
    // clamping it to zero would flatten the only day worth investigating into the
    // axis.
    const points = dailyPoints([row({ grossProfit: '-25.50' })]);
    expect(points[0]?.grossProfit).toBe(-25.5);
  });

  it('plots nothing for an empty window rather than a point at zero', () => {
    expect(dailyPoints([])).toEqual([]);
  });

  it('turns a value it cannot read into zero instead of taking the axis with it', () => {
    const points = dailyPoints([row({ revenue: '', grossProfit: 'NaN' })]);
    expect(points[0]?.revenue).toBe(0);
    expect(points[0]?.grossProfit).toBe(0);
  });
});
