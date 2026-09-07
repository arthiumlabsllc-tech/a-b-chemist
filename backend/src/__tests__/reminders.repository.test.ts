import fs from 'node:fs';
import path from 'node:path';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Sql } from '../database/pool';
import {
  findReminder,
  listDueReminders,
  listReminders,
  recordReminderOutcome,
  scheduleReminder,
  supersedeAppointmentReminders,
  supersedeRefillReminder,
  type NewReminder,
} from '../repositories/reminders.repository';
import * as repository from '../repositories/reminders.repository';
import {
  appointmentReminderKey,
  appointmentReminderPrefix,
  refillReminderKey,
} from '../utils/reminder-keys';
import type { NotificationStatus } from '../utils/schema-enums';

/**
 * The SQL the reminders repository emits, the row it maps back, and the dedupe key
 * format the two of them share.
 *
 * Phase 8's acceptance lines are both about this module: deduplication proven so a
 * repeated refresh does not re-raise the same reminder, and the unsent state proven
 * honest. Neither is visible from a service test, which mocks this module and so
 * never sees a statement, a parameter list or a conflict clause at all.
 *
 * What is pinned here that nothing else can see:
 *
 *   - A reminder created already `sent`, or created with a reason, or created
 *     attached to a bell entry it never raised. All three columns are absent from
 *     the insert, so there is no parameter through which any of them could arrive.
 *   - A dedupe path that returns a mapped row instead of saying nothing happened.
 *     `scheduled: false` is the only signal a refresh has that it changed nothing,
 *     and a caller cannot distinguish "I raised this" from "somebody already had"
 *     without it.
 *   - `status = 'pending'` written as a parameter. Valid, and silently a sequential
 *     scan of every reminder the pharmacy has ever written, because the partial
 *     index the queue depends on is predicated on that exact literal.
 *   - An exclusive `due_at < $2`, which leaves a reminder due at precisely the
 *     instant the scheduler ran to the next run, and then the one after that.
 *   - The supersede statement spelling its own `'appointment:'` prefix instead of
 *     taking it from `utils/reminder-keys.ts`, which would be a second copy of one
 *     format and the two would drift without either erroring.
 *   - A prefix wide enough to match another consultation, which would cancel every
 *     appointment reminder in the pharmacy when one appointment moved.
 *   - The refill supersede matching its key with a prefix where the appointment one
 *     needs one. A refill is keyed to the prescription alone, so exactly one row can
 *     ever match; widening that to `like` would turn a statement with one possible
 *     answer into one that guesses, and the guess would be invisible.
 *
 * Section 18 of `database/tests/assertions.sql` executes all of it against a real
 * server: 18b proves the three defaults, 18c runs one dedupe key through the insert
 * twice and requires the second refresh to raise nothing, change nothing and stamp
 * nothing, 18d requires `not_sent` to be refused both with a supplied null reason
 * and with the reason omitted while a real reason goes straight through, 18e
 * requires a second scheduler run guarded on `pending` to match nothing, 18f
 * requires the queue to hold exactly the reminders that are both pending and due
 * with the one due at that instant included, 18g reads the partial index's
 * predicate out of the catalog, 18h supersedes one moved appointment and requires
 * four other reminders to survive it untouched, and 18i requires a reminder to go
 * with its patient. 18j supersedes a refill by its exact key -- the statement that
 * stops a collected prescription texting the patient about medicine they are
 * already holding -- and requires the appointment reminder beside it and the refill
 * already dealt with to survive it. The last describe block here is the tie between
 * those statements and these.
 */

interface Call {
  text: string;
  params: unknown[];
}

/** Collapses whitespace, so a reformat is not a failure but a rewrite is. */
function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const PATIENT = 'a0000000-0000-4000-8000-000000000040';
const REMINDER = 'a0000000-0000-4000-8000-0000000000c1';
const NOTIFICATION = 'a0000000-0000-4000-8000-0000000000d2';
const CONSULTATION = 'c0000000-0000-4000-8000-000000000001';
const OTHER_CONSULTATION = 'c0000000-0000-4000-8000-000000000002';
const PRESCRIPTION = 'a0000000-0000-4000-8000-0000000000a1';
const DUE = new Date('2026-04-20T09:00:00.000Z');
const STAMP = new Date('2026-04-06T09:15:00.000Z');
const MESSAGE = 'Your blood pressure script is due for a refill.';
const KEY = refillReminderKey(PRESCRIPTION);
const REASON = 'no SMS provider is configured';

function fakeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REMINDER,
    pharmacy_id: PHARMACY,
    patient_id: PATIENT,
    kind: 'refill',
    due_at: DUE,
    message: MESSAGE,
    status: 'pending',
    not_sent_reason: null,
    notification_id: null,
    dedupe_key: KEY,
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  };
}

const NEW_REMINDER: NewReminder = {
  pharmacyId: PHARMACY,
  patientId: PATIENT,
  kind: 'refill',
  dueAt: '2026-04-20T09:00:00.000Z',
  message: MESSAGE,
  dedupeKey: KEY,
};

type Outcome = { rows: Record<string, unknown>[] } | { error: unknown };

interface Recorder {
  sql: Sql;
  calls: Call[];
  queueRows: (rows: Record<string, unknown>[]) => void;
  queueError: (error: unknown) => void;
}

/**
 * Records every call and then decides what to answer.
 *
 * One implementation rather than `mockResolvedValueOnce` replacing it: a
 * replacement would skip the recording, and most of what is asserted here is how
 * many statements were issued and with how many parameters, not what they said.
 */
function recorder(): Recorder {
  const calls: Call[] = [];
  const scripted: Outcome[] = [];
  const fallback: Record<string, unknown>[] = [fakeRow()];

  const sql: Sql = {
    query<T extends QueryResultRow>(
      text: string,
      values?: readonly unknown[]
    ): Promise<QueryResult<T>> {
      calls.push({ text: normalise(text), params: [...(values ?? [])] });

      const outcome = scripted.shift();
      if (outcome !== undefined && 'error' in outcome) {
        return Promise.reject(outcome.error);
      }
      const rows = (outcome !== undefined ? outcome.rows : fallback) as T[];
      return Promise.resolve({
        rows,
        rowCount: rows.length,
        oid: 0,
        fields: [],
        command: '',
      } as QueryResult<T>);
    },
  };

  return {
    sql,
    calls,
    queueRows: (rows) => scripted.push({ rows }),
    queueError: (error) => scripted.push({ error }),
  };
}

function onlyCall(calls: Call[]): Call {
  if (calls.length !== 1) {
    throw new Error(`expected exactly one statement, saw ${calls.length}`);
  }
  const call = calls[0];
  if (call === undefined) throw new Error('unreachable');
  return call;
}

/**
 * One call of every statement the module can emit — which is eight, because the
 * list has two whole orderings behind it, the queue is a statement of its own, and
 * the two supersede statements match their keys differently.
 */
async function everyStatementShape(): Promise<Call[]> {
  const { sql, calls } = recorder();
  await scheduleReminder(sql, NEW_REMINDER);
  await findReminder(sql, PHARMACY, REMINDER);
  await listDueReminders(sql, PHARMACY, '2026-04-21T12:00:00.000Z', 50);
  await listReminders(sql, PHARMACY, { order: 'upcoming', limit: 50, offset: 0 });
  await listReminders(sql, PHARMACY, { order: 'recent', limit: 50, offset: 0 });
  await recordReminderOutcome(
    sql,
    PHARMACY,
    REMINDER,
    { status: 'not_sent', notSentReason: REASON },
    ['pending']
  );
  await supersedeAppointmentReminders(sql, PHARMACY, CONSULTATION, 'keep', REASON);
  await supersedeRefillReminder(sql, PHARMACY, PRESCRIPTION, REASON);
  return calls;
}

describe('scheduleReminder', () => {
  it('sends six parameters in column order', async () => {
    const { sql, calls } = recorder();

    await scheduleReminder(sql, NEW_REMINDER);

    expect(onlyCall(calls).params).toEqual([
      PHARMACY,
      PATIENT,
      'refill',
      '2026-04-20T09:00:00.000Z',
      MESSAGE,
      KEY,
    ]);
  });

  it('names neither status nor reason nor notification, so none of the three can be forged', async () => {
    const { sql, calls } = recorder();

    await scheduleReminder(sql, NEW_REMINDER);

    // Asserted on the column list, because all three words also appear in the
    // returning clause. 18b proves each default against a real server: a new
    // reminder is `pending`, has no reason, and is attached to no bell entry. A
    // parameter for `status` would be a way to write a reminder claiming it was
    // sent when nothing was attempted, which is the dishonest state migration 0005
    // exists to make impossible.
    expect(onlyCall(calls).text).toContain(
      'insert into reminders (pharmacy_id, patient_id, kind, due_at, message, dedupe_key) values'
    );
    expect(onlyCall(calls).params).toHaveLength(6);
    expect(onlyCall(calls).text).toContain(
      'returning id, pharmacy_id, patient_id, kind, due_at, message, status'
    );
  });

  it('deduplicates in the database, with the conflict target the unique index actually has', async () => {
    const { sql, calls } = recorder();

    await scheduleReminder(sql, NEW_REMINDER);

    // The whole mechanism, and the reason it is not a select followed by an insert:
    // that pair is a race with a window exactly as wide as the two round trips
    // between the read and the write, and its failure mode is a patient getting the
    // same message twice. Naming both columns matters too — a conflict target of
    // `dedupe_key` alone would not match the unique index, and Postgres refuses an
    // ON CONFLICT whose target has no index to infer.
    expect(onlyCall(calls).text).toContain(
      'on conflict (pharmacy_id, dedupe_key) do nothing'
    );
    expect(onlyCall(calls).text).not.toContain('do update');
  });

  it('says nothing happened when the key was already held, rather than answering with a row', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    // `do nothing` returns no row on a conflict, and this is the acceptance line:
    // a repeated refresh reports that it re-raised nothing. A caller that received
    // a mapped row here would raise a notification for a reminder that already has
    // one, and the bell would fill with duplicates of the same refill.
    await expect(scheduleReminder(sql, NEW_REMINDER)).resolves.toEqual({
      scheduled: false,
      reminder: null,
    });
  });

  it('says it raised the reminder when it did, with the row beside the answer', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow()]);

    const result = await scheduleReminder(sql, NEW_REMINDER);

    // Both halves together, so a caller cannot have to choose between knowing that
    // something changed and knowing what.
    expect(result.scheduled).toBe(true);
    expect(result.reminder?.dedupeKey).toBe(KEY);
  });

  it('rejects with the database error unchanged, so a refused reminder reaches the caller', async () => {
    const { sql, queueError } = recorder();
    const checkViolation = Object.assign(new Error('check violation'), { code: '23514' });
    queueError(checkViolation);

    // 18d proves the server raises 23514 for an unexplained `not_sent`. This is the
    // other half: the repository must not flatten the code into a generic failure,
    // or the service cannot tell a refused row from a lost connection.
    await expect(scheduleReminder(sql, NEW_REMINDER)).rejects.toBe(checkViolation);
  });
});

describe('findReminder', () => {
  it('filters on pharmacy as well as id, and answers null when there is no such row', async () => {
    const { sql, calls, queueRows } = recorder();
    queueRows([]);

    await expect(findReminder(sql, PHARMACY, REMINDER)).resolves.toBeNull();

    // The pharmacy predicate is what stops one tenant reading another's reminders by
    // guessing an id. Single-tenant today, and the column is still there because a
    // `where id = $1` that works is the failure nobody notices until it does not.
    expect(onlyCall(calls).params).toEqual([PHARMACY, REMINDER]);
    expect(onlyCall(calls).text).toContain('where pharmacy_id = $1 and id = $2');
  });
});

describe('listDueReminders', () => {
  it('writes the pending status as a literal, because the index it needs is partial on exactly that', async () => {
    const { sql, calls } = recorder();

    await listDueReminders(sql, PHARMACY, '2026-04-21T12:00:00.000Z', 50);

    // Unusual for this codebase and deliberate. `reminders_pharmacy_due_idx` is a
    // partial index on (pharmacy_id, due_at) where status = 'pending', and the
    // planner only considers it when the query's own predicate implies the index's.
    // A bound value is unknown at plan time, so the queue would be a sequential scan
    // of every reminder ever written, on every tick, growing forever. 18g reads the
    // predicate out of the catalog so the two cannot disagree unnoticed.
    expect(onlyCall(calls).text).toContain("and status = 'pending'");
    expect(onlyCall(calls).params).toHaveLength(3);
    expect(onlyCall(calls).params).not.toContain('pending');
  });

  it('includes a reminder due at exactly the instant asked about', async () => {
    const { sql, calls } = recorder();

    await listDueReminders(sql, PHARMACY, '2026-04-21T12:00:00.000Z', 50);

    // `<=` and not `<`. An exclusive bound would leave a reminder due at precisely
    // the moment the scheduler ran to the next run, and then to the one after that
    // for as long as the clock happened to land on it. 18f executes this with a
    // fixture due at exactly the instant passed in.
    expect(onlyCall(calls).text).toContain('and due_at <= $2::timestamptz');
    expect(onlyCall(calls).text).not.toContain('due_at < $2::timestamptz');
  });

  it('takes the instant from the caller rather than asking the server for it', async () => {
    const { sql, calls } = recorder();

    await listDueReminders(sql, PHARMACY, '2026-04-21T12:00:00.000Z', 50);

    // `now()` would work and would be one fewer parameter. A parameter means every
    // reminder in one scheduler run is selected against one instant, so the run can
    // be reasoned about afterwards from the timestamp it was given, and a test can
    // choose the instant instead of racing the clock.
    expect(onlyCall(calls).text).not.toContain('now()');
    expect(onlyCall(calls).params[1]).toBe('2026-04-21T12:00:00.000Z');
  });

  it('orders soonest first with an id tie-break, and lets the limit bind', async () => {
    const { sql, calls } = recorder();

    await listDueReminders(sql, PHARMACY, '2026-04-21T12:00:00.000Z', 10);

    // The tie-break is not decoration: two reminders written in one refresh share a
    // `due_at` only if they were given one, but they certainly share `created_at`,
    // and a queue whose order changes between two identical calls is a queue that
    // can skip a reminder when it is paged through.
    expect(onlyCall(calls).text).toContain('order by due_at asc, id asc');
    expect(onlyCall(calls).text).toContain('limit $3');
    expect(onlyCall(calls).params[2]).toBe(10);
  });

  it('answers an empty queue with an empty list', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    // The common case — most ticks have nothing due — and `null` here would be a
    // crash in the scheduler loop rather than a quiet no-op.
    await expect(
      listDueReminders(sql, PHARMACY, '2026-04-21T12:00:00.000Z', 50)
    ).resolves.toEqual([]);
  });
});

describe('listReminders', () => {
  it('sends eight parameters, with every filter null when none was asked for', async () => {
    const { sql, calls } = recorder();

    await listReminders(sql, PHARMACY, { limit: 50, offset: 0 });

    expect(onlyCall(calls).params).toEqual([PHARMACY, null, null, null, null, null, 50, 0]);
  });

  it('folds an empty kind list into null, because `= any(\'{}\')` matches no row', async () => {
    const { sql, calls } = recorder();

    await listReminders(sql, PHARMACY, { kinds: [], limit: 50, offset: 0 });

    // Valid SQL, and silently empty. A dashboard asked for "both kinds" by a caller
    // that filtered a list down to nothing would show no reminders at all, which
    // reads as a pharmacy with nobody due a refill rather than as a broken filter.
    expect(onlyCall(calls).params[2]).toBeNull();
  });

  it('folds an empty status list into null too, in the same statement', async () => {
    const { sql, calls } = recorder();

    await listReminders(sql, PHARMACY, { statuses: [], limit: 50, offset: 0 });

    // The same trap in the second array of one statement. Folded in one place and
    // not the other, the list would be empty for a reason nobody could see.
    expect(onlyCall(calls).params[3]).toBeNull();
  });

  it('copies both arrays rather than binding the caller\'s', async () => {
    const { sql, calls } = recorder();
    const kinds: Array<'refill' | 'appointment'> = ['refill'];
    const statuses: NotificationStatus[] = ['pending'];

    await listReminders(sql, PHARMACY, { kinds, statuses, limit: 50, offset: 0 });
    kinds.push('appointment');
    statuses.push('sent');

    // The pushes happen after the call. Bound directly, the recorded parameters
    // would be the same objects and would now each hold two values.
    expect(onlyCall(calls).params[2]).toEqual(['refill']);
    expect(onlyCall(calls).params[3]).toEqual(['pending']);
  });

  it('widens the closing date to the whole day, on due_at rather than created_at', async () => {
    const { sql, calls } = recorder();

    await listReminders(sql, PHARMACY, {
      from: '2026-04-01',
      to: '2026-04-30',
      limit: 50,
      offset: 0,
    });

    // `due_at` is a `timestamptz`, so `$6::date` is midnight at the *start* of the
    // day and a closing bound of `<=` would drop every reminder due on the last day
    // asked for. Both bounds are on `due_at` and not `created_at`, because when a
    // reminder is due is the fact a dashboard sorts by: filtered on one column and
    // ordered by another, the pages would not line up with the filter.
    expect(onlyCall(calls).text).toContain(
      "and ($6::date is null or due_at < $6::date + interval '1 day')"
    );
    expect(onlyCall(calls).text).toContain('and ($5::date is null or due_at >= $5::date)');
    expect(onlyCall(calls).text).not.toContain('created_at >= $5');
    expect(onlyCall(calls).params.slice(4, 6)).toEqual(['2026-04-01', '2026-04-30']);
  });

  it('orders soonest first unless the history was asked for, and defaults to the dashboard', async () => {
    const upcoming = recorder();
    await listReminders(upcoming.sql, PHARMACY, { limit: 50, offset: 0 });
    const defaulted = recorder();
    await listReminders(defaulted.sql, PHARMACY, { order: 'upcoming', limit: 50, offset: 0 });
    const recent = recorder();
    await listReminders(recent.sql, PHARMACY, { order: 'recent', limit: 50, offset: 0 });

    expect(onlyCall(upcoming.calls).text).toContain('order by due_at asc, id asc');
    expect(onlyCall(defaulted.calls).text).toBe(onlyCall(upcoming.calls).text);
    expect(onlyCall(recent.calls).text).toContain('order by due_at desc, id desc');
    // Each ordering has to be absent from the other's statement. One reversed would
    // return the same page in the other sequence rather than the other end of the
    // list, which with limit and offset is a different set of reminders entirely.
    expect(onlyCall(upcoming.calls).text).not.toContain('desc');
    expect(onlyCall(recent.calls).text).not.toContain('asc');
  });

  it('is one statement per ordering for every filter combination, because there is no builder', async () => {
    const { sql, calls } = recorder();

    await listReminders(sql, PHARMACY, { limit: 50, offset: 0 });
    await listReminders(sql, PHARMACY, { patientId: PATIENT, limit: 50, offset: 0 });
    await listReminders(sql, PHARMACY, {
      patientId: PATIENT,
      kinds: ['refill', 'appointment'],
      statuses: ['pending', 'not_sent'],
      from: '2026-04-01',
      to: '2026-04-30',
      limit: 20,
      offset: 40,
    });
    await listReminders(sql, PHARMACY, { order: 'recent', limit: 20, offset: 0 });

    // A `where` spliced together per combination would need one PREPARE per shape,
    // and the shapes no test happened to exercise would be statements nobody ever
    // parsed against the real schema. Two orderings, two statements, no more.
    expect([...new Set(calls.map((call) => call.text))]).toHaveLength(2);
    expect(calls[2]?.params).toEqual([
      PHARMACY,
      PATIENT,
      ['refill', 'appointment'],
      ['pending', 'not_sent'],
      '2026-04-01',
      '2026-04-30',
      20,
      40,
    ]);
  });
});

describe('recordReminderOutcome', () => {
  it('sends seven parameters, with the guard list last', async () => {
    const { sql, calls } = recorder();

    await recordReminderOutcome(
      sql,
      PHARMACY,
      REMINDER,
      { status: 'not_sent', notSentReason: REASON },
      ['pending']
    );

    expect(onlyCall(calls).params).toEqual([
      PHARMACY,
      REMINDER,
      'not_sent',
      true,
      REASON,
      null,
      ['pending'],
    ]);
  });

  it('writes the status directly, because an outcome with no status is not an outcome', async () => {
    const { sql, calls } = recorder();

    await recordReminderOutcome(sql, PHARMACY, REMINDER, { status: 'sent' }, ['pending']);

    // Not coalesced and not flagged, unlike every other preserving update in this
    // codebase. `status` is required in the type and written outright, so there is
    // no call shape that leaves a reminder in the state it was in while claiming to
    // have recorded an outcome for it.
    expect(onlyCall(calls).text).toContain('set status = $3::notification_status');
    expect(onlyCall(calls).text).not.toContain('status = coalesce');
  });

  it('treats an omitted reason as "leave it" and a supplied null as "clear it"', async () => {
    const clearing = recorder();
    await recordReminderOutcome(
      clearing.sql,
      PHARMACY,
      REMINDER,
      { status: 'sent', notSentReason: null },
      ['not_sent']
    );
    const leaving = recorder();
    await recordReminderOutcome(leaving.sql, PHARMACY, REMINDER, { status: 'sent' }, ['not_sent']);

    // The flagged case, and the reason it is not a coalesce: a retry that succeeds
    // has to be able to take the old reason off, or the row reads `sent` with "no
    // SMS provider is configured" still beside it. 18e executes both halves.
    expect(onlyCall(clearing.calls).params.slice(3, 5)).toEqual([true, null]);
    expect(onlyCall(leaving.calls).params.slice(3, 5)).toEqual([false, null]);
    expect(onlyCall(clearing.calls).text).toContain(
      'not_sent_reason = case when $4::boolean then $5::text else not_sent_reason end'
    );
  });

  it('coalesces the notification id, so a later outcome cannot un-attach the bell entry', async () => {
    const { sql, calls } = recorder();

    await recordReminderOutcome(
      sql,
      PHARMACY,
      REMINDER,
      { status: 'not_sent', notSentReason: REASON, notificationId: NOTIFICATION },
      ['pending']
    );

    // The opposite treatment from the reason, on purpose. A notification id is
    // written once, when the reminder raises its bell entry, and there is no
    // operation that should un-write it: a reminder that stops pointing at the
    // notification it raised leaves a bell entry nothing accounts for.
    expect(onlyCall(calls).text).toContain(
      'notification_id = coalesce($6::uuid, notification_id)'
    );
    expect(onlyCall(calls).params[5]).toBe(NOTIFICATION);
  });

  it('guards on the status the row is in, as a parameter the caller chooses', async () => {
    const { sql, calls } = recorder();

    await recordReminderOutcome(
      sql,
      PHARMACY,
      REMINDER,
      { status: 'not_sent', notSentReason: REASON },
      ['pending']
    );

    // This is what stops a reminder being dealt with twice. Two scheduler runs
    // overlapping both select the same pending row; without the guard both write an
    // outcome and both raise a notification, and the patient is messaged twice. With
    // it the second matches nothing, because the row is no longer pending — a
    // database-level answer to a concurrency question rather than a lock held in the
    // application, which is only as reliable as the one process that remembers it.
    expect(onlyCall(calls).text).toContain('and status = any($7::notification_status[])');
    expect(onlyCall(calls).params[6]).toEqual(['pending']);
  });

  it('takes a state other than pending, which a backfill is entitled to and the scheduler is not', async () => {
    const { sql, calls } = recorder();

    await recordReminderOutcome(
      sql,
      PHARMACY,
      REMINDER,
      { status: 'not_sent', notSentReason: 'the number was disconnected' },
      ['sent', 'failed']
    );

    // Hardcoding `pending` would push the next caller into writing its own statement,
    // and a second copy of this update is a second place for the guard to be wrong.
    // 18e passes `['not_sent']` through the same statement.
    expect(onlyCall(calls).params[6]).toEqual(['sent', 'failed']);
  });

  it('copies the guard list rather than binding the caller\'s', async () => {
    const { sql, calls } = recorder();
    const allowedFrom: NotificationStatus[] = ['pending'];

    await recordReminderOutcome(sql, PHARMACY, REMINDER, { status: 'sent' }, allowedFrom);
    allowedFrom.push('not_sent');

    // Bound directly, the guard would have widened after the statement was issued —
    // and a guard that widens on its own is the failure mode it exists to prevent.
    expect(onlyCall(calls).params[6]).toEqual(['pending']);
  });

  it('answers null when the guard matched no row, which is the second scheduler run', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    // Null means the row exists and the guard refused, but only because the caller
    // established existence first inside the same transaction. For a reminder the
    // two cases are very different sentences: one is a stale row in a batch and the
    // other is a reminder already dealt with, which is the case that stops a patient
    // getting the same message twice.
    await expect(
      recordReminderOutcome(sql, PHARMACY, REMINDER, { status: 'sent' }, ['pending'])
    ).resolves.toBeNull();
  });

  it('is one statement for every outcome shape, because there is no builder', async () => {
    const { sql, calls } = recorder();

    await recordReminderOutcome(sql, PHARMACY, REMINDER, { status: 'sent' }, ['pending']);
    await recordReminderOutcome(
      sql,
      PHARMACY,
      REMINDER,
      { status: 'not_sent', notSentReason: REASON },
      ['pending']
    );
    await recordReminderOutcome(
      sql,
      PHARMACY,
      REMINDER,
      { status: 'not_sent', notSentReason: REASON, notificationId: NOTIFICATION },
      ['pending']
    );

    expect([...new Set(calls.map((call) => call.text))]).toHaveLength(1);
    expect(calls[2]?.params).toEqual([
      PHARMACY,
      REMINDER,
      'not_sent',
      true,
      REASON,
      NOTIFICATION,
      ['pending'],
    ]);
  });
});

describe('supersedeAppointmentReminders', () => {
  it('takes the prefix from the key builder rather than spelling its own', async () => {
    const { sql, calls } = recorder();

    await supersedeAppointmentReminders(sql, PHARMACY, CONSULTATION, 'keep', REASON);

    // The statement carries only the wildcard; the prefix arrives bound, from the
    // module that also builds the whole key. Spelling `'appointment:'` into the SQL
    // as well would be a second copy of one format, and if the two drifted the
    // supersede would silently stop matching — the stale reminder would stay
    // pending, stay in the partial index, and fire for a slot nobody is expecting
    // the patient at. Nothing would error.
    expect(onlyCall(calls).text).toContain("dedupe_key like ($3::text || '%')");
    expect(onlyCall(calls).text).not.toContain("'appointment:'");
    expect(onlyCall(calls).params[2]).toBe(appointmentReminderPrefix(CONSULTATION));
  });

  it('narrows on the kind and on pending, so it cannot rewrite a reminder already dealt with', async () => {
    const { sql, calls } = recorder();

    await supersedeAppointmentReminders(sql, PHARMACY, CONSULTATION, 'keep', REASON);

    // Both predicates, and 18h executes the four reminders that survive because of
    // them. `kind` because a refill key never starts with `appointment:` and
    // matching one would be a bug nobody could see; `pending` because a reminder
    // already dealt with is a record of what happened and is not this function's to
    // rewrite. The status predicate has a second consequence worth having: a pending
    // reminder has necessarily never raised a notification, since
    // recordReminderOutcome writes the status and the id in one statement, so
    // superseding cannot leave a bell entry describing a slot that no longer exists.
    const text = onlyCall(calls).text;
    expect(text).toContain("and kind = 'appointment'");
    expect(text).toContain("and status = 'pending'");
    expect(text).toContain("set status = 'not_sent'");
  });

  it('writes not_sent as a literal, so there is no parameter that could claim it was sent', async () => {
    const { sql, calls } = recorder();

    await supersedeAppointmentReminders(sql, PHARMACY, CONSULTATION, 'keep', REASON);

    // Superseding has exactly one meaning. A parameter here would be a way to write
    // `'sent'` for a message nobody sent, and the schema would permit it — the
    // constraint only requires a reason beside `not_sent` and `failed`.
    expect(onlyCall(calls).text).toContain("set status = 'not_sent'");
    expect(onlyCall(calls).params).not.toContain('not_sent');
  });

  it('keeps the key the caller says is still current', async () => {
    const { sql, calls } = recorder();
    const keep = appointmentReminderKey(CONSULTATION, '2026-04-27T09:30:00.000Z');

    await supersedeAppointmentReminders(sql, PHARMACY, CONSULTATION, keep, REASON);

    // Required rather than optional, and it is what makes the operation safe to run
    // before raising the new reminder. Without it, editing a consultation whose slot
    // did not change would supersede the current reminder and then re-raise it — a
    // fresh pending row where a sent one was, and a patient texted twice about one
    // appointment.
    expect(onlyCall(calls).text).toContain('and dedupe_key <> $2::text');
    expect(onlyCall(calls).params[1]).toBe(keep);
  });

  it('says how many it superseded, counting ids rather than hauling rows back', async () => {
    const { sql, calls, queueRows } = recorder();

    // Only `id` comes back, following `markAllRead`: counting rows does not need
    // twelve columns each, and a consultation rescheduled a dozen times would
    // otherwise haul the lot across the wire to arrive at a number. The second
    // assertion is the one that makes the first mean anything — without it,
    // returning the whole column list would still count two and pass.
    queueRows([{ id: 'a' }, { id: 'b' }]);
    await expect(
      supersedeAppointmentReminders(sql, PHARMACY, CONSULTATION, 'keep', REASON)
    ).resolves.toBe(2);
    expect(onlyCall(calls).text).toContain('returning id');
    expect(onlyCall(calls).text).not.toContain('returning id,');

    // Zero rather than an error when nothing matched, which is the ordinary case:
    // editing a consultation whose slot did not move has nothing to supersede, and
    // a caller rescheduling in one transaction cannot be expected to know in
    // advance whether the old reminder was ever raised.
    queueRows([]);
    await expect(
      supersedeAppointmentReminders(sql, PHARMACY, CONSULTATION, 'keep', REASON)
    ).resolves.toBe(0);
  });
});

describe('supersedeRefillReminder', () => {
  it('takes the key from the builder and matches it whole, with no wildcard in the statement', async () => {
    const { sql, calls } = recorder();

    await supersedeRefillReminder(sql, PHARMACY, PRESCRIPTION, REASON);

    // The mirror of the appointment version, and the difference is the point. A
    // refill is keyed to the prescription alone, so there is exactly one reminder
    // per prescription and nothing to narrow down: `=` rather than `like`, and no
    // `'%'` reaches the statement. That also removes the escaping question a
    // wildcard would raise. Spelling `'refill:'` into the SQL as well would be a
    // second copy of the format `utils/reminder-keys.ts` owns.
    expect(onlyCall(calls).text).toContain('and dedupe_key = $2::text');
    expect(onlyCall(calls).text).not.toContain('like');
    expect(onlyCall(calls).text).not.toContain("'refill:'");
    expect(onlyCall(calls).params[1]).toBe(refillReminderKey(PRESCRIPTION));
  });

  it('narrows on the kind and on pending, so it cannot rewrite a reminder already dealt with', async () => {
    const { sql, calls } = recorder();

    await supersedeRefillReminder(sql, PHARMACY, PRESCRIPTION, REASON);

    // `kind` because an appointment key never equals a refill key, so the predicate
    // is not what stops one -- it is what says so in the statement a reader and the
    // planner both look at. `pending` for the reason the appointment version gives:
    // a reminder already dealt with is a record of what happened, and 18j asserts a
    // sent refill survives a later collection untouched.
    const text = onlyCall(calls).text;
    expect(text).toContain("and kind = 'refill'");
    expect(text).toContain("and status = 'pending'");
    expect(text).toContain("set status = 'not_sent'");
  });

  it('writes not_sent as a literal, so there is no parameter that could claim it was sent', async () => {
    const { sql, calls } = recorder();

    await supersedeRefillReminder(sql, PHARMACY, PRESCRIPTION, REASON);

    expect(onlyCall(calls).text).toContain("set status = 'not_sent'");
    expect(onlyCall(calls).params).not.toContain('not_sent');
  });

  it('takes no key to keep, because nothing is raised after it', async () => {
    const { sql, calls } = recorder();

    await supersedeRefillReminder(sql, PHARMACY, PRESCRIPTION, REASON);

    // Three parameters where the appointment version has four. The appointment one
    // needs `keepDedupeKey` because it runs *before* raising the replacement and
    // must not cancel it; a collection raises nothing afterwards, so a parameter
    // here would be one a caller could get wrong for no benefit.
    expect(onlyCall(calls).params).toEqual([PHARMACY, refillReminderKey(PRESCRIPTION), REASON]);
    expect(onlyCall(calls).text).not.toContain('<>');
  });

  it('answers whether there was one to stop, because at most one row can match', async () => {
    const { sql, calls, queueRows } = recorder();

    queueRows([{ id: 'a' }]);
    await expect(supersedeRefillReminder(sql, PHARMACY, PRESCRIPTION, REASON)).resolves.toBe(true);
    expect(onlyCall(calls).text).toContain('returning id');
    expect(onlyCall(calls).text).not.toContain('returning id,');

    // False rather than an error when nothing matched, which is the ordinary case:
    // dispensing a prescription whose reminder was never raised has nothing to stop,
    // and `prescriptions.service.ts` discards the answer inside the transaction for
    // exactly that reason.
    queueRows([]);
    await expect(supersedeRefillReminder(sql, PHARMACY, PRESCRIPTION, REASON)).resolves.toBe(false);
  });
});

describe('the dedupe keys', () => {
  it('keys a refill to the prescription alone, so the same script cannot raise two reminders', async () => {
    // 18c drives this key through the insert twice and requires the second refresh
    // to raise nothing. The stability is what makes that a database answer rather
    // than an application one: the same prescription always produces the same key,
    // so the unique index is what decides.
    expect(refillReminderKey(PRESCRIPTION)).toBe(`refill:${PRESCRIPTION}`);
    expect(refillReminderKey(PRESCRIPTION)).toBe(refillReminderKey(PRESCRIPTION));
    expect(refillReminderKey('other')).not.toBe(refillReminderKey(PRESCRIPTION));
  });

  it('keys an appointment to the slot as well, so moving it raises a fresh reminder', async () => {
    const before = appointmentReminderKey(CONSULTATION, '2026-04-20T09:30:00.000Z');
    const after = appointmentReminderKey(CONSULTATION, '2026-04-27T09:30:00.000Z');

    // The timestamp is the part that makes rescheduling work. Without it the new
    // slot's key would collide with the old, `on conflict do nothing` would swallow
    // it, and the patient would keep the reminder for the time that was cancelled.
    expect(before).not.toBe(after);
    expect(before).toBe(`appointment:${CONSULTATION}:2026-04-20T09:30:00.000Z`);
  });

  it('gives a refill and an appointment for the same id keys that cannot collide', async () => {
    // Two kinds share one unique index, so the prefixes are what keep a refill
    // reminder from suppressing an appointment one that happens to name the same id.
    expect(refillReminderKey(CONSULTATION)).not.toBe(appointmentReminderKey(CONSULTATION, 'x'));
    expect(refillReminderKey(CONSULTATION).startsWith('appointment:')).toBe(false);
  });

  it('matches every slot for one consultation, and no slot for any other', async () => {
    const prefix = appointmentReminderPrefix(CONSULTATION);

    // Both directions, and the second is the one that matters: a prefix of
    // `'appointment:'` alone would satisfy the first and cancel every appointment
    // reminder in the pharmacy when one appointment moved. 18h executes this against
    // a real server with a second consultation's reminder in the table.
    expect(appointmentReminderKey(CONSULTATION, '2026-04-20T09:30:00.000Z').startsWith(prefix)).toBe(
      true
    );
    expect(appointmentReminderKey(CONSULTATION, '2026-05-04T09:30:00.000Z').startsWith(prefix)).toBe(
      true
    );
    expect(
      appointmentReminderKey(OTHER_CONSULTATION, '2026-04-20T09:30:00.000Z').startsWith(prefix)
    ).toBe(false);
    expect(refillReminderKey(PRESCRIPTION).startsWith(prefix)).toBe(false);
  });

  it('builds the prefix from the same literal it builds the key from', async () => {
    // The agreement the supersede statement depends on, asserted directly rather
    // than inferred from the two tests above. A prefix that stopped being a prefix
    // of the key is the silent failure the whole module exists to avoid.
    const key = appointmentReminderKey(CONSULTATION, '2026-04-20T09:30:00.000Z');
    expect(key.indexOf(appointmentReminderPrefix(CONSULTATION))).toBe(0);
    expect(appointmentReminderPrefix(CONSULTATION).endsWith('%')).toBe(false);
  });
});

describe('the mapped row', () => {
  it('turns the due time and both stamps into ISO strings', async () => {
    const { sql, queueRows } = recorder();
    queueRows([
      fakeRow({
        due_at: new Date('2026-04-20T09:00:00.000Z'),
        created_at: new Date('2026-04-06T09:15:00.000Z'),
        updated_at: new Date('2026-04-06T11:40:00.000Z'),
      }),
    ]);

    const [row] = await listReminders(sql, PHARMACY, { limit: 50, offset: 0 });

    // `timestamptz` arrives as a JS Date — `database/pg-types.ts` overrides the
    // parser for `date` only, deliberately, and the two are different OIDs.
    expect(row?.dueAt).toBe('2026-04-20T09:00:00.000Z');
    expect(row?.createdAt).toBe('2026-04-06T09:15:00.000Z');
    expect(row?.updatedAt).toBe('2026-04-06T11:40:00.000Z');
  });

  it('keeps an unexplained reminder apart from one with no bell entry', async () => {
    const { sql, queueRows } = recorder();
    queueRows([
      fakeRow({ not_sent_reason: null, notification_id: null }),
      fakeRow({ id: 'x', not_sent_reason: undefined, notification_id: undefined }),
    ]);

    const rows = await listReminders(sql, PHARMACY, { limit: 50, offset: 0 });

    // Two nullable columns beside each other meaning different things, and a cast
    // through `as string | null` would let `undefined` reach the response where the
    // key goes missing entirely. A frontend testing `row.notSentReason === null` to
    // decide whether to show an explanation would decide not to.
    for (const row of rows) {
      expect(row.notSentReason).toBeNull();
      expect(row.notificationId).toBeNull();
    }
  });

  it('carries every column the statement selected', async () => {
    const { sql, queueRows } = recorder();
    queueRows([
      fakeRow({
        status: 'not_sent',
        not_sent_reason: REASON,
        notification_id: NOTIFICATION,
      }),
    ]);

    const [row] = await listReminders(sql, PHARMACY, { limit: 50, offset: 0 });

    // The whole shape at once, so a column added to REMINDER_COLUMNS and forgotten
    // in the mapper is a failure here rather than a silently absent field in every
    // response this module produces. `not_sent_reason` is the one that matters:
    // without it a list can say "not sent" and nothing else.
    expect(row).toEqual({
      id: REMINDER,
      pharmacyId: PHARMACY,
      patientId: PATIENT,
      kind: 'refill',
      dueAt: '2026-04-20T09:00:00.000Z',
      message: MESSAGE,
      status: 'not_sent',
      notSentReason: REASON,
      notificationId: NOTIFICATION,
      dedupeKey: KEY,
      createdAt: '2026-04-06T09:15:00.000Z',
      updatedAt: '2026-04-06T09:15:00.000Z',
    });
  });
});

describe('the module surface', () => {
  it('offers no way to remove a row, and superseding is a status rather than a deletion', () => {
    // The two names filtered out are CommonJS interop artefacts rather than exports
    // of this module, and which of them appears depends on how the compiler emitted
    // the namespace import. Leaving them in would make this fail for a reason that
    // says nothing about the module's surface.
    const exported = Object.keys(repository)
      .filter((name) => name !== '__esModule' && name !== 'default')
      .sort();

    // An exact list, so a new export is a decision somebody makes here rather than
    // something that appears quietly. `supersedeRefillReminder` was added for
    // `prescriptions.service.ts` and this list was not updated with it, and nothing
    // noticed because the suites being run were the ones near the change: a
    // module-surface assertion is only a guard if the whole suite is run.
    expect(exported).toEqual([
      'findReminder',
      'listDueReminders',
      'listReminders',
      'recordReminderOutcome',
      'scheduleReminder',
      'supersedeAppointmentReminders',
      'supersedeRefillReminder',
    ]);
    // Nothing here restricts — `patient_id` cascades and `notification_id` sets null
    // — so a delete would work and its absence is a decision. Every case that looks
    // like a deletion is a status: a moved appointment, a patient who asked us to
    // stop, a prescription that turned out to be wrong. All three are `not_sent`
    // with a reason beside it, and 18i proves the one case where rows really should
    // go is the schema's cascade and needs nothing from this module.
    expect(exported.filter((name) => /delete|remove|destroy|purge/i.test(name))).toEqual([]);
  });
});

describe('the Postgres harness carries these same statements', () => {
  // Pinning SQL as text proves the repository builds what we intend and nothing
  // more. It cannot prove that `on conflict do nothing` really returns no row, that
  // a swallowed conflict really leaves `updated_at` alone, that a check constraint
  // really refuses an unexplained `not_sent` through this statement, that the
  // partial index really is predicated on `pending`, or that superseding really
  // leaves four other reminders untouched.
  //
  // Section 18 executes all five, on the statements it prepared rather than on
  // copies of them: `harness_repo_sql` reads the text back out of
  // pg_prepared_statements, so 18b-18i run the shapes 18a parsed. This guard is the
  // tie that makes the shapes 18a parsed the shapes the code emits.
  const harnessPath = path.resolve(
    __dirname, '..', '..', '..', 'database', 'tests', 'assertions.sql'
  );

  function harnessStatements(): Set<string> {
    const source = fs.readFileSync(harnessPath, 'utf8');
    // Scoped to this repository's prefix. Sections 6, 9, 10, 11, 13, 14, 15, 16 and
    // 17 prepare other repositories' statements; counting those as ours would let a
    // stale reminder statement hide among them.
    const bodies = [...source.matchAll(/prepare\s+reminders_repo_\w+\s+as\s+([\s\S]*?);/g)].map(
      (match) => match[1]
    );
    if (bodies.length === 0) {
      throw new Error(
        `no \`prepare reminders_repo_* as\` statements found in ${harnessPath}; section 18 ` +
          'of the harness is what executes these shapes, proves the three insert defaults, ' +
          'runs one dedupe key twice and requires an unexplained not_sent to be refused, so ' +
          'restore it rather than deleting this test'
      );
    }
    return new Set(bodies.map((body) => normalise(body ?? '')));
  }

  it('proves each of them against the harness, and fails naming any it has lost', async () => {
    const statements = (await everyStatementShape()).map((call) => call.text);
    const harness = harnessStatements();

    // Guarding the guard: if the drive stopped issuing statements the comparison
    // below would pass against nothing. Eight, because the list has two orderings
    // behind it, the queue is a statement of its own, and the two supersede
    // statements match their keys differently.
    expect([...new Set(statements)]).toHaveLength(8);

    const missing = [...new Set(statements)].filter((statement) => !harness.has(statement));
    expect(missing).toEqual([]);
  });

  it('has no prepared statement in the harness that the repository no longer emits', async () => {
    const statements = new Set((await everyStatementShape()).map((call) => call.text));
    const harness = harnessStatements();

    // The other direction. A prepared statement left behind after the repository
    // changed would keep the harness green for a shape nothing produces, while the
    // real shape went unproven — and section 18 would still be executing something,
    // which is what makes the omission easy to miss.
    const stale = [...harness].filter((statement) => !statements.has(statement));
    expect(stale).toEqual([]);
  });
});
