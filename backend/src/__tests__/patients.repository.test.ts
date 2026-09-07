import fs from 'node:fs';
import path from 'node:path';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Sql } from '../database/pool';
import {
  countPatients,
  createPatient,
  findPatient,
  listPatients,
  phoneSearchDigits,
  updatePatient,
  type NewPatient,
} from '../repositories/patients.repository';

/**
 * The SQL the patients repository emits, and the row it maps back.
 *
 * Four of the failures pinned here cannot be seen from a service test, because a
 * service test mocks this module and so never sees a statement at all:
 *
 *   - A phone search that compares against the raw column finds a customer only
 *     when the term happens to be written the same way their number was. The
 *     same handset is on the record five ways, so the results of a search depend
 *     on who was at the counter on the day each record was typed.
 *   - A null phone pattern turned harmless with `coalesce($3, '%')` — the obvious
 *     fix — makes a name search return every patient in the book, because an
 *     empty phone matches `%`.
 *   - A patch applied by reading the row, spreading the edit over it and writing
 *     the whole row back loses whatever a colleague changed in between. Nothing
 *     errors; the allergy is simply gone from a record that still says it was
 *     updated a minute ago.
 *   - `coalesce` cannot clear a nullable column, because it cannot tell "not
 *     supplied" from "set to null". A wrong phone number that cannot be removed
 *     is a wrong phone number that keeps being sent reminders.
 *
 * Section 14 of `database/tests/assertions.sql` executes all four against a real
 * server: 14d finds two writings of one number, 14e requires a name search to
 * return one patient rather than five, 14f requires a notes-only edit to move
 * nothing else and a flagged null to clear the phone, and 14g proves that LIKE's
 * escape character on this server is the backslash `likePattern` writes. The last
 * describe block here is the tie between those statements and these.
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
const STAMP = new Date('2026-03-15T09:00:00.000Z');

/**
 * A patient row as the driver returns it.
 *
 * `date_of_birth` is a **string**, not a Date. `database/pg-types.ts` overrides
 * the `date` parser so the value arrives as it came over the wire, because the
 * default parser builds a JS Date at local midnight and a Date is an instant in
 * a timezone while a `date` is neither — on any host east of UTC `1988-03-15`
 * would come back as the 14th. The timestamps are Dates, because `timestamptz`
 * is a different OID and is deliberately left alone.
 */
function fakeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PATIENT,
    pharmacy_id: PHARMACY,
    full_name: 'Amabel Osei',
    phone: '024 123-4567',
    date_of_birth: '1988-03-15',
    gender: 'female',
    allergies: ['aspirin'],
    conditions: [],
    medications: ['metformin 500mg'],
    notes: 'Takes metformin with food.',
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  };
}

const NEW_PATIENT: NewPatient = {
  pharmacyId: PHARMACY,
  fullName: 'Amabel Osei',
  phone: '024 123-4567',
  dateOfBirth: '1988-03-15',
  gender: 'female',
  allergies: ['aspirin'],
  conditions: [],
  medications: ['metformin 500mg'],
  notes: 'Takes metformin with food.',
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

/** One call of every function in the module, so the drift guard sees all five. */
async function everyStatementShape(): Promise<Call[]> {
  const { sql, calls } = recorder();
  await createPatient(sql, NEW_PATIENT);
  await findPatient(sql, PHARMACY, PATIENT);
  await listPatients(sql, PHARMACY, { search: 'osei', limit: 50, offset: 0 });
  await countPatients(sql, PHARMACY, { search: 'osei' });
  await updatePatient(sql, PHARMACY, PATIENT, { notes: 'edited' });
  return calls;
}

describe('createPatient', () => {
  it('sends nine parameters in column order, with the casts in the statement', async () => {
    const { sql, calls } = recorder();

    await createPatient(sql, NEW_PATIENT);

    expect(onlyCall(calls).params).toEqual([
      PHARMACY,
      'Amabel Osei',
      '024 123-4567',
      '1988-03-15',
      'female',
      ['aspirin'],
      [],
      ['metformin 500mg'],
      'Takes metformin with food.',
    ]);
    // The casts are what make the statement deducible on its own, which is what
    // section 14a checks by parsing it. `gender` in particular is an enum: a
    // bare `$5` would be deduced as text and then fail at assignment rather than
    // at parse, which is the difference between a harness failure and a 500.
    expect(onlyCall(calls).text).toContain('$4::date, $5::gender, $6::text[]');
  });

  it('copies the three arrays, so a caller reusing its own list cannot edit the row afterwards', async () => {
    const { sql, calls } = recorder();
    const allergies = ['aspirin'];

    await createPatient(sql, { ...NEW_PATIENT, allergies });
    allergies.push('penicillin');

    // The push happens after the call, and the recorded parameter is the value as
    // it was bound. If the repository had passed the caller's array straight
    // through, the recorded parameter would be the same object and would now hold
    // two entries — the row would say an allergy was recorded that nobody typed
    // at the time of the insert.
    expect(onlyCall(calls).params[5]).toEqual(['aspirin']);
  });

  it('passes nulls through rather than dropping them, because the columns are nullable and not defaulted', async () => {
    const { sql, calls } = recorder();

    await createPatient(sql, {
      pharmacyId: PHARMACY,
      fullName: 'Kwabena Osei',
      phone: null,
      dateOfBirth: null,
      gender: null,
      allergies: [],
      conditions: [],
      medications: [],
      notes: null,
    });

    expect(onlyCall(calls).params).toEqual([
      PHARMACY,
      'Kwabena Osei',
      null,
      null,
      null,
      [],
      [],
      [],
      null,
    ]);
  });

  it('maps the returned row', async () => {
    const { sql } = recorder();

    await expect(createPatient(sql, NEW_PATIENT)).resolves.toEqual({
      id: PATIENT,
      pharmacyId: PHARMACY,
      fullName: 'Amabel Osei',
      phone: '024 123-4567',
      dateOfBirth: '1988-03-15',
      gender: 'female',
      allergies: ['aspirin'],
      conditions: [],
      medications: ['metformin 500mg'],
      notes: 'Takes metformin with food.',
      createdAt: '2026-03-15T09:00:00.000Z',
      updatedAt: '2026-03-15T09:00:00.000Z',
    });
  });

  it('throws when the insert returns no row, rather than mapping undefined into a patient', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    // There is no unique index on this table for a conflict to swallow the row,
    // so an empty result means the statement is wrong rather than the input. A
    // mapped `undefined` would be a patient with no id, which the caller would
    // hand to a URL.
    await expect(createPatient(sql, NEW_PATIENT)).rejects.toThrow(
      'insert into patients returned no row'
    );
  });

  it('propagates a database error instead of turning it into an empty patient', async () => {
    const { sql, queueError } = recorder();
    const failure = Object.assign(new Error('value too long'), { code: '22001' });
    queueError(failure);

    await expect(createPatient(sql, NEW_PATIENT)).rejects.toBe(failure);
  });
});

describe('findPatient', () => {
  it('scopes by pharmacy as well as by id, in the predicate rather than afterwards', async () => {
    const { sql, calls } = recorder();

    await findPatient(sql, PHARMACY, PATIENT);

    // Filtering after the read would return the row to the caller first and rely
    // on the caller noticing whose it is. This schema is single-tenant precisely
    // so that a second tenant cannot arrive quietly, but the predicate is what
    // keeps that true rather than the deployment.
    const call = onlyCall(calls);
    expect(call.text).toContain('where pharmacy_id = $1 and id = $2');
    expect(call.params).toEqual([PHARMACY, PATIENT]);
  });

  it('returns null for a patient this pharmacy does not have', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    await expect(findPatient(sql, PHARMACY, PATIENT)).resolves.toBeNull();
  });
});

describe('the search', () => {
  it('sends no filter at all when nothing was searched for', async () => {
    const { sql, calls } = recorder();

    await listPatients(sql, PHARMACY, { limit: 50, offset: 0 });

    // Both patterns null, which makes the leading `$2::text is null` branch true
    // and every patient visible. An empty string and a whitespace-only one are
    // the same answer, because `ilike '%%'` matches every row and a search box
    // with a space in it is a search box with nothing in it.
    expect(onlyCall(calls).params).toEqual([PHARMACY, null, null, 50, 0]);

    for (const blank of ['', '   ', '\t']) {
      const blankRecorder = recorder();
      await listPatients(blankRecorder.sql, PHARMACY, { search: blank, limit: 50, offset: 0 });
      expect({ blank, params: onlyCall(blankRecorder.calls).params }).toEqual({
        blank,
        params: [PHARMACY, null, null, 50, 0],
      });
    }
  });

  it('reduces five writings of one number to the same nine digits', async () => {
    // The whole reason the phone branch exists. `utils/phone.ts` is explicit that
    // the column holds the number exactly as it was typed, so these five are all
    // in the table on a busy week and all belong to one handset.
    for (const written of [
      '0241234567',
      '024 123 4567',
      '024-123-4567',
      '+233241234567',
      '+233 24 123 4567',
      '233241234567',
      '00233241234567',
    ]) {
      expect({ written, digits: phoneSearchDigits(written) }).toEqual({
        written,
        digits: '241234567',
      });
    }
  });

  it('searches a fragment as typed, minus the trunk zero, because a half-remembered number is remembered locally', async () => {
    // `024 123` is not a complete number, so `normaliseGhanaPhone` declines it —
    // correctly, since its job is deciding whether a destination is sendable and
    // a search term is not a destination. What must not happen is the fragment
    // being searched with its `0` on, which finds the locally-written records and
    // silently misses `+233 24 123 4567`.
    expect(phoneSearchDigits('024 123')).toBe('24123');
    expect(phoneSearchDigits('1234')).toBe('1234');
  });

  it('leaves a number that is not Ghanaian alone, because a customer visiting from Lomé is still a customer', async () => {
    expect(phoneSearchDigits('+228 90 12 34 56')).toBe('22890123456');
    expect(phoneSearchDigits('0022890123456')).toBe('22890123456');
  });

  it('refuses to build a phone pattern out of nothing, rather than building one that matches everybody', async () => {
    for (const term of ['Amabel', '   ', '', '0', '00', '+', '-']) {
      expect({ term, digits: phoneSearchDigits(term) }).toEqual({ term, digits: null });
    }
  });

  it('sends a name pattern and no phone pattern for a term with no digits in it', async () => {
    const { sql, calls } = recorder();

    await listPatients(sql, PHARMACY, { search: 'Amabel', limit: 50, offset: 0 });

    expect(onlyCall(calls).params).toEqual([PHARMACY, '%Amabel%', null, 50, 0]);
  });

  it('escapes the LIKE wildcards in a name, so a search is literal', async () => {
    const { sql, calls } = recorder();

    await listPatients(sql, PHARMACY, { search: 'A_B', limit: 50, offset: 0 });

    // `_` is a single-character wildcard. Left alone, a patient named `A_B`
    // would match every patient whose name has an A then any character then a B,
    // and a search for "50%" would return the whole book. `likePattern` escapes
    // it and 14g executes the escape against a real server.
    expect(onlyCall(calls).params[1]).toBe('%A\\_B%');
  });

  it('travels as a parameter, so nothing a caller types reaches the statement as SQL', async () => {
    const { sql, calls } = recorder();

    await listPatients(sql, PHARMACY, {
      search: "%'; drop table patients; --",
      limit: 50,
      offset: 0,
    });

    const call = onlyCall(calls);
    expect(call.text).not.toContain('drop table');
    expect(call.text).not.toContain('patients;');
    // The name pattern holds the whole hostile term, escaped, as one bound value.
    // A bound value is never parsed as SQL, so the quote does not need doubling
    // here and doubling it would mean searching for a term the caller did not type.
    expect(call.params[1]).toBe('%\\%\'; drop table patients; --%');
    // And the phone pattern is null, because the term holds no digits — which is
    // the branch being left out rather than the branch matching everything.
    expect(call.params[2]).toBeNull();
  });

  it('is one statement for every filter combination, because there is no builder', async () => {
    const { sql, calls } = recorder();

    await listPatients(sql, PHARMACY, { limit: 50, offset: 0 });
    await listPatients(sql, PHARMACY, { search: 'osei', limit: 50, offset: 0 });
    await listPatients(sql, PHARMACY, { search: '0241234567', limit: 10, offset: 20 });

    // A `where` spliced together per combination produces a statement per
    // combination, and the harness would need a PREPARE for each to prove them.
    // One shape means one PREPARE, and it means a combination no test happened to
    // exercise is still a statement somebody parsed.
    expect([...new Set(calls.map((call) => call.text))]).toHaveLength(1);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.params).toHaveLength(5);
    }
  });

  it('searches the name and the phone with the same term, and says which predicate is which', async () => {
    const { sql, calls } = recorder();

    await listPatients(sql, PHARMACY, { search: '+233 24 123 4567', limit: 50, offset: 0 });

    expect(onlyCall(calls).text).toContain(
      `and ($2::text is null or full_name ilike $2 or regexp_replace(coalesce(phone, ''), '[^0-9+]', '', 'g') like $3)`
    );
    // The name branch gets the term as typed and the phone branch gets the nine
    // national digits. Two patterns from one term is the point: the customer who
    // reads their number out and the one who spells their name are served by the
    // same box.
    expect(onlyCall(calls).params).toEqual([
      PHARMACY,
      '%+233 24 123 4567%',
      '%241234567%',
      50,
      0,
    ]);
  });
});

describe('countPatients', () => {
  it('searches with the same two patterns the list does, so the pager total matches the page', async () => {
    const list = recorder();
    const count = recorder();
    const term = '+233 24 123 4567';

    await listPatients(list.sql, PHARMACY, { search: term, limit: 50, offset: 0 });
    await countPatients(count.sql, PHARMACY, { search: term });

    const listPatterns = onlyCall(list.calls).params.slice(1, 3);
    const countPatterns = onlyCall(count.calls).params.slice(1, 3);
    expect(countPatterns).toEqual(listPatterns);
    // Three parameters and no limit or offset: a count that paged would report
    // the size of the page rather than the size of the result.
    expect(onlyCall(count.calls).params).toHaveLength(3);
  });

  it('casts the count to int, because pg hands a bigint back as a string', async () => {
    const { sql, calls } = recorder();

    await countPatients(sql, PHARMACY, {});

    // Without `::int` the server types `count(*)` as bigint and node-postgres
    // returns it as a string. `total === 0` is then false for `'0'`, so an empty
    // patient book reads as a non-empty one to any caller comparing against zero.
    expect(onlyCall(calls).text).toContain('select count(*)::int as n from patients');
  });

  it('returns a number, so a total of zero compares equal to zero', async () => {
    const { sql, queueRows } = recorder();
    queueRows([{ n: 0 }]);

    await expect(countPatients(sql, PHARMACY, { search: 'nobody' })).resolves.toBe(0);
  });

  it('answers zero rather than undefined when the server returns no row at all', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    // A count over a table always answers, so this is belt and braces — but an
    // `undefined` badge is the one failure a UI cannot render its way out of.
    await expect(countPatients(sql, PHARMACY, {})).resolves.toBe(0);
  });
});

describe('updatePatient', () => {
  it('sends fourteen parameters, four of them flags saying whether a nullable column was supplied', async () => {
    const { sql, calls } = recorder();

    await updatePatient(sql, PHARMACY, PATIENT, { notes: 'edited' });

    expect(onlyCall(calls).params).toEqual([
      PHARMACY,
      PATIENT,
      null, // full_name
      null, // allergies
      null, // conditions
      null, // medications
      false, // phone supplied?
      null, // phone
      false, // date_of_birth supplied?
      null, // date_of_birth
      false, // gender supplied?
      null, // gender
      true, // notes supplied?
      'edited', // notes
    ]);
  });

  it('leaves an omitted column null and unflagged, which is how the statement knows not to touch it', async () => {
    const { sql, calls } = recorder();

    await updatePatient(sql, PHARMACY, PATIENT, { fullName: 'Amabel Mensah' });

    const params = onlyCall(calls).params;
    expect(params[2]).toBe('Amabel Mensah');
    // The allergies are not mentioned, so they are null rather than an empty
    // array: `coalesce($4::text[], allergies)` keeps what is on the row. Sending
    // `[]` here would wipe the allergy list on every edit that did not restate it,
    // which is the lost update this shape exists to prevent.
    expect(params[3]).toBeNull();
    expect(params[6]).toBe(false);
    expect(params[7]).toBeNull();
  });

  it('sends an empty array for a list being cleared, and coalesce keeps it because it is not null', async () => {
    const { sql, calls } = recorder();

    await updatePatient(sql, PHARMACY, PATIENT, { allergies: [] });

    // The other half of the same distinction. `[]` is not null, so
    // `coalesce($4::text[], allergies)` resolves to `[]` and the allergies are
    // genuinely emptied — a patient who has outgrown a childhood allergy has to
    // be able to have it taken off the record.
    expect(onlyCall(calls).params[3]).toEqual([]);
  });

  it('flags an explicit null so the statement clears the column instead of preserving it', async () => {
    const { sql, calls } = recorder();

    await updatePatient(sql, PHARMACY, PATIENT, { phone: null, notes: null });

    const params = onlyCall(calls).params;
    expect(params.slice(6, 8)).toEqual([true, null]);
    expect(params.slice(12, 14)).toEqual([true, null]);
    // And the columns nobody mentioned stay unflagged, so a request that clears
    // a phone number does not also clear the date of birth.
    expect(params.slice(8, 10)).toEqual([false, null]);
  });

  it('treats undefined as "not supplied" and null as "clear it", which is the whole distinction', async () => {
    const notSupplied = recorder();
    const cleared = recorder();

    await updatePatient(notSupplied.sql, PHARMACY, PATIENT, { gender: undefined });
    await updatePatient(cleared.sql, PHARMACY, PATIENT, { gender: null });

    expect(onlyCall(notSupplied.calls).params.slice(10, 12)).toEqual([false, null]);
    expect(onlyCall(cleared.calls).params.slice(10, 12)).toEqual([true, null]);
    expect(notSupplied.calls[0]?.params).not.toEqual(cleared.calls[0]?.params);
  });

  it('casts every nullable column in the statement, so the parser is not guessing from the value', async () => {
    const { sql, calls } = recorder();

    await updatePatient(sql, PHARMACY, PATIENT, {});

    const text = onlyCall(calls).text;
    for (const fragment of [
      'full_name = coalesce($3::text, full_name)',
      'allergies = coalesce($4::text[], allergies)',
      'phone = case when $7::boolean then $8::text else phone end',
      'date_of_birth = case when $9::boolean then $10::date else date_of_birth end',
      'gender = case when $11::boolean then $12::gender else gender end',
      'notes = case when $13::boolean then $14::text else notes end',
    ]) {
      expect({ fragment, present: text.includes(fragment) }).toEqual({
        fragment,
        present: true,
      });
    }
  });

  it('does not set updated_at, because the trigger does and section 5 proves it stamps without swallowing the write', async () => {
    const { sql, calls } = recorder();

    await updatePatient(sql, PHARMACY, PATIENT, { notes: 'edited' });

    // Setting it here as well would be harmless and would also be a second place
    // that has to remember. 14f asserts the column moves on an update this
    // statement performs, which is the evidence that it does not need to.
    expect(onlyCall(calls).text).not.toContain('updated_at =');
  });

  it('scopes the write by pharmacy, so a patient belonging to nobody here returns null and not a row', async () => {
    const { sql, calls, queueRows } = recorder();
    queueRows([]);

    await expect(updatePatient(sql, PHARMACY, PATIENT, { notes: 'x' })).resolves.toBeNull();
    expect(onlyCall(calls).text).toContain('where pharmacy_id = $1 and id = $2');
  });

  it('returns the row as it now stands, mapped the same way a read maps it', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow({ notes: 'edited', phone: null })]);

    await expect(updatePatient(sql, PHARMACY, PATIENT, { notes: 'edited' })).resolves.toEqual({
      id: PATIENT,
      pharmacyId: PHARMACY,
      fullName: 'Amabel Osei',
      phone: null,
      dateOfBirth: '1988-03-15',
      gender: 'female',
      allergies: ['aspirin'],
      conditions: [],
      medications: ['metformin 500mg'],
      notes: 'edited',
      createdAt: '2026-03-15T09:00:00.000Z',
      updatedAt: '2026-03-15T09:00:00.000Z',
    });
  });

  it('numbers its placeholders contiguously, so a column added later cannot reuse one', async () => {
    const { sql, calls } = recorder();

    await updatePatient(sql, PHARMACY, PATIENT, { notes: 'edited' });

    const text = onlyCall(calls).text;
    const used = [...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    expect([...new Set(used)].sort((left, right) => left - right)).toEqual(
      Array.from({ length: 14 }, (_, index) => index + 1)
    );
  });
});

describe('the mapped row', () => {
  it('passes a date through as the string it arrived as, rather than through a Date', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow({ date_of_birth: '1988-03-15' })]);

    const [row] = await listPatients(sql, PHARMACY, { limit: 50, offset: 0 });

    // The value is already correct when it arrives, thanks to the parser
    // override, and the mapper's job is to not break it. Routing it through
    // `new Date(...)` and back would move the day on any host east of UTC, which
    // is a CI runner, a container with a locale set, or a region migration.
    expect(row?.dateOfBirth).toBe('1988-03-15');
  });

  it('drops a NULL array element rather than rendering it as the word null', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow({ allergies: ['aspirin', null, 'penicillin'] })]);

    const [row] = await listPatients(sql, PHARMACY, { limit: 50, offset: 0 });

    // `'{aspirin,NULL,penicillin}'` is a legal value for a `text[]`. `String(null)`
    // is `'null'`, which would put a four-letter allergy on a patient's record
    // that nobody typed and no pharmacist would read as absent.
    expect(row?.allergies).toEqual(['aspirin', 'penicillin']);
  });

  it('treats a column that is not an array as empty, rather than throwing on the way out of the database', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow({ medications: null, conditions: undefined })]);

    const [row] = await listPatients(sql, PHARMACY, { limit: 50, offset: 0 });

    // The columns are `not null` in the schema, so this cannot happen through a
    // real read. It can happen through a column list that drifts, and the
    // alternative is a TypeError inside a mapper, which surfaces as a 500 with no
    // patient in it.
    expect(row?.medications).toEqual([]);
    expect(row?.conditions).toEqual([]);
  });

  it('keeps a null gender apart from an undisclosed one', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow({ gender: null }), fakeRow({ id: 'x', gender: 'undisclosed' })]);

    const rows = await listPatients(sql, PHARMACY, { limit: 50, offset: 0 });

    // Two facts a pharmacist reading back a record wants apart: one is a gap to
    // fill in at the next visit, the other is a boundary to respect.
    expect(rows[0]?.gender).toBeNull();
    expect(rows[1]?.gender).toBe('undisclosed');
  });

  it('turns both timestamps into ISO strings', async () => {
    const { sql, queueRows } = recorder();
    queueRows([
      fakeRow({
        created_at: new Date('2026-01-04T08:00:00.000Z'),
        updated_at: new Date('2026-03-15T09:30:00.000Z'),
      }),
    ]);

    const [row] = await listPatients(sql, PHARMACY, { limit: 50, offset: 0 });

    expect(row?.createdAt).toBe('2026-01-04T08:00:00.000Z');
    expect(row?.updatedAt).toBe('2026-03-15T09:30:00.000Z');
  });
});

describe('the Postgres harness carries these same statements', () => {
  // Pinning SQL as text proves the repository builds what we intend and nothing
  // more. It cannot prove that `regexp_replace` really reduces a formatted number
  // to the digits being searched for, that a null phone pattern really does mean
  // "no phone match" rather than "every phone matches", or that this server reads
  // a backslash as LIKE's escape character.
  //
  // Section 14 executes all three, on the statements it prepared rather than on
  // copies of them: `harness_repo_sql` reads the text back out of
  // pg_prepared_statements, so 14d-14h run the shapes 14a parsed. This guard is
  // the tie that makes the shapes 14a parsed the shapes the code emits.
  const harnessPath = path.resolve(
    __dirname, '..', '..', '..', 'database', 'tests', 'assertions.sql'
  );

  function harnessStatements(): Set<string> {
    const source = fs.readFileSync(harnessPath, 'utf8');
    // Scoped to this repository's prefix. Sections 6, 9, 10, 11 and 13 prepare
    // other repositories' statements; counting those as ours would let a stale
    // patient statement hide among them.
    const bodies = [...source.matchAll(/prepare\s+patients_repo_\w+\s+as\s+([\s\S]*?);/g)].map(
      (match) => match[1]
    );
    if (bodies.length === 0) {
      throw new Error(
        `no \`prepare patients_repo_* as\` statements found in ${harnessPath}; section 14 ` +
          'of the harness is what executes these shapes, proves the phone search across two ' +
          'writings of one number and requires 23503 from a delete, so restore it rather than ' +
          'deleting this test'
      );
    }
    return new Set(bodies.map((body) => normalise(body ?? '')));
  }

  it('proves each of them against the harness, and fails naming any it has lost', async () => {
    const statements = (await everyStatementShape()).map((call) => call.text);
    const harness = harnessStatements();

    // Guarding the guard: if the drive stopped issuing statements the comparison
    // below would pass against nothing. Five functions, five statements.
    expect([...new Set(statements)]).toHaveLength(5);

    const missing = [...new Set(statements)].filter((statement) => !harness.has(statement));
    expect(missing).toEqual([]);
  });

  it('has no prepared statement in the harness that the repository no longer emits', async () => {
    const statements = new Set((await everyStatementShape()).map((call) => call.text));
    const harness = harnessStatements();

    // The other direction. A prepared statement left behind after the repository
    // changed would keep the harness green for a shape nothing produces, while the
    // real shape went unproven — and section 14 would still be executing
    // something, which is what makes the omission easy to miss.
    const stale = [...harness].filter((statement) => !statements.has(statement));
    expect(stale).toEqual([]);
  });
});
