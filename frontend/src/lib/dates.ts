/**
 * Calendar-day arithmetic on the `'YYYY-MM-DD'` strings the API sends and the
 * date inputs yield, and the two-way conversion between a `datetime-local` input
 * and the UTC timestamp the API stores.
 *
 * One module rather than one per page because the same three facts are needed by
 * the expiry badge, by a report's range and by any button that says "last seven
 * days": a day count must not depend on the timezone of the device reading it; an
 * impossible date must be refused rather than rolled forward into a neighbouring
 * one; and "today" is read in exactly one place, so two pages cannot disagree
 * about which day it is.
 *
 * Ghana is UTC+0 with no daylight saving, so the UTC date *is* the wall date in
 * Accra — the same reasoning `backend/src/utils/clock.ts` gives for stamping a
 * sale with the UTC day. A tablet set to another zone would read a different day
 * from the server's, and the fix for that is a timezone the pharmacy chooses, not
 * a browser's.
 */

const MS_PER_DAY = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Days from the epoch for a `'YYYY-MM-DD'` string, or null when it is not one.
 *
 * The round trip is the point. `Date.UTC` rolls an impossible date forward —
 * 2026-02-30 becomes 2 March — so formatting the result back and comparing
 * refuses a date nobody meant, instead of quietly answering about a different
 * one. Integer days rather than milliseconds is what keeps every comparison below
 * out of any timezone: two epoch-day numbers differ by the calendar, whatever
 * zone the machine is in.
 */
export function daysSinceEpoch(dateOnly: string): number | null {
  const [, year, month, day] = DATE_ONLY.exec(dateOnly) ?? [];
  if (year === undefined || month === undefined || day === undefined) return null;
  const days = Date.UTC(Number(year), Number(month) - 1, Number(day)) / MS_PER_DAY;
  return new Date(days * MS_PER_DAY).toISOString().slice(0, 10) === dateOnly ? days : null;
}

/**
 * Whole calendar days from `from` to `to`, or null when either is not a real date.
 *
 * Negative when `to` is the earlier of the two. A distance — the absolute value —
 * would be the friendlier answer and the wrong one: it turns "you typed the range
 * backwards" into a plausible number of days, and a reversed range is the mistake
 * a date picker most needs to name rather than absorb.
 */
export function calendarDaysBetween(from: string, to: string): number | null {
  const start = daysSinceEpoch(from);
  const end = daysSinceEpoch(to);
  if (start === null || end === null) return null;
  return end - start;
}

/**
 * `dateOnly` moved by whole days, or null when it is not a real date to move.
 *
 * Through the epoch-day count rather than `new Date(iso)` and `setDate`: those
 * work in local time, so shifting a UTC-midnight date by a day in a zone behind
 * UTC lands on 23:00 of the day before and formats back one day short. "Last
 * seven days" that silently means six is the kind of error nobody spots, because
 * the answer still looks like a week of trading.
 */
export function shiftDays(dateOnly: string, days: number): string | null {
  const start = daysSinceEpoch(dateOnly);
  if (start === null || !Number.isFinite(days)) return null;
  return new Date((start + days) * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * How many calendar days a window covers, counting both ends: one day is 1, not
 * 0, because "from 5 Sep to 5 Sep" is a day of trading.
 *
 * This is the figure the API's range ceiling is written in, so a picker that
 * counted the gap instead of the days would offer a range one day wider than the
 * server takes — and the operator would meet that as a 400 after waiting for the
 * request, not as a disabled button.
 */
export function inclusiveDayCount(from: string, to: string): number | null {
  const between = calendarDaysBetween(from, to);
  return between === null ? null : between + 1;
}

/**
 * Today as `'YYYY-MM-DD'`, and the only function here that reads the clock.
 *
 * Deliberately thin and parameterised: everything else takes a date as an
 * argument, so a test can pin a boundary — a leap day, a month end, the last day
 * a range may cover — without its answer depending on when it happens to run.
 */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Date-time inputs
// ---------------------------------------------------------------------------

/**
 * A `datetime-local` value into the UTC timestamp the API stores, or null when it
 * is not one.
 *
 * The input yields `'YYYY-MM-DDTHH:mm'` with no zone on it. The screening and
 * consultation routes validate `measuredAt`/`scheduledAt` with `isISO8601`, which a
 * zone-less string passes — but `new Date` on the server would then read it as
 * *server*-local time, a reading that moves with wherever the backend happens to
 * run. Appending `Z` pins it instead: Ghana is UTC+0 with no daylight saving, so
 * the wall time the pharmacist types at the counter *is* the UTC instant, which is
 * the same reasoning the day arithmetic above gives. A tablet set to another zone
 * does not change the answer, because the pharmacist types the time they mean
 * rather than a time their device's zone would convert.
 *
 * Seconds are accepted when a `step` on the input yields them and are normalised
 * into the result either way.
 */
export function dateTimeLocalToIso(value: string): string | null {
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (parts === null) return null;
  const date = parts[1];
  const hour = parts[2];
  const minute = parts[3];
  const second = parts[4] ?? '00';
  if (date === undefined || hour === undefined || minute === undefined) return null;
  // The date half is checked by the same round trip the day arithmetic uses, so
  // 2026-02-30T10:00 is refused rather than rolled into March.
  if (daysSinceEpoch(date) === null) return null;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  return `${date}T${hour}:${minute}:${second}.000Z`;
}

/**
 * A stored UTC timestamp into the value a `datetime-local` input takes, or `''`
 * when it cannot be read.
 *
 * The inverse of `dateTimeLocalToIso`, used to seed a reschedule form from the
 * appointment's `scheduledAt`. Because the API returns a timestamptz as a UTC `'Z'`
 * string and Ghana is UTC+0, the leading `YYYY-MM-DDTHH:mm` of it *is* the wall
 * time to show — so this slices rather than converting through `Date`, which would
 * move the value by the reading device's offset from UTC and hand back a time the
 * pharmacist did not book. `''` rather than null so it drops straight into a
 * controlled input's `value`.
 */
export function isoToDateTimeLocal(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '';
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  if (parts === null) return '';
  const date = parts[1];
  const hhmm = parts[2];
  if (date === undefined || hhmm === undefined) return '';
  return daysSinceEpoch(date) === null ? '' : `${date}T${hhmm}`;
}
