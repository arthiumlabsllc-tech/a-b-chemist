jest.mock('../database/pool', () => ({
  poolSql: { query: jest.fn() },
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: jest.fn(),
  withSavepoint: jest.fn(),
  probeDatabase: jest.fn().mockResolvedValue({ ok: true }),
  closePool: jest.fn().mockResolvedValue(undefined),
  getPool: jest.fn(),
}));

jest.mock('../repositories/users.repository', () => ({
  findUserById: jest.fn(),
  findUserByEmail: jest.fn(),
  listStaff: jest.fn(),
  createStaff: jest.fn(),
  countActiveOwners: jest.fn(),
  updateStaff: jest.fn(),
  setPassword: jest.fn(),
  markLogin: jest.fn(),
  bumpSessionVersion: jest.fn(),
}));

jest.mock('../repositories/patients.repository', () => ({
  countPatients: jest.fn(),
  createPatient: jest.fn(),
  findPatient: jest.fn(),
  listPatients: jest.fn(),
  updatePatient: jest.fn(),
}));

jest.mock('../repositories/screenings.repository', () => ({
  createScreening: jest.fn(),
  latestScreeningOfType: jest.fn(),
  listScreenings: jest.fn(),
}));

import request from 'supertest';
import type { PoolClient } from 'pg';
import { createApp } from '../app';
import { withTransaction } from '../database/pool';
import { findPatient } from '../repositories/patients.repository';
import {
  createScreening,
  latestScreeningOfType,
  listScreenings,
  type NewScreening,
  type ScreeningFilters,
  type ScreeningRow,
} from '../repositories/screenings.repository';
import { findUserById, type UserRow } from '../repositories/users.repository';
import { signAccessToken } from '../utils/jwt';
import type { UserRole } from '../utils/permissions';
import { SCREENING_TYPES } from '../utils/schema-enums';

/**
 * Counter screenings, over HTTP.
 *
 * ## The split this router is the clearest example of
 *
 * Reading a history is `patients:read`, which counter staff hold; recording a
 * reading is `screenings:write`, which they do not. Both are asserted here for
 * every role rather than for the interesting one. `patients.routes.test.ts`
 * explains the other half of the same reasoning — a suite that asserted only the
 * role it expected to be refused would not notice the day somebody tightened the
 * read, and the failure would arrive as a counter that can no longer show a
 * patient's last blood pressure while the pharmacist is on the phone.
 *
 * ## An empty cell means two different things here, and both are on purpose
 *
 * On `GET /screenings` a cleared filter is no filter: `?patientId=&type=&from=&to=`
 * asks for the whole pharmacy, which is what `routes/shared.ts`'s `OPTIONAL_QUERY`
 * makes true for every filter in a query string. On `GET /screenings/latest` the
 * same `?patientId=` is a 400, because there the patient is not a filter but the
 * subject of the question. In a `POST` body an empty `measuredAt` is a 400 too,
 * because a body carries real types and a setting that skips `''` there would also
 * skip `0` and `false` — which this service hands to `.trim()` and to
 * `toNumberOrNull`. All three are pinned below, because the distinction is exactly
 * the kind that gets "made consistent" by somebody who has only seen one of them.
 *
 * ## What is being proven about the wire, and not only about the service
 *
 * A refusal thrown by `services/screenings.service.ts` — a forward-dated reading,
 * one half of a blood pressure — has to reach the browser in the same envelope a
 * validator-thrown one does, with a `field` the form can point at. Proving that in
 * the service's own suite would prove nothing about the wire, and a second shape of
 * 400 is a second kind of red that nobody wrote a renderer for.
 */

const app = createApp();

const createMock = createScreening as jest.Mock;
const listMock = listScreenings as jest.Mock;
const latestMock = latestScreeningOfType as jest.Mock;
const findPatientMock = findPatient as jest.Mock;
const findUserByIdMock = findUserById as jest.Mock;
const withTransactionMock = withTransaction as jest.Mock;

/**
 * One client for the whole suite, handed to whatever work a transaction is given.
 *
 * Without this, `withTransaction` resolves `undefined` and `recordScreening`'s
 * patient lookup is called with nothing — which reads as a missing patient and
 * answers 404 from a route that was never reached. A 404 from a missing test
 * double is indistinguishable from a 404 from a broken route, which is why this is
 * written down rather than left to be rediscovered the next time the suite is red.
 */
const CLIENT = { query: jest.fn() } as unknown as PoolClient;

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'a0000000-0000-4000-8000-000000000002';
const PHARMACIST_ID = 'a0000000-0000-4000-8000-000000000003';
const CASHIER_ID = 'a0000000-0000-4000-8000-000000000004';
const PATIENT = 'a0000000-0000-4000-8000-000000000040';
/** A user id nobody at this pharmacy holds, for the body that claims one. */
const IMPOSTOR = 'a0000000-0000-4000-8000-000000000050';
const STORED_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpMbS0nVBM7iFtXJGvYxQmC5nqJZS';

let users: Record<string, UserRow>;

function user(id: string, role: UserRole): UserRow {
  return {
    id,
    pharmacyId: PHARMACY,
    fullName: role,
    email: `${id}@aandb.example`,
    phone: null,
    role,
    passwordHash: STORED_HASH,
    isActive: true,
    sessionVersion: 2,
    lastLoginAt: null,
  };
}

function tokenFor(id: string, role: UserRole): string {
  return signAccessToken({ userId: id, pharmacyId: PHARMACY, role, sessionVersion: 2 });
}

const ownerToken = (): string => tokenFor(OWNER_ID, 'pharmacy_owner');
const pharmacistToken = (): string => tokenFor(PHARMACIST_ID, 'pharmacist');
const cashierToken = (): string => tokenFor(CASHIER_ID, 'staff');

/**
 * All three, because this router refuses one of them on one of its routes and
 * answers all three on the other two — which is only visible if all three are run.
 */
const EVERY_ROLE: [UserRole, () => string][] = [
  ['pharmacy_owner', ownerToken],
  ['pharmacist', pharmacistToken],
  ['staff', cashierToken],
];

/** A complete row. Every column, so a dropped one is a failure and not a `null`. */
function screeningRow(overrides: Partial<ScreeningRow> = {}): ScreeningRow {
  return {
    id: 'a0000000-0000-4000-8000-000000000060',
    pharmacyId: PHARMACY,
    patientId: PATIENT,
    recordedBy: OWNER_ID,
    type: 'blood_pressure',
    riskLevel: 'high',
    systolicBp: 148,
    diastolicBp: 92,
    bloodGlucoseMmol: null,
    weightKg: null,
    heightCm: null,
    bmi: null,
    temperatureC: null,
    heartRateBpm: null,
    measuredAt: '2026-09-01T09:00:00.000Z',
    notes: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

/**
 * The row the repository hands back, whatever was written.
 *
 * Deliberately not built *from* the write. Doing that would mean re-implementing
 * `measurementColumns`'s switch inside a test, and a second copy of the rule that
 * turns a measurement into eight columns is a copy that can agree with the test and
 * disagree with the repository. So the write and the response are asserted
 * separately: what reached the table is read off `createScreening`'s argument, and
 * what reached the browser is read off this row plus the reason derived from it.
 */
const STORED = screeningRow();

/**
 * A patient, in the only shape this router's path needs.
 *
 * `recordScreening` reads one thing from the row `findPatient` returns — whether it
 * is null — and the whole record is `patients.routes.test.ts`'s business. Stubbing
 * it keeps two suites from having to agree about a shape neither of them tests.
 */
const FOUND_PATIENT = { id: PATIENT, pharmacyId: PHARMACY };

/** The smallest recording that is a whole recording. */
const BP_BODY = {
  patientId: PATIENT,
  type: 'blood_pressure',
  values: { systolicBp: 148, diastolicBp: 92 },
};

function call(
  method: 'get' | 'post',
  path: string,
  token: string | undefined,
  body?: object
): request.Test {
  const agent = request(app) as unknown as Record<string, (url: string) => request.Test>;
  const verb = agent[method];
  if (verb === undefined) throw new Error(`no supertest verb for ${method}`);
  const test = verb.call(agent, path);
  if (token !== undefined) test.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) test.send(body);
  return test;
}

interface ErrorBody {
  success: false;
  /**
   * `unknown` rather than the field-error array, because two shapes arrive here and
   * both are correct: a list of `{ field, message }` from validation and from the
   * service's own refusals, and `{ missing: [...] }` from `authorize`. Typing it as
   * one would make the other assertion a cast, and a cast in a test is an assertion
   * nobody checks.
   */
  error: { message: string; code?: string; details?: unknown };
}

function errorOf(body: unknown): ErrorBody {
  return body as ErrorBody;
}

/** The `NewScreening` the router asked to be inserted. */
function written(): NewScreening {
  const call = createMock.mock.calls[0];
  if (call === undefined) {
    // Named rather than left to surface as a property read on undefined, which
    // reads like a broken route instead of a test that expected a write.
    throw new Error('createScreening was never called');
  }
  return (call as unknown[])[1] as NewScreening;
}

/** The filters the history route handed to the repository. */
function filtersOf(): ScreeningFilters {
  const call = listMock.mock.calls[0];
  if (call === undefined) throw new Error('listScreenings was never called');
  return (call as unknown[])[2] as ScreeningFilters;
}

beforeEach(() => {
  jest.clearAllMocks();
  users = {
    [OWNER_ID]: user(OWNER_ID, 'pharmacy_owner'),
    [PHARMACIST_ID]: user(PHARMACIST_ID, 'pharmacist'),
    [CASHIER_ID]: user(CASHIER_ID, 'staff'),
  };
  findUserByIdMock.mockImplementation(async (id: string) => users[id] ?? null);
  withTransactionMock.mockImplementation(
    async (work: (client: PoolClient) => Promise<unknown>) => work(CLIENT)
  );
  findPatientMock.mockResolvedValue(FOUND_PATIENT);
  createMock.mockResolvedValue(STORED);
  listMock.mockResolvedValue([STORED]);
  latestMock.mockResolvedValue(STORED);
});

describe('who may use this router', () => {
  it('answers every role on the two reads, and refuses counter staff on the write', async () => {
    for (const [role, token] of EVERY_ROLE) {
      const history = await call('get', '/screenings', token());
      const latest = await call(
        'get',
        `/screenings/latest?patientId=${PATIENT}&type=blood_pressure`,
        token()
      );
      const record = await call('post', '/screenings', token(), BP_BODY);

      // Pinned as one object per role, so a failure names the role and the route
      // together rather than leaving three assertions to be counted by hand.
      expect({
        role,
        history: history.status,
        latest: latest.status,
        record: record.status,
      }).toEqual({
        role,
        history: 200,
        latest: 200,
        // 201 because the reading did not exist before the request.
        record: role === 'staff' ? 403 : 201,
      });
    }
  });

  it('names the permission it refused, and does no work behind the refusal', async () => {
    const response = await call('post', '/screenings', cashierToken(), BP_BODY);
    const body = errorOf(response.body);

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).toBe('Your role does not permit this action');
    // The permission rather than the role, so the counter's message can say what is
    // missing instead of who the caller has to be.
    expect(body.error.details).toEqual({ missing: ['screenings:write'] });

    expect(createMock).not.toHaveBeenCalled();
    // Nor the patient lookup, which is the half that matters: `authorize` runs
    // before the handler, so a refused request reads no clinical record at all.
    expect(findPatientMock).not.toHaveBeenCalled();
  });

  it('answers 401 with no token, and does no work at all', async () => {
    for (const [method, path, body] of [
      ['get', '/screenings', undefined],
      ['get', `/screenings/latest?patientId=${PATIENT}&type=blood_pressure`, undefined],
      ['post', '/screenings', BP_BODY],
    ] as ['get' | 'post', string, object | undefined][]) {
      const response = await call(method, path, undefined, body);
      const error = errorOf(response.body);
      expect({ method, path, status: response.status, code: error.error.code }).toEqual({
        method,
        path,
        status: 401,
        code: 'not_authenticated',
      });
    }

    expect(createMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(latestMock).not.toHaveBeenCalled();
    expect(findPatientMock).not.toHaveBeenCalled();
  });
});

describe('GET /screenings', () => {
  it('defaults to the first fifty readings with no filter at all', async () => {
    const response = await call('get', '/screenings', ownerToken());

    expect(response.status).toBe(200);
    expect(filtersOf()).toEqual({
      patientId: null,
      types: [],
      from: null,
      to: null,
      limit: 50,
      offset: 0,
    });
    expect(response.body.data).toEqual({
      screenings: expect.any(Array),
      limit: 50,
      offset: 0,
      // The list of types travels with the page, so the filter control is built
      // from what the backend will accept rather than from a second copy of the
      // enum in the browser that can drift from it.
      types: SCREENING_TYPES,
    });
  });

  it('treats a cleared filter cell as no filter, on all four of them at once', async () => {
    const response = await call(
      'get',
      '/screenings?patientId=&type=&from=&to=',
      pharmacistToken()
    );

    // The assertion that makes `routes/shared.ts`'s `OPTIONAL_QUERY` load-bearing.
    // `optional()` skips only `undefined` and `optional({ values: 'null' })` skips
    // only `undefined` and `null`, so under either of these this request was four
    // 400s: a browser sends an empty cell for every filter field the pharmacist
    // cleared, and the history answered that by refusing to load.
    expect(response.status).toBe(200);
    expect(filtersOf()).toEqual({
      patientId: null,
      types: [],
      from: null,
      to: null,
      limit: 50,
      offset: 0,
    });
  });

  it('still refuses a value that is not an id, so the widening opened no uuid cast', async () => {
    for (const value of ['0', 'false', 'not-a-uuid']) {
      const response = await call('get', `/screenings?patientId=${value}`, ownerToken());
      const body = errorOf(response.body);
      // `'0'` and `'false'` are truthy strings, so `{ values: 'falsy' }` does not
      // skip them and `.isUUID()` still runs. Had they been skipped they would have
      // reached `patient_id = $2::uuid` and answered 500 on every request — a
      // database error for what is a form typo.
      expect({ value, status: response.status, details: body.error.details }).toEqual({
        value,
        status: 400,
        details: [{ field: 'patientId', message: 'That is not a valid patient id' }],
      });
    }
    expect(listMock).not.toHaveBeenCalled();
  });

  it('narrows the history to one patient', async () => {
    await call('get', `/screenings?patientId=${PATIENT}`, cashierToken());
    expect(filtersOf().patientId).toBe(PATIENT);
  });

  it('accepts a repeated type filter, because a chart wants two series', async () => {
    await call('get', '/screenings?type=bmi&type=weight', ownerToken());
    expect(filtersOf().types).toEqual(['bmi', 'weight']);
  });

  it('refuses a type that is not one, naming the list it has to come from', async () => {
    const response = await call('get', '/screenings?type=height', ownerToken());
    const body = errorOf(response.body);
    expect(response.status).toBe(400);
    expect(body.error.message).toBe(
      'Some details need correcting before this can be saved'
    );
    expect(body.error.details).toEqual([
      { field: 'type', message: `Type must be one of ${SCREENING_TYPES.join(', ')}` },
    ]);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('passes a date range through untouched, and leaves the widening to SQL', async () => {
    await call('get', '/screenings?from=2026-03-01&to=2026-03-31', ownerToken());
    // Both arrive as the text the form sent. The closing bound is widened to the
    // whole day by the repository's `$5::date + interval '1 day'`, not here: a
    // route that sent `2026-04-01` would be making the same decision twice, in two
    // places that can drift.
    expect({ from: filtersOf().from, to: filtersOf().to }).toEqual({
      from: '2026-03-01',
      to: '2026-03-31',
    });
  });

  it('refuses a date in the format the picker was not set to', async () => {
    for (const [name, value] of [
      ['from', '01/03/2026'],
      ['to', '2026-13-45'],
    ] as [string, string][]) {
      const response = await call('get', `/screenings?${name}=${value}`, ownerToken());
      expect({ name, status: response.status }).toEqual({ name, status: 400 });
      expect(errorOf(response.body).error.details).toEqual([
        {
          field: name,
          message:
            name === 'from'
              ? 'Enter the start date as YYYY-MM-DD'
              : 'Enter the end date as YYYY-MM-DD',
        },
      ]);
    }
  });

  it('pages, and hands the page to the repository rather than slicing in memory', async () => {
    const response = await call('get', '/screenings?limit=20&offset=40', ownerToken());
    expect({ limit: filtersOf().limit, offset: filtersOf().offset }).toEqual({
      limit: 20,
      offset: 40,
    });
    expect(response.body.data.limit).toBe(20);
    expect(response.body.data.offset).toBe(40);
  });

  it('keeps the level that was decided and carries the rebuilt sentence beside it', async () => {
    listMock.mockResolvedValue([
      screeningRow({ riskLevel: 'low', systolicBp: 210, diastolicBp: 120 }),
    ]);

    const response = await call('get', '/screenings', ownerToken());
    const [first] = response.body.data.screenings;

    // The asymmetry `screenings.repository.ts` documents, seen from the browser:
    // the level is the decision made at the time and does not move when a threshold
    // is corrected, while the sentence is help text and is rebuilt from the numbers
    // on every read. A history that re-triaged a year of patients because somebody
    // edited a constant would be the more dangerous of the two mistakes.
    expect(first.riskLevel).toBe('low');
    expect(first.riskReason).toContain('210/120');
    // And nothing else was added on the way out — no total, because the repository
    // has no counting statement and inventing one here would be a guess.
    expect(Object.keys(response.body.data).sort()).toEqual([
      'limit',
      'offset',
      'screenings',
      'types',
    ]);
  });
});

describe('GET /screenings/latest', () => {
  it('answers with the last reading of that type, scoped to the token\'s pharmacy', async () => {
    const response = await call(
      'get',
      `/screenings/latest?patientId=${PATIENT}&type=blood_pressure`,
      cashierToken()
    );

    expect(response.status).toBe(200);
    expect(latestMock).toHaveBeenCalledWith(
      expect.anything(),
      PHARMACY,
      PATIENT,
      'blood_pressure'
    );
    expect(response.body.data.screening.id).toBe(STORED.id);
    expect(response.body.data.screening.riskReason).toContain('148/92');
  });

  it('answers null rather than 404 when nothing of that type has been taken', async () => {
    latestMock.mockResolvedValue(null);
    const response = await call(
      'get',
      `/screenings/latest?patientId=${PATIENT}&type=blood_pressure`,
      ownerToken()
    );

    // `null` is an answer. A patient with no previous reading is the ordinary case
    // the first time anybody takes one, and a 404 would make the patient page show
    // "nothing recorded yet" and "record not found" as the same screen — two states
    // that look alike and mean opposite things.
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: { screening: null } });
  });

  it('requires both halves of the question', async () => {
    for (const path of [
      '/screenings/latest',
      `/screenings/latest?patientId=${PATIENT}`,
      '/screenings/latest?type=blood_pressure',
    ]) {
      const response = await call('get', path, ownerToken());
      expect({ path, status: response.status }).toEqual({ path, status: 400 });
    }
    expect(latestMock).not.toHaveBeenCalled();
  });

  it('refuses a cleared patient cell here, where the same cell means no filter on the list', async () => {
    const response = await call(
      'get',
      '/screenings/latest?patientId=&type=blood_pressure',
      ownerToken()
    );
    const body = errorOf(response.body);

    // The deliberate contrast with `GET /screenings`, and the reason
    // `OPTIONAL_QUERY`'s doc comment names this route. Here the patient is not a
    // filter but the subject of the question, so an empty cell is a request with
    // the patient missing and refusing it is the answer. Answering "everybody's
    // last blood pressure" would be worse than a 400: it would be a real row from
    // a real patient, handed to whoever asked for nobody.
    expect(response.status).toBe(400);
    expect(body.error.details).toEqual([
      { field: 'patientId', message: 'That is not a valid patient id' },
    ]);
    expect(latestMock).not.toHaveBeenCalled();
  });

  it('refuses a type that is not one, with the list in the sentence', async () => {
    const response = await call(
      'get',
      `/screenings/latest?patientId=${PATIENT}&type=height`,
      ownerToken()
    );
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      { field: 'type', message: `Type must be one of ${SCREENING_TYPES.join(', ')}` },
    ]);
  });
});

describe('POST /screenings', () => {
  it('records the reading and signs it with the token, not with the body', async () => {
    const response = await call('post', '/screenings', ownerToken(), {
      ...BP_BODY,
      // Both of these are claims a client has no authority to make, and neither
      // has anywhere to land: `ScreeningInput` has no `riskLevel` field and the
      // service sets `recordedBy` from the actor.
      recordedBy: IMPOSTOR,
      riskLevel: 'low',
    });

    expect(response.status).toBe(201);
    expect(written()).toEqual({
      pharmacyId: PHARMACY,
      patientId: PATIENT,
      recordedBy: OWNER_ID,
      measurement: { type: 'blood_pressure', systolic: 148, diastolic: 92 },
      weightKg: null,
      heightCm: null,
      measuredAt: expect.any(String),
      notes: null,
    });
    // The structural half of the same claim. A read of `written().riskLevel` would
    // be `undefined` for a row that never carried one and for a body that dropped
    // one, and the two are different guarantees.
    expect(written()).not.toHaveProperty('riskLevel');
    expect(written()).not.toHaveProperty('recordedBy', IMPOSTOR);
    expect(response.body.data.screening.id).toBe(STORED.id);
  });

  it('looks the patient up inside the transaction, and answers 404 without writing', async () => {
    findPatientMock.mockResolvedValue(null);
    const response = await call('post', '/screenings', pharmacistToken(), BP_BODY);
    const body = errorOf(response.body);

    // `CLIENT` and not `expect.anything()`: the lookup has to happen on the
    // transaction's own connection, so the row is written against a patient that
    // existed at the moment of writing. A lookup before the transaction turns a
    // patient deleted in between into a foreign-key violation — a 500 naming a
    // constraint, which is a schema disclosure and also simply the wrong answer.
    expect(findPatientMock).toHaveBeenCalledWith(CLIENT, PHARMACY, PATIENT);
    expect(response.status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('No patient matches that id');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('records a blank measuredAt as now', async () => {
    await call('post', '/screenings', ownerToken(), BP_BODY);
    const at = Date.parse(written().measuredAt);

    // Not pinned to a value, because this route deliberately does not mock the
    // clock: what is worth proving is that an omitted date becomes a real instant
    // rather than null or a zero date, and a `numeric` column holding
    // `1970-01-01` would sort every future reading above it forever.
    expect(Number.isNaN(at)).toBe(false);
    expect(Math.abs(at - Date.now())).toBeLessThan(60_000);
  });

  it('accepts a reading typed as text, which is what a form sends', async () => {
    await call('post', '/screenings', ownerToken(), {
      patientId: PATIENT,
      type: 'blood_pressure',
      values: { systolicBp: '148', diastolicBp: '92' },
    });
    expect(written().measurement).toEqual({
      type: 'blood_pressure',
      systolic: 148,
      diastolic: 92,
    });
  });

  it('works a BMI out of the scale and the stature rod', async () => {
    await call('post', '/screenings', ownerToken(), {
      patientId: PATIENT,
      type: 'bmi',
      values: {},
      weightKg: 76.44,
      heightCm: 175,
    });

    // The thing a pharmacist actually has is a weight and a height, not a ratio,
    // and `values: {}` is the shape that form posts. 76.44 kg at 175 cm is 24.96,
    // rounded to 25 before classification so the level and the stored number are
    // derived from the same figure.
    expect(written().measurement).toEqual({ type: 'bmi', bmi: 25 });
    // And both inputs are kept on the row, because a BMI without the height it came
    // from cannot be checked by anybody reading the record later.
    expect({ weightKg: written().weightKg, heightCm: written().heightCm }).toEqual({
      weightKg: 76.44,
      heightCm: 175,
    });
  });

  it('lets a typed BMI win over the one it would have computed', async () => {
    await call('post', '/screenings', ownerToken(), {
      patientId: PATIENT,
      type: 'bmi',
      values: { bmi: 31.4 },
      weightKg: 76.44,
      heightCm: 175,
    });
    // If the pharmacist wrote a figure down, that figure is the reading. Computing
    // over it would classify a number the row does not show.
    expect(written().measurement).toEqual({ type: 'bmi', bmi: 31.4 });
  });

  it('keeps a weight taken beside a blood pressure instead of throwing it away', async () => {
    await call('post', '/screenings', ownerToken(), { ...BP_BODY, weightKg: 82.5 });
    expect(written().measurement).toEqual({
      type: 'blood_pressure',
      systolic: 148,
      diastolic: 92,
    });
    expect(written().weightKg).toBe(82.5);
  });

  it('refuses one half of a blood pressure, in the validator\'s own envelope', async () => {
    const response = await call('post', '/screenings', ownerToken(), {
      patientId: PATIENT,
      type: 'blood_pressure',
      values: { systolicBp: 148 },
    });
    const body = errorOf(response.body);

    // Thrown by `utils/screening.ts`, not by express-validator — the route checks
    // only that a reading arrived as a number or as text, because the pairing rule
    // is a clinical one and a second copy of it in a validator chain would be a
    // second place to get it wrong. What is being proven is that the two sources of
    // a field error answer identically, so the counter shows one kind of red.
    expect(response.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toBe(
      'Some details need correcting before this can be saved'
    );
    expect(body.error.details).toEqual([
      {
        field: 'diastolicBp',
        message: 'The bottom blood pressure number is needed, and it has to be a number.',
      },
    ]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a BMI screening with neither a ratio nor both numbers', async () => {
    const response = await call('post', '/screenings', ownerToken(), {
      patientId: PATIENT,
      type: 'bmi',
      values: {},
    });
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      {
        field: 'bmi',
        message:
          'Enter the BMI, or enter both a weight in kg and a height in cm and it will be worked out',
      },
    ]);
  });

  it('refuses a reading dated in the future, naming the field and the way out', async () => {
    const response = await call('post', '/screenings', ownerToken(), {
      ...BP_BODY,
      measuredAt: '2999-01-01T00:00:00.000Z',
    });
    const body = errorOf(response.body);

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details).toEqual([
      {
        field: 'measuredAt',
        message:
          'A reading cannot be taken in the future. Leave the date blank to record it as now.',
      },
    ]);
    // Not merely a preference: `latestScreeningOfType` orders by `measured_at desc`,
    // so one forward-dated row becomes that patient's most recent blood pressure
    // forever and quietly starts being the thing every later reading is compared to.
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses an empty measuredAt in a body, where the same cell means no filter in a query', async () => {
    const response = await call('post', '/screenings', ownerToken(), {
      ...BP_BODY,
      measuredAt: '',
    });

    // Pinned so the distinction cannot drift. `OPTIONAL_QUERY` would skip this, and
    // on a JSON body it would skip `0`, `false` and `NaN` too — this service calls
    // `.trim()` on a `measuredAt`, so a skipped `0` is a `TypeError` inside a
    // transaction and a 500 naming no field.
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      {
        field: 'measuredAt',
        message: 'Enter the date and time the reading was taken',
      },
    ]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('gives a remark beside the reading both of its two reachable sentences', async () => {
    const notText = await call('post', '/screenings', ownerToken(), { ...BP_BODY, notes: 42 });
    expect(errorOf(notText.body).error.details).toEqual([
      { field: 'notes', message: 'Enter the notes as text' },
    ]);

    // 501 rather than a constant read off the router, so the limit is pinned as a
    // fact about the wire: if it were raised, this refusal would answer 201 and
    // fail here rather than quietly letting a longer remark through.
    const tooLong = await call('post', '/screenings', ownerToken(), {
      ...BP_BODY,
      notes: 'n'.repeat(501),
    });
    expect(errorOf(tooLong.body).error.details).toEqual([
      { field: 'notes', message: 'Notes must be 500 characters or fewer' },
    ]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('names the reading that arrived as something other than a number', async () => {
    const response = await call('post', '/screenings', ownerToken(), {
      patientId: PATIENT,
      type: 'blood_sugar',
      values: { bloodGlucoseMmol: { nested: true } },
    });

    // The label comes from `READING_FIELDS` per field rather than from one generic
    // sentence, so a form with seven inputs on it can point at the right one. This
    // is also the boundary the route does own: `toNumberOrNull` is typed
    // `string | number | null`, and an object reaching it is a thrown `TypeError`
    // and a 500 that names nothing.
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      {
        field: 'values.bloodGlucoseMmol',
        message: 'Enter the blood sugar reading in mmol/L as a number',
      },
    ]);
  });
});

/**
 * Every way a request to this router can be wrong, swept for the one answer that is
 * never acceptable.
 *
 * `inventory.routes.test.ts` has the same sweep over its bodies and
 * `patients.routes.test.ts` extends it to query and path parameters; this one
 * covers both, because a router whose filters were just widened is a router whose
 * messages are worth re-reading in one pass rather than one chain at a time.
 */
describe('never answers with the validator\'s own "Invalid value"', () => {
  const CASES: { path: string; method: 'get' | 'post'; body?: object }[] = [
    { path: '/screenings?limit=0', method: 'get' },
    { path: '/screenings?limit=201', method: 'get' },
    { path: '/screenings?limit=abc', method: 'get' },
    { path: '/screenings?offset=-1', method: 'get' },
    { path: '/screenings?offset=abc', method: 'get' },
    { path: '/screenings?patientId=not-a-uuid', method: 'get' },
    { path: '/screenings?type=height', method: 'get' },
    { path: '/screenings?from=01/03/2026', method: 'get' },
    { path: '/screenings?to=2026-13-45', method: 'get' },
    { path: '/screenings/latest', method: 'get' },
    { path: '/screenings/latest?patientId=&type=blood_pressure', method: 'get' },
    { path: '/screenings/latest?patientId=not-a-uuid&type=bmi', method: 'get' },
    { path: `/screenings/latest?patientId=${PATIENT}&type=height`, method: 'get' },
    { path: '/screenings', method: 'post', body: {} },
    { path: '/screenings', method: 'post', body: { type: 'bmi' } },
    { path: '/screenings', method: 'post', body: { patientId: PATIENT } },
    { path: '/screenings', method: 'post', body: { patientId: 'nope', type: 'bmi' } },
    { path: '/screenings', method: 'post', body: { patientId: PATIENT, type: 'height' } },
    { path: '/screenings', method: 'post', body: { ...BP_BODY, values: 'nope' } },
    { path: '/screenings', method: 'post', body: { ...BP_BODY, values: [] } },
    { path: '/screenings', method: 'post', body: { ...BP_BODY, values: { systolicBp: {} } } },
    { path: '/screenings', method: 'post', body: { ...BP_BODY, values: { diastolicBp: true } } },
    { path: '/screenings', method: 'post', body: { ...BP_BODY, values: { bmi: [1] } } },
    { path: '/screenings', method: 'post', body: { ...BP_BODY, weightKg: {} } },
    { path: '/screenings', method: 'post', body: { ...BP_BODY, heightCm: [] } },
    { path: '/screenings', method: 'post', body: { ...BP_BODY, measuredAt: 'yesterday' } },
    { path: '/screenings', method: 'post', body: { ...BP_BODY, measuredAt: '' } },
    { path: '/screenings', method: 'post', body: { ...BP_BODY, notes: 42 } },
    { path: '/screenings', method: 'post', body: { ...BP_BODY, notes: 'n'.repeat(501) } },
  ];

  it('gives every refusal a sentence a person can act on', async () => {
    const offenders: string[] = [];

    for (const entry of CASES) {
      const response = await call(entry.method, entry.path, ownerToken(), entry.body);
      const body = JSON.stringify(response.body);

      // Both halves matter. A 200 would mean the case was not a case at all and the
      // sweep was quietly testing nothing; "Invalid value" is the defect, because it
      // tells the pharmacist that something was wrong and not what.
      if (response.status !== 400) {
        offenders.push(`${entry.method} ${entry.path} ${body} answered ${response.status}`);
      }
      if (body.includes('Invalid value')) {
        offenders.push(`${entry.method} ${entry.path} ${body}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('reads and writes nothing for any of them', async () => {
    for (const entry of CASES) {
      await call(entry.method, entry.path, ownerToken(), entry.body);
    }
    // The sweep above proves the messages; this proves the refusals happened before
    // the work rather than after it. A router that recorded the reading and then
    // complained about a field would answer 400 and still have written it — and on
    // this table there is no update, so it could not be taken back.
    expect(createMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(latestMock).not.toHaveBeenCalled();
  });
});
