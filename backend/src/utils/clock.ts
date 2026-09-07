/**
 * Reading the clock, in one place.
 *
 * `utils/fefo.ts` takes `today` as a parameter and states in its header that it
 * holds no clock, which is what makes the expiry boundary testable. Something
 * has to supply that parameter, and if every caller derives it independently
 * they will not all derive it the same way — one will use the local date, one
 * the UTC date, and the two will disagree for part of every day.
 *
 * The decision recorded here is that the UTC date is the right one for A&B.
 * Ghana is UTC+0 and has no daylight saving, so `toISOString().slice(0, 10)` is
 * the date on the wall in Accra at every hour of every day. That is a fact about
 * this pharmacy's location rather than a general truth: a deployment anywhere
 * with a nonzero offset would need a timezone-aware date here, and the expiry
 * boundary would move by a day for part of each day if it did not get one.
 */

/**
 * Today as `'YYYY-MM-DD'` — the shape every function in `utils/fefo.ts` takes,
 * and the shape a Postgres `date` column returns now that `database/pg-types.ts`
 * stops the driver from turning it into a `Date`.
 */
export function todayDateOnly(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The current instant as ISO-8601, for a `timestamptz` column. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}
