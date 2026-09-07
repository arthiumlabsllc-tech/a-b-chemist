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

jest.mock('../repositories/consultations.repository', () => ({
  createConsultation: jest.fn(),
  findConsultation: jest.fn(),
  listConsultations: jest.fn(),
  updateConsultation: jest.fn(),
}));

jest.mock('../repositories/reminders.repository', () => ({
  // Every export, not only the two this router's services call. `createApp` loads
  // the whole route tree, so `notifications.routes.ts` imports this module too, and
  // a mock naming two functions hands it `undefined` for the other five — which is
  // silent until a test that never touches reminders starts failing for a reason
  // nobody can see from its own file.
  scheduleReminder: jest.fn(),
  findReminder: jest.fn(),
  listDueReminders: jest.fn(),
  listReminders: jest.fn(),
  recordReminderOutcome: jest.fn(),
  supersedeAppointmentReminders: jest.fn(),
  supersedeRefillReminder: jest.fn(),
}));

import request from 'supertest';
import type { PoolClient } from 'pg';
import { createApp } from '../app';
import { poolSql, withTransaction } from '../database/pool';
import { findPatient } from '../repositories/patients.repository';
import {
  createConsultation,
  findConsultation,
  listConsultations,
  updateConsultation,
  type ConsultationFilters,
  type ConsultationPatch,
  type ConsultationRow,
  type NewConsultation,
} from '../repositories/consultations.repository';
import {
  scheduleReminder,
  supersedeAppointmentReminders,
  type NewReminder,
} from '../repositories/reminders.repository';
import { findUserById, type UserRow } from '../repositories/users.repository';
import { signAccessToken } from '../utils/jwt';
import type { UserRole } from '../utils/permissions';
import { CONSULTATION_STATUSES, CONSULTATION_TYPES } from '../utils/schema-enums';

/**
 * The consultation diary, over HTTP.
 *
 * ## The permission split, asserted for every role on every route
 *
 * Reading the diary is `patients:read`, which counter staff hold; booking, moving
 * and ending an appointment are `consultations:write`, which they do not. Both
 * halves are run for all three roles. A suite that tested only the role it expected
 * to be refused would not notice the day somebody widened the write, and the
 * failure would arrive as a counter that can book an appointment it should not be
 * able to.
 *
 * ## The distinction this router exists to prove at the wire
 *
 * `PATCH /consultations/:id` carries three different meanings in one body:
 * an absent key is "leave this column alone", a `null` is "clear it", and a value
 * is "set it". `consultations.repository.ts` writes `case when $n::boolean` columns
 * to carry exactly that, and the route reads the body field by field rather than
 * casting over it so the distinction survives.
 *
 * It did not survive the service. `rescheduleConsultation` collapsed an absent
 * `videoUrl` and `durationMinutes` into `null`, because the two coercers it uses
 * answer `null` for "nothing was given" — the right answer for a booking and the
 * wrong one for a patch. Every appointment moved by a form that posted only the new
 * time lost its meeting link and its length, and the row still looked perfectly
 * ordinary. `consultations.service.test.ts` pins the collapse at the service; the
 * tests below pin it from the outside, because the defect was reachable through a
 * request body and a route-level test is the one that would have caught it there.
 *
 * ## An empty cell means two different things on one route
 *
 * On `GET /consultations` a cleared filter is no filter, which is what
 * `routes/shared.ts`'s `OPTIONAL_QUERY` makes true — and that constant's own
 * documentation says every router importing it has to prove it here, not once in
 * whichever suite first noticed. `limit` and `offset` are the exception on the same
 * route and in the same query string: `pagination` uses a bare `.optional()`, so
 * `?limit=` is a 400 while `?patientId=` is not. Both are pinned.
 */

const app = createApp();

const createMock = createConsultation as jest.Mock;
const findMock = findConsultation as jest.Mock;
const listMock = listConsultations as jest.Mock;
const updateMock = updateConsultation as jest.Mock;
const findPatientMock = findPatient as jest.Mock;
const findUserByIdMock = findUserById as jest.Mock;
const scheduleMock = scheduleReminder as jest.Mock;
const supersedeMock = supersedeAppointmentReminders as jest.Mock;
const withTransactionMock = withTransaction as jest.Mock;

/**
 * One client for the whole suite, handed to whatever work a transaction is given.
 *
 * Without this, `withTransaction` resolves `undefined` and the service's patient
 * lookup is called with nothing — which reads as a missing patient and answers 404
 * from a route that was never reached. A 404 from a missing test double is
 * indistinguishable from a 404 from a broken route.
 */
const CLIENT = { query: jest.fn() } as unknown as PoolClient;

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const OTHER_PHARMACY = 'a0000000-0000-4000-8000-000000000099';
const OWNER_ID = 'a0000000-0000-4000-8000-000000000002';
const PHARMACIST_ID = 'a0000000-0000-4000-8000-000000000003';
const CASHIER_ID = 'a0000000-0000-4000-8000-000000000004';
const PATIENT = 'a0000000-0000-4000-8000-000000000040';
const CONSULTATION = 'a0000000-0000-4000-8000-000000000060';

const STORED_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpMbS0nVBM7iFtXJGvYxQmC5nqJZS';

const CASHIER_NAME = 'Kofi Mensah';
const PHARMACIST_NAME = 'Dr Ama Boateng';

/**
 * Far enough ahead that the suite's answer does not depend on the day it runs.
 *
 * `utils/clock` is deliberately not mocked here: this suite is about what crosses
 * the wire, and a frozen clock would freeze it in a way the real route is not. A
 * slot in 2027 is in the future whenever the tests are run, so "a reminder was
 * raised" stays a true statement rather than one that expires.
 */
const FUTURE = '2027-06-01T09:00:00.000Z';

/** Always in the past, for the booking that should raise nothing. */
const PAST = '2020-01-01T09:00:00.000Z';

/** A new slot, spelled the way a datetime-local input spells it. */
const MOVED_TO = '2027-06-08T14:30:00.000Z';

const LINK = 'https://meet.example/room/9';

let users: Record<string, UserRow>;

function user(id: string, role: UserRole): UserRow {
  return {
    id,
    pharmacyId: PHARMACY,
    fullName: role === 'staff' ? CASHIER_NAME : PHARMACIST_NAME,
    email: `${id}@aandb.example`,
    phone: null,
    role,
    passwordHash: STORED_HASH,
    isActive: true,
    sessionVersion: 2,
    lastLoginAt: null,
  };
}

function tokenFor(id: string, role: UserRole, pharmacyId: string = PHARMACY): string {
  return signAccessToken({ userId: id, pharmacyId, role, sessionVersion: 2 });
}

const ownerToken = (): string => tokenFor(OWNER_ID, 'pharmacy_owner');
const pharmacistToken = (): string => tokenFor(PHARMACIST_ID, 'pharmacist');
const cashierToken = (): string => tokenFor(CASHIER_ID, 'staff');

/**
 * All three, because this router refuses one of them on three of its routes and
 * answers all three on the other two — which is only visible if all three are run.
 */
const EVERY_ROLE: [UserRole, () => string][] = [
  ['pharmacy_owner', ownerToken],
  ['pharmacist', pharmacistToken],
  ['staff', cashierToken],
];

/**
 * A complete row, and deliberately a *video* appointment with a link and a length.
 *
 * The default is the row that has something to lose. A reschedule that wiped
 * `video_url` and `duration_minutes` is invisible against a row where both were
 * already null, so the case that caught a real defect is the ordinary case rather
 * than the one built to be interesting.
 */
function consultationRow(overrides: Partial<ConsultationRow> = {}): ConsultationRow {
  return {
    id: CONSULTATION,
    pharmacyId: PHARMACY,
    patientId: PATIENT,
    conductedBy: PHARMACIST_ID,
    type: 'video',
    status: 'scheduled',
    scheduledAt: FUTURE,
    durationMinutes: 30,
    videoUrl: LINK,
    notes: 'Bring the repeat slip.',
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

/**
 * The row the repository hands back, whatever was written.
 *
 * Not built *from* the write. What reached the table is read off the repository
 * call's argument and what reached the browser is read off this row, so the two are
 * asserted separately and a mapping bug cannot cancel itself out.
 */
const STORED = consultationRow();

/** A patient, in the only shape this router's path needs. */
const FOUND_PATIENT = { id: PATIENT, pharmacyId: PHARMACY };

/** What the booking form posts: a video appointment, complete. */
const BOOKING = {
  patientId: PATIENT,
  type: 'video',
  // Deliberately a *different spelling* of `FUTURE` — no milliseconds — so the
  // normalisation on the way in is visible rather than assumed.
  scheduledAt: '2027-06-01T09:00:00Z',
  conductedBy: PHARMACIST_ID,
  durationMinutes: 30,
  videoUrl: LINK,
  notes: 'Bring the repeat slip.',
};

/** What a reschedule posts when the only thing that changed is the time. */
const MOVE = { scheduledAt: '2027-06-08T14:30:00Z' };

/**
 * The two parameterised paths, as constants.
 *
 * Not for brevity, though it helps: a path built inline in forty places is a path
 * that can be built slightly differently in one of them, and a test that hits the
 * wrong url fails with a 404 that reads like a broken route.
 */
const ONE = `/consultations/${CONSULTATION}`;
const ONE_END = `/consultations/${CONSULTATION}/end`;

function call(
  method: 'get' | 'post' | 'patch',
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
   * `unknown` rather than the field-error array, because three shapes arrive here
   * and all are correct: a list of `{ field, message }` from validation, `{ missing }`
   * from `authorize`, and `{ field }` or `{ status }` from the service's own
   * refusals. Typing it as one would make the others casts, and a cast in a test is
   * an assertion nobody checks.
   */
  error: { message: string; code?: string; details?: unknown };
}

function errorOf(body: unknown): ErrorBody {
  return body as ErrorBody;
}

/** The `NewConsultation` the booking route asked to be inserted. */
function written(): NewConsultation {
  const call = createMock.mock.calls[0];
  if (call === undefined) {
    // Named rather than left to surface as a property read on undefined, which
    // reads like a broken route instead of a test that expected a write.
    throw new Error('createConsultation was never called');
  }
  return (call as unknown[])[1] as NewConsultation;
}

/** The `ConsultationPatch` a reschedule or an ending asked for. */
function patchOf(): ConsultationPatch {
  const call = updateMock.mock.calls[0];
  if (call === undefined) throw new Error('updateConsultation was never called');
  return (call as unknown[])[3] as ConsultationPatch;
}

/** The filters the diary route handed to the repository. */
function filtersOf(): ConsultationFilters {
  const call = listMock.mock.calls[0];
  if (call === undefined) throw new Error('listConsultations was never called');
  return (call as unknown[])[2] as ConsultationFilters;
}

/** The reminder a booking or a reschedule raised. */
function reminded(): NewReminder {
  const call = scheduleMock.mock.calls[0];
  if (call === undefined) throw new Error('scheduleReminder was never called');
  return (call as unknown[])[1] as NewReminder;
}

/** What a reschedule or an ending asked to be swept, and why. */
function superseded(): { keepDedupeKey: string; reason: string } {
  const call = supersedeMock.mock.calls[0];
  if (call === undefined) {
    throw new Error('supersedeAppointmentReminders was never called');
  }
  const args = call as unknown[];
  return { keepDedupeKey: args[3] as string, reason: args[4] as string };
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
  findMock.mockResolvedValue(STORED);
  updateMock.mockResolvedValue(STORED);
  listMock.mockResolvedValue([STORED]);
  scheduleMock.mockResolvedValue({ scheduled: true, reminder: null });
  supersedeMock.mockResolvedValue(1);
});

describe('who may use this router', () => {
  it('answers every role on the two reads, and refuses counter staff on the three writes', async () => {
    for (const [role, token] of EVERY_ROLE) {
      const diary = await call('get', '/consultations', token());
      const one = await call('get', `/consultations/${CONSULTATION}`, token());
      const book = await call('post', '/consultations', token(), BOOKING);
      const move = await call('patch', `/consultations/${CONSULTATION}`, token(), MOVE);
      const end = await call('post', `/consultations/${CONSULTATION}/end`, token(), {
        status: 'completed',
      });

      // Pinned as one object per role, so a failure names the role and the route
      // together rather than leaving five assertions to be counted by hand.
      expect({
        role,
        diary: diary.status,
        one: one.status,
        book: book.status,
        move: move.status,
        end: end.status,
      }).toEqual({
        role,
        diary: 200,
        one: 200,
        // 201 because the appointment did not exist before the request.
        book: role === 'staff' ? 403 : 201,
        move: role === 'staff' ? 403 : 200,
        end: role === 'staff' ? 403 : 200,
      });
    }
  });

  it('names the permission it refused, and does no work behind the refusal', async () => {
    const book = await call('post', '/consultations', cashierToken(), BOOKING);
    const move = await call('patch', `/consultations/${CONSULTATION}`, cashierToken(), MOVE);
    const end = await call('post', `/consultations/${CONSULTATION}/end`, cashierToken(), {
      status: 'cancelled',
    });

    for (const response of [book, move, end]) {
      const body = errorOf(response.body);
      expect(response.status).toBe(403);
      expect(body.error.code).toBe('forbidden');
      expect(body.error.message).toBe('Your role does not permit this action');
      // The permission, not the route: the counter shows one sentence for three
      // buttons, and naming the permission is what tells a pharmacist that this is
      // a role question rather than a broken form.
      expect(body.error.details).toEqual({ missing: ['consultations:write'] });
    }

    // `authorize` runs before the validators and before the handler, so a refusal
    // here is a refusal that cost nothing. A router that booked the appointment and
    // then checked who asked would answer 403 and still have written it.
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  it('refuses a request carrying no token at all', async () => {
    // The sentence is `auth.routes.test.ts`'s business; what belongs here is that
    // the whole router sits behind `authenticate` and not behind one route of it.
    for (const path of ['/consultations', `/consultations/${CONSULTATION}`]) {
      const response = await call('get', path, undefined);
      expect(response.status).toBe(401);
    }
    const book = await call('post', '/consultations', undefined, BOOKING);
    expect(book.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('reads the pharmacy from the token, so one pharmacy cannot open another\'s diary', async () => {
    const elsewhere = tokenFor(OWNER_ID, 'pharmacy_owner', OTHER_PHARMACY);
    findMock.mockResolvedValue(null);

    const one = await call('get', `/consultations/${CONSULTATION}`, elsewhere);
    const diary = await call('get', '/consultations', elsewhere);

    // The 404 is the repository's answer to a scoped query that matched nothing,
    // which is the point: the id was valid and the row exists, just not here.
    expect(one.status).toBe(404);
    expect(diary.status).toBe(200);
    expect(findMock).toHaveBeenCalledWith(poolSql, OTHER_PHARMACY, CONSULTATION);
    expect(listMock).toHaveBeenCalledWith(poolSql, OTHER_PHARMACY, expect.anything());
    expect(findMock).not.toHaveBeenCalledWith(poolSql, PHARMACY, CONSULTATION);
  });
});

describe('GET /consultations', () => {
  it('asks for the first fifty, soonest first, with no filter at all', async () => {
    const response = await call('get', '/consultations', pharmacistToken());

    expect(response.status).toBe(200);
    // `order` is absent rather than `'upcoming'`: the default belongs to the module
    // that owns the ordering, and a route that spelled it out would be a second
    // place to change when the diary's default reading order changes.
    expect(filtersOf()).toStrictEqual({
      patientId: null,
      statuses: [],
      conductedBy: null,
      from: null,
      to: null,
      limit: 50,
      offset: 0,
    });
  });

  it('honours a page the caller asked for', async () => {
    await call('get', '/consultations?limit=20&offset=40', ownerToken());
    const filters = filtersOf();
    expect({ limit: filters.limit, offset: filters.offset }).toEqual({ limit: 20, offset: 40 });
  });

  it('treats a cleared filter cell as no filter, on all six of them at once', async () => {
    const response = await call(
      'get',
      '/consultations?patientId=&conductedBy=&status=&from=&to=&order=',
      cashierToken()
    );

    expect(response.status).toBe(200);
    // `toStrictEqual` and not `toEqual`, because the claim about `order` is that the
    // key is *absent* rather than present-and-undefined: the route builds it with a
    // spread, and `toEqual` would pass on `{ order: undefined }` too.
    expect(filtersOf()).toStrictEqual({
      patientId: null,
      statuses: [],
      conductedBy: null,
      from: null,
      to: null,
      limit: 50,
      offset: 0,
    });
    expect(filtersOf()).not.toHaveProperty('order');
  });

  it('refuses a cleared limit cell, where a cleared filter cell means no filter', async () => {
    const cleared = await call('get', '/consultations?patientId=', ownerToken());
    const limit = await call('get', '/consultations?limit=', ownerToken());
    const offset = await call('get', '/consultations?offset=', ownerToken());

    // Same route, same query string, opposite answers, and both on purpose.
    // `pagination` uses a bare `.optional()`, which skips only `undefined`; every
    // filter uses `OPTIONAL_QUERY`, which skips `''` as well. An empty page size is
    // not a page size nobody asked for, it is a page size that was cleared.
    expect({ cleared: cleared.status, limit: limit.status, offset: offset.status }).toEqual({
      cleared: 200,
      limit: 400,
      offset: 400,
    });
    expect(errorOf(limit.body).error.details).toEqual([
      { field: 'limit', message: 'limit must be between 1 and 200' },
    ]);
    expect(errorOf(offset.body).error.details).toEqual([
      { field: 'offset', message: 'offset must be 0 or more' },
    ]);
  });

  it('still refuses a value that is not an id, so the widening opened no uuid cast', async () => {
    for (const value of ['0', 'false', 'not-a-uuid']) {
      for (const field of ['patientId', 'conductedBy']) {
        const response = await call('get', `/consultations?${field}=${value}`, ownerToken());
        const body = errorOf(response.body);
        expect({ value, field, status: response.status, details: body.error.details }).toEqual({
          value,
          field,
          status: 400,
          details: [
            {
              field,
              message:
                field === 'patientId'
                  ? 'That is not a valid patient id'
                  : 'That is not a valid member of staff',
            },
          ],
        });
      }
    }
    expect(listMock).not.toHaveBeenCalled();
  });

  it('accepts a status once and accepts it repeated', async () => {
    await call('get', '/consultations?status=completed', ownerToken());
    expect(filtersOf().statuses).toEqual(['completed']);

    listMock.mockClear();
    await call('get', '/consultations?status=scheduled&status=no_show', ownerToken());
    // Both spellings reach `toEnumMember` the same way, or the single-value case is
    // a special case somebody eventually forgets to write.
    expect(filtersOf().statuses).toEqual(['scheduled', 'no_show']);
  });

  it('refuses a status outside the enum, and says which values are inside it', async () => {
    const response = await call('get', '/consultations?status=finished', ownerToken());

    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      {
        field: 'status',
        message: 'Status must be one of scheduled, completed, cancelled, no_show',
      },
    ]);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('takes an ordering, and refuses one that is not a reading of the diary', async () => {
    await call('get', '/consultations?order=recent', ownerToken());
    expect(filtersOf().order).toBe('recent');

    listMock.mockClear();
    const response = await call('get', '/consultations?order=sideways', ownerToken());
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      { field: 'order', message: "Order must be 'upcoming' or 'recent'" },
    ]);
  });

  it('answers the two enums beside the page, so a form is not carrying its own copy', async () => {
    const response = await call('get', '/consultations', ownerToken());
    const data = response.body.data as {
      consultations: ConsultationRow[];
      limit: number;
      offset: number;
      statuses: string[];
      types: string[];
    };

    expect(data.statuses).toEqual([...CONSULTATION_STATUSES]);
    expect(data.types).toEqual([...CONSULTATION_TYPES]);
    expect({ limit: data.limit, offset: data.offset }).toEqual({ limit: 50, offset: 0 });
    expect(data.consultations).toHaveLength(1);
    // The asymmetry that makes the diary useful: the level of a screening is frozen
    // at the decision made at the time, but an appointment's type and status are
    // read straight back, because nothing about them is a judgement.
    expect(data.consultations[0]?.videoUrl).toBe(LINK);
  });

  it('answers an empty page for a diary with nothing in it, rather than a refusal', async () => {
    listMock.mockResolvedValue([]);
    const response = await call('get', '/consultations?status=no_show', cashierToken());

    expect(response.status).toBe(200);
    expect(response.body.data.consultations).toEqual([]);
    // No total, and that is a decision rather than a gap: both of this list's real
    // views are "what is coming up" and "the last few", and neither shows a count.
    expect(response.body.data).not.toHaveProperty('total');
  });
});

describe('GET /consultations/:id', () => {
  it('answers one consultation, and 404 for a miss', async () => {
    const found = await call('get', `/consultations/${CONSULTATION}`, cashierToken());
    expect(found.status).toBe(200);
    expect(found.body.data.consultation.id).toBe(CONSULTATION);
    expect(findMock).toHaveBeenCalledWith(poolSql, PHARMACY, CONSULTATION);

    findMock.mockResolvedValue(null);
    const missed = await call('get', `/consultations/${CONSULTATION}`, cashierToken());
    expect(missed.status).toBe(404);
    expect(errorOf(missed.body).error).toEqual({
      message: 'No consultation matches that id',
      code: 'not_found',
    });
  });

  it('refuses an id that is not an id, before asking the database for it', async () => {
    for (const value of ['not-a-uuid', '1', 'null']) {
      const response = await call('get', `/consultations/${value}`, ownerToken());
      expect({ value, status: response.status }).toEqual({ value, status: 400 });
      expect(errorOf(response.body).error.details).toEqual([
        { field: 'id', message: 'That is not a valid consultation id' },
      ]);
    }
    // A `uuid` column asked for `'null'` is a cast error from Postgres and a 500
    // whose message the error middleware withholds, so the refusal has to be here.
    expect(findMock).not.toHaveBeenCalled();
  });
});

describe('POST /consultations', () => {
  it('books the appointment and answers 201, writing no status', async () => {
    const response = await call('post', '/consultations', pharmacistToken(), BOOKING);

    expect(response.status).toBe(201);
    expect(response.body.data.consultation.id).toBe(CONSULTATION);
    expect(written()).toStrictEqual({
      pharmacyId: PHARMACY,
      patientId: PATIENT,
      conductedBy: PHARMACIST_ID,
      type: 'video',
      // `.000Z` out for a body that sent no milliseconds: the spelling the database
      // stored, and the only one a later reschedule can reproduce to find this
      // appointment's reminder by prefix.
      scheduledAt: FUTURE,
      durationMinutes: 30,
      videoUrl: LINK,
      notes: 'Bring the repeat slip.',
    });
    // `createConsultation` names eight columns and `status` is not one of them, so
    // there is no body that books an appointment which has already finished.
    expect(written()).not.toHaveProperty('status');
    // The patient is looked up inside the transaction, so an appointment cannot be
    // written against somebody removed a moment earlier.
    expect(findPatientMock).toHaveBeenCalledWith(CLIENT, PHARMACY, PATIENT);
  });

  it('turns a field nobody sent into a null, which on a booking is the honest answer', async () => {
    await call('post', '/consultations', ownerToken(), {
      patientId: PATIENT,
      type: 'in_person',
      scheduledAt: '2027-06-01T09:00:00Z',
    });

    // The same collapse that is a defect on a patch is correct here, and the
    // difference is the operation: an appointment nobody gave a length for has no
    // length, while an appointment that was moved has the length it already had.
    expect(written()).toStrictEqual({
      pharmacyId: PHARMACY,
      patientId: PATIENT,
      conductedBy: null,
      type: 'in_person',
      scheduledAt: FUTURE,
      durationMinutes: null,
      videoUrl: null,
      notes: null,
    });
    // No conductor named, so nobody was looked up beyond the caller: an unheld
    // appointment is a normal thing for a pharmacy to have on its diary.
    //
    // `authenticate` resolves the token's own user on every authenticated request,
    // so "not called" is never the right assertion about `findUserById` in a route
    // suite — it would fail on a route that worked. What is being claimed is that
    // the lookup happened once and was the caller's, so a conductor nobody named
    // costs no second query.
    expect(findUserByIdMock).toHaveBeenCalledTimes(1);
    expect(findUserByIdMock).toHaveBeenCalledWith(OWNER_ID);
  });

  it('raises the reminder inside the same transaction as the booking', async () => {
    await call('post', '/consultations', ownerToken(), BOOKING);

    // One transaction, and both writes handed the same client. A 201 from this
    // route therefore means the row and its reminder both exist, which is the
    // guarantee the bell depends on — a reminder written after the commit could be
    // lost between the two, and the appointment would simply never be mentioned.
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith(CLIENT, expect.anything());
    expect(scheduleMock).toHaveBeenCalledWith(CLIENT, expect.anything());

    // Spelled out rather than built with `appointmentReminderKey`: a test that
    // calls the function it is checking agrees with itself whatever it does.
    expect(reminded().dedupeKey).toBe(`appointment:${CONSULTATION}:${FUTURE}`);
    expect(reminded().kind).toBe('appointment');
    expect(reminded().patientId).toBe(PATIENT);
    expect(reminded().pharmacyId).toBe(PHARMACY);
    // Plain text, because it ends up in an SMS body and in a bell.
    expect(typeof reminded().message).toBe('string');
    expect(reminded().message.length).toBeGreaterThan(0);
  });

  it('books a slot that has already passed, and raises nothing for it', async () => {
    createMock.mockResolvedValue(consultationRow({ scheduledAt: PAST }));

    const response = await call('post', '/consultations', ownerToken(), {
      ...BOOKING,
      scheduledAt: '2020-01-01T09:00:00Z',
    });

    // Not a refusal. An appointment recorded after the fact is a record of
    // something that took place, and refusing it would push the pharmacy towards
    // back-dating a slot to next week in order to write down what happened today.
    expect(response.status).toBe(201);
    // But no text telling somebody to attend an appointment they were sitting in.
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("refuses a patient who is not this pharmacy's, before writing anything", async () => {
    findPatientMock.mockResolvedValue(null);

    const response = await call('post', '/consultations', ownerToken(), BOOKING);

    expect(response.status).toBe(404);
    expect(errorOf(response.body).error).toEqual({
      message: 'No patient matches that id',
      code: 'not_found',
    });
    expect(createMock).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("refuses a conductor who is counter staff, in the service's own envelope", async () => {
    const response = await call('post', '/consultations', ownerToken(), {
      ...BOOKING,
      conductedBy: CASHIER_ID,
    });

    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.code).toBe('conductor_not_permitted');
    expect(errorOf(response.body).error.message).toBe(
      `${CASHIER_NAME} cannot hold this consultation. A pharmacist or the owner has to.`
    );
    // An object rather than a validator's array, and the difference is honest: the
    // service names the field to point at but has no second sentence to add,
    // because the sentence is the message. A renderer that reads `details` as an
    // array of field errors has to cope with this shape, which is worth knowing
    // from a test rather than from a bug report.
    expect(errorOf(response.body).error.details).toEqual({ field: 'conductedBy' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a conductor whose login is no longer active', async () => {
    users[PHARMACIST_ID] = { ...user(PHARMACIST_ID, 'pharmacist'), isActive: false };

    const response = await call('post', '/consultations', ownerToken(), BOOKING);

    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.code).toBe('conductor_inactive');
    expect(errorOf(response.body).error.message).toBe(
      `${PHARMACIST_NAME} cannot hold this consultation: that login is no longer active`
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a meeting link that is not https', async () => {
    const response = await call('post', '/consultations', ownerToken(), {
      ...BOOKING,
      videoUrl: 'http://meet.example/room/9',
    });

    // The scheme rule is the service's and the route deliberately does not repeat
    // it: two implementations of one security rule, checked against different
    // inputs, is how the two come to disagree.
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.code).toBe('validation_failed');
    expect(errorOf(response.body).error.message).toBe('The meeting link must start with https://');
    expect(errorOf(response.body).error.details).toEqual([
      {
        field: 'videoUrl',
        message:
          'Only an https link can be stored, because it is opened from a page served over https',
      },
    ]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a length sent as text, where the same length as a number is fine', async () => {
    const asText = await call('post', '/consultations', ownerToken(), {
      ...BOOKING,
      durationMinutes: '30',
    });
    const asNumber = await call('post', '/consultations', ownerToken(), {
      ...BOOKING,
      durationMinutes: 30,
    });

    expect({ asText: asText.status, asNumber: asNumber.status }).toEqual({
      asText: 400,
      asNumber: 201,
    });
    // `.custom` rather than `.isInt()`, and the difference is not pedantry:
    // express-validator stringifies before handing a value to a standard validator,
    // so `.isInt()` would accept `"30"` and the service would refuse it later with
    // a sentence about whole numbers — the right answer from the wrong layer,
    // after a validator that had said the value was fine.
    expect(errorOf(asText.body).error.details).toEqual([
      {
        field: 'durationMinutes',
        message: 'Enter the length of the consultation as a whole number of minutes',
      },
    ]);
    expect(written().durationMinutes).toBe(30);
  });

  it('refuses a negative length, which the schema would answer with a 500', async () => {
    const response = await call('post', '/consultations', ownerToken(), {
      ...BOOKING,
      durationMinutes: -5,
    });

    // `check (duration_minutes is null or duration_minutes >= 0)` is in the schema,
    // so a negative value that reached the database would come back as a
    // constraint violation and a 500 whose message the error middleware withholds.
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      {
        field: 'durationMinutes',
        message: 'Enter the length of the consultation as a whole number of minutes',
      },
    ]);
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /consultations/:id', () => {
  it('moves the time and leaves four columns nobody mentioned alone', async () => {
    const response = await call('patch', ONE, pharmacistToken(), MOVE);

    expect(response.status).toBe(200);
    // `toStrictEqual`, because the whole claim is about keys that are present and
    // undefined against keys that are present and null: the repository writes
    // `case when $n::boolean` with the flag set from `patch.x !== undefined`, so
    // `undefined` leaves a column alone and `null` clears it. `toEqual` treats the
    // two as equal and would have passed on the defect this route once had.
    expect(patchOf()).toStrictEqual({
      scheduledAt: MOVED_TO,
      conductedBy: undefined,
      durationMinutes: undefined,
      videoUrl: undefined,
      notes: undefined,
      allowedFrom: ['scheduled'],
    });
    // Absent rather than undefined: a reschedule that moved an in-person visit to
    // next week should not have to restate that it is in person.
    expect(patchOf()).not.toHaveProperty('type');
  });

  it('takes the link away on a null, and keeps it on a body that says nothing', async () => {
    await call('patch', ONE, ownerToken(), { ...MOVE, videoUrl: null });
    expect(patchOf().videoUrl).toBeNull();

    updateMock.mockClear();
    await call('patch', ONE, ownerToken(), MOVE);
    expect(patchOf().videoUrl).toBeUndefined();

    updateMock.mockClear();
    await call('patch', ONE, ownerToken(), { ...MOVE, notes: null });
    expect(patchOf().notes).toBeNull();
  });

  it('unassigns a conductor on an explicit null, without looking anybody up', async () => {
    const response = await call('patch', ONE, ownerToken(), { ...MOVE, conductedBy: null });

    expect(response.status).toBe(200);
    expect(patchOf().conductedBy).toBeNull();
    // Legitimate on its own: a pharmacist calling in sick leaves the appointment
    // booked and unheld rather than cancelled, so there is nobody to check. The one
    // lookup is `authenticate` resolving the caller's own token.
    expect(findUserByIdMock).toHaveBeenCalledTimes(1);
    expect(findUserByIdMock).toHaveBeenCalledWith(OWNER_ID);
  });

  it('drops a meeting link when the appointment stops being a video one', async () => {
    await call('patch', ONE, ownerToken(), { ...MOVE, type: 'in_person' });

    // The one place an unmentioned field *is* cleared, and it is a decision about
    // the type rather than about the link: a `coalesce` would keep handing out an
    // address for a meeting that is no longer happening online.
    expect(patchOf().type).toBe('in_person');
    expect(patchOf().videoUrl).toBeNull();
  });

  it('keeps the link when the appointment is still a video one', async () => {
    await call('patch', ONE, ownerToken(), { ...MOVE, type: 'video' });

    expect(patchOf().type).toBe('video');
    expect(patchOf().videoUrl).toBeUndefined();
  });

  it('checks a conductor named here, which is the only route that can move one', async () => {
    const response = await call('patch', ONE, ownerToken(), { ...MOVE, conductedBy: CASHIER_ID });

    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.code).toBe('conductor_not_permitted');
    expect(errorOf(response.body).error.details).toEqual({ field: 'conductedBy' });
    // The refusal comes out of the service before the transaction is opened, so
    // nothing was written and the appointment is still held by whoever held it.
    expect(updateMock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  it('stops the old reminder first, and keeps the new one out of the sweep', async () => {
    updateMock.mockResolvedValue(consultationRow({ scheduledAt: MOVED_TO }));

    const response = await call('patch', ONE, ownerToken(), MOVE);

    expect(response.status).toBe(200);
    expect(supersedeMock).toHaveBeenCalledWith(
      CLIENT,
      PHARMACY,
      CONSULTATION,
      expect.any(String),
      expect.any(String)
    );
    expect(superseded().keepDedupeKey).toBe(`appointment:${CONSULTATION}:${MOVED_TO}`);
    expect(superseded().reason).toBe(
      'The appointment moved to Tuesday, 8 June 2027 at 14:30, so this reminder ' +
        'is for a time that is no longer booked.'
    );
    expect(reminded().dedupeKey).toBe(superseded().keepDedupeKey);

    // Order, and not only presence. Sweeping after scheduling would delete the
    // reminder the same transaction just wrote, because the sweep takes every
    // pending appointment reminder for this consultation except one key — and if
    // that key is not yet in the table, "except one" excepts nothing.
    const swept = supersedeMock.mock.invocationCallOrder[0];
    const raised = scheduleMock.mock.invocationCallOrder[0];
    if (swept === undefined || raised === undefined) {
      throw new Error('expected both a supersede and a schedule');
    }
    expect(swept).toBeLessThan(raised);
  });

  it('moves a slot into the past, supersedes the old reminder and raises nothing', async () => {
    updateMock.mockResolvedValue(consultationRow({ scheduledAt: PAST }));

    const response = await call('patch', ONE, ownerToken(), {
      scheduledAt: '2020-01-01T09:00:00Z',
    });

    expect(response.status).toBe(200);
    expect(superseded().keepDedupeKey).toBe(`appointment:${CONSULTATION}:${PAST}`);
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('refuses to move an appointment that has already ended', async () => {
    findMock.mockResolvedValue(consultationRow({ status: 'completed' }));
    updateMock.mockResolvedValue(null);

    const response = await call('patch', ONE, ownerToken(), MOVE);

    // One that has been completed, cancelled or missed is a record of what
    // happened, and reopening it to change the time would be a way to un-record it.
    expect(response.status).toBe(409);
    expect(errorOf(response.body).error).toEqual({
      message: 'This consultation is completed, so its time can no longer be changed',
      code: 'consultation_not_movable',
      details: { status: 'completed' },
    });
    // The row was found and the guard refused it, so no reminder was touched: the
    // one still pending for a completed appointment is `POST /:id/end`'s business.
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('answers 404 for an appointment this pharmacy does not have', async () => {
    findMock.mockResolvedValue(null);

    const response = await call('patch', ONE, ownerToken(), MOVE);

    expect(response.status).toBe(404);
    expect(errorOf(response.body).error).toEqual({
      message: 'No consultation matches that id',
      code: 'not_found',
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('refuses a patch with no new time, which is not a reschedule', async () => {
    const response = await call('patch', ONE, ownerToken(), { notes: 'Changed.' });

    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      { field: 'scheduledAt', message: 'Enter the date and time of the appointment' },
    ]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('treats the type as optional here, where a booking has to name one', async () => {
    const move = await call('patch', ONE, ownerToken(), MOVE);
    const book = await call('post', '/consultations', ownerToken(), {
      patientId: PATIENT,
      scheduledAt: '2027-06-01T09:00:00Z',
    });

    // The one field whose required-ness differs between the two, and only it: the
    // two must otherwise accept the same fields, or a form that booked an
    // appointment stops working when it edits one.
    expect({ move: move.status, book: book.status }).toEqual({ move: 200, book: 400 });
    expect(errorOf(book.body).error.details).toEqual([
      { field: 'type', message: 'Type must be one of in_person, video, chat, phone' },
    ]);
  });
});

describe('POST /consultations/:id/end', () => {
  /**
   * The three endings, and the sentence each leaves beside the reminders it stops.
   *
   * One route with the status in the body rather than three literal routes, because
   * all three do the same three things — move the row out of `scheduled`, refuse if
   * it already moved, and supersede whatever is still pending — and only the
   * sentence differs. Three routes over one behaviour is three places for the two
   * to drift.
   */
  const ENDINGS: [string, string][] = [
    ['completed', 'The appointment has already taken place.'],
    ['cancelled', 'The appointment was cancelled, so there is nothing to remind about.'],
    ['no_show', 'The appointment was not attended, so there is nothing to remind about.'],
  ];

  it.each(ENDINGS)(
    'marks one %s and supersedes everything still pending for it',
    async (status, reason) => {
      updateMock.mockResolvedValue(
        consultationRow({ status: status as ConsultationRow['status'] })
      );

      const response = await call('post', ONE_END, pharmacistToken(), { status });

      expect(response.status).toBe(200);
      expect(response.body.data.consultation.status).toBe(status);
      expect(patchOf()).toStrictEqual({ status, allowedFrom: ['scheduled'] });

      // The empty string, spelled out rather than imported as `SUPERSEDE_ALL_KEYS`:
      // it is the value that expresses "keep nothing", because every key this
      // system writes begins with `appointment:` or `refill:`, so `dedupe_key <> ''`
      // excludes no row. A reminder that fires after the appointment ended tells a
      // patient to attend something that already happened.
      expect(superseded().keepDedupeKey).toBe('');
      expect(superseded().reason).toBe(reason);
      // Nothing is raised to replace what was swept, and the count swept is not
      // returned to the caller because zero is the normal answer: the reminder
      // usually fired a day before the slot.
      expect(scheduleMock).not.toHaveBeenCalled();
    }
  );

  it('refuses "scheduled", which is not an ending', async () => {
    const response = await call('post', ONE_END, ownerToken(), { status: 'scheduled' });

    expect(response.status).toBe(400);
    // The accepted list is derived from the enum by filtering out `'scheduled'`,
    // not written out: a literal copy would keep accepting three values the day a
    // fourth ending was added, and nothing would fail.
    expect(errorOf(response.body).error.details).toEqual([
      { field: 'status', message: 'Status must be one of completed, cancelled, no_show' },
    ]);
    expect(updateMock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  it('refuses to end an appointment that already ended', async () => {
    findMock.mockResolvedValue(consultationRow({ status: 'cancelled' }));
    updateMock.mockResolvedValue(null);

    const response = await call('post', ONE_END, ownerToken(), { status: 'completed' });

    expect(response.status).toBe(409);
    expect(errorOf(response.body).error).toEqual({
      message: 'This consultation is cancelled, so it cannot be marked completed',
      code: 'consultation_not_movable',
      details: { status: 'cancelled' },
    });
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  it('answers 404 for an appointment this pharmacy does not have', async () => {
    findMock.mockResolvedValue(null);

    const response = await call('post', ONE_END, ownerToken(), { status: 'completed' });

    expect(response.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
  });
});

/**
 * Every way a request to this router can be wrong, swept for the one answer that is
 * never acceptable.
 *
 * `inventory.routes.test.ts` has the same sweep over its bodies and
 * `patients.routes.test.ts` extends it to query and path parameters; this one covers
 * all three plus a `PATCH`, because a router whose filters were just widened and
 * whose patch semantics carry three meanings is a router whose messages are worth
 * re-reading in one pass rather than one chain at a time.
 */
describe('never answers with the validator\'s own "Invalid value"', () => {
  const CASES: { path: string; method: 'get' | 'post' | 'patch'; body?: object }[] = [
    { path: '/consultations?limit=0', method: 'get' },
    { path: '/consultations?limit=201', method: 'get' },
    { path: '/consultations?limit=abc', method: 'get' },
    { path: '/consultations?limit=', method: 'get' },
    { path: '/consultations?offset=-1', method: 'get' },
    { path: '/consultations?offset=abc', method: 'get' },
    { path: '/consultations?offset=', method: 'get' },
    { path: '/consultations?patientId=not-a-uuid', method: 'get' },
    { path: '/consultations?patientId=0', method: 'get' },
    { path: '/consultations?conductedBy=false', method: 'get' },
    { path: '/consultations?status=finished', method: 'get' },
    { path: '/consultations?status=scheduled&status=finished', method: 'get' },
    { path: '/consultations?from=01/03/2027', method: 'get' },
    { path: '/consultations?to=2027-13-45', method: 'get' },
    { path: '/consultations?order=sideways', method: 'get' },
    { path: '/consultations/not-a-uuid', method: 'get' },
    { path: '/consultations', method: 'post', body: {} },
    { path: '/consultations', method: 'post', body: { patientId: PATIENT } },
    {
      path: '/consultations',
      method: 'post',
      body: { type: 'video', scheduledAt: '2027-06-01T09:00:00Z' },
    },
    { path: '/consultations', method: 'post', body: { ...BOOKING, patientId: 'nope' } },
    { path: '/consultations', method: 'post', body: { ...BOOKING, type: 'telepathy' } },
    { path: '/consultations', method: 'post', body: { ...BOOKING, scheduledAt: 'next Tuesday' } },
    { path: '/consultations', method: 'post', body: { ...BOOKING, scheduledAt: '' } },
    { path: '/consultations', method: 'post', body: { ...BOOKING, conductedBy: 'not-a-uuid' } },
    { path: '/consultations', method: 'post', body: { ...BOOKING, durationMinutes: '30' } },
    { path: '/consultations', method: 'post', body: { ...BOOKING, durationMinutes: -5 } },
    { path: '/consultations', method: 'post', body: { ...BOOKING, durationMinutes: 1.5 } },
    { path: '/consultations', method: 'post', body: { ...BOOKING, videoUrl: 42 } },
    { path: '/consultations', method: 'post', body: { ...BOOKING, videoUrl: 'x'.repeat(2049) } },
    { path: '/consultations', method: 'post', body: { ...BOOKING, notes: [] } },
    { path: '/consultations', method: 'post', body: { ...BOOKING, notes: 'n'.repeat(501) } },
    { path: ONE, method: 'patch', body: {} },
    { path: ONE, method: 'patch', body: { scheduledAt: 'tomorrow' } },
    { path: ONE, method: 'patch', body: { scheduledAt: '' } },
    { path: ONE, method: 'patch', body: { ...MOVE, type: 'telepathy' } },
    { path: ONE, method: 'patch', body: { ...MOVE, conductedBy: 'not-a-uuid' } },
    { path: ONE, method: 'patch', body: { ...MOVE, durationMinutes: '30' } },
    { path: ONE, method: 'patch', body: { ...MOVE, notes: 42 } },
    { path: '/consultations/not-a-uuid', method: 'patch', body: MOVE },
    { path: ONE_END, method: 'post', body: {} },
    { path: ONE_END, method: 'post', body: { status: 'scheduled' } },
    { path: ONE_END, method: 'post', body: { status: 'finished' } },
    { path: '/consultations/not-a-uuid/end', method: 'post', body: { status: 'completed' } },
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
    // the work rather than after it. A router that moved the appointment and then
    // complained about a field would answer 400 and still have moved it — and a
    // moved appointment has already had its reminder swept.
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(findMock).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
  });
});
