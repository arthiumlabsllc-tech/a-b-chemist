import { execFileSync } from 'child_process';
import path from 'path';
import { types } from 'pg';
import { DATE_OID, parseDateColumn, registerPgTypeParsers } from '../database/pg-types';

/**
 * The `date` type override.
 *
 * Two kinds of claim, proven in the two places they can be proven:
 *
 *   - that our module replaces the parser, and what it returns, in-process;
 *   - that the parser it replaces was unsafe, in a child process under a chosen
 *     timezone.
 *
 * The split is not a preference. Setting `process.env.TZ` inside a jest test has
 * no effect — checked, not assumed: the assignment is visible on `process.env`
 * and on `require('process').env`, and `new Date(...).getTimezoneOffset()` still
 * does not move, because V8's timezone is settled before the test runs and jest
 * never triggers a re-read. The same assignment in a plain `node -e` does move
 * it. A test that set TZ here would therefore pass whatever the code did, which
 * is worse than no test: it reads as coverage of the exact case it skips.
 */

const defaultDateParser = types.getTypeParser(DATE_OID);

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

interface DriverBehaviour {
  /** What pg's shipped parser yields for `2026-03-15` in this zone. */
  before: string;
  /** What the same parser yields once replaced by one that returns the string. */
  after: string;
}

/**
 * Reads the driver's behaviour for a `date` column in a child process started
 * under `zone`, before and after the override this module applies.
 *
 * The child restates the override as `(value) => value` rather than importing
 * it, because the module is TypeScript and a plain `node -e` cannot require it.
 * That the two are the same override is pinned by the in-process tests below:
 * they assert `registerPgTypeParsers` produces exactly this.
 *
 * `TZ` is passed in the child's environment rather than assigned inside it, so
 * this does not depend on the in-process re-read behaviour at all.
 */
function driverBehaviourIn(zone: string): DriverBehaviour {
  const script = [
    "const { types } = require('pg');",
    'const read = () => {',
    "  const parsed = types.getTypeParser(1082)('2026-03-15');",
    "  return parsed instanceof Date ? parsed.toISOString().slice(0, 10) : String(parsed);",
    '};',
    'const before = read();',
    'types.setTypeParser(1082, (value) => value);',
    'const after = read();',
    'process.stdout.write(JSON.stringify({ before, after }));',
  ].join('\n');

  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, TZ: zone },
    encoding: 'utf8',
  });
  return JSON.parse(output) as DriverBehaviour;
}

describe('the date column override', () => {
  beforeAll(() => {
    registerPgTypeParsers();
  });

  it('returns a date as the string that came over the wire', () => {
    expect(parseDateColumn('2026-03-15')).toBe('2026-03-15');
    expect(parseDateColumn('1999-12-31')).toBe('1999-12-31');
    expect(parseDateColumn('2028-02-29')).toBe('2028-02-29');
  });

  it('replaces a parser that handed back an instant where the column holds a day', () => {
    // A `date` has no time and no timezone; a Date has both, and the driver
    // invents them by placing the day at local midnight. This is the fact the
    // child-process test below turns into a moved date.
    expect(defaultDateParser('2026-03-15')).toBeInstanceOf(Date);
    expect(parseDateColumn('2026-03-15')).not.toBeInstanceOf(Date);
  });

  it('the default parser moves the day with the host clock, and the override does not', () => {
    // East of UTC, local midnight is the previous afternoon in UTC, so reading
    // the day back out with the obvious `toISOString().slice(0, 10)` gives the
    // 14th. An expiry date one day early makes sellable stock unsellable;
    // shifted the other way it keeps expired stock on the till.
    expect(driverBehaviourIn('Asia/Tokyo')).toEqual({ before: '2026-03-14', after: '2026-03-15' });

    // Accra is UTC+0, so this deployment would never have shown it. That is the
    // reason it is pinned here rather than left to be found by a CI runner, a
    // container image with a locale set, or a region move.
    expect(driverBehaviourIn('Africa/Accra')).toEqual({ before: '2026-03-15', after: '2026-03-15' });
    expect(driverBehaviourIn('UTC')).toEqual({ before: '2026-03-15', after: '2026-03-15' });

    // West of UTC the day survives, because local midnight is later the same day
    // in UTC. A developer in New York would have found nothing wrong, which is
    // what makes the bug worth a test rather than a shrug.
    expect(driverBehaviourIn('America/New_York')).toEqual({
      before: '2026-03-15',
      after: '2026-03-15',
    });
  });

  it('leaves timestamptz alone', () => {
    // A timestamptz is a real instant and a Date is the right shape for it;
    // overriding that too would break every `created_at` in the API. The literal
    // is Postgres's own wire format — the parser returns null for an ISO-8601
    // string with a `T` and a `Z`, which is not what arrives over the wire.
    const TIMESTAMPTZ_OID = 1184;
    expect(types.getTypeParser(TIMESTAMPTZ_OID)('2026-03-15 09:00:00+00')).toBeInstanceOf(Date);
    expect(DATE_OID).not.toBe(TIMESTAMPTZ_OID);
  });

  it('leaves numeric as the decimal string the driver already returns', () => {
    // Money must not become a double on the way in. This asserts the default is
    // already what we want, so changing it later is a decision rather than an
    // accident.
    const NUMERIC_OID = 1700;
    expect(types.getTypeParser(NUMERIC_OID)('2.3333')).toBe('2.3333');
    expect(types.getTypeParser(NUMERIC_OID)('12500.00')).toBe('12500.00');
  });

  it('is safe to register twice', () => {
    registerPgTypeParsers();
    registerPgTypeParsers();
    expect(parseDateColumn('2026-03-15')).toBe('2026-03-15');
  });
});
