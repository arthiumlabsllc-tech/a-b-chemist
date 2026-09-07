import { todayDateOnly, nowIso } from '../utils/clock';
import { isDateOnly } from '../utils/fefo';

/**
 * The clock, and the guarantee the rest of the codebase rests on.
 *
 * `utils/fefo.ts` takes `today` as a parameter and refuses to read a clock
 * itself, which is what makes the expiry boundary testable. That only holds if
 * every caller derives the parameter the same way, and this is the suite that
 * says what "the same way" means: the UTC date, always.
 *
 * `jest.setup.js` pins `process.env.TZ` to a nine-hour offset for exactly this
 * file's benefit. Without it the assertions below would pass on a UTC+0 machine
 * whether `todayDateOnly` read the UTC calendar or the local one — and this
 * machine is UTC+0, as is Ghana, as is the production host.
 */

/**
 * 20:00 UTC on 15 March is 05:00 on 16 March in Tokyo.
 *
 * One instant where the UTC date and the local date are different days, so an
 * implementation that reached for `getFullYear`/`getMonth`/`getDate` returns
 * `'2026-03-16'` here and fails.
 */
const DISCRIMINATING_INSTANT = new Date('2026-03-15T20:00:00.000Z');

describe('clock', () => {
  it('is running in a zone that is not UTC, so the rest of this suite can tell the two apart', () => {
    // The vacuous-pass guard. If Node ever stopped honouring the TZ assignment
    // in jest.setup.js, every assertion below would still hold and would be
    // testing nothing — a local-calendar bug would be invisible again.
    expect(new Date(DISCRIMINATING_INSTANT).getTimezoneOffset()).not.toBe(0);
    expect(new Date(DISCRIMINATING_INSTANT).getDate()).not.toBe(15);
  });

  it('returns the UTC date, not the date where the server happens to be', () => {
    expect(todayDateOnly(DISCRIMINATING_INSTANT)).toBe('2026-03-15');
  });

  it('rolls over at UTC midnight, and not a moment earlier', () => {
    expect(todayDateOnly(new Date('2026-03-15T23:59:59.999Z'))).toBe('2026-03-15');
    expect(todayDateOnly(new Date('2026-03-16T00:00:00.000Z'))).toBe('2026-03-16');
  });

  it('returns a shape utils/fefo.ts will accept rather than throw on', () => {
    // The contract between the two modules, asserted from both ends. `fefo.ts`
    // throws on anything that is not a date-only string — deliberately, because a
    // timestamp passed as `today` would compare a date against a datetime and
    // move the expiry boundary by a day. If `todayDateOnly` ever returned an ISO
    // instant, that throw would be the first sign of it, at the counter.
    for (const instant of [
      '2026-01-01T00:00:00.000Z',
      '2026-02-28T12:00:00.000Z',
      '2026-03-15T20:00:00.000Z',
      '2026-12-31T23:59:59.999Z',
    ]) {
      const today = todayDateOnly(new Date(instant));
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(isDateOnly(today)).toBe(true);
    }
  });

  it('reads the current clock when given no argument', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-03-15T20:00:00.000Z'));
      expect(todayDateOnly()).toBe('2026-03-15');
      expect(nowIso()).toBe('2026-03-15T20:00:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns a full instant from nowIso, for a timestamptz column', () => {
    // Distinct from todayDateOnly on purpose: a movement or a reminder needs the
    // time of day, and truncating it to a date would make two events in one day
    // indistinguishable — the same class of defect that migration 0002 fixed in
    // the ledger's `created_at`.
    expect(nowIso(DISCRIMINATING_INSTANT)).toBe('2026-03-15T20:00:00.000Z');
    expect(Date.parse(nowIso(DISCRIMINATING_INSTANT))).toBe(DISCRIMINATING_INSTANT.getTime());
  });
});
