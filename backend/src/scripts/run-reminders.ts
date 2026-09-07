import { closePool } from '../database/pool';
import { listPharmacyIds } from '../repositories/pharmacies.repository';
import {
  DEFAULT_REMINDER_BATCH_LIMIT,
  refreshReminders,
  type RefreshSummary,
} from '../services/reminders.service';
import { nowIso } from '../utils/clock';
import { scoped } from '../utils/logger';

/**
 * Runs the reminder batch once, then exits.
 *
 * This is the "scheduler hook" Phase 8 asks for, and it is deliberately a script
 * rather than a timer inside the server. A `setInterval` in the API process would
 * run once per replica, so two Render instances would each pick up the same due
 * reminder; the dedupe key stops that producing two bell entries, but it does not
 * stop two attempts at one text message, which is the window
 * `services/reminders.service.ts` documents at length. A cron entry runs once
 * regardless of how many replicas are serving traffic.
 *
 * Cron, on the host or through Render's cron jobs. The minutes are listed
 * rather than written as a step, because the step spelling of "every quarter
 * hour" begins with a slash-star sequence that would close this comment:
 *
 *     0,15,30,45 * * * *  cd /opt/backend && npm run reminders:run
 *
 * Every run is independent and safe to repeat. A run that finds nothing due does
 * nothing and exits zero, so overlapping or duplicated invocations cost one
 * empty query each.
 *
 * ## What it logs, and why the wording matters
 *
 * In this environment no SMS provider is configured, so *every* reminder the
 * batch deals with is dealt with as `not sent`, with a reason written beside it
 * and a bell entry raised so the pharmacy sees it in the app. A log line reading
 * "processed 12 reminders" would therefore say something false — it would read as
 * twelve patients texted. The summary is printed with its categories intact, and
 * a run that sent nothing says so in those words.
 */

const log = scoped('reminders:run');

/**
 * How many batches one run will take before it stops and says it stopped.
 *
 * The drain terminates without this: `now` is fixed for the whole run, so
 * `due_at <= now` selects from a set that cannot grow while the loop is running,
 * and every reminder selected leaves `pending` before the next pass looks. The
 * cap is here anyway, because that argument rests on reading
 * `dealWithReminder` correctly and a cron job that never finishes is worse than
 * one that finishes having left 40 reminders for the next run. Hitting the cap
 * is logged rather than silent.
 *
 * 20 passes of 50 is 1000 reminders, which is more than A&B's whole patient
 * list could produce in one day.
 *
 * Exported so the test can pin the cap rather than restate it, and so a caller
 * that wants a shallower run can see the ceiling it is running under.
 */
export const MAX_PASSES = 20;

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * One line per pharmacy, with the categories kept separate.
 *
 * `alreadyDealt` is reported rather than folded into the others: it means
 * another run reached this reminder first, and a number that is usually zero
 * becoming nonzero is the visible symptom of two schedulers running at once.
 */
export function summarise(pharmacyId: string, summary: RefreshSummary): string {
  const parts = [
    `${summary.due} due`,
    `${summary.sent} sent`,
    `${summary.notSent} not sent`,
    `${summary.failed} failed`,
  ];
  if (summary.alreadyDealt > 0) parts.push(`${summary.alreadyDealt} already dealt with`);
  return `${pharmacyId}: ${parts.join(', ')}`;
}

export async function drain(pharmacyId: string, now: string): Promise<void> {
  for (let pass = 1; pass <= MAX_PASSES; pass += 1) {
    const summary = await refreshReminders(pharmacyId, now);

    if (summary.due === 0) {
      // Nothing left. The first pass finding nothing is the normal case and is
      // logged at debug so a cron log is not full of empty runs; a pass that
      // follows real work is logged at info as the run's result.
      const line = summarise(pharmacyId, summary);
      if (pass === 1) log.debug(`${line} — nothing due`);
      else log.info(`${line} — drained in ${pass - 1} ${pass === 2 ? 'pass' : 'passes'}`);
      return;
    }

    log.info(`pass ${pass}: ${summarise(pharmacyId, summary)}`);

    if (summary.due < DEFAULT_REMINDER_BATCH_LIMIT) {
      // A short batch means the queue is empty; there is no next pass to take.
      log.info(`${pharmacyId}: nothing further due`);
      return;
    }

    if (pass === MAX_PASSES) {
      // Full batch on the last allowed pass, so there may be more waiting. Said
      // plainly rather than left to be inferred from the pass count.
      log.warn(
        `${pharmacyId}: stopped after ${MAX_PASSES} passes of ${DEFAULT_REMINDER_BATCH_LIMIT} ` +
          'and the last pass was still full, so reminders may remain. The next run picks them up.'
      );
    }
  }
}

/**
 * One complete run: find the pharmacies, take the instant, drain each.
 *
 * Exported rather than left as the body of a top-level call so that
 * `__tests__/run-reminders.test.ts` can assert what it does. The other two
 * scripts in this directory run on import and are therefore untested; this one
 * has logic in it — a loop bound and a log line that has to stay honest about
 * nothing having been sent — and logic that cannot be reached by a test is logic
 * that cannot be seen to fail.
 */
export async function runReminders(): Promise<void> {
  const pharmacyIds = await listPharmacyIds();

  if (pharmacyIds.length === 0) {
    // Not "nothing to do". The scheduler was asked to serve a pharmacy and the
    // database has none, which means `npm run db:apply` has not run against this
    // connection string. Exiting zero would let a cron job report success while
    // pointing at the wrong database forever.
    throw new Error(
      'the database has no pharmacy in it. Run npm run db:apply against this DATABASE_URL first.'
    );
  }

  // Taken once, before any pharmacy is processed. A run that asked for the time
  // per pharmacy would judge each against a slightly different instant, and the
  // summaries would not be comparable — or, in the pathological case, a reminder
  // due between the two reads would be picked up for one pharmacy's pass and
  // missed for another's. `nowIso` is UTC, which is correct for Ghana: UTC+0 and
  // no daylight saving.
  const now = nowIso();

  log.info(
    `${pharmacyIds.length === 1 ? '1 pharmacy' : `${pharmacyIds.length} pharmacies`}, ` +
      `batch limit ${DEFAULT_REMINDER_BATCH_LIMIT}, instant ${now}`
  );

  for (const pharmacyId of pharmacyIds) {
    await drain(pharmacyId, now);
  }
}

// `require.main === module` is what makes the export above safe: the module runs
// the batch when cron starts it, and does nothing when a test imports it. Without
// the guard, `jest` would open a real database connection on collection.
if (require.main === module) {
  runReminders()
    .catch((error: unknown) => {
      log.error(describe(error));
      process.exitCode = 1;
    })
    .finally(() =>
      // As in `seed-owner-password.ts`: an idle pooled client holds the event loop
      // open, and without this the script prints its summary and then hangs until
      // the idle timeout, which in a cron log looks like a job that never ends.
      closePool()
    );
}
