/**
 * The calendar arithmetic, checked on the days that break naive date code.
 *
 * The happy case — 5 September plus one day is 6 September — is not what this file
 * is for. What matters is the set of days where a shortcut gives a confident wrong
 * answer: the last day of a month, the last day of a year, 28 February in a leap
 * year and in one that is not, and a reversed pair. Every one of those is a day a
 * pharmacy trades on, and an off-by-one at a month end moves a whole day of takings
 * from one report into the next without anything on the screen looking wrong.
 *
 * Every function takes its dates as arguments, so none of these answers depends on
 * when the suite runs.
 */

import {
  calendarDaysBetween,
  dateTimeLocalToIso,
  daysSinceEpoch,
  inclusiveDayCount,
  isoToDateTimeLocal,
  shiftDays,
  todayIso,
} from '../dates';

describe('daysSinceEpoch', () => {
  it('counts one day as one, across a month end and a year end', () => {
    const firstOfMarch = daysSinceEpoch('2026-03-01');
    expect(firstOfMarch).not.toBeNull();
    expect(daysSinceEpoch('2026-02-28')).toBe((firstOfMarch ?? 0) - 1);
    expect(daysSinceEpoch('2026-01-01')).toBe((daysSinceEpoch('2026-01-02') ?? 0) - 1);
    expect(daysSinceEpoch('2025-12-31')).toBe((daysSinceEpoch('2026-01-01') ?? 0) - 1);
  });

  it('gives the same day the same number, and consecutive days consecutive numbers', () => {
    expect(daysSinceEpoch('2026-09-05')).toBe(daysSinceEpoch('2026-09-05'));
    expect(daysSinceEpoch('2026-09-06')).toBe((daysSinceEpoch('2026-09-05') ?? 0) + 1);
  });

  it('refuses a date that does not exist rather than rolling it into the next month', () => {
    // `Date.UTC` alone would make 2026-02-30 into 2 March, so a report asked for
    // "the last seven days" from an impossible anchor would silently cover a week
    // that includes days nobody meant. The round trip is what catches it.
    expect(daysSinceEpoch('2026-02-30')).toBeNull();
    expect(daysSinceEpoch('2026-04-31')).toBeNull();
    expect(daysSinceEpoch('2026-13-01')).toBeNull();
    expect(daysSinceEpoch('2026-00-10')).toBeNull();
    expect(daysSinceEpoch('2025-02-29')).toBeNull();
  });

  it('accepts the leap day in a leap year, which the case above is not', () => {
    expect(daysSinceEpoch('2024-02-29')).not.toBeNull();
    expect(daysSinceEpoch('2000-02-29')).not.toBeNull();
  });

  it('refuses anything that is not exactly YYYY-MM-DD', () => {
    for (const notADate of [
      '',
      '2026-9-5',
      '05/09/2026',
      '2026-09-05T00:00:00Z',
      '2026-09-05 ',
      'not-a-date',
    ]) {
      expect({ input: notADate, days: daysSinceEpoch(notADate) }).toEqual({
        input: notADate,
        days: null,
      });
    }
  });
});

describe('calendarDaysBetween', () => {
  it('is zero for one day asked about itself', () => {
    expect(calendarDaysBetween('2026-09-05', '2026-09-05')).toBe(0);
  });

  it('counts forward', () => {
    expect(calendarDaysBetween('2026-09-05', '2026-09-06')).toBe(1);
    expect(calendarDaysBetween('2026-09-01', '2026-09-30')).toBe(29);
    expect(calendarDaysBetween('2026-01-01', '2026-12-31')).toBe(364);
    expect(calendarDaysBetween('2026-01-01', '2027-01-01')).toBe(365);
  });

  it('goes negative for a reversed pair instead of answering with a distance', () => {
    // The absolute value is the tempting implementation and the wrong one: it
    // turns "you typed the range backwards" into a plausible number, and the
    // picker would then report a valid width for a window covering nothing.
    expect(calendarDaysBetween('2026-09-06', '2026-09-05')).toBe(-1);
    expect(calendarDaysBetween('2027-01-01', '2026-01-01')).toBe(-365);
  });

  it('counts by the calendar, not by thirty-day months', () => {
    expect(calendarDaysBetween('2026-01-31', '2026-02-01')).toBe(1);
    expect(calendarDaysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(calendarDaysBetween('2024-02-28', '2024-03-01')).toBe(2);
  });

  it('is null when either end is not a real date', () => {
    expect(calendarDaysBetween('2026-02-30', '2026-03-01')).toBeNull();
    expect(calendarDaysBetween('2026-03-01', '2026-02-30')).toBeNull();
    expect(calendarDaysBetween('', '2026-03-01')).toBeNull();
    expect(calendarDaysBetween('2026-03-01', '')).toBeNull();
  });
});

describe('shiftDays', () => {
  it('leaves a date alone when shifted by nothing', () => {
    expect(shiftDays('2026-09-05', 0)).toBe('2026-09-05');
  });

  it('steps back over a month end and a year end', () => {
    expect(shiftDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(shiftDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDays('2026-09-01', -6)).toBe('2026-08-26');
  });

  it('steps forward into a leap day and out of a short month', () => {
    expect(shiftDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(shiftDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(shiftDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(shiftDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('round-trips, so a preset cannot drift a day from the anchor it was made from', () => {
    expect(shiftDays(shiftDays('2026-09-05', -29) ?? '', 29)).toBe('2026-09-05');
  });

  it('refuses a date it cannot read and a shift that is not a number', () => {
    expect(shiftDays('2026-02-30', 1)).toBeNull();
    expect(shiftDays('', 1)).toBeNull();
    expect(shiftDays('2026-09-05', Number.NaN)).toBeNull();
    expect(shiftDays('2026-09-05', Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('inclusiveDayCount', () => {
  it('counts both ends, so one day of trading is one and not zero', () => {
    expect(inclusiveDayCount('2026-09-05', '2026-09-05')).toBe(1);
    expect(inclusiveDayCount('2026-09-01', '2026-09-07')).toBe(7);
    expect(inclusiveDayCount('2026-08-26', '2026-09-05')).toBe(11);
  });

  it('counts a whole year as the days in it, leap year included', () => {
    expect(inclusiveDayCount('2026-01-01', '2026-12-31')).toBe(365);
    expect(inclusiveDayCount('2024-01-01', '2024-12-31')).toBe(366);
  });

  it('is zero or below for a reversed pair, which is how the picker knows', () => {
    expect(inclusiveDayCount('2026-09-06', '2026-09-05')).toBe(0);
    expect(inclusiveDayCount('2026-09-07', '2026-09-05')).toBe(-1);
  });

  it('is null when either end is not a real date', () => {
    expect(inclusiveDayCount('2026-02-30', '2026-03-01')).toBeNull();
    expect(inclusiveDayCount('2026-03-01', 'nope')).toBeNull();
  });
});

describe('todayIso', () => {
  it('is the UTC date of the instant it is given', () => {
    // Ghana is UTC+0 with no daylight saving, so the UTC date is the wall date in
    // Accra — the same day the backend stamps a sale with. Asserted against an
    // instant rather than against the machine's clock, so the answer here does not
    // depend on the timezone the suite happens to run in.
    expect(todayIso(new Date('2026-09-05T00:00:00Z'))).toBe('2026-09-05');
    expect(todayIso(new Date('2026-09-05T23:59:59Z'))).toBe('2026-09-05');
    expect(todayIso(new Date('2026-09-06T00:00:00Z'))).toBe('2026-09-06');
  });

  it('is a date the rest of this module accepts', () => {
    // The one place that reads the clock, and every preset is built from its
    // answer. If it ever yielded something `daysSinceEpoch` refused, every preset
    // would be null and the page would silently offer no shortcuts at all.
    expect(daysSinceEpoch(todayIso(new Date('2026-02-28T12:00:00Z')))).not.toBeNull();
    expect(shiftDays(todayIso(new Date('2026-12-31T12:00:00Z')), -1)).toBe('2026-12-30');
  });

  it('defaults to the current clock, in the same shape', () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(daysSinceEpoch(todayIso())).not.toBeNull();
  });
});

describe('dateTimeLocalToIso', () => {
  it('pins a wall time to UTC, because Ghana is UTC+0', () => {
    expect(dateTimeLocalToIso('2026-09-07T14:30')).toBe('2026-09-07T14:30:00.000Z');
  });

  it('keeps seconds when the input yields them', () => {
    expect(dateTimeLocalToIso('2026-09-07T14:30:05')).toBe('2026-09-07T14:30:05.000Z');
  });

  it('refuses a shape that is not a datetime-local value', () => {
    expect(dateTimeLocalToIso('')).toBeNull();
    expect(dateTimeLocalToIso('2026-09-07')).toBeNull();
    expect(dateTimeLocalToIso('14:30')).toBeNull();
    expect(dateTimeLocalToIso('2026-09-07 14:30')).toBeNull();
  });

  it('refuses an impossible calendar day rather than rolling it forward', () => {
    expect(dateTimeLocalToIso('2026-02-30T10:00')).toBeNull();
  });

  it('refuses an out-of-range clock time', () => {
    expect(dateTimeLocalToIso('2026-09-07T24:00')).toBeNull();
    expect(dateTimeLocalToIso('2026-09-07T23:60')).toBeNull();
  });
});

describe('isoToDateTimeLocal', () => {
  it('reads the wall time off a stored UTC timestamp', () => {
    expect(isoToDateTimeLocal('2026-09-07T14:30:00.000Z')).toBe('2026-09-07T14:30');
  });

  it('round-trips with dateTimeLocalToIso', () => {
    expect(isoToDateTimeLocal(dateTimeLocalToIso('2026-09-07T14:30'))).toBe('2026-09-07T14:30');
  });

  it('is empty for a missing or unreadable value', () => {
    expect(isoToDateTimeLocal(null)).toBe('');
    expect(isoToDateTimeLocal(undefined)).toBe('');
    expect(isoToDateTimeLocal('not-a-date')).toBe('');
  });
});
