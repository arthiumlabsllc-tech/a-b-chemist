import { query } from '../database/pool';

/**
 * The `pharmacies` table, read for the one question the tax settings do not ask:
 * which pharmacies exist.
 *
 * `tax-settings.repository.ts` already reads this table, but it reads *a* row
 * that a request has named. This exists for the callers that have no request —
 * the reminder scheduler chief among them, which runs from cron with nobody
 * signed in and therefore no token to take a `pharmacy_id` from.
 *
 * ## Why the id is queried rather than configured
 *
 * The obvious alternative is a `PHARMACY_ID` environment variable. It is
 * rejected because of how it fails. A variable that is absent is caught at boot
 * by `findConfigProblems`, but a variable that is *present and wrong* is not
 * caught anywhere: the scheduler would run, find no due reminders for a pharmacy
 * that has no reminders, log a clean summary and exit zero. Every patient's
 * refill reminder would silently never be sent, and the log would say the
 * opposite. That is the worst failure mode this system has, because the thing
 * that goes missing is the thing nobody is looking at.
 *
 * Asking the table cannot be wrong in that way. It returns whatever pharmacies
 * the database actually has — one today, because `init.sql` seeds one and
 * `database/tests/assertions.sql` ASSERT 8a pins `count(*) = 1`. If A&B ever
 * re-seeds with a generated uuid instead of the fixed literal, this still works
 * and the variable would not. And if a second pharmacy ever appears, both are
 * served instead of one being left behind.
 *
 * The cost is one indexed scan of a one-row table per scheduler run. That is not
 * a cost worth trading the failure mode against.
 */

/**
 * Every pharmacy id in the database, in a fixed order.
 *
 * Ordered by `id` rather than returned unordered because a scheduler that
 * processes pharmacies in a different order each run makes its log unreadable:
 * two runs with the same outcome would print their lines in different orders,
 * and diffing them would show a change where there was none. `id` is a uuid and
 * so carries no meaning, but its order is stable, which is the only thing asked
 * of it here.
 *
 * An empty result is a real state and is reported as one rather than thrown. A
 * database with no pharmacy in it is a database that has not been seeded, and
 * the caller says so; throwing here would turn that into a stack trace in a cron
 * log, which reads like a crash and is not one.
 */
export async function listPharmacyIds(): Promise<string[]> {
  const result = await query('select id from pharmacies order by id', []);
  return result.rows.map((row) => row.id as string);
}
