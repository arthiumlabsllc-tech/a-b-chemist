import fs from 'node:fs';
import path from 'node:path';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Sql } from '../database/pool';
import {
  createConsultation,
  findConsultation,
  listConsultations,
  updateConsultation,
  type NewConsultation,
} from '../repositories/consultations.repository';
import * as repository from '../repositories/consultations.repository';
import type { ConsultationStatus } from '../utils/schema-enums';

/**
 * The SQL the consultations repository emits, and the row it maps back.
 *
 * Five of the failures pinned here cannot be seen from a service test, because a
 * service test mocks this module and so never sees a statement or a parameter
 * list at all:
 *
 *   - A booking created with a status the caller chose. `status` is left out of
 *     the insert so a new consultation takes the column default, and a parameter
 *     for it would be a way to create a finished appointment that never happened.
 *   - A guard written as a literal instead of a parameter, or omitted. Either one
 *     lets a completed consultation be rescheduled to next month, and the diary
 *     then shows an appointment that has already been had.
 *   - `coalesce` on a nullable column. It cannot tell "not supplied" from "set to
 *     null", so a video consultation moved across a counter would keep handing out
 *     a link to a meeting that is no longer online — and there would be no way to
 *     remove it.
 *   - `status = any('{}')`, valid SQL matching no row, which shows an empty diary
 *     rather than every appointment.
 *   - One ordering reversed instead of two orderings, which with `limit` and
 *     `offset` returns the same page in the other sequence rather than the other
 *     end of the list.
 *
 * Section 16 of `database/tests/assertions.sql` executes these against a real
 * server: 16b proves the default really is `scheduled` rather than assuming it
 * from a reading of `init.sql`, 16c refuses a duration of -5 with 23514 while
 * accepting null, 16d requires a guard that matched no row to change nothing *and
 * stamp nothing*, 16e widens the closing day and folds an empty status array away,
 * 16f requires a notes-only edit to move nothing else while a supplied null clears
 * the link and an omitted one keeps it, and 16g requires 23503 from deleting the
 * pharmacist who conducted one. The last describe block here is the tie between
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
const STAFF = 'a0000000-0000-4000-8000-000000000010';
const CONSULTATION = 'a0000000-0000-4000-8000-000000000091';
const SCHEDULED = new Date('2026-04-02T09:30:00.000Z');
const STAMP = new Date('2026-03-20T14:00:00.000Z');
const LINK = 'https://meet.example/a-and-b/room';

/** A consultation row as the driver returns it: `timestamptz` as Dates, `integer` as a number. */
function fakeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONSULTATION,
    pharmacy_id: PHARMACY,
    patient_id: PATIENT,
    conducted_by: STAFF,
    type: 'video',
    status: 'scheduled',
    scheduled_at: SCHEDULED,
    duration_minutes: 30,
    video_url: LINK,
    notes: 'Follow-up on the blood pressure reading.',
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  };
}

const NEW_CONSULTATION: NewConsultation = {
  pharmacyId: PHARMACY,
  patientId: PATIENT,
  conductedBy: STAFF,
  type: 'video',
  scheduledAt: '2026-04-02T09:30:00.000Z',
  durationMinutes: 30,
  videoUrl: LINK,
  notes: 'Follow-up on the blood pressure reading.',
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
 * replacement would skip the recording, and half of what is asserted here is how
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
 * One call of every statement the module can emit — which is five, not four,
 * because `listConsultations` has two whole orderings behind it.
 */
async function everyStatementShape(): Promise<Call[]> {
  const { sql, calls } = recorder();
  await createConsultation(sql, NEW_CONSULTATION);
  await findConsultation(sql, PHARMACY, CONSULTATION);
  await listConsultations(sql, PHARMACY, { order: 'upcoming', limit: 50, offset: 0 });
  await listConsultations(sql, PHARMACY, { order: 'recent', limit: 50, offset: 0 });
  await updateConsultation(sql, PHARMACY, CONSULTATION, {
    notes: 'edited',
    allowedFrom: ['scheduled'],
  });
  return calls;
}

describe('createConsultation', () => {
  it('sends eight parameters in column order, with the casts in the statement', async () => {
    const { sql, calls } = recorder();

    await createConsultation(sql, NEW_CONSULTATION);

    expect(onlyCall(calls).params).toEqual([
      PHARMACY,
      PATIENT,
      STAFF,
      'video',
      '2026-04-02T09:30:00.000Z',
      30,
      LINK,
      'Follow-up on the blood pressure reading.',
    ]);
    expect(onlyCall(calls).text).toContain(
      '$4::consultation_type, $5::timestamptz, $6::integer, $7, $8'
    );
  });

  it('does not name `status`, so there is no parameter a finished booking could arrive through', async () => {
    const { sql, calls } = recorder();

    await createConsultation(sql, NEW_CONSULTATION);

    // Asserted on the column list rather than by searching for the word `status`,
    // which also appears in the returning clause. 16b proves the default this
    // relies on really is `scheduled`, so the omission is a guarantee and not a
    // guess: getting a consultation to any other state goes through
    // updateConsultation, which is where the transition rule is tested.
    expect(onlyCall(calls).text).toContain(
      'insert into consultations (pharmacy_id, patient_id, conducted_by, type, ' +
        'scheduled_at, duration_minutes, video_url, notes) values'
    );
    expect(onlyCall(calls).text).toContain('returning id, pharmacy_id, patient_id, conducted_by, type, status');
  });

  it('sends null rather than undefined for the optionals a booking did not supply', async () => {
    const { sql, calls } = recorder();

    await createConsultation(sql, {
      pharmacyId: PHARMACY,
      patientId: PATIENT,
      type: 'in_person',
      scheduledAt: '2026-04-02T09:30:00.000Z',
    });

    // node-pg refuses a bind parameter that is `undefined`, so this would not be a
    // quietly wrong row — it would be a 500 on the first appointment booked without
    // a pharmacist assigned, which is how most of them start.
    expect(onlyCall(calls).params).toEqual([
      PHARMACY,
      PATIENT,
      null,
      'in_person',
      '2026-04-02T09:30:00.000Z',
      null,
      null,
      null,
    ]);
  });

  it('throws rather than returning a mapped nothing when the insert yields no row', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    await expect(createConsultation(sql, NEW_CONSULTATION)).rejects.toThrow(
      'insert into consultations returned no row'
    );
  });

  it('rejects with the database error unchanged, so a refused booking reaches the caller', async () => {
    const { sql, queueError } = recorder();
    const checkViolation = Object.assign(new Error('check violation'), { code: '23514' });
    queueError(checkViolation);

    // 16c proves the server raises 23514 for a duration of -5. This is the other
    // half: the repository must not flatten it into a generic failure, or the
    // service cannot tell a refused length from a lost connection.
    await expect(createConsultation(sql, NEW_CONSULTATION)).rejects.toBe(checkViolation);
  });
});

describe('findConsultation', () => {
  it('filters on pharmacy as well as id, and answers null when there is no such row', async () => {
    const { sql, calls, queueRows } = recorder();
    queueRows([]);

    await expect(findConsultation(sql, PHARMACY, CONSULTATION)).resolves.toBeNull();

    // The pharmacy predicate is what stops one tenant reading another's diary by
    // guessing an id. It is single-tenant today and the column is still there,
    // because a `where id = $1` that works is the failure nobody notices until it
    // does not.
    expect(onlyCall(calls).params).toEqual([PHARMACY, CONSULTATION]);
    expect(onlyCall(calls).text).toContain('where pharmacy_id = $1 and id = $2');
  });
});

describe('listConsultations', () => {
  it('sends eight parameters, with every filter null when none was asked for', async () => {
    const { sql, calls } = recorder();

    await listConsultations(sql, PHARMACY, { limit: 50, offset: 0 });

    expect(onlyCall(calls).params).toEqual([PHARMACY, null, null, null, null, null, 50, 0]);
  });

  it('folds an empty status list into null, because `= any(\'{}\')` matches no row', async () => {
    const { sql, calls } = recorder();

    await listConsultations(sql, PHARMACY, { statuses: [], limit: 50, offset: 0 });

    // Valid SQL, and silently empty. A diary asked for "every status" by a caller
    // that filtered a list down to nothing would show no appointments at all, which
    // reads as a quiet week rather than as a broken filter.
    expect(onlyCall(calls).params[2]).toBeNull();
  });

  it('copies the status array rather than binding the caller\'s', async () => {
    const { sql, calls } = recorder();
    const statuses: ConsultationStatus[] = ['scheduled'];

    await listConsultations(sql, PHARMACY, { statuses, limit: 50, offset: 0 });
    statuses.push('completed');

    // The push happens after the call. Bound directly, the recorded parameter would
    // be the same object and would now hold two statuses.
    expect(onlyCall(calls).params[2]).toEqual(['scheduled']);
  });

  it('widens the closing date to the whole day with `<` and one day, not with `<=`', async () => {
    const { sql, calls } = recorder();

    await listConsultations(sql, PHARMACY, {
      from: '2026-04-01',
      to: '2026-04-10',
      limit: 50,
      offset: 0,
    });

    // `scheduled_at` is a `timestamptz`, so `$6::date` is midnight at the *start* of
    // the day. A closing bound of `<=` would drop every appointment on the last day
    // asked for, which for a diary is the day somebody is most likely to be looking
    // at. 16e executes both halves of this against the server.
    expect(onlyCall(calls).text).toContain(
      "and ($6::date is null or scheduled_at < $6::date + interval '1 day')"
    );
    expect(onlyCall(calls).text).not.toContain('scheduled_at <= $6');
    expect(onlyCall(calls).params.slice(4, 6)).toEqual(['2026-04-01', '2026-04-10']);
  });

  it('orders soonest first unless the history was asked for, and defaults to the diary', async () => {
    const upcoming = recorder();
    await listConsultations(upcoming.sql, PHARMACY, { limit: 50, offset: 0 });
    const defaulted = recorder();
    await listConsultations(defaulted.sql, PHARMACY, { order: 'upcoming', limit: 50, offset: 0 });
    const recent = recorder();
    await listConsultations(recent.sql, PHARMACY, { order: 'recent', limit: 50, offset: 0 });

    expect(onlyCall(upcoming.calls).text).toContain('order by scheduled_at asc, id asc');
    expect(onlyCall(defaulted.calls).text).toBe(onlyCall(upcoming.calls).text);
    expect(onlyCall(recent.calls).text).toContain('order by scheduled_at desc, id desc');
    // Each ordering has to be absent from the other's statement. If they were the
    // same string the diary and the history would be one view, and the tie-break
    // would be running in the wrong direction for one of them.
    expect(onlyCall(upcoming.calls).text).not.toContain('desc');
    expect(onlyCall(recent.calls).text).not.toContain('asc');
  });

  it('is one statement per ordering for every filter combination, because there is no builder', async () => {
    const { sql, calls } = recorder();

    await listConsultations(sql, PHARMACY, { limit: 50, offset: 0 });
    await listConsultations(sql, PHARMACY, { patientId: PATIENT, limit: 50, offset: 0 });
    await listConsultations(sql, PHARMACY, {
      patientId: PATIENT,
      statuses: ['scheduled', 'no_show'],
      conductedBy: STAFF,
      from: '2026-04-01',
      to: '2026-04-30',
      limit: 20,
      offset: 40,
    });
    await listConsultations(sql, PHARMACY, { order: 'recent', limit: 20, offset: 0 });

    // A `where` spliced together per combination would need one PREPARE per shape,
    // and the shapes no test happened to exercise would be statements nobody ever
    // parsed against the real schema. Two orderings, two statements, no more.
    expect([...new Set(calls.map((call) => call.text))]).toHaveLength(2);
    expect(calls[2]?.params).toEqual([
      PHARMACY,
      PATIENT,
      ['scheduled', 'no_show'],
      STAFF,
      '2026-04-01',
      '2026-04-30',
      20,
      40,
    ]);
  });

  it('answers an empty diary with an empty list rather than with null', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    await expect(listConsultations(sql, PHARMACY, { limit: 50, offset: 0 })).resolves.toEqual([]);
  });
});

describe('updateConsultation', () => {
  it('sends fourteen parameters, with the guard list last', async () => {
    const { sql, calls } = recorder();

    await updateConsultation(sql, PHARMACY, CONSULTATION, {
      notes: 'edited',
      allowedFrom: ['scheduled'],
    });

    // Indices 5 to 12 are the four supplied-flag/value pairs, in column order. A
    // false beside a null means "not supplied"; the true beside the note is what
    // writes it.
    expect(onlyCall(calls).params).toEqual([
      PHARMACY,
      CONSULTATION,
      null,
      null,
      null,
      false,
      null,
      false,
      null,
      false,
      null,
      true,
      'edited',
      ['scheduled'],
    ]);
  });

  it('treats undefined as "not supplied" and null as "clear it", for all four nullable columns', async () => {
    const clearing = recorder();
    await updateConsultation(clearing.sql, PHARMACY, CONSULTATION, {
      durationMinutes: null,
      conductedBy: null,
      videoUrl: null,
      notes: null,
      allowedFrom: ['scheduled'],
    });
    const leaving = recorder();
    await updateConsultation(leaving.sql, PHARMACY, CONSULTATION, {
      allowedFrom: ['scheduled'],
    });

    // The whole point of the flagged `case`. `coalesce` would make the first call a
    // no-op, and a video consultation moved across a counter would keep its link
    // with no way to remove it.
    expect(onlyCall(clearing.calls).params.slice(5, 13)).toEqual([
      true, null, true, null, true, null, true, null,
    ]);
    expect(onlyCall(leaving.calls).params.slice(5, 13)).toEqual([
      false, null, false, null, false, null, false, null,
    ]);
  });

  it('writes the not-null columns with coalesce and the nullable ones with a flagged case', async () => {
    const { sql, calls } = recorder();

    await updateConsultation(sql, PHARMACY, CONSULTATION, { allowedFrom: ['scheduled'] });

    const text = onlyCall(calls).text;
    // Three columns cannot be cleared, so there is nothing for a flag to protect.
    expect(text).toContain('set type = coalesce($3::consultation_type, type)');
    expect(text).toContain('status = coalesce($4::consultation_status, status)');
    expect(text).toContain('scheduled_at = coalesce($5::timestamptz, scheduled_at)');
    // Four can, so each gets one. Every nullable column is cast, which is what lets
    // 16a parse the statement with no literal to deduce a type from.
    expect(text).toContain(
      'duration_minutes = case when $6::boolean then $7::integer else duration_minutes end'
    );
    expect(text).toContain(
      'conducted_by = case when $8::boolean then $9::uuid else conducted_by end'
    );
    expect(text).toContain('video_url = case when $10::boolean then $11::text else video_url end');
    expect(text).toContain('notes = case when $12::boolean then $13::text else notes end');
  });

  it('guards on the status the row is in, as a parameter the service chooses', async () => {
    const { sql, calls } = recorder();

    await updateConsultation(sql, PHARMACY, CONSULTATION, {
      status: 'completed',
      allowedFrom: ['scheduled'],
    });

    // The guard reads the pre-update status, so passing a new status beside the
    // states it may be left from is a transition rather than a contradiction. It is
    // a parameter rather than a rule written into the statement, following
    // updateSalePaymentStatus, because which transitions are sound is a decision
    // for the service that has to write the sentence explaining a refusal.
    expect(onlyCall(calls).text).toContain(
      'and status = any($14::consultation_status[])'
    );
    expect(onlyCall(calls).params[3]).toBe('completed');
    expect(onlyCall(calls).params[13]).toEqual(['scheduled']);
  });

  it('accepts more than one state to transition from, which is what a rebooking rule needs', async () => {
    const { sql, calls } = recorder();

    await updateConsultation(sql, PHARMACY, CONSULTATION, {
      status: 'scheduled',
      allowedFrom: ['cancelled', 'no_show'],
    });

    // A single-state guard could not express "put this back on the diary", which is
    // the one thing a cancelled appointment needs to be able to do.
    expect(onlyCall(calls).params[13]).toEqual(['cancelled', 'no_show']);
  });

  it('copies the guard list rather than binding the caller\'s', async () => {
    const { sql, calls } = recorder();
    const allowedFrom: ConsultationStatus[] = ['scheduled'];

    await updateConsultation(sql, PHARMACY, CONSULTATION, { allowedFrom });
    allowedFrom.push('completed');

    // Bound directly, the guard would have widened after the statement was issued —
    // and a guard that widens on its own is the failure mode this parameter exists
    // to prevent.
    expect(onlyCall(calls).params[13]).toEqual(['scheduled']);
  });

  it('answers null when the guard matched no row, leaving the caller to say why', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    // Null here means the row exists and the guard refused, but only because the
    // service called findConsultation first inside the same transaction. On its own
    // the two cases are indistinguishable, which is why the pairing is documented
    // on findConsultation rather than left to the reader.
    await expect(
      updateConsultation(sql, PHARMACY, CONSULTATION, { allowedFrom: ['scheduled'] })
    ).resolves.toBeNull();
  });

  it('is one statement for every patch shape, because there is no builder', async () => {
    const { sql, calls } = recorder();

    await updateConsultation(sql, PHARMACY, CONSULTATION, { allowedFrom: ['scheduled'] });
    await updateConsultation(sql, PHARMACY, CONSULTATION, {
      notes: 'edited',
      allowedFrom: ['scheduled'],
    });
    await updateConsultation(sql, PHARMACY, CONSULTATION, {
      type: 'in_person',
      status: 'cancelled',
      scheduledAt: '2026-05-01T09:30:00.000Z',
      durationMinutes: 45,
      conductedBy: null,
      videoUrl: null,
      notes: null,
      allowedFrom: ['scheduled'],
    });

    // A `set` list assembled from whichever optionals arrived would be 128 shapes
    // here, and `sales.repository.ts` needs two PREPAREs for exactly that reason.
    // One fixed shape needs one, and every combination is a statement somebody
    // parsed against the real schema.
    expect([...new Set(calls.map((call) => call.text))]).toHaveLength(1);
    expect(calls[2]?.params).toEqual([
      PHARMACY,
      CONSULTATION,
      'in_person',
      'cancelled',
      '2026-05-01T09:30:00.000Z',
      true,
      45,
      true,
      null,
      true,
      null,
      true,
      null,
      ['scheduled'],
    ]);
  });
});

describe('the mapped row', () => {
  it('keeps a duration that arrived as a number, and nulls one that arrived as text', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow({ duration_minutes: 30 }), fakeRow({ id: 'x', duration_minutes: '30' })]);

    const rows = await listConsultations(sql, PHARMACY, { limit: 50, offset: 0 });

    // `integer` is parsed to a JS number by node-pg, so the typeof check is
    // complete here — and that is exactly what makes it wrong for a `numeric`,
    // which arrives as decimal text and needs `toNumberOrNull` instead. The two
    // mappers are different because the two column types are, and 15c pins the
    // numeric half by requiring `7.80` to keep both of its decimal places.
    expect(rows[0]?.durationMinutes).toBe(30);
    expect(rows[1]?.durationMinutes).toBeNull();
  });

  it('keeps an unassigned pharmacist apart from one nobody recorded', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow({ conducted_by: null }), fakeRow({ id: 'x', conducted_by: undefined })]);

    const rows = await listConsultations(sql, PHARMACY, { limit: 50, offset: 0 });

    // The column is nullable and stays that way: a pharmacist calling in sick leaves
    // the appointment booked and unassigned rather than cancelled, and the diary has
    // to be able to show the gap.
    expect(rows[0]?.conductedBy).toBeNull();
    expect(rows[1]?.conductedBy).toBeNull();
  });

  it('turns all three timestamps into ISO strings', async () => {
    const { sql, queueRows } = recorder();
    queueRows([
      fakeRow({
        scheduled_at: new Date('2026-04-02T09:30:00.000Z'),
        created_at: new Date('2026-03-20T14:00:00.000Z'),
        updated_at: new Date('2026-03-21T08:15:00.000Z'),
      }),
    ]);

    const [row] = await listConsultations(sql, PHARMACY, { limit: 50, offset: 0 });

    expect(row?.scheduledAt).toBe('2026-04-02T09:30:00.000Z');
    expect(row?.createdAt).toBe('2026-03-20T14:00:00.000Z');
    expect(row?.updatedAt).toBe('2026-03-21T08:15:00.000Z');
  });

  it('carries every column the statement selected', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow()]);

    const [row] = await listConsultations(sql, PHARMACY, { limit: 50, offset: 0 });

    expect(row).toEqual({
      id: CONSULTATION,
      pharmacyId: PHARMACY,
      patientId: PATIENT,
      conductedBy: STAFF,
      type: 'video',
      status: 'scheduled',
      scheduledAt: '2026-04-02T09:30:00.000Z',
      durationMinutes: 30,
      videoUrl: LINK,
      notes: 'Follow-up on the blood pressure reading.',
      createdAt: '2026-03-20T14:00:00.000Z',
      updatedAt: '2026-03-20T14:00:00.000Z',
    });
  });

  it('keeps `no_show` apart from `cancelled`, because they are different facts about a patient', async () => {
    const { sql, queueRows } = recorder();
    queueRows([
      fakeRow({ status: 'no_show' }),
      fakeRow({ id: 'x', status: 'cancelled' }),
    ]);

    const rows = await listConsultations(sql, PHARMACY, { limit: 50, offset: 0 });

    // Both end a consultation and neither involves a clinician's time being spent,
    // but one was called off and the other did not arrive. Collapsing them would
    // leave a diary that cannot tell a pharmacist whether to rebook or to follow up.
    expect(rows[0]?.status).toBe('no_show');
    expect(rows[1]?.status).toBe('cancelled');
  });
});

describe('the module surface', () => {
  it('offers no way to remove a row, which is the reminder table and not an omission', () => {
    // The two names filtered out are CommonJS interop artefacts rather than exports
    // of this module, and which of them appears depends on how the compiler emitted
    // the namespace import. Leaving them in would make this fail for a reason that
    // says nothing about the module's surface.
    const exported = Object.keys(repository)
      .filter((name) => name !== '__esModule' && name !== 'default')
      .sort();

    expect(exported).toEqual([
      'createConsultation',
      'findConsultation',
      'listConsultations',
      'updateConsultation',
    ]);
    // The list above pins the exact surface and so would fail on any addition; this
    // one says why, and would still be the useful failure if the list were updated
    // without the reasoning being. `reminders` has no consultation_id and points at
    // a consultation only through text in dedupe_key, so a deleted consultation
    // would leave a live reminder with nothing to remind about — and it would fire.
    expect(exported.filter((name) => /delete|remove|destroy|purge/i.test(name))).toEqual([]);
  });
});

describe('the Postgres harness carries these same statements', () => {
  // Pinning SQL as text proves the repository builds what we intend and nothing
  // more. It cannot prove that the column default really is `scheduled`, that a
  // guard matching no row really leaves `updated_at` alone, that `= any('{}')`
  // really matches nothing on this server, or that deleting a pharmacist who
  // conducted a consultation really is refused.
  //
  // Section 16 executes all four, on the statements it prepared rather than on
  // copies of them: `harness_repo_sql` reads the text back out of
  // pg_prepared_statements, so 16b-16g run the shapes 16a parsed. This guard is
  // the tie that makes the shapes 16a parsed the shapes the code emits.
  const harnessPath = path.resolve(
    __dirname, '..', '..', '..', 'database', 'tests', 'assertions.sql'
  );

  function harnessStatements(): Set<string> {
    const source = fs.readFileSync(harnessPath, 'utf8');
    // Scoped to this repository's prefix. Sections 6, 9, 10, 11, 13, 14 and 15
    // prepare other repositories' statements; counting those as ours would let a
    // stale consultation statement hide among them.
    const bodies = [...source.matchAll(/prepare\s+consultations_repo_\w+\s+as\s+([\s\S]*?);/g)].map(
      (match) => match[1]
    );
    if (bodies.length === 0) {
      throw new Error(
        `no \`prepare consultations_repo_* as\` statements found in ${harnessPath}; section 16 ` +
          'of the harness is what executes these shapes, proves the status default and requires ' +
          '23503 from deleting a conductor, so restore it rather than deleting this test'
      );
    }
    return new Set(bodies.map((body) => normalise(body ?? '')));
  }

  it('proves each of them against the harness, and fails naming any it has lost', async () => {
    const statements = (await everyStatementShape()).map((call) => call.text);
    const harness = harnessStatements();

    // Guarding the guard: if the drive stopped issuing statements the comparison
    // below would pass against nothing. Five statements, because the list has two
    // orderings behind it.
    expect([...new Set(statements)]).toHaveLength(5);

    const missing = [...new Set(statements)].filter((statement) => !harness.has(statement));
    expect(missing).toEqual([]);
  });

  it('has no prepared statement in the harness that the repository no longer emits', async () => {
    const statements = new Set((await everyStatementShape()).map((call) => call.text));
    const harness = harnessStatements();

    // The other direction. A prepared statement left behind after the repository
    // changed would keep the harness green for a shape nothing produces, while the
    // real shape went unproven — and section 16 would still be executing something,
    // which is what makes the omission easy to miss.
    const stale = [...harness].filter((statement) => !statements.has(statement));
    expect(stale).toEqual([]);
  });
});
