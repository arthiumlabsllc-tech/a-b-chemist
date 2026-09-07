import fs from 'node:fs';
import path from 'node:path';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Sql } from '../database/pool';
import {
  countPrescriptions,
  createPrescription,
  findPrescription,
  listPrescriptions,
  updatePrescription,
  type NewPrescription,
} from '../repositories/prescriptions.repository';
import * as repository from '../repositories/prescriptions.repository';
import type { PrescriptionStatus } from '../utils/schema-enums';

/**
 * The SQL the prescriptions repository emits, and the row it maps back.
 *
 * Six of the failures pinned here cannot be seen from a service test, because a
 * service test mocks this module and so never sees a statement or a parameter list
 * at all:
 *
 *   - A prescription created already `dispensed`. `status` is left out of the
 *     insert so a new row takes the column default, and a parameter for it would be
 *     a way to record that medicine left the shelf when it did not.
 *   - `coalesce` on one of the five nullable columns. It cannot tell "not supplied"
 *     from "set to null", so a prescription attached to the wrong patient could
 *     never be detached — which is a clinical error on somebody else's record, not
 *     a tidy one.
 *   - `coalesce` on `status` swapped for a flagged `case`. The opposite mistake, and
 *     the one that makes a prescription with no status representable.
 *   - The approver and the prescriber written into each other's columns. One is a
 *     `uuid` and the other is free text, so the casts catch a swap in one direction
 *     only; the flags beside them are not typed at all.
 *   - `status = any('{}')`, valid SQL matching no row, which shows an empty approval
 *     queue rather than every prescription waiting.
 *   - The count drifting from the list. They share one predicate for exactly that
 *     reason, and a badge reading 3 above two rows is believed by nobody.
 *
 * Section 17 of `database/tests/assertions.sql` executes these against a real
 * server: 17b reads the three foreign-key delete rules out of `pg_constraint`
 * rather than out of a comment, 17c proves the default really is `pending`, 17d
 * deletes the sale and requires the prescription to survive it with its patient and
 * its notes, 17e requires a guard that matched no row to change nothing *and stamp
 * nothing* twice over, 17f folds an empty status array away and widens the closing
 * day while requiring the count to agree with the list, 17g requires the queue to
 * come back oldest first and the history newest first, and 17h requires a supplied
 * null to detach a prescription from the wrong patient while an omitted note is
 * left alone. The last describe block here is the tie between those statements and
 * these.
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
const PRESCRIPTION = 'a0000000-0000-4000-8000-0000000000a1';
const SALE = 'a0000000-0000-4000-8000-0000000000b2';
const STAMP = new Date('2026-04-06T09:15:00.000Z');
const PRESCRIBER = 'Dr. Mensah';
const NOTE = 'Two weeks of the blood pressure script.';

/**
 * The filter rule as both orderings and the count emit it, after normalisation.
 * Spelled out here rather than read off one of the three, so that a change to any
 * one of them shows up as a disagreement with this string and not as two tests
 * quietly changing their minds together.
 */
const FILTER_TEXT =
  "($2::uuid is null or patient_id = $2::uuid) " +
  "and ($3::prescription_status[] is null or status = any($3::prescription_status[])) " +
  "and ($4::date is null or created_at >= $4::date) " +
  "and ($5::date is null or created_at < $5::date + interval '1 day')";

/** A prescription row as the driver returns it: `timestamptz` as Dates, enums as text. */
function fakeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PRESCRIPTION,
    pharmacy_id: PHARMACY,
    patient_id: PATIENT,
    sale_id: SALE,
    prescriber_name: PRESCRIBER,
    status: 'pending',
    approved_by: null,
    notes: NOTE,
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  };
}

const NEW_PRESCRIPTION: NewPrescription = {
  pharmacyId: PHARMACY,
  patientId: PATIENT,
  saleId: SALE,
  prescriberName: PRESCRIBER,
  approvedBy: STAFF,
  notes: NOTE,
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
 * One call of every statement the module can emit — which is six, because the list
 * has two whole orderings behind it and the count is a statement of its own.
 */
async function everyStatementShape(): Promise<Call[]> {
  const { sql, calls } = recorder();
  await createPrescription(sql, NEW_PRESCRIPTION);
  await findPrescription(sql, PHARMACY, PRESCRIPTION);
  await listPrescriptions(sql, PHARMACY, { order: 'newest', limit: 50, offset: 0 });
  await listPrescriptions(sql, PHARMACY, { order: 'oldest', limit: 50, offset: 0 });
  await countPrescriptions(sql, PHARMACY, {});
  await updatePrescription(sql, PHARMACY, PRESCRIPTION, {
    notes: 'edited',
    allowedFrom: ['pending'],
  });
  return calls;
}

describe('createPrescription', () => {
  it('sends six parameters in column order', async () => {
    const { sql, calls } = recorder();

    await createPrescription(sql, NEW_PRESCRIPTION);

    // Column order is pharmacy_id, patient_id, sale_id, prescriber_name,
    // approved_by, notes. Asserting the array rather than counting it is what makes
    // a transposition a failure: two uuids sit beside each other at indices 1 and 2
    // and would both bind happily against the wrong column.
    expect(onlyCall(calls).params).toEqual([PHARMACY, PATIENT, SALE, PRESCRIBER, STAFF, NOTE]);
  });

  it('does not name `status`, so there is no parameter a dispensed prescription could arrive through', async () => {
    const { sql, calls } = recorder();

    await createPrescription(sql, NEW_PRESCRIPTION);

    // Asserted on the column list rather than by searching for the word `status`,
    // which also appears in the returning clause. 17c proves the default this relies
    // on really is `pending`, so the omission is a guarantee and not a guess:
    // `dispensed` is the one status worth forging, because it is the one that says
    // medicine left the shelf, and the only way to reach it is through
    // updatePrescription where the transition is guarded.
    expect(onlyCall(calls).text).toContain(
      'insert into prescriptions (pharmacy_id, patient_id, sale_id, prescriber_name, ' +
        'approved_by, notes) values ($1, $2, $3, $4, $5, $6)'
    );
    expect(onlyCall(calls).text).toContain(
      'returning id, pharmacy_id, patient_id, sale_id, prescriber_name, status'
    );
  });

  it('sends null rather than undefined for the optionals a counter sale did not supply', async () => {
    const { sql, calls } = recorder();

    await createPrescription(sql, { pharmacyId: PHARMACY, prescriberName: PRESCRIBER });

    // node-pg refuses a bind parameter that is `undefined`, so this would not be a
    // quietly wrong row — it would be a 500 on a walk-in prescription taken before
    // anybody opened a record, which is the ordinary case for this table.
    expect(onlyCall(calls).params).toEqual([PHARMACY, null, null, PRESCRIBER, null, null]);
  });

  it('throws rather than returning a mapped nothing when the insert yields no row', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    // `mapPrescription` reads ten properties off its argument, so an absent row
    // would be a TypeError from inside the mapper rather than a sentence about what
    // went wrong. Throwing here is the difference between those two failures.
    await expect(createPrescription(sql, NEW_PRESCRIPTION)).rejects.toThrow(
      'insert into prescriptions returned no row'
    );
  });

  it('rejects with the database error unchanged, so a refused insert reaches the caller', async () => {
    const { sql, queueError } = recorder();
    const foreignKeyViolation = Object.assign(new Error('foreign key violation'), {
      code: '23503',
    });
    queueError(foreignKeyViolation);

    // 17b reads the delete rules out of pg_constraint and 14h executes the patient
    // restriction. This is the other half: the repository must not flatten the code
    // into a generic failure, or the service cannot tell "that patient does not
    // exist" from a lost connection.
    await expect(createPrescription(sql, NEW_PRESCRIPTION)).rejects.toBe(foreignKeyViolation);
  });
});

describe('findPrescription', () => {
  it('filters on pharmacy as well as id, and answers null when there is no such row', async () => {
    const { sql, calls, queueRows } = recorder();
    queueRows([]);

    await expect(findPrescription(sql, PHARMACY, PRESCRIPTION)).resolves.toBeNull();

    // The pharmacy predicate is what stops one tenant reading another's
    // prescriptions by guessing an id. It is single-tenant today and the column is
    // still there, because a `where id = $1` that works is the failure nobody
    // notices until it does not.
    expect(onlyCall(calls).params).toEqual([PHARMACY, PRESCRIPTION]);
    expect(onlyCall(calls).text).toContain('where pharmacy_id = $1 and id = $2');
  });
});

describe('listPrescriptions', () => {
  it('sends seven parameters, with every filter null when none was asked for', async () => {
    const { sql, calls } = recorder();

    await listPrescriptions(sql, PHARMACY, { limit: 50, offset: 0 });

    expect(onlyCall(calls).params).toEqual([PHARMACY, null, null, null, null, 50, 0]);
  });

  it('filters with the same predicate the count filters with', async () => {
    const list = recorder();
    await listPrescriptions(list.sql, PHARMACY, { limit: 50, offset: 0 });
    const count = recorder();
    await countPrescriptions(count.sql, PHARMACY, {});

    // 17f requires the two numbers to agree against a real server. This is why they
    // can: one string, used three times, so there is nothing to drift.
    expect(onlyCall(list.calls).text).toContain(FILTER_TEXT);
    expect(onlyCall(count.calls).text).toContain(FILTER_TEXT);
  });

  it('folds an empty status list into null, because `= any(\'{}\')` matches no row', async () => {
    const { sql, calls } = recorder();

    await listPrescriptions(sql, PHARMACY, { statuses: [], limit: 50, offset: 0 });

    // Valid SQL, and silently empty. An approval queue asked for "every status" by a
    // caller that filtered a list down to nothing would show nothing waiting, which
    // reads as a pharmacy with no work rather than as a broken filter.
    expect(onlyCall(calls).params[2]).toBeNull();
  });

  it('copies the status array rather than binding the caller\'s', async () => {
    const { sql, calls } = recorder();
    const statuses: PrescriptionStatus[] = ['pending'];

    await listPrescriptions(sql, PHARMACY, { statuses, limit: 50, offset: 0 });
    statuses.push('approved');

    // The push happens after the call. Bound directly, the recorded parameter would
    // be the same object and would now hold two statuses.
    expect(onlyCall(calls).params[2]).toEqual(['pending']);
  });

  it('widens the closing date to the whole day with `<` and one day, not with `<=`', async () => {
    const { sql, calls } = recorder();

    await listPrescriptions(sql, PHARMACY, {
      from: '2026-04-01',
      to: '2026-04-05',
      limit: 50,
      offset: 0,
    });

    // `created_at` is a `timestamptz`, so `$5::date` is midnight at the *start* of
    // the day. A closing bound of `<=` would drop every prescription written on the
    // last day asked for. 17f executes both halves of this, with a fixture at 23:00
    // on the closing day and one at 00:30 on the day after it.
    expect(onlyCall(calls).text).toContain(
      "and ($5::date is null or created_at < $5::date + interval '1 day')"
    );
    expect(onlyCall(calls).text).not.toContain('created_at <= $5');
    expect(onlyCall(calls).params.slice(3, 5)).toEqual(['2026-04-01', '2026-04-05']);
  });

  it('orders oldest first when the queue was asked for, and defaults to the history', async () => {
    const newest = recorder();
    await listPrescriptions(newest.sql, PHARMACY, { limit: 50, offset: 0 });
    const defaulted = recorder();
    await listPrescriptions(defaulted.sql, PHARMACY, { order: 'newest', limit: 50, offset: 0 });
    const oldest = recorder();
    await listPrescriptions(oldest.sql, PHARMACY, { order: 'oldest', limit: 50, offset: 0 });

    expect(onlyCall(newest.calls).text).toContain('order by created_at desc, id desc');
    expect(onlyCall(defaulted.calls).text).toBe(onlyCall(newest.calls).text);
    expect(onlyCall(oldest.calls).text).toContain('order by created_at asc, id asc');
    // Each ordering has to be absent from the other's statement. A queue sorted
    // newest first buries the prescription left pending three weeks on page four,
    // and it stays there because every new one pushes it further down.
    expect(onlyCall(newest.calls).text).not.toContain('asc');
    expect(onlyCall(oldest.calls).text).not.toContain('desc');
  });

  it('is one statement per ordering for every filter combination, because there is no builder', async () => {
    const { sql, calls } = recorder();

    await listPrescriptions(sql, PHARMACY, { limit: 50, offset: 0 });
    await listPrescriptions(sql, PHARMACY, { patientId: PATIENT, limit: 50, offset: 0 });
    await listPrescriptions(sql, PHARMACY, {
      patientId: PATIENT,
      statuses: ['pending', 'approved'],
      from: '2026-04-01',
      to: '2026-04-30',
      limit: 20,
      offset: 40,
    });
    await listPrescriptions(sql, PHARMACY, { order: 'oldest', limit: 20, offset: 0 });

    // A `where` spliced together per combination would need one PREPARE per shape,
    // and the shapes no test happened to exercise would be statements nobody ever
    // parsed against the real schema. Two orderings, two statements, no more.
    expect([...new Set(calls.map((call) => call.text))]).toHaveLength(2);
    expect(calls[2]?.params).toEqual([
      PHARMACY,
      PATIENT,
      ['pending', 'approved'],
      '2026-04-01',
      '2026-04-30',
      20,
      40,
    ]);
  });

  it('answers an empty result with an empty list rather than with null', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    // A patient with no prescriptions is the common case, not an error, and `null`
    // here would be a crash in whatever renders the history.
    await expect(listPrescriptions(sql, PHARMACY, { limit: 50, offset: 0 })).resolves.toEqual([]);
  });
});

describe('countPrescriptions', () => {
  it('counts with the same filters as the list, and with no page parameters', async () => {
    const { sql, calls } = recorder();

    await countPrescriptions(sql, PHARMACY, {
      patientId: PATIENT,
      statuses: ['pending'],
      from: '2026-04-01',
      to: '2026-04-30',
    });

    // Five parameters, because `order`, `limit` and `offset` are not in the type:
    // they are meaningless in an aggregate, and accepting them would be a way to ask
    // for a count of one page and get a number that does not mean anything.
    expect(onlyCall(calls).params).toEqual([PHARMACY, PATIENT, ['pending'], '2026-04-01', '2026-04-30']);
    expect(onlyCall(calls).text).not.toContain('limit');
    expect(onlyCall(calls).text).not.toContain('offset');
    expect(onlyCall(calls).text).not.toContain('order by');
  });

  it('asks for an int, because a bigint arrives as text and `"0"` is truthy', async () => {
    const { sql, calls, queueRows } = recorder();
    queueRows([{ total: 3 }]);

    const total = await countPrescriptions(sql, PHARMACY, { statuses: ['pending'] });

    // `count` is a `bigint` and node-pg hands a bigint back as a string. Left
    // uncast, the badge would read `"3"` and its visibility test would be
    // `waiting.length > 0` or a truthiness check on `"0"` — true, so an empty queue
    // would show a badge saying zero. The cast makes it a number and 17f executes it.
    expect(onlyCall(calls).text).toContain('select count(*)::int as total from prescriptions');
    expect(total).toBe(3);
    expect(typeof total).toBe('number');
  });

  it('folds an empty status list into null here too', async () => {
    const { sql, calls } = recorder();

    await countPrescriptions(sql, PHARMACY, { statuses: [] });

    // The same trap in the second statement that shares it. Folded in one place and
    // not the other, the badge would read zero above a full list.
    expect(onlyCall(calls).params[2]).toBeNull();
  });

  it('answers zero rather than throwing when the aggregate yields no row', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    // An aggregate with no GROUP BY always returns exactly one row, so this branch
    // is unreachable in practice and the test drives it deliberately. Zero is the
    // honest value: a badge that fails to render is worse than one that reads zero,
    // and throwing here would turn a count into a 500 on a dashboard.
    await expect(countPrescriptions(sql, PHARMACY, {})).resolves.toBe(0);
  });
});

describe('updatePrescription', () => {
  it('sends fourteen parameters, with the guard list last', async () => {
    const { sql, calls } = recorder();

    await updatePrescription(sql, PHARMACY, PRESCRIPTION, {
      notes: 'edited',
      allowedFrom: ['pending'],
    });

    // Indices 3 to 12 are the five supplied-flag/value pairs, in column order. A
    // false beside a null means "not supplied"; the true beside the note is what
    // writes it.
    expect(onlyCall(calls).params).toEqual([
      PHARMACY,
      PRESCRIPTION,
      null,
      false,
      null,
      false,
      null,
      false,
      null,
      false,
      null,
      true,
      'edited',
      ['pending'],
    ]);
  });

  it('treats undefined as "not supplied" and null as "clear it", for all five nullable columns', async () => {
    const clearing = recorder();
    await updatePrescription(clearing.sql, PHARMACY, PRESCRIPTION, {
      patientId: null,
      saleId: null,
      approvedBy: null,
      prescriberName: null,
      notes: null,
      allowedFrom: ['pending'],
    });
    const leaving = recorder();
    await updatePrescription(leaving.sql, PHARMACY, PRESCRIPTION, {
      allowedFrom: ['pending'],
    });

    // The whole point of the flagged `case`. `coalesce` would make the first call a
    // no-op, and a prescription attached to the wrong patient could never be
    // detached. 17h executes both halves against the server.
    expect(onlyCall(clearing.calls).params.slice(3, 13)).toEqual([
      true, null, true, null, true, null, true, null, true, null,
    ]);
    expect(onlyCall(leaving.calls).params.slice(3, 13)).toEqual([
      false, null, false, null, false, null, false, null, false, null,
    ]);
  });

  it('writes the status with coalesce and the five nullables with a flagged case', async () => {
    const { sql, calls } = recorder();

    await updatePrescription(sql, PHARMACY, PRESCRIPTION, { allowedFrom: ['pending'] });

    const text = onlyCall(calls).text;
    expect(text).toContain('set status = coalesce($3::prescription_status, status)');
    expect(text).toContain(
      'patient_id = case when $4::boolean then $5::uuid else patient_id end'
    );
    expect(text).toContain('sale_id = case when $6::boolean then $7::uuid else sale_id end');
    // Every nullable column is cast, which is what lets 17a parse the statement with
    // no literal anywhere in it to deduce a type from.
    expect(text).toContain('approved_by = case when $8::boolean then $9::uuid else approved_by end');
    expect(text).toContain(
      'prescriber_name = case when $10::boolean then $11::text else prescriber_name end'
    );
    expect(text).toContain('notes = case when $12::boolean then $13::text else notes end');
  });

  it('cannot clear the status, because a prescription with no status is not a prescription', async () => {
    const { sql, calls } = recorder();

    await updatePrescription(sql, PHARMACY, PRESCRIPTION, { allowedFrom: ['pending'] });

    // `status` is `not null` in the schema, so there is nothing for a flag to
    // protect — but `coalesce` is still the right shape here rather than the easy
    // one, because a flagged case with a supplied null would be a 23502 at runtime
    // on the one column the whole module is organised around. Asserted as an absence
    // as well as a presence, since a second assignment to the same column in one
    // `set` list is legal SQL and the later one wins.
    expect(onlyCall(calls).text).toContain('set status = coalesce($3::prescription_status, status)');
    expect(onlyCall(calls).text).not.toContain('status = case when');
    expect(onlyCall(calls).params[2]).toBeNull();
  });

  it('keeps the approver and the prescriber in their own columns', async () => {
    const { sql, calls } = recorder();

    await updatePrescription(sql, PHARMACY, PRESCRIPTION, {
      approvedBy: STAFF,
      prescriberName: PRESCRIBER,
      allowedFrom: ['pending'],
    });

    // Indices 7 to 10 are two flag/value pairs sitting beside each other, and the
    // columns they write are adjacent in the table. A uuid cast catches a swap in
    // one direction only — text into `approved_by` fails, but a pharmacist's id into
    // `prescriber_name` is a perfectly valid string, and the prescription would then
    // name a person as the prescriber who was only the one who checked it.
    expect(onlyCall(calls).params.slice(7, 11)).toEqual([true, STAFF, true, PRESCRIBER]);
    expect(onlyCall(calls).text).toContain('approved_by = case when $8::boolean then $9::uuid');
    expect(onlyCall(calls).text).toContain(
      'prescriber_name = case when $10::boolean then $11::text'
    );
  });

  it('guards on the status the row is in, as a parameter the service chooses', async () => {
    const { sql, calls } = recorder();

    await updatePrescription(sql, PHARMACY, PRESCRIPTION, {
      status: 'approved',
      allowedFrom: ['pending'],
    });

    // The guard reads the pre-update status, so passing a new status beside the
    // states it may be left from is a transition rather than a contradiction.
    expect(onlyCall(calls).text).toContain('and status = any($14::prescription_status[])');
    expect(onlyCall(calls).params[2]).toBe('approved');
    expect(onlyCall(calls).params[13]).toEqual(['pending']);
  });

  it('takes the transition rule from the caller rather than encoding it', async () => {
    const { sql, calls } = recorder();

    await updatePrescription(sql, PHARMACY, PRESCRIPTION, {
      status: 'pending',
      allowedFrom: ['dispensed'],
    });

    // That is a transition the domain forbids — nothing leaves `dispensed` — and the
    // repository emits it anyway, which is the design rather than a gap. Following
    // updateSalePaymentStatus and updateConsultation, the rule belongs to the service
    // that has to write the sentence explaining a refusal, and the repository's job
    // is the shape. What is asserted here is that the shape has nothing else baked
    // into it: exactly three predicates, and the third is the caller's array.
    expect(onlyCall(calls).params[2]).toBe('pending');
    expect(onlyCall(calls).params[13]).toEqual(['dispensed']);
    expect(onlyCall(calls).text).toContain(
      'where pharmacy_id = $1 and id = $2 and status = any($14::prescription_status[]) returning'
    );
  });

  it('accepts more than one state to transition from, which is what an approval rule needs', async () => {
    const { sql, calls } = recorder();

    await updatePrescription(sql, PHARMACY, PRESCRIPTION, {
      status: 'rejected',
      allowedFrom: ['pending', 'approved'],
    });

    // A single-state guard could not express "reject this", which is legal from both
    // of the states a prescription can be waiting in. 17e executes the refusal half:
    // the same guard against a `dispensed` row matches nothing and stamps nothing.
    expect(onlyCall(calls).params[13]).toEqual(['pending', 'approved']);
  });

  it('copies the guard list rather than binding the caller\'s', async () => {
    const { sql, calls } = recorder();
    const allowedFrom: PrescriptionStatus[] = ['pending'];

    await updatePrescription(sql, PHARMACY, PRESCRIPTION, { allowedFrom });
    allowedFrom.push('dispensed');

    // Bound directly, the guard would have widened after the statement was issued —
    // and a guard that widens on its own is the failure mode this parameter exists
    // to prevent.
    expect(onlyCall(calls).params[13]).toEqual(['pending']);
  });

  it('answers null when the guard matched no row, leaving the caller to say why', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    // Null here means the row exists and the guard refused, but only because the
    // service called findPrescription first inside the same transaction. On its own
    // the two cases are indistinguishable, and they are different sentences: one is
    // a stale link in somebody's browser and the other is a prescription that has
    // already been dispensed.
    await expect(
      updatePrescription(sql, PHARMACY, PRESCRIPTION, { allowedFrom: ['pending'] })
    ).resolves.toBeNull();
  });

  it('is one statement for every patch shape, because there is no builder', async () => {
    const { sql, calls } = recorder();

    await updatePrescription(sql, PHARMACY, PRESCRIPTION, { allowedFrom: ['pending'] });
    await updatePrescription(sql, PHARMACY, PRESCRIPTION, {
      notes: 'edited',
      allowedFrom: ['pending'],
    });
    await updatePrescription(sql, PHARMACY, PRESCRIPTION, {
      status: 'approved',
      patientId: PATIENT,
      saleId: SALE,
      approvedBy: STAFF,
      prescriberName: PRESCRIBER,
      notes: NOTE,
      allowedFrom: ['pending'],
    });

    // A `set` list assembled from whichever optionals arrived would be 64 shapes
    // here, most of which no test would ever exercise and none of which the harness
    // could parse without 64 PREPAREs. One fixed shape needs one.
    expect([...new Set(calls.map((call) => call.text))]).toHaveLength(1);
    expect(calls[2]?.params).toEqual([
      PHARMACY,
      PRESCRIPTION,
      'approved',
      true,
      PATIENT,
      true,
      SALE,
      true,
      STAFF,
      true,
      PRESCRIBER,
      true,
      NOTE,
      ['pending'],
    ]);
  });
});

describe('the mapped row', () => {
  it('answers null for every nullable column, whether the driver sent null or nothing', async () => {
    const { sql, queueRows } = recorder();
    queueRows([
      fakeRow({
        patient_id: null,
        sale_id: null,
        prescriber_name: null,
        approved_by: null,
        notes: null,
      }),
      fakeRow({
        id: 'x',
        patient_id: undefined,
        sale_id: undefined,
        prescriber_name: undefined,
        approved_by: undefined,
        notes: undefined,
      }),
    ]);

    const rows = await listPrescriptions(sql, PHARMACY, { limit: 50, offset: 0 });

    // A cast through `as string | null` would let the second row's `undefined`
    // reach the response, where the key goes missing entirely rather than reading
    // null — and a frontend that checks `row.patientId === null` to decide whether
    // this was a walk-in would decide it was not.
    for (const row of rows) {
      expect(row.patientId).toBeNull();
      expect(row.saleId).toBeNull();
      expect(row.prescriberName).toBeNull();
      expect(row.approvedBy).toBeNull();
      expect(row.notes).toBeNull();
    }
  });

  it('keeps an empty note apart from no note', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow({ notes: '' }), fakeRow({ id: 'x', notes: null })]);

    const rows = await listPrescriptions(sql, PHARMACY, { limit: 50, offset: 0 });

    // `textOrNull` is a type check and not a truthiness check, which is the property
    // the other four columns depend on even though a uuid is never `''`. `notes` is
    // where the difference is observable: `value || null` is the plausible
    // simplification, and it would make a note somebody cleared indistinguishable
    // from one nobody wrote.
    expect(rows[0]?.notes).toBe('');
    expect(rows[1]?.notes).toBeNull();
  });

  it('turns both timestamps into ISO strings', async () => {
    const { sql, queueRows } = recorder();
    queueRows([
      fakeRow({
        created_at: new Date('2026-04-06T09:15:00.000Z'),
        updated_at: new Date('2026-04-06T11:40:00.000Z'),
      }),
    ]);

    const [row] = await listPrescriptions(sql, PHARMACY, { limit: 50, offset: 0 });

    // `timestamptz` arrives as a JS Date — `database/pg-types.ts` overrides the
    // parser for `date` only, deliberately, and the two are different OIDs. Left as
    // a Date it would serialise to the same string by accident through JSON.stringify
    // and fail everywhere that did not go through it.
    expect(row?.createdAt).toBe('2026-04-06T09:15:00.000Z');
    expect(row?.updatedAt).toBe('2026-04-06T11:40:00.000Z');
  });

  it('carries every column the statement selected', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow()]);

    const [row] = await listPrescriptions(sql, PHARMACY, { limit: 50, offset: 0 });

    // The whole shape at once, so a column added to PRESCRIPTION_COLUMNS and
    // forgotten in the mapper is a failure here rather than a silently absent field
    // in every response this module produces.
    expect(row).toEqual({
      id: PRESCRIPTION,
      pharmacyId: PHARMACY,
      patientId: PATIENT,
      saleId: SALE,
      prescriberName: PRESCRIBER,
      status: 'pending',
      approvedBy: null,
      notes: NOTE,
      createdAt: '2026-04-06T09:15:00.000Z',
      updatedAt: '2026-04-06T09:15:00.000Z',
    });
  });

  it('passes the status through as the server wrote it rather than re-deriving it', async () => {
    const { sql, queueRows } = recorder();
    queueRows([
      fakeRow({ status: 'dispensed', approved_by: STAFF }),
      fakeRow({ id: 'x', status: 'rejected' }),
    ]);

    const rows = await listPrescriptions(sql, PHARMACY, { limit: 50, offset: 0 });

    // There is no rule in this module that says a dispensed prescription must have
    // an approver, and none is invented on read. The status is the column's, and the
    // transitions are the service's — a mapper that normalised either would be a
    // second place for the rule to be wrong.
    expect(rows[0]?.status).toBe('dispensed');
    expect(rows[1]?.status).toBe('rejected');
  });
});

describe('the module surface', () => {
  it('offers no way to remove a row, which is three separate reasons and not an omission', () => {
    // The two names filtered out are CommonJS interop artefacts rather than exports
    // of this module, and which of them appears depends on how the compiler emitted
    // the namespace import. Leaving them in would make this fail for a reason that
    // says nothing about the module's surface.
    const exported = Object.keys(repository)
      .filter((name) => name !== '__esModule' && name !== 'default')
      .sort();

    expect(exported).toEqual([
      'countPrescriptions',
      'createPrescription',
      'findPrescription',
      'listPrescriptions',
      'updatePrescription',
    ]);
    // The list above pins the exact surface and so would fail on any addition; this
    // one says why, and would still be the useful failure if the list were updated
    // without the reasoning being. `patient_id` and `approved_by` both restrict,
    // which 17b reads out of pg_constraint, and `sale_id` sets null — so the
    // prescription outliving its sale is the designed behaviour 17d executes, not a
    // clause nobody thought about.
    expect(exported.filter((name) => /delete|remove|destroy|purge/i.test(name))).toEqual([]);
  });
});

describe('the Postgres harness carries these same statements', () => {
  // Pinning SQL as text proves the repository builds what we intend and nothing
  // more. It cannot prove that the column default really is `pending`, that a guard
  // matching no row really leaves `updated_at` alone, that deleting a sale really
  // sets `sale_id` null instead of taking the prescription with it, that
  // `= any('{}')` really matches nothing on this server, or that the count really
  // agrees with the list it sits above.
  //
  // Section 17 executes all five, on the statements it prepared rather than on
  // copies of them: `harness_repo_sql` reads the text back out of
  // pg_prepared_statements, so 17b-17h run the shapes 17a parsed. This guard is the
  // tie that makes the shapes 17a parsed the shapes the code emits.
  const harnessPath = path.resolve(
    __dirname, '..', '..', '..', 'database', 'tests', 'assertions.sql'
  );

  function harnessStatements(): Set<string> {
    const source = fs.readFileSync(harnessPath, 'utf8');
    // Scoped to this repository's prefix. Sections 6, 9, 10, 11, 13, 14, 15 and 16
    // prepare other repositories' statements; counting those as ours would let a
    // stale prescription statement hide among them.
    const bodies = [...source.matchAll(/prepare\s+prescriptions_repo_\w+\s+as\s+([\s\S]*?);/g)].map(
      (match) => match[1]
    );
    if (bodies.length === 0) {
      throw new Error(
        `no \`prepare prescriptions_repo_* as\` statements found in ${harnessPath}; section 17 ` +
          'of the harness is what executes these shapes, proves the status default, reads the ' +
          'three foreign-key delete rules out of pg_constraint and requires a prescription to ' +
          'survive its sale, so restore it rather than deleting this test'
      );
    }
    return new Set(bodies.map((body) => normalise(body ?? '')));
  }

  it('proves each of them against the harness, and fails naming any it has lost', async () => {
    const statements = (await everyStatementShape()).map((call) => call.text);
    const harness = harnessStatements();

    // Guarding the guard: if the drive stopped issuing statements the comparison
    // below would pass against nothing. Six, because the list has two orderings
    // behind it and the count is a statement of its own.
    expect([...new Set(statements)]).toHaveLength(6);

    const missing = [...new Set(statements)].filter((statement) => !harness.has(statement));
    expect(missing).toEqual([]);
  });

  it('has no prepared statement in the harness that the repository no longer emits', async () => {
    const statements = new Set((await everyStatementShape()).map((call) => call.text));
    const harness = harnessStatements();

    // The other direction. A prepared statement left behind after the repository
    // changed would keep the harness green for a shape nothing produces, while the
    // real shape went unproven — and section 17 would still be executing something,
    // which is what makes the omission easy to miss.
    const stale = [...harness].filter((statement) => !statements.has(statement));
    expect(stale).toEqual([]);
  });
});
