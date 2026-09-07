import { types } from 'pg';

/**
 * Type parsers `pg`'s defaults get wrong for this schema.
 *
 * Registered from `getPool()` rather than as an import side effect, so the
 * override is in place exactly when a connection is about to be made and a
 * module that never touches the database never changes global driver state.
 */

/** `date`. Not `timestamp` and not `timestamptz`, which are different OIDs and are left alone. */
export const DATE_OID = 1082;

let registered = false;

/**
 * Hands back a Postgres `date` as the string it came over the wire as.
 *
 * The default parser builds a JS `Date` at local midnight, and a `Date` is an
 * instant in a timezone while a `date` is neither. Converting one to the other
 * and back moves it: on a host east of UTC, `2026-03-15` becomes
 * `2026-03-14T15:00:00.000Z`, and anything that reads the date back out of that
 * — `toISOString().slice(0, 10)`, the obvious thing to write — gets the 14th.
 *
 * Verified against pg-types 2.2.0 in UTC, America/New_York, Asia/Tokyo and
 * Africa/Accra. Accra is UTC+0, so this deployment would not have shown the
 * bug; a CI runner, a container base image with a locale set, or a region
 * migration would have, and it would have shown up as stock becoming
 * unsellable a day early — or, shifted the other way, as expired stock still
 * on the till.
 *
 * The string is also what `utils/fefo.ts` wants. `expiryDate` is `'YYYY-MM-DD'`
 * there and the whole module reasons about it as a date with no time in it,
 * which is what the column actually holds.
 *
 * Idempotent: `setTypeParser` replaces, so registering twice would be harmless,
 * but the flag keeps the intent obvious and the function cheap to call from
 * `getPool()` on every connection.
 */
export function registerPgTypeParsers(): void {
  if (registered) return;
  registered = true;
  types.setTypeParser(DATE_OID, (value: string) => value);
}

/**
 * Reads back what the driver will now return for a `date`, for tests.
 *
 * Goes through `pg`'s own registry rather than calling the function above, so
 * a test using this is asserting what the driver does and not what this module
 * believes it asked for.
 */
export function parseDateColumn(value: string): unknown {
  return types.getTypeParser(DATE_OID)(value);
}
