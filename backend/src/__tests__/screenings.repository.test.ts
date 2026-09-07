import fs from 'node:fs';
import path from 'node:path';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Sql } from '../database/pool';
import {
  createScreening,
  latestScreeningOfType,
  listScreenings,
  type NewScreening,
} from '../repositories/screenings.repository';
import * as repository from '../repositories/screenings.repository';
import type { ScreeningMeasurement } from '../utils/screening';

/**
 * The SQL the screenings repository emits, and the row it maps back.
 *
 * Five of the failures pinned here cannot be seen from a service test, because a
 * service test mocks this module and so never sees a statement or a parameter
 * list at all:
 *
 *   - A risk level accepted from the caller. `screenings.risk_level` is
 *     `not null`, so something must always fill it, and if that something can be
 *     a request body then a client posting `riskLevel: 'low'` beside a systolic
 *     of 210 writes a row that tells a pharmacist nothing is wrong.
 *   - A measurement spread over the wrong columns, or over all of them. One
 *     table holds six kinds of row, and a mapper that wrote a glucose into
 *     `systolic_bp` would produce a row that classifies as a blood pressure.
 *   - `type = any('{}')`, which is valid SQL matching no row. A chart asked for
 *     "every type" by passing an empty list would draw nothing and read as a
 *     patient with no history.
 *   - A closing date bound of `<= $5::date`, which means "up to midnight at the
 *     *start* of the day". A history asked for March would silently drop every
 *     reading taken in March.
 *   - `value || null` in the mapper, which turns a reading of zero into a gap.
 *
 * Section 15 of `database/tests/assertions.sql` executes these against a real
 * server: 15b proves `screenings` has no `updated_at` to write, 15c refuses a
 * systolic of zero and keeps `7.80` as two decimal places, 15d requires the
 * 23:00 reading on the closing day and refuses the 00:30 one after it, and 15e
 * requires an empty type array to match nothing while a one-type array matches
 * two. The last describe block here is the tie between those statements and
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
const SCREENING = 'a0000000-0000-4000-8000-000000000090';
const MEASURED = new Date('2026-03-01T08:00:00.000Z');
const STAMP = new Date('2026-03-01T08:01:00.000Z');

/**
 * A screening row as the driver returns it.
 *
 * There is no `updated_at` in here, and that is not an oversight in the fixture:
 * the column does not exist on the table, which 15b asserts against
 * `information_schema.columns` rather than taking from a reading of `init.sql`.
 *
 * `blood_glucose_mmol numeric(5, 2)` arrives as decimal text and the `integer`
 * columns arrive as numbers, so the mapper has to accept both shapes. `measured_at`
 * and `created_at` are Dates because `timestamptz` is a different OID from `date`
 * and is deliberately left alone by `database/pg-types.ts`.
 */
function fakeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SCREENING,
    pharmacy_id: PHARMACY,
    patient_id: PATIENT,
    recorded_by: STAFF,
    type: 'blood_pressure',
    risk_level: 'high',
    systolic_bp: 148,
    diastolic_bp: 92,
    blood_glucose_mmol: null,
    weight_kg: null,
    height_cm: null,
    bmi: null,
    temperature_c: null,
    heart_rate_bpm: null,
    measured_at: MEASURED,
    notes: 'Taken seated, left arm.',
    created_at: STAMP,
    ...overrides,
  };
}

const NEW_SCREENING: NewScreening = {
  pharmacyId: PHARMACY,
  patientId: PATIENT,
  recordedBy: STAFF,
  measurement: { type: 'blood_pressure', systolic: 148, diastolic: 92 },
  measuredAt: '2026-03-01T08:00:00.000Z',
  notes: 'Taken seated, left arm.',
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

/** One call of every function in the module, so the drift guard sees all three. */
async function everyStatementShape(): Promise<Call[]> {
  const { sql, calls } = recorder();
  await createScreening(sql, NEW_SCREENING);
  await listScreenings(sql, PHARMACY, { limit: 50, offset: 0 });
  await latestScreeningOfType(sql, PHARMACY, PATIENT, 'blood_pressure');
  return calls;
}

/**
 * The eight measurement columns in insert order: systolic, diastolic, glucose,
 * weight, height, BMI, temperature, pulse. One member of the union per row, with
 * the level `classifyRisk` decides for it.
 *
 * The levels are written out as literals rather than obtained by calling
 * `classifyRisk` again, because a test that asks the classifier what the
 * classifier thinks cannot fail when the repository asks the wrong question of
 * it. The thresholds themselves are pinned by `__tests__/screening.test.ts`.
 */
const SPREADS: Array<{
  measurement: ScreeningMeasurement;
  type: string;
  level: string;
  columns: Array<number | null>;
}> = [
  {
    measurement: { type: 'blood_pressure', systolic: 148, diastolic: 92 },
    type: 'blood_pressure',
    level: 'high',
    columns: [148, 92, null, null, null, null, null, null],
  },
  {
    measurement: { type: 'blood_sugar', glucoseMmol: 7.8 },
    type: 'blood_sugar',
    level: 'moderate',
    columns: [null, null, 7.8, null, null, null, null, null],
  },
  {
    measurement: { type: 'bmi', bmi: 31.4 },
    type: 'bmi',
    level: 'high',
    columns: [null, null, null, null, null, 31.4, null, null],
  },
  {
    measurement: { type: 'weight', weightKg: 70 },
    type: 'weight',
    level: 'low',
    columns: [null, null, null, 70, null, null, null, null],
  },
  {
    measurement: { type: 'temperature', temperatureC: 38.4 },
    type: 'temperature',
    level: 'high',
    columns: [null, null, null, null, null, null, 38.4, null],
  },
  {
    measurement: { type: 'heart_rate', heartRateBpm: 72 },
    type: 'heart_rate',
    level: 'low',
    columns: [null, null, null, null, null, null, null, 72],
  },
];

describe('createScreening', () => {
  it('sends fifteen parameters in column order, with the casts in the statement', async () => {
    const { sql, calls } = recorder();

    await createScreening(sql, NEW_SCREENING);

    expect(onlyCall(calls).params).toEqual([
      PHARMACY,
      PATIENT,
      STAFF,
      'blood_pressure',
      'high',
      148,
      92,
      null,
      null,
      null,
      null,
      null,
      null,
      '2026-03-01T08:00:00.000Z',
      'Taken seated, left arm.',
    ]);
    // The casts are what make the statement deducible on its own, which is what
    // 15a checks by parsing it. `type` and `risk_level` are both enums: a bare
    // `$4` would be deduced as text and then fail at assignment rather than at
    // parse, which is the difference between a harness failure and a 500.
    expect(onlyCall(calls).text).toContain(
      '$4::screening_type, $5::risk_level, $6, $7, $8, $9, $10'
    );
    expect(onlyCall(calls).text).toContain('$14::timestamptz, $15');
  });

  it('derives the risk level rather than accepting one, for all six kinds of reading', async () => {
    for (const spread of SPREADS) {
      const { sql, calls } = recorder();

      await createScreening(sql, { ...NEW_SCREENING, measurement: spread.measurement });

      const call = onlyCall(calls);
      // One recorder per case, so a failure names the reading that broke rather
      // than reporting the first of six.
      expect(call.params[3]).toBe(spread.type);
      expect(call.params[4]).toBe(spread.level);
      expect(call.params.slice(5, 13)).toEqual(spread.columns);
    }
  });

  it('ignores a risk level a caller put in the body, which is the whole point of deriving it', async () => {
    const { sql, calls } = recorder();
    // What a client posting `riskLevel: 'low'` beside a systolic of 210 amounts
    // to. The cast is the test being honest about what it is doing: `NewScreening`
    // has no such field, so this object cannot be built without one.
    const spoofed = {
      ...NEW_SCREENING,
      measurement: { type: 'blood_pressure', systolic: 210, diastolic: 120 },
      riskLevel: 'low',
    } as unknown as NewScreening;

    await createScreening(sql, spoofed);

    expect(onlyCall(calls).params[4]).toBe('high');
    expect(onlyCall(calls).params).toHaveLength(15);
  });

  it('records the extra weight and height beside any kind of reading, not only beside a BMI', async () => {
    const { sql, calls } = recorder();

    await createScreening(sql, {
      ...NEW_SCREENING,
      measurement: { type: 'blood_pressure', systolic: 128, diastolic: 82 },
      weightKg: 70.5,
      heightCm: 168,
    });

    // A visit that weighed somebody and took their blood pressure should not have
    // the weight thrown away on the grounds that the pharmacist called it a blood
    // pressure screening.
    expect(onlyCall(calls).params[8]).toBe(70.5);
    expect(onlyCall(calls).params[9]).toBe(168);
    expect(onlyCall(calls).params[4]).toBe('moderate');
  });

  it('lets the weight measurement win over a contradictory extra', async () => {
    const { sql, calls } = recorder();

    await createScreening(sql, {
      ...NEW_SCREENING,
      measurement: { type: 'weight', weightKg: 70 },
      weightKg: 99,
    });

    // Both are a weight in kilograms and the one in the union is the one that was
    // classified. Storing the other would leave a row whose level was decided from
    // a number the row does not show.
    expect(onlyCall(calls).params[8]).toBe(70);
  });

  it('does not invent a BMI out of a weight and a height', async () => {
    const { sql, calls } = recorder();

    await createScreening(sql, {
      ...NEW_SCREENING,
      measurement: { type: 'weight', weightKg: 70 },
      heightCm: 168,
    });

    // `computeBmi` exists and is tested, and this is deliberately not where it is
    // called: a BMI is a second reading with its own classification, and writing
    // one as a side effect of a weight would put a level on the row that nobody
    // asked for and no `type` names.
    expect(onlyCall(calls).params[10]).toBeNull();
    expect(onlyCall(calls).params[4]).toBe('low');
  });

  it('sends null rather than undefined for an extra that was not supplied', async () => {
    const { sql, calls } = recorder();

    await createScreening(sql, NEW_SCREENING);

    // node-pg refuses a bind parameter that is `undefined`, so this would not be a
    // quietly wrong row — it would be a 500 on the first screening recorded without
    // a weight beside it, which is most of them.
    const params = onlyCall(calls).params;
    expect(params).not.toContain(undefined);
    expect(params[8]).toBeNull();
    expect(params[9]).toBeNull();
  });

  it('passes the notes through as null rather than as an empty string', async () => {
    const { sql, calls } = recorder();

    await createScreening(sql, { ...NEW_SCREENING, notes: null });

    expect(onlyCall(calls).params[14]).toBeNull();
  });

  it('throws rather than returning a mapped nothing when the insert yields no row', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    await expect(createScreening(sql, NEW_SCREENING)).rejects.toThrow(
      'insert into screenings returned no row'
    );
  });

  it('rejects with the database error unchanged, so a refused reading reaches the caller', async () => {
    const { sql, queueError } = recorder();
    const checkViolation = Object.assign(new Error('check violation'), { code: '23514' });
    queueError(checkViolation);

    // 15c proves the server raises 23514 for a systolic of zero. This is the other
    // half: the repository must not swallow it into a generic failure, or the
    // service cannot tell a refused reading from a lost connection.
    await expect(createScreening(sql, NEW_SCREENING)).rejects.toBe(checkViolation);
  });
});

describe('listScreenings', () => {
  it('sends seven parameters, with every filter null when none was asked for', async () => {
    const { sql, calls } = recorder();

    await listScreenings(sql, PHARMACY, { limit: 50, offset: 0 });

    expect(onlyCall(calls).params).toEqual([PHARMACY, null, null, null, null, 50, 0]);
  });

  it('folds an empty type list into null, because `= any(\'{}\')` matches no row', async () => {
    const { sql, calls } = recorder();

    await listScreenings(sql, PHARMACY, { types: [], limit: 50, offset: 0 });

    // Valid SQL, and silently empty. A chart asked for "every type" by a caller
    // that filtered a list down to nothing would draw nothing and read as a patient
    // with no history at all.
    expect(onlyCall(calls).params[2]).toBeNull();
  });

  it('copies the type array rather than binding the caller\'s', async () => {
    const { sql, calls } = recorder();
    const types: Array<'blood_pressure'> = ['blood_pressure'];

    await listScreenings(sql, PHARMACY, { types, limit: 50, offset: 0 });
    types.push('blood_pressure');

    // The push happens after the call. If the array had been bound directly the
    // recorded parameter would be the same object and would now hold two entries,
    // which is how a filter ends up describing something nobody asked for.
    expect(onlyCall(calls).params[2]).toEqual(['blood_pressure']);
  });

  it('widens the closing date to the whole day with `<` and one day, not with `<=`', async () => {
    const { sql, calls } = recorder();

    await listScreenings(sql, PHARMACY, { from: '2026-03-01', to: '2026-03-15', limit: 50, offset: 0 });

    // `measured_at` is a `timestamptz`, so `$5::date` is midnight at the *start* of
    // the day. A closing bound of `<=` would mean "up to 00:00 on the 15th" and a
    // history asked for March would drop every reading taken in March.
    expect(onlyCall(calls).text).toContain(
      "and ($5::date is null or measured_at < $5::date + interval '1 day')"
    );
    expect(onlyCall(calls).text).not.toContain('measured_at <= $5');
    expect(onlyCall(calls).params.slice(3, 5)).toEqual(['2026-03-01', '2026-03-15']);
  });

  it('is one statement for every filter combination, because there is no builder', async () => {
    const { sql, calls } = recorder();

    await listScreenings(sql, PHARMACY, { limit: 50, offset: 0 });
    await listScreenings(sql, PHARMACY, { patientId: PATIENT, limit: 50, offset: 0 });
    await listScreenings(sql, PHARMACY, {
      patientId: PATIENT,
      types: ['blood_sugar'],
      from: '2026-01-01',
      to: '2026-03-31',
      limit: 20,
      offset: 40,
    });

    // A `where` spliced together per combination would need one PREPARE per shape,
    // and the shapes no test happened to exercise would be statements nobody ever
    // parsed against the real schema.
    expect([...new Set(calls.map((call) => call.text))]).toHaveLength(1);
    expect(calls[2]?.params).toEqual([
      PHARMACY,
      PATIENT,
      ['blood_sugar'],
      '2026-01-01',
      '2026-03-31',
      20,
      40,
    ]);
  });

  it('orders newest first with the id as the tie-break', async () => {
    const { sql, calls } = recorder();

    await listScreenings(sql, PHARMACY, { limit: 50, offset: 0 });

    // `measured_at` defaults to `now()`, which is transaction-start time, so two
    // readings written in one transaction carry an identical timestamp. Without a
    // tie-break their order is whatever the planner felt like, and a list that
    // reorders itself between two loads of the same page cannot be read carefully.
    expect(onlyCall(calls).text).toContain('order by measured_at desc, id desc');
  });

  it('answers an empty result with an empty list rather than with null', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    // A history with nothing in it is a fact about the patient, not an absence of
    // an answer, and a caller writing `rows.map(...)` should not have to ask first.
    await expect(listScreenings(sql, PHARMACY, { limit: 50, offset: 0 })).resolves.toEqual([]);
  });
});

describe('latestScreeningOfType', () => {
  it('filters on pharmacy, patient and type, and takes one row', async () => {
    const { sql, calls } = recorder();

    await latestScreeningOfType(sql, PHARMACY, PATIENT, 'blood_sugar');

    expect(onlyCall(calls).params).toEqual([PHARMACY, PATIENT, 'blood_sugar']);
    expect(onlyCall(calls).text).toContain('and type = $3::screening_type');
    expect(onlyCall(calls).text).toContain('order by measured_at desc, id desc limit 1');
    // Not `max(measured_at)`: the caller needs the whole row, because "your last
    // reading was high" is a different sentence depending on whether it was last
    // week or last year.
    expect(onlyCall(calls).text).not.toContain('max(');
  });

  it('answers null rather than undefined when the patient has none of that type', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    // 15e proves this against the server for a type the patient has no reading of.
    // `null` and not `undefined` matters to a caller writing
    // `latest ?? previousReading`, where `undefined` would fall through the same way.
    await expect(
      latestScreeningOfType(sql, PHARMACY, PATIENT, 'temperature')
    ).resolves.toBeNull();
  });
});

describe('the mapped row', () => {
  it('converts a `numeric` that arrived as decimal text, and keeps an `integer` that arrived as a number', async () => {
    const { sql, queueRows } = recorder();
    queueRows([
      fakeRow({
        type: 'blood_sugar',
        blood_glucose_mmol: '7.80',
        systolic_bp: null,
        diastolic_bp: null,
        heart_rate_bpm: 72,
      }),
    ]);

    const [row] = await listScreenings(sql, PHARMACY, { limit: 50, offset: 0 });

    // `numeric(5, 2)` comes over the wire as the text `7.80` rather than as a
    // double, which is what stops two decimal places from becoming 7.8. The mapper
    // has to accept both, because a column list that changed type would otherwise
    // put a string into a `RiskAssessment` comparison and get an answer that is
    // wrong rather than an error.
    expect(row?.bloodGlucoseMmol).toBe(7.8);
    expect(row?.heartRateBpm).toBe(72);
    expect(row?.systolicBp).toBeNull();
  });

  it('keeps a reading of zero apart from a gap, rather than falsy-collapsing it', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow({ heart_rate_bpm: 0, notes: '' })]);

    const [row] = await listScreenings(sql, PHARMACY, { limit: 50, offset: 0 });

    // `value || null` is the shape that breaks here. The schema refuses a pulse of
    // zero with `check (is null or > 0)`, so this cannot arrive from a real read of
    // that column — but an empty note can, and the same one-line mapper applied to
    // a number would turn a zero into "not measured", which is the one thing a
    // clinician cannot have confused with a measurement.
    expect(row?.heartRateBpm).toBe(0);
    expect(row?.notes).toBe('');
  });

  it('turns a column that is neither string nor number into null rather than throwing', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow({ bmi: undefined, temperature_c: {} })]);

    const [row] = await listScreenings(sql, PHARMACY, { limit: 50, offset: 0 });

    // Both columns are nullable, so `undefined` cannot come from a real read of
    // them either. It can come from a column list that drifted, and the alternative
    // is a TypeError inside a mapper, which surfaces as a 500 with no patient and
    // no reading in it.
    expect(row?.bmi).toBeNull();
    expect(row?.temperatureC).toBeNull();
  });

  it('turns both timestamps into ISO strings', async () => {
    const { sql, queueRows } = recorder();
    queueRows([
      fakeRow({
        measured_at: new Date('2026-03-01T08:00:00.000Z'),
        created_at: new Date('2026-03-01T08:01:00.000Z'),
      }),
    ]);

    const [row] = await listScreenings(sql, PHARMACY, { limit: 50, offset: 0 });

    expect(row?.measuredAt).toBe('2026-03-01T08:00:00.000Z');
    expect(row?.createdAt).toBe('2026-03-01T08:01:00.000Z');
  });

  it('carries every column the statement selected, and no `updatedAt`', async () => {
    const { sql, queueRows } = recorder();
    queueRows([
      fakeRow({
        weight_kg: '70.5',
        height_cm: '168.0',
        bmi: '25.0',
      }),
    ]);

    const [row] = await listScreenings(sql, PHARMACY, { limit: 50, offset: 0 });

    expect(row).toEqual({
      id: SCREENING,
      pharmacyId: PHARMACY,
      patientId: PATIENT,
      recordedBy: STAFF,
      type: 'blood_pressure',
      riskLevel: 'high',
      systolicBp: 148,
      diastolicBp: 92,
      bloodGlucoseMmol: null,
      weightKg: 70.5,
      heightCm: 168,
      bmi: 25,
      temperatureC: null,
      heartRateBpm: null,
      measuredAt: '2026-03-01T08:00:00.000Z',
      notes: 'Taken seated, left arm.',
      createdAt: '2026-03-01T08:01:00.000Z',
    });
    // Stated as its own assertion because `toEqual` would report it as a missing
    // key in a wall of output. `screenings` is the only table in the schema with
    // neither an `updated_at` nor a `set_updated_at` trigger, and a row that grew
    // one would be a row claiming an edit nobody can see.
    expect(row).not.toHaveProperty('updatedAt');
  });

  it('keeps the level it was written with rather than re-deriving it on read', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow({ systolic_bp: 148, diastolic_bp: 92, risk_level: 'moderate' })]);

    const [row] = await listScreenings(sql, PHARMACY, { limit: 50, offset: 0 });

    // A row that could not be produced today, deliberately. 148/92 classifies as
    // high, so this is a historical row written under a previous threshold. Re-deriving
    // on read would retroactively re-triage every patient the pharmacy has ever
    // screened the first time a number in `utils/screening.ts` was corrected.
    expect(row?.riskLevel).toBe('moderate');
  });
});

describe('the module surface', () => {
  it('offers no way to change or remove a row, which is the table and not an omission', () => {
    // The two names filtered out are CommonJS interop artefacts rather than
    // exports of this module, and which of them appears depends on how the
    // compiler emitted the namespace import. Leaving them in would make this fail
    // for a reason that says nothing about the module's surface.
    const exported = Object.keys(repository)
      .filter((name) => name !== '__esModule' && name !== 'default')
      .sort();

    expect(exported).toEqual([
      'createScreening',
      'latestScreeningOfType',
      'listScreenings',
    ]);
    // The assertion above pins the exact surface and so would fail on any addition;
    // this one says why, and would still be the useful failure if the list above
    // were updated without the reasoning being.
    expect(exported.filter((name) => /update|delete|remove|edit|patch/i.test(name))).toEqual([]);
  });
});

describe('the Postgres harness carries these same statements', () => {
  // Pinning SQL as text proves the repository builds what we intend and nothing
  // more. It cannot prove that `= any('{}')` really matches no row on this server,
  // that `< $5::date + interval '1 day'` really includes a reading taken at 23:00
  // on the closing day, that `numeric(5, 2)` really hands back `7.80` rather than
  // `7.8`, or that a systolic of zero really is refused.
  //
  // Section 15 executes all four, on the statements it prepared rather than on
  // copies of them: `harness_repo_sql` reads the text back out of
  // pg_prepared_statements, so 15b-15e run the shapes 15a parsed. This guard is
  // the tie that makes the shapes 15a parsed the shapes the code emits.
  const harnessPath = path.resolve(
    __dirname, '..', '..', '..', 'database', 'tests', 'assertions.sql'
  );

  function harnessStatements(): Set<string> {
    const source = fs.readFileSync(harnessPath, 'utf8');
    // Scoped to this repository's prefix. Sections 6, 9, 10, 11, 13 and 14 prepare
    // other repositories' statements; counting those as ours would let a stale
    // screening statement hide among them.
    const bodies = [...source.matchAll(/prepare\s+screenings_repo_\w+\s+as\s+([\s\S]*?);/g)].map(
      (match) => match[1]
    );
    if (bodies.length === 0) {
      throw new Error(
        `no \`prepare screenings_repo_* as\` statements found in ${harnessPath}; section 15 ` +
          'of the harness is what executes these shapes, proves the day-widening on the closing ' +
          'bound and the empty-array filter, so restore it rather than deleting this test'
      );
    }
    return new Set(bodies.map((body) => normalise(body ?? '')));
  }

  it('proves each of them against the harness, and fails naming any it has lost', async () => {
    const statements = (await everyStatementShape()).map((call) => call.text);
    const harness = harnessStatements();

    // Guarding the guard: if the drive stopped issuing statements the comparison
    // below would pass against nothing. Three functions, three statements.
    expect([...new Set(statements)]).toHaveLength(3);

    const missing = [...new Set(statements)].filter((statement) => !harness.has(statement));
    expect(missing).toEqual([]);
  });

  it('has no prepared statement in the harness that the repository no longer emits', async () => {
    const statements = new Set((await everyStatementShape()).map((call) => call.text));
    const harness = harnessStatements();

    // The other direction. A prepared statement left behind after the repository
    // changed would keep the harness green for a shape nothing produces, while the
    // real shape went unproven — and section 15 would still be executing
    // something, which is what makes the omission easy to miss.
    const stale = [...harness].filter((statement) => !statements.has(statement));
    expect(stale).toEqual([]);
  });
});
