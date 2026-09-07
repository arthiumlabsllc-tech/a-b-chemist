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
  // The repository is mocked and the service is not, so what these tests exercise
  // is the whole path a registration actually travels: express-validator, the
  // authorisation middleware, `tidyList`, the future-date check and the patch
  // built field by field. Mocking the service would test the route against a stub
  // that agrees with the test, and the assertion that matters most below — that a
  // forward-dated birth date reaches the browser as a 400 naming a field the form
  // can point at — would then be about nothing.
  countPatients: jest.fn(),
  createPatient: jest.fn(),
  findPatient: jest.fn(),
  listPatients: jest.fn(),
  updatePatient: jest.fn(),
}));

import request from 'supertest';
import type { PoolClient } from 'pg';
import { createApp } from '../app';
import { withTransaction } from '../database/pool';
import {
  countPatients,
  createPatient,
  findPatient,
  listPatients,
  updatePatient,
  type NewPatient,
  type PatientPatch,
  type PatientRow,
} from '../repositories/patients.repository';
import { findUserById, type UserRow } from '../repositories/users.repository';
import { PATIENT_LIMITS } from '../services/patients.service';
import { HttpError } from '../utils/http';
import { signAccessToken } from '../utils/jwt';
import type { UserRole } from '../utils/permissions';
import type { Gender } from '../utils/schema-enums';
import { MAX_SEARCH_LENGTH } from '../routes/shared';

/**
 * Patient records, over HTTP.
 *
 * The permission split on this router is not a split, and that is the first thing
 * worth asserting. `patients:read` and `patients:write` are both held by counter
 * staff, so all three roles may open and edit a record — because the person who
 * sells the paracetamol is the person who writes down the allergy, and a router
 * that refused them would teach the counter to keep the allergy in their head.
 * Everything clinical that hangs off the record is where the split lives, on its
 * own router behind its own permission. A test that only asserted the interesting
 * role would not notice the day somebody tightened this one, and the failure would
 * arrive as a pharmacist unable to register a patient at a busy counter.
 *
 * The second thing under test is the two-layer refusal of a date of birth. The
 * route owns the format and the service owns the meaning, because "not after
 * today" is a relationship with a clock and express-validator has no validator
 * that also knows which day it is. Both are asserted here rather than in
 * `patients.service.test.ts` alone, because the claim worth making is that a
 * service-thrown `HttpError` reaches the browser in the same envelope as a
 * validator-thrown one, with a `field` the form can point at. Proving that in the
 * service's own suite would prove nothing about the wire.
 */

const app = createApp();

const createMock = createPatient as jest.Mock;
const findMock = findPatient as jest.Mock;
const listMock = listPatients as jest.Mock;
const countMock = countPatients as jest.Mock;
const updateMock = updatePatient as jest.Mock;
const findUserByIdMock = findUserById as jest.Mock;
const withTransactionMock = withTransaction as jest.Mock;

/**
 * One client for the whole suite, handed to whatever work a transaction is given.
 *
 * Without it `withTransaction` resolves `undefined`, and `changePatient` compares
 * that against `null` — which is the check for a row that went between the lookup
 * and the update — so an unimplemented mock reads as a found row and then throws
 * inside `toView`. A 500 from a missing test double is indistinguishable from a
 * 500 from a broken route, which is the reason this is written down rather than
 * left to be rediscovered the next time the suite goes red.
 */
const CLIENT = { query: jest.fn() } as unknown as PoolClient;

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const OTHER_PHARMACY = 'a0000000-0000-4000-8000-000000000009';
const OWNER_ID = 'a0000000-0000-4000-8000-000000000002';
const PHARMACIST_ID = 'a0000000-0000-4000-8000-000000000003';
const CASHIER_ID = 'a0000000-0000-4000-8000-000000000004';
const PATIENT = 'a0000000-0000-4000-8000-000000000040';
const STORED_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpMbS0nVBM7iFtXJGvYxQmC5nqJZS';

const PHONE = '024 123 4567';
const PHONE_INTERNATIONAL = '+233241234567';

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

/** All three, because on this router there is no role to leave out. */
const EVERY_ROLE: [UserRole, () => string][] = [
  ['pharmacy_owner', ownerToken],
  ['pharmacist', pharmacistToken],
  ['staff', cashierToken],
];

function row(overrides: Partial<PatientRow> = {}): PatientRow {
  const gender: Gender | null = 'female';
  return {
    id: PATIENT,
    pharmacyId: PHARMACY,
    fullName: 'Ama Mensah',
    phone: PHONE,
    dateOfBirth: '1978-02-11',
    gender,
    allergies: ['Penicillin'],
    conditions: ['Hypertension'],
    medications: ['Amlodipine 5mg'],
    notes: null,
    createdAt: '2026-01-05T09:00:00.000Z',
    updatedAt: '2026-01-05T09:00:00.000Z',
    ...overrides,
  };
}

/** The smallest registration that is a whole registration. */
const VALID_BODY = { fullName: 'Ama Mensah' };

function call(
  method: 'get' | 'post' | 'patch',
  path: string,
  token: string | undefined,
  body?: object
): request.Test {
  const agent = request(app) as unknown as Record<
    string,
    (url: string) => request.Test
  >;
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
   * `unknown` rather than the field-error array, because two shapes arrive here
   * and both are correct: a list of `{ field, message }` from validation and from
   * the service's own refusals, and `{ missing: [...] }` from `authorize`. Typing
   * it as one would make the other assertion a cast, and a cast in a test is an
   * assertion nobody checks.
   */
  error: { message: string; code?: string; details?: unknown };
}

function errorOf(body: unknown): ErrorBody {
  return body as ErrorBody;
}

/** Every `NewPatient` the router asked to be inserted. */
function created(): NewPatient[] {
  return createMock.mock.calls.map((call) => (call as unknown[])[1] as NewPatient);
}

/** Every patch the router handed to `updatePatient`. */
function patches(): PatientPatch[] {
  return updateMock.mock.calls.map((call) => (call as unknown[])[3] as PatientPatch);
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
  createMock.mockImplementation(async (_sql: unknown, write: NewPatient) =>
    row({
      fullName: write.fullName,
      phone: write.phone,
      dateOfBirth: write.dateOfBirth,
      gender: write.gender,
      allergies: [...write.allergies],
      conditions: [...write.conditions],
      medications: [...write.medications],
      notes: write.notes,
    })
  );
  findMock.mockResolvedValue(row());
  listMock.mockResolvedValue([row()]);
  countMock.mockResolvedValue(1);
  updateMock.mockImplementation(async (_sql, _pharmacyId, _id, patch: PatientPatch) =>
    row({
      ...patch,
      allergies: [...(patch.allergies ?? [])],
      conditions: [...(patch.conditions ?? [])],
      medications: [...(patch.medications ?? [])],
    })
  );
});

describe('who may use this router', () => {
  it('answers every role on all four routes, because the counter writes the record', async () => {
    for (const [role, token] of EVERY_ROLE) {
      const list = await call('get', '/patients', token());
      const create = await call('post', '/patients', token(), VALID_BODY);
      const read = await call('get', `/patients/${PATIENT}`, token());
      const edit = await call('patch', `/patients/${PATIENT}`, token(), { notes: 'Asked.' });

      // 201 on the create and 200 on the rest, per role. Pinned as one object per
      // role so a failure names the role and the route together rather than
      // leaving four assertions to be counted by hand.
      expect({
        role,
        list: list.status,
        create: create.status,
        read: read.status,
        edit: edit.status,
      }).toEqual({ role, list: 200, create: 201, read: 200, edit: 200 });
    }
  });

  it('answers 401 with no token, and does no work at all', async () => {
    for (const [method, path, body] of [
      ['get', '/patients', undefined],
      ['post', '/patients', VALID_BODY],
      ['get', `/patients/${PATIENT}`, undefined],
      ['patch', `/patients/${PATIENT}`, { notes: 'Asked.' }],
    ] as ['get' | 'post' | 'patch', string, object | undefined][]) {
      const response = await call(method, path, undefined, body);
      const error = errorOf(response.body);
      expect({ method, path, status: response.status, code: error.error.code }).toEqual({
        method,
        path,
        status: 401,
        code: 'not_authenticated',
      });
    }

    // Authorisation runs before the handler, so an anonymous request leaves no
    // trace in the register. The opposite ordering would be a route that reads and
    // validates on everybody's behalf and then decides whether to answer.
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(findMock).not.toHaveBeenCalled();
  });
});

describe('GET /patients', () => {
  it('defaults to the first fifty with no search', async () => {
    const response = await call('get', '/patients', ownerToken());
    expect(response.status).toBe(200);
    expect(listMock.mock.calls[0]?.[2]).toEqual({ search: null, limit: 50, offset: 0 });
    expect(response.body.data).toEqual({
      patients: expect.any(Array),
      total: 1,
      limit: 50,
      offset: 0,
    });
  });

  it('trims a search before passing it on', async () => {
    await call('get', '/patients?search=%20%20ama%20%20', ownerToken());
    // A search built from an untrimmed term is a `LIKE` that misses the row the
    // pharmacist can see, and the miss reads as "no such patient" rather than as
    // "there were spaces".
    expect(listMock.mock.calls[0]?.[2]).toEqual({ search: 'ama', limit: 50, offset: 0 });
  });

  it('turns a whitespace-only search into no search at all', async () => {
    await call('get', '/patients?search=%20%20%20', ownerToken());
    // Null rather than ''. The repository treats an empty search as "every
    // patient" anyway, but a filter that reaches SQL as an empty string is one a
    // future edit could start matching literally.
    expect(listMock.mock.calls[0]?.[2]).toEqual({ search: null, limit: 50, offset: 0 });
  });

  it('passes the page through, and the count gets the search without it', async () => {
    countMock.mockResolvedValue(57);
    const response = await call('get', '/patients?search=ama&limit=20&offset=40', ownerToken());
    expect(response.body.data).toEqual({
      patients: expect.any(Array),
      total: 57,
      limit: 20,
      offset: 40,
    });
    expect(countMock.mock.calls[0]?.[2]).toEqual({ search: 'ama' });
  });

  it('carries the textable number on every row of the register', async () => {
    listMock.mockResolvedValue([row(), row({ phone: 'not a number' })]);
    countMock.mockResolvedValue(2);
    const response = await call('get', '/patients', ownerToken());
    expect(response.body.data.patients.map((patient: { smsNumber: string | null }) => patient.smsNumber)).toEqual([
      PHONE_INTERNATIONAL,
      null,
    ]);
  });
});

describe('POST /patients', () => {
  it('answers 201 with the record, in the one envelope', async () => {
    const response = await call('post', '/patients', ownerToken(), {
      fullName: 'Ama Mensah',
      phone: PHONE,
      dateOfBirth: '1978-02-11',
      gender: 'female',
      allergies: ['Penicillin', 'Penicillin', ' Sulfa '],
      conditions: ['Hypertension'],
      medications: [],
      notes: 'Regular.',
    });

    // 201 rather than 200: the record did not exist before this request, and a
    // create that answers like a read is one a retry cannot tell apart.
    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.patient).toEqual({
      ...row(),
      fullName: 'Ama Mensah',
      allergies: ['Penicillin', 'Sulfa'],
      conditions: ['Hypertension'],
      medications: [],
      notes: 'Regular.',
      smsNumber: PHONE_INTERNATIONAL,
    });
  });

  it('takes the pharmacy from the token and ignores one posted in the body', async () => {
    await call('post', '/patients', pharmacistToken(), {
      ...VALID_BODY,
      pharmacyId: OTHER_PHARMACY,
    });
    // A single-tenant build is not a reason to leave the parameter shaped so that
    // a second tenant would be one line away. The record is written field by
    // field from a contract that has no pharmacy in it.
    expect(created()[0]?.pharmacyId).toBe(PHARMACY);
    expect(created()[0]).not.toHaveProperty('pharmacyId', OTHER_PHARMACY);
  });

  it('registers a patient who gave nothing but a name', async () => {
    const response = await call('post', '/patients', cashierToken(), VALID_BODY);
    expect(response.status).toBe(201);
    expect(created()[0]).toEqual({
      pharmacyId: PHARMACY,
      fullName: 'Ama Mensah',
      phone: null,
      dateOfBirth: null,
      gender: null,
      allergies: [],
      conditions: [],
      medications: [],
      notes: null,
    });
  });

  it('refuses a date of birth the route cannot check, in the service\'s words and envelope', async () => {
    const response = await call('post', '/patients', ownerToken(), {
      ...VALID_BODY,
      dateOfBirth: '2999-01-01',
    });
    const body = errorOf(response.body);

    // This is the assertion the two-layer split exists to make. The route owns
    // the format and cannot own this one, because "not after today" needs a
    // clock; the service throws, and what arrives is the same shape a validator
    // would have produced, with a field the form can point at. A service error
    // that reached the browser as a bare 400 with no `details` would be a
    // registration form that could not say which input was wrong.
    expect(response.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toBe('The date of birth cannot be in the future');
    expect(body.error.details).toEqual([
      { field: 'dateOfBirth', message: 'Enter a date that has already happened' },
    ]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a name that is too short, naming the field and the range', async () => {
    const response = await call('post', '/patients', ownerToken(), { fullName: 'A' });
    const body = errorOf(response.body);
    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Some details need correcting before this can be saved');
    expect(body.error.details).toEqual([
      {
        field: 'fullName',
        message: `Enter a full name of between ${PATIENT_LIMITS.fullName.min} and ${PATIENT_LIMITS.fullName.max} characters`,
      },
    ]);
  });

  it('refuses a date in any format but YYYY-MM-DD', async () => {
    const response = await call('post', '/patients', ownerToken(), {
      ...VALID_BODY,
      dateOfBirth: '11/02/1978',
    });
    expect(errorOf(response.body).error.details).toEqual([
      { field: 'dateOfBirth', message: 'Enter the date of birth as YYYY-MM-DD' },
    ]);
  });

  it('refuses a gender that is not one of the four the schema holds', async () => {
    const response = await call('post', '/patients', ownerToken(), {
      ...VALID_BODY,
      gender: 'm',
    });
    // The message lists the four, because a dropdown that posted something else is
    // a frontend and a schema that have drifted, and the person reading the 400 is
    // the one who has to go and find out which.
    expect(errorOf(response.body).error.details).toEqual([
      { field: 'gender', message: 'Gender must be one of male, female, other, undisclosed' },
    ]);
  });

  it('accepts undisclosed, which is an answer and not an absence', async () => {
    await call('post', '/patients', ownerToken(), { ...VALID_BODY, gender: 'undisclosed' });
    expect(created()[0]?.gender).toBe('undisclosed');
  });

  it('trims a clinical list entry before it is stored', async () => {
    await call('post', '/patients', ownerToken(), {
      ...VALID_BODY,
      allergies: ['  Penicillin  '],
    });
    // The sanitizer writes back to `req.body`, which on Express 5 is an ordinary
    // property rather than the getter `req.query` is — so a trimmed value really
    // does reach the service, and `tidyList` trimming again is the second of two
    // layers rather than the only one.
    expect(created()[0]?.allergies).toEqual(['Penicillin']);
  });

  it('refuses a clinical list that is not a list, and says so rather than quoting the ceiling', async () => {
    const response = await call('post', '/patients', ownerToken(), {
      ...VALID_BODY,
      allergies: 'Penicillin',
    });
    // One message for the chain, because `isArray({ min, max })` is the only
    // validator on it and a `.withMessage` would be the message every failure got.
    // This assertion is the one that caught it: with the override in place a
    // string posted where a list belongs answered "holds at most 100 entries".
    expect(errorOf(response.body).error.details).toEqual([
      {
        field: 'allergies',
        message: `Enter allergies as a list of ${PATIENT_LIMITS.listLength.max} entries or fewer`,
      },
    ]);
  });

  it('words each of the three lists for the thing it holds', async () => {
    // One helper builds all three, and the entry labels are singular where the
    // list labels are plural: "an allergy" would be wrong on the list and
    // "conditions" wrong on the entry. Three copies of this chain would have
    // agreed today and drifted the day one of them was edited.
    const listMessage = (field: string): string =>
      `Enter ${field} as a list of ${PATIENT_LIMITS.listLength.max} entries or fewer`;

    for (const [field, singular] of [
      ['allergies', 'allergy'],
      ['conditions', 'condition'],
      ['medications', 'medication'],
    ] as [string, string][]) {
      const notAList = await call('post', '/patients', ownerToken(), {
        ...VALID_BODY,
        [field]: 'one entry',
      });
      expect({ field, details: errorOf(notAList.body).error.details }).toEqual({
        field,
        details: [{ field, message: listMessage(field) }],
      });

      const badEntry = await call('post', '/patients', ownerToken(), {
        ...VALID_BODY,
        [field]: [42],
      });
      expect({ field, details: errorOf(badEntry.body).error.details }).toEqual({
        field,
        details: [{ field: `${field}[0]`, message: `Enter each ${singular} as text` }],
      });

      const longEntry = await call('post', '/patients', ownerToken(), {
        ...VALID_BODY,
        [field]: ['a'.repeat(PATIENT_LIMITS.listItem.max + 1)],
      });
      expect({ field, details: errorOf(longEntry.body).error.details }).toEqual({
        field,
        details: [
          {
            field: `${field}[0]`,
            message: `Each ${singular} must be between ${PATIENT_LIMITS.listItem.min} and ${PATIENT_LIMITS.listItem.max} characters`,
          },
        ],
      });
    }
  });

  it('refuses a list longer than the ceiling, in the same sentence as a list that is not one', async () => {
    const response = await call('post', '/patients', ownerToken(), {
      ...VALID_BODY,
      allergies: Array.from({ length: PATIENT_LIMITS.listLength.max + 1 }, (_, index) => `A${index}`),
    });
    expect(errorOf(response.body).error.details).toEqual([
      {
        field: 'allergies',
        message: `Enter allergies as a list of ${PATIENT_LIMITS.listLength.max} entries or fewer`,
      },
    ]);
  });
});

describe('PATCH /patients/:id', () => {
  it('clears a field sent as null and leaves a field it was not sent alone', async () => {
    const response = await call('patch', `/patients/${PATIENT}`, ownerToken(), {
      phone: null,
      notes: 'Asked about the amlodipine.',
    });
    expect(response.status).toBe(200);
    // `phone: null` is "clear the number". An omitted `dateOfBirth` is "leave the
    // date alone", and it must not arrive as null or the repository's
    // `case when $flag::boolean` would read the omission as a decision to erase it.
    expect(patches()[0]).toEqual({ phone: null, notes: 'Asked about the amlodipine.' });
  });

  it('refuses a patch with nothing in it rather than answering with an unchanged row', async () => {
    const response = await call('patch', `/patients/${PATIENT}`, ownerToken(), {});
    const body = errorOf(response.body);
    expect(response.status).toBe(400);
    expect(body.error.code).toBe('nothing_to_update');
    expect(body.error.message).toBe('Nothing to change — send at least one field to edit');
    // A silent no-op is a frontend that believes it saved something it did not
    // send, and the belief survives the request that produced it.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('answers 404 for a record that is not there, and does not attempt the update', async () => {
    findMock.mockResolvedValue(null);
    const response = await call('patch', `/patients/${PATIENT}`, ownerToken(), { notes: 'x' });
    const body = errorOf(response.body);
    expect(response.status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('No patient matches that id');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('refuses a future date of birth on an edit too', async () => {
    const response = await call('patch', `/patients/${PATIENT}`, ownerToken(), {
      dateOfBirth: '2999-01-01',
    });
    expect(errorOf(response.body).error.details).toEqual([
      { field: 'dateOfBirth', message: 'Enter a date that has already happened' },
    ]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('scopes the lookup and the update to the caller\'s pharmacy', async () => {
    await call('patch', `/patients/${PATIENT}`, cashierToken(), { notes: 'x' });
    expect(findMock).toHaveBeenCalledWith(expect.anything(), PHARMACY, PATIENT);
    expect(updateMock).toHaveBeenCalledWith(expect.anything(), PHARMACY, PATIENT, { notes: 'x' });
  });
});

describe('GET /patients/:id', () => {
  it('answers with the record and the number it can text', async () => {
    const response = await call('get', `/patients/${PATIENT}`, cashierToken());
    expect(response.status).toBe(200);
    expect(response.body.data.patient.id).toBe(PATIENT);
    expect(response.body.data.patient.smsNumber).toBe(PHONE_INTERNATIONAL);
    expect(response.body.data.patient.phone).toBe(PHONE);
  });

  it('answers 404 for a miss, in the same words as another pharmacy\'s patient', async () => {
    findMock.mockResolvedValue(null);
    const response = await call('get', `/patients/${PATIENT}`, ownerToken());
    const body = errorOf(response.body);
    expect(response.status).toBe(404);
    expect(body.error.code).toBe('not_found');
    // One message for both cases, deliberately: telling them apart hands a caller
    // a way to enumerate which ids exist in another tenant.
    expect(body.error.message).toBe('No patient matches that id');
    expect(findMock).toHaveBeenCalledWith(expect.anything(), PHARMACY, PATIENT);
  });

  it('propagates a service refusal unchanged rather than flattening it to a 500', async () => {
    findMock.mockRejectedValue(new HttpError(404, 'No patient matches that id', { code: 'not_found' }));
    const response = await call('get', `/patients/${PATIENT}`, ownerToken());
    expect(response.status).toBe(404);
    expect(errorOf(response.body).error.code).toBe('not_found');
  });
});

/**
 * Every way a request to this router can be wrong, swept for the one answer that
 * is never acceptable.
 *
 * `inventory.routes.test.ts` has the same sweep over its bodies and the reason is
 * recorded there: a chain with no message answers with express-validator's own
 * `'Invalid value'`, which tells the pharmacist that something was wrong and not
 * what. This one covers query parameters and path parameters as well, which the
 * inventory sweep does not — the four `?search` chains in this codebase were
 * spelled without a message precisely because nothing swept a query string for it.
 */
describe('never answers with the validator\'s own "Invalid value"', () => {
  const CASES: { path: string; method: 'get' | 'post' | 'patch'; body?: object }[] = [
    { path: '/patients?limit=0', method: 'get' },
    { path: '/patients?limit=201', method: 'get' },
    { path: '/patients?limit=abc', method: 'get' },
    { path: '/patients?offset=-1', method: 'get' },
    { path: '/patients?offset=abc', method: 'get' },
    { path: `/patients?search=${'a'.repeat(MAX_SEARCH_LENGTH + 1)}`, method: 'get' },
    { path: '/patients/not-a-uuid', method: 'get' },
    { path: '/patients/not-a-uuid', method: 'patch', body: { notes: 'x' } },
    { path: '/patients', method: 'post', body: {} },
    { path: '/patients', method: 'post', body: { fullName: 'A' } },
    { path: '/patients', method: 'post', body: { fullName: 'a'.repeat(121) } },
    { path: '/patients', method: 'post', body: { fullName: 42 } },
    { path: '/patients', method: 'post', body: { ...VALID_BODY, dateOfBirth: '11/02/1978' } },
    { path: '/patients', method: 'post', body: { ...VALID_BODY, dateOfBirth: '2026-13-45' } },
    { path: '/patients', method: 'post', body: { ...VALID_BODY, gender: 'm' } },
    { path: '/patients', method: 'post', body: { ...VALID_BODY, phone: 42 } },
    { path: '/patients', method: 'post', body: { ...VALID_BODY, notes: 'n'.repeat(2001) } },
    { path: '/patients', method: 'post', body: { ...VALID_BODY, allergies: 'Penicillin' } },
    { path: '/patients', method: 'post', body: { ...VALID_BODY, allergies: [42] } },
    { path: '/patients', method: 'post', body: { ...VALID_BODY, allergies: [''] } },
    {
      path: '/patients',
      method: 'post',
      body: { ...VALID_BODY, allergies: ['a'.repeat(PATIENT_LIMITS.listItem.max + 1)] },
    },
    {
      path: '/patients',
      method: 'post',
      body: {
        ...VALID_BODY,
        allergies: Array.from({ length: 101 }, (_, index) => `A${index}`),
      },
    },
    { path: '/patients', method: 'post', body: { ...VALID_BODY, conditions: 'one' } },
    { path: '/patients', method: 'post', body: { ...VALID_BODY, medications: [{}] } },
    { path: `/patients/${PATIENT}`, method: 'patch', body: { fullName: 'A' } },
    { path: `/patients/${PATIENT}`, method: 'patch', body: { gender: 'x' } },
  ];

  it('gives every refusal a sentence a person can act on', async () => {
    const offenders: string[] = [];

    for (const entry of CASES) {
      const response = await call(entry.method, entry.path, ownerToken(), entry.body);
      const body = JSON.stringify(response.body);

      // Both halves matter. A 200 would mean the case was not a case at all and
      // the sweep was quietly testing nothing; "Invalid value" is the defect.
      if (response.status !== 400) {
        offenders.push(`${entry.method} ${entry.path} ${body} answered ${response.status}`);
      }
      if (body.includes('Invalid value')) {
        offenders.push(`${entry.method} ${entry.path} ${body}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('writes nothing for any of them', async () => {
    for (const entry of CASES) {
      await call(entry.method, entry.path, ownerToken(), entry.body);
    }
    // The sweep above proves the messages; this proves the refusals happened
    // before the work rather than after it. A router that inserted the record and
    // then complained about a field would answer 400 and still have written.
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});
