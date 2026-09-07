jest.mock('../database/pool', () => ({
  poolSql: { query: jest.fn() },
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: jest.fn(),
  withSavepoint: jest.fn(),
  probeDatabase: jest.fn().mockResolvedValue({ ok: true }),
  closePool: jest.fn().mockResolvedValue(undefined),
  getPool: jest.fn(),
}));

jest.mock('../config', () => {
  const actual = jest.requireActual('../config') as typeof import('../config');
  return {
    ...actual,
    config: actual.buildConfig({
      ...process.env,
      // Cleared rather than left to whatever a developer's `backend/.env` happens to
      // hold, for the reason `jest.setup.js` deletes the Paystack keys outright. With
      // a provider configured, `configuredSmsProvider` answers the deliberately
      // unwritten one, and every reminder below is then dealt with as `not sent` for a
      // *different* reason — so the honesty assertions would all still pass while
      // proving something other than what production does today.
      SMS_API_URL: '',
      SMS_API_KEY: '',
    }),
  };
});

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
  // Every export: `createApp` loads the whole route tree, so four other routers import
  // this module, and a mock naming one function hands them `undefined` for the rest —
  // which stays silent until a test that never touches patients fails for a reason
  // nobody can see from its own file.
  countPatients: jest.fn(),
  createPatient: jest.fn(),
  findPatient: jest.fn(),
  listPatients: jest.fn(),
  updatePatient: jest.fn(),
}));

jest.mock('../repositories/notifications.repository', () => ({
  countUnread: jest.fn(),
  listNotifications: jest.fn(),
  markAllRead: jest.fn(),
  markRead: jest.fn(),
  raiseNotification: jest.fn(),
}));

jest.mock('../repositories/reminders.repository', () => ({
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
import {
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
  raiseNotification,
  type NewNotification,
  type NotificationFilters,
  type NotificationRow,
} from '../repositories/notifications.repository';
import { findPatient, type PatientRow } from '../repositories/patients.repository';
import {
  listDueReminders,
  listReminders,
  recordReminderOutcome,
  type ReminderFilters,
  type ReminderRow,
} from '../repositories/reminders.repository';
import { findUserById, type UserRow } from '../repositories/users.repository';
import { DEFAULT_REMINDER_BATCH_LIMIT, reminderNotificationKey } from '../services/reminders.service';
// Not mocked, following `reminders.service.test.ts` and the house rule about modules
// with real branches. `POST /refresh` runs the real batch and the real `deliverSms`,
// so the `not sent` this suite asserts is the one the pharmacy gets today rather than
// one a stub invented.
import { SMS_NOT_CONFIGURED_REASON } from '../services/sms';
import { signAccessToken } from '../utils/jwt';
import type { UserRole } from '../utils/permissions';
import {
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  REMINDER_KINDS,
  type Gender,
} from '../utils/schema-enums';

/**
 * The bell, the dashboard's reminder panel, and the button that runs the scheduler,
 * over HTTP.
 *
 * ## The one permission that is not the others
 *
 * Four of the five routes are `notifications:read`, which counter staff hold. The
 * fifth, `POST /notifications/refresh`, is `notifications:refresh`, which they do not —
 * and the reason is not seniority. Running the batch writes a status onto every
 * reminder it picks up, and `not sent` is a clinical statement that a patient was not
 * told something. Both halves are run for all three roles, because a suite that tested
 * only the refusal would not notice the day `notifications:refresh` was widened, and
 * the failure would arrive as a till that can decide what a patient was told.
 *
 * The refusal is also asserted to have cost nothing. `authorize` runs before the
 * handler, so a refused refresh opens no transaction and selects no reminders; a router
 * that ran the batch and then checked who asked would answer 403 and still have written
 * a `not sent` onto fifty rows.
 *
 * ## `visibleTo` is the caller and not a filter
 *
 * `GET /notifications` is always scoped to the signed-in user, and there is no query
 * parameter that widens it. That is worth a test with the parameter spelled in it,
 * because `notifications.read_at` is a column on the row rather than a join table:
 * "read" is shared, so a scope that could be widened would widen the unread count with
 * it, and an owner asking for the whole pharmacy's bell would see a badge that meant
 * nothing.
 *
 * ## The honesty line, from the wire
 *
 * `reminders.service.test.ts` proves the unsent state honest about the service. What
 * only this file can prove is that it survives the trip out: `status` and
 * `notSentReason` arrive on every row of `GET /notifications/reminders` rather than
 * being summarised, and `POST /notifications/refresh` answers with `sent: 0` visible
 * beside `notSent: 1` instead of a count of reminders processed. A panel that inferred
 * "not delivered" from an empty `sentAt` would be guessing at the one thing the row
 * states.
 *
 * ## An empty cell means three different things on this router
 *
 * On `?type=` and on all six reminder filters, a cleared cell is no filter, which is
 * what `routes/shared.ts`'s `OPTIONAL_QUERY` makes true — and that constant's own
 * documentation says every router importing it has to prove it here. On `?unreadOnly=`
 * a cleared cell is left *unset* rather than settled at `false`, because `false` in a
 * filter object is a claim that somebody asked for the read ones too. And on `?limit=`
 * a cleared cell is a refusal, because `pagination` uses a bare `.optional()`. All
 * three are pinned, in the same suite, because they look like one rule and are not.
 */

const app = createApp();

const withTransactionMock = withTransaction as jest.Mock;
const findUserByIdMock = findUserById as jest.Mock;
const findPatientMock = findPatient as jest.Mock;
const listMock = listNotifications as jest.Mock;
const countMock = countUnread as jest.Mock;
const readMock = markRead as jest.Mock;
const readAllMock = markAllRead as jest.Mock;
const raiseMock = raiseNotification as jest.Mock;
const listRemindersMock = listReminders as jest.Mock;
const listDueMock = listDueReminders as jest.Mock;
const recordOutcomeMock = recordReminderOutcome as jest.Mock;

/**
 * One client for the whole suite, handed to whatever work a transaction is given.
 *
 * Without this, `withTransaction` resolves `undefined` and the refresh batch calls
 * `findPatient` with nothing — which reads as a patient who has gone, and answers with
 * a `not sent` reason nobody asked for. A wrong reason from a missing test double is
 * indistinguishable from a wrong reason from a broken batch.
 */
const CLIENT = { query: jest.fn() } as unknown as PoolClient;

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'a0000000-0000-4000-8000-000000000002';
const PHARMACIST_ID = 'a0000000-0000-4000-8000-000000000003';
const CASHIER_ID = 'a0000000-0000-4000-8000-000000000004';
const PATIENT = 'a0000000-0000-4000-8000-000000000040';
const NOTIFICATION = 'a0000000-0000-4000-8000-0000000000d2';
const REMINDER = 'a0000000-0000-4000-8000-0000000000c1';

const STORED_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpMbS0nVBM7iFtXJGvYxQmC5nqJZS';
const CASHIER_NAME = 'Kofi Mensah';
const PHARMACIST_NAME = 'Dr Ama Boateng';
const PATIENT_NAME = 'Ama Mensah';

/** A Ghana mobile in the spelling the counter would type it. */
const PHONE = '024 123 4567';

/** The text a patient would have been sent, and therefore the text the bell shows. */
const MESSAGE = 'Your blood pressure script is due for a refill.';

const DUE_AT = '2026-09-05T08:30:00.000Z';
const READ_AT = '2026-09-05T09:30:00.000Z';

/**
 * An instant, matched rather than pinned.
 *
 * `utils/clock` is deliberately not mocked in this suite: the routes read a real clock
 * and a real one is what makes "stamped with the request instant" a claim about the
 * application rather than about a spy. The shape is asserted because an instant that
 * stopped being ISO 8601 would sort wrongly against every other table's.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A badge number deliberately different from the length of the list, so a bell that
 * reported `notifications.length` instead of the count would fail rather than
 * coincidentally agree.
 */
const UNREAD = 7;

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

function tokenFor(id: string, role: UserRole): string {
  return signAccessToken({ userId: id, pharmacyId: PHARMACY, role, sessionVersion: 2 });
}

const ownerToken = (): string => tokenFor(OWNER_ID, 'pharmacy_owner');
const pharmacistToken = (): string => tokenFor(PHARMACIST_ID, 'pharmacist');
const cashierToken = (): string => tokenFor(CASHIER_ID, 'staff');

/**
 * All three, because this router refuses one of them on one of its five routes and
 * answers all three on the other four — which is only visible if all three are run.
 */
const EVERY_ROLE: [UserRole, () => string][] = [
  ['pharmacy_owner', ownerToken],
  ['pharmacist', pharmacistToken],
  ['staff', cashierToken],
];

/**
 * Complete rows rather than partial ones cast to the interface: if any of the three
 * grows a required field this file stops compiling, instead of quietly feeding the
 * application a row no database would ever return.
 *
 * The bell entry's default is the row production holds today — `not_sent`, with the
 * reason beside it and no `sentAt` — because that is the state the acceptance criterion
 * is about.
 */
function notificationRow(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: NOTIFICATION,
    pharmacyId: PHARMACY,
    // Null is how the table spells a broadcast, and a patient reminder is one: it is
    // not the property of whoever happened to open the bell first.
    userId: null,
    type: 'refill_reminder',
    status: 'not_sent',
    title: `Refill reminder — ${PATIENT_NAME}`,
    body: MESSAGE,
    relatedType: 'reminder',
    relatedId: REMINDER,
    dedupeKey: `reminder:${REMINDER}`,
    notSentReason: SMS_NOT_CONFIGURED_REASON,
    sentAt: null,
    readAt: null,
    createdAt: DUE_AT,
    updatedAt: DUE_AT,
    ...overrides,
  };
}

function reminderRow(overrides: Partial<ReminderRow> = {}): ReminderRow {
  return {
    id: REMINDER,
    pharmacyId: PHARMACY,
    patientId: PATIENT,
    kind: 'refill',
    dueAt: DUE_AT,
    message: MESSAGE,
    status: 'pending',
    notSentReason: null,
    notificationId: null,
    dedupeKey: `refill:${REMINDER}`,
    createdAt: '2026-08-22T09:15:00.000Z',
    updatedAt: '2026-08-22T09:15:00.000Z',
    ...overrides,
  };
}

function patientRow(overrides: Partial<PatientRow> = {}): PatientRow {
  const gender: Gender | null = 'female';
  return {
    id: PATIENT,
    pharmacyId: PHARMACY,
    fullName: PATIENT_NAME,
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

/**
 * The five paths, as constants.
 *
 * Not for brevity, though it helps: a path built inline in thirty places is a path that
 * can be built slightly differently in one of them, and a test that hits the wrong url
 * fails with a 404 that reads like a broken route.
 */
const BELL = '/notifications';
const REMINDERS = '/notifications/reminders';
const READ_ALL = '/notifications/read-all';
const REFRESH = '/notifications/refresh';
const ONE_READ = `/notifications/${NOTIFICATION}/read`;

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
   * `unknown` rather than the field-error array, because three shapes arrive here and
   * all are correct: a list of `{ field, message }` from validation and `{ missing }`
   * from `authorize`. Typing it as one would make the other a cast, and a cast in a
   * test is an assertion nobody checks.
   */
  error: { message: string; code?: string; details?: unknown };
}

function errorOf(body: unknown): ErrorBody {
  return body as ErrorBody;
}

/**
 * The filters the bell handed to the repository.
 *
 * Indexed, because two tests below send a cleared filter and a filled one in the same
 * test — the claim is about the contrast, and a contrast needs both halves in one
 * place. Reading call zero for the second half asserts the first request twice and
 * passes whatever the route does with the second.
 */
function bellFiltersOf(index = 0): NotificationFilters {
  const first = listMock.mock.calls[index];
  if (first === undefined) throw new Error(`listNotifications was never called for ${index}`);
  return (first as unknown[])[2] as NotificationFilters;
}

/** As above, for the dashboard's reminder panel. */
function reminderFiltersOf(index = 0): ReminderFilters {
  const first = listRemindersMock.mock.calls[index];
  if (first === undefined) throw new Error(`listReminders was never called for ${index}`);
  return (first as unknown[])[2] as ReminderFilters;
}

/** The bell entry the refresh batch asked to be raised. */
function raised(): NewNotification {
  const first = raiseMock.mock.calls[0];
  if (first === undefined) throw new Error('raiseNotification was never called');
  return (first as unknown[])[1] as NewNotification;
}

/**
 * One full batch, so "the batch came back full" can be expressed as the limit rather
 * than as the literal 50.
 *
 * The ids are generated rather than reused because a batch of fifty rows sharing one id
 * is not a batch, and a test built on it would still pass while proving nothing about
 * the count.
 */
function batchOf(size: number): ReminderRow[] {
  return Array.from({ length: size }, (_, index) =>
    reminderRow({ id: `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}` })
  );
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
  listMock.mockResolvedValue([notificationRow()]);
  countMock.mockResolvedValue(UNREAD);
  readMock.mockResolvedValue(notificationRow({ readAt: READ_AT, updatedAt: READ_AT }));
  readAllMock.mockResolvedValue(3);
  listRemindersMock.mockResolvedValue([
    reminderRow({ status: 'not_sent', notSentReason: SMS_NOT_CONFIGURED_REASON }),
  ]);
  // An empty batch by default, so the four routes that are not the refresh cannot
  // reach the delivery path by accident and a test that wants a batch has to ask.
  listDueMock.mockResolvedValue([]);
  findPatientMock.mockResolvedValue(patientRow());
  raiseMock.mockResolvedValue({ raised: true, notification: notificationRow() });
  recordOutcomeMock.mockResolvedValue(
    reminderRow({ status: 'not_sent', notSentReason: SMS_NOT_CONFIGURED_REASON })
  );
});

describe('who may use this router', () => {
  it('answers every role on the four reads, and refuses counter staff on the refresh', async () => {
    for (const [role, token] of EVERY_ROLE) {
      const bell = await call('get', BELL, token());
      const reminders = await call('get', REMINDERS, token());
      const one = await call('get', `${BELL}?unreadOnly=true`, token());
      const readAll = await call('post', READ_ALL, token());
      const read = await call('post', ONE_READ, token());
      const refresh = await call('post', REFRESH, token());

      // Pinned as one object per role, so a failure names the role and the route
      // together rather than leaving six assertions to be counted by hand.
      expect({
        role,
        bell: bell.status,
        reminders: reminders.status,
        unreadOnly: one.status,
        readAll: readAll.status,
        readOne: read.status,
        refresh: refresh.status,
      }).toEqual({
        role,
        bell: 200,
        reminders: 200,
        unreadOnly: 200,
        readAll: 200,
        readOne: 200,
        // The one route counter staff cannot use, and the only one that writes a
        // statement about what a patient was told.
        refresh: role === 'staff' ? 403 : 200,
      });
    }
  });

  it('names the permission the refresh refused, and runs no batch behind the refusal', async () => {
    const response = await call('post', REFRESH, cashierToken());
    const body = errorOf(response.body);

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).toBe('Your role does not permit this action');
    // The permission, not the route: naming it is what tells a pharmacist this is a
    // role question rather than a broken button.
    expect(body.error.details).toEqual({ missing: ['notifications:refresh'] });

    // `authorize` runs before the handler, so a refusal here cost nothing. A router
    // that ran the batch and then checked who asked would answer 403 and still have
    // written `not sent` onto every reminder it picked up.
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(listDueMock).not.toHaveBeenCalled();
    expect(findPatientMock).not.toHaveBeenCalled();
    expect(recordOutcomeMock).not.toHaveBeenCalled();
    expect(raiseMock).not.toHaveBeenCalled();
  });
});

describe('GET /notifications', () => {
  it('lists the bell with the badge beside it, and the types a filter can be built from', async () => {
    const response = await call('get', BELL, ownerToken());

    expect(response.status).toBe(200);
    // One body, asserted whole. `unread` is 7 over a list of one row on purpose: a
    // badge taken from `notifications.length` would read 1, and the two numbers have
    // to be able to disagree for the count to mean anything.
    expect(response.body).toEqual({
      success: true,
      data: {
        notifications: [notificationRow()],
        unread: UNREAD,
        limit: 50,
        offset: 0,
        // The enum travels with the list, so a filter is built from the values the
        // backend will accept rather than from a second copy of them in the frontend.
        types: [...NOTIFICATION_TYPES],
      },
    });
    expect(countMock).toHaveBeenCalledWith(poolSql, PHARMACY, OWNER_ID);
  });

  it('scopes the bell to the caller, and takes no visibleTo from the query string', async () => {
    // Spelled as a real uuid belonging to a real member of staff, so this fails as a
    // widening rather than as a cast error if the parameter ever becomes one.
    const response = await call(
      'get',
      `${BELL}?visibleTo=${CASHIER_ID}&userId=${CASHIER_ID}`,
      ownerToken()
    );

    expect(response.status).toBe(200);
    expect(bellFiltersOf().visibleTo).toBe(OWNER_ID);
    expect(countMock).toHaveBeenCalledWith(poolSql, PHARMACY, OWNER_ID);
  });

  it('treats a cleared filter cell as no filter, on both of them at once', async () => {
    const response = await call('get', `${BELL}?type=&unreadOnly=`, pharmacistToken());

    expect(response.status).toBe(200);
    // `toStrictEqual`, and `unreadOnly: undefined` written out rather than left off the
    // expected object. The key is present with no value, which `toStrictEqual` treats
    // as different from an absent key and `toEqual` does not — so this pins what the
    // route actually builds instead of the near-miss.
    expect(bellFiltersOf()).toStrictEqual({
      types: [],
      visibleTo: PHARMACIST_ID,
      unreadOnly: undefined,
      limit: 50,
      offset: 0,
    });
    // The claim the route's own comment makes is that a cleared cell does not become
    // `false`, and `undefined` is how it says so. `notifications.repository.ts` reads
    // `filters.unreadOnly === true`, so unset and absent are one behaviour there — but
    // a settled `false` would be a claim that somebody asked for the read ones too.
    expect(bellFiltersOf().unreadOnly).toBeUndefined();
  });

  it('reads the five ways a checkbox gets spelled as one yes, and a no as a settled no', async () => {
    // `on` is not a curiosity: it is what an HTML checkbox serialises to when nobody
    // set a `value` on it, so the spelling most likely to arrive from a form is among
    // the ones `.isBoolean()` would have refused. `routes/shared.ts` declines the
    // library validator for exactly this reason and runs the coercer instead.
    //
    // Indexed per iteration rather than reading call zero each time. `clearMocks` runs
    // between tests and not between loop iterations, so an unindexed helper asserts the
    // first request five times and passes whatever the other four spellings do — which
    // is how this test came to be red, and is the failure `bellFiltersOf`'s own comment
    // was written to prevent.
    const YES = ['true', 'yes', 'y', 'on', '1'];
    for (const [index, written] of YES.entries()) {
      await call('get', `${BELL}?unreadOnly=${written}`, pharmacistToken());
      expect({ written, unreadOnly: bellFiltersOf(index).unreadOnly }).toEqual({
        written,
        unreadOnly: true,
      });
    }

    await call('get', `${BELL}?unreadOnly=off`, pharmacistToken());
    // A `false` that was asked for, which is not the same as the unset key above.
    expect(bellFiltersOf(YES.length).unreadOnly).toBe(false);
  });

  it('passes a repeated type filter through as one array', async () => {
    const response = await call(
      'get',
      `${BELL}?type=stock_expiry&type=product_recall`,
      pharmacistToken()
    );

    expect(response.status).toBe(200);
    expect(bellFiltersOf().types).toEqual(['stock_expiry', 'product_recall']);
  });

  it('refuses a type that is not in the enum, and names the field', async () => {
    const response = await call('get', `${BELL}?type=stock_alert`, ownerToken());
    const body = errorOf(response.body);

    expect(response.status).toBe(400);
    expect(body.error.details).toEqual([
      {
        field: 'type',
        message: `Type must be one of ${NOTIFICATION_TYPES.join(', ')}`,
      },
    ]);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('refuses one bad type in a list of good ones, rather than dropping it', async () => {
    const response = await call(
      'get',
      `${BELL}?type=stock_expiry&type=stock_alert`,
      ownerToken()
    );

    // Dropping the unknown value would answer with a narrower list than was asked for,
    // and a panel showing only expiry alerts reads as a pharmacy with no recalls.
    expect(response.status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('refuses a cleared limit where it accepts a cleared type, on the same query string', async () => {
    // The asymmetry `routes/shared.ts` documents: `pagination` uses a bare
    // `.optional()`, which skips `undefined` and `null` but not `''`, so `?limit=`
    // reaches `isInt` and fails. Widening it would mean a page size of "whatever the
    // empty string casts to".
    const cleared = await call('get', `${BELL}?limit=`, pharmacistToken());
    const absent = await call('get', `${BELL}?type=`, pharmacistToken());

    expect(cleared.status).toBe(400);
    expect(errorOf(cleared.body).error.details).toEqual([
      { field: 'limit', message: 'limit must be between 1 and 200' },
    ]);
    expect(absent.status).toBe(200);
  });

  it('refuses a yes/no filter it cannot read, in the same words the reader would use', async () => {
    const response = await call('get', `${BELL}?unreadOnly=maybe`, pharmacistToken());

    expect(response.status).toBe(400);
    // One sentence for one input, whichever layer produced it: `booleanQuery` runs the
    // coercer and takes the chain's message from the same `label` the handler passes to
    // `toBoolean`, so the validator and the reader cannot word the field differently.
    expect(errorOf(response.body).error.details).toEqual([
      { field: 'unreadOnly', message: 'Enter the unread filter as yes or no' },
    ]);
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe('POST /notifications/:id/read', () => {
  it('marks one read at the request instant and returns the row as the table now holds it', async () => {
    const response = await call('post', ONE_READ, pharmacistToken());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: { notification: notificationRow({ readAt: READ_AT, updatedAt: READ_AT }) },
    });
    // The stamp is an argument rather than `now()` in the statement, so it agrees with
    // everything else written in the same request — which is what makes a timeline
    // assembled from several tables sortable.
    expect(readMock).toHaveBeenCalledWith(
      poolSql,
      PHARMACY,
      PHARMACIST_ID,
      NOTIFICATION,
      expect.stringMatching(ISO_INSTANT)
    );
  });

  it('answers 404 for a row that is not there, in the same words as one that is not theirs', async () => {
    readMock.mockResolvedValue(null);

    const response = await call('post', ONE_READ, cashierToken());
    const body = errorOf(response.body);

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('No notification matches that id');
    // A null is either a row that does not exist or one aimed at a different member of
    // staff. Telling them apart would be a way to enumerate whose notifications exist,
    // so the answer carries nothing beside the sentence.
    expect(body.error.details).toBeUndefined();
  });

  it('refuses an id that is not a uuid before it reaches the service', async () => {
    const response = await call('post', '/notifications/not-a-uuid/read', ownerToken());

    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      { field: 'id', message: 'That is not a valid notification id' },
    ]);
    expect(readMock).not.toHaveBeenCalled();
  });
});

describe('POST /notifications/read-all', () => {
  it('reports how many this click read, and zero on the next one', async () => {
    readAllMock.mockResolvedValue(4);
    const first = await call('post', READ_ALL, pharmacistToken());
    expect(first.body).toEqual({ success: true, data: { read: 4 } });

    // Zero on the second click, because `markAllRead` is scoped to `read_at is null`.
    // Reporting the total instead would say four more rows had been cleared.
    readAllMock.mockResolvedValue(0);
    const second = await call('post', READ_ALL, pharmacistToken());
    expect(second.body).toEqual({ success: true, data: { read: 0 } });

    expect(readAllMock).toHaveBeenLastCalledWith(
      poolSql,
      PHARMACY,
      PHARMACIST_ID,
      expect.stringMatching(ISO_INSTANT)
    );
  });

  it('reads no body, so a malformed one cannot reach anything', async () => {
    // There is no `runValidation` on this route and nothing for it to validate: the
    // caller is the token and the instant is the clock. A body is not read, so a
    // nonsense one is not a 400 — and pinning that stops a validator being added here
    // later on the grounds that every other route has one.
    const response = await call('post', READ_ALL, ownerToken(), { nonsense: true, limit: 'x' });

    expect(response.status).toBe(200);
    expect(readAllMock).toHaveBeenCalledWith(
      poolSql,
      PHARMACY,
      OWNER_ID,
      expect.stringMatching(ISO_INSTANT)
    );
  });
});

describe('GET /notifications/reminders', () => {
  it('lists the reminders with the reason beside every unsent one, and the kinds a filter can be built from', async () => {
    const stored = reminderRow({
      status: 'not_sent',
      notSentReason: SMS_NOT_CONFIGURED_REASON,
      notificationId: NOTIFICATION,
    });
    listRemindersMock.mockResolvedValue([stored]);

    const response = await call('get', REMINDERS, pharmacistToken());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: { reminders: [stored], limit: 50, offset: 0, kinds: [...REMINDER_KINDS] },
    });
    // The acceptance criterion, on the wire rather than in a service: the row says it
    // was not sent *and says why*, and nothing on the way out summarised it into a
    // count or left a panel to infer it from an empty `sentAt`.
    const [first] = response.body.data.reminders as ReminderRow[];
    expect(first?.status).toBe('not_sent');
    expect(first?.notSentReason).toBe(SMS_NOT_CONFIGURED_REASON);
  });

  it('treats a cleared filter cell as no filter, on all six of them at once', async () => {
    const response = await call(
      'get',
      `${REMINDERS}?patientId=&kind=&status=&from=&to=&order=`,
      pharmacistToken()
    );

    expect(response.status).toBe(200);
    // `toStrictEqual`, because the claim about `order` is that the key is absent rather
    // than null — the default ordering belongs to the repository that owns the two
    // orderings, and a route that sent `'upcoming'` would be a second place stating it.
    expect(reminderFiltersOf()).toStrictEqual({
      patientId: null,
      kinds: [],
      statuses: [],
      from: null,
      to: null,
      limit: 50,
      offset: 0,
    });
    expect(reminderFiltersOf()).not.toHaveProperty('order');
  });

  it('still refuses a value that is not an id, so the widening opened no uuid cast', async () => {
    for (const value of ['0', 'false', 'not-a-uuid']) {
      const response = await call('get', `${REMINDERS}?patientId=${value}`, ownerToken());
      const body = errorOf(response.body);
      expect({ value, status: response.status, details: body.error.details }).toEqual({
        value,
        status: 400,
        details: [{ field: 'patientId', message: 'That is not a valid patient id' }],
      });
    }
    expect(listRemindersMock).not.toHaveBeenCalled();
  });

  it('refuses a notification type offered as a reminder kind, which is the easy confusion', async () => {
    // `refill_reminder` is a member of `notification_type` and not of `reminder_kind`,
    // and the two enums are one word apart. Both go into a `::…[]` cast, so the wrong
    // one accepted here is a 500 on every request rather than a message.
    const response = await call('get', `${REMINDERS}?kind=refill_reminder`, pharmacistToken());

    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      { field: 'kind', message: `Kind must be one of ${REMINDER_KINDS.join(', ')}` },
    ]);
    expect(listRemindersMock).not.toHaveBeenCalled();
  });

  it('refuses a status that is not in the enum, and sends an ordering through only when one was asked for', async () => {
    const refused = await call('get', `${REMINDERS}?status=delivered`, ownerToken());
    expect(refused.status).toBe(400);
    expect(errorOf(refused.body).error.details).toEqual([
      { field: 'status', message: `Status must be one of ${NOTIFICATION_STATUSES.join(', ')}` },
    ]);

    await call('get', `${REMINDERS}?order=recent`, pharmacistToken());
    expect(reminderFiltersOf().order).toBe('recent');

    await call('get', REMINDERS, pharmacistToken());
    expect(reminderFiltersOf(1)).not.toHaveProperty('order');
  });
});

describe('POST /notifications/refresh', () => {
  it('reports a batch in which nothing was sent as nothing sent, with the reason beside it', async () => {
    listDueMock.mockResolvedValue([reminderRow()]);

    const response = await call('post', REFRESH, pharmacistToken());

    expect(response.status).toBe(200);
    // `sent: 0` beside `notSent: 1`, both visible. Collapsing these into "processed 1
    // reminder" is the specific sentence an operator would believe and a patient would
    // not, and it is a collapse this route could perform on the way out.
    expect(response.body.data).toEqual({
      summary: {
        now: expect.stringMatching(ISO_INSTANT),
        due: 1,
        sent: 0,
        notSent: 1,
        failed: 0,
        alreadyDealt: 0,
      },
      moreDue: false,
    });

    // The bell entry the batch raised carries the same two facts, so the panel and the
    // summary cannot drift into calling one thing by two names.
    expect(raised()).toEqual(
      expect.objectContaining({
        userId: null,
        type: 'refill_reminder',
        status: 'not_sent',
        notSentReason: SMS_NOT_CONFIGURED_REASON,
        sentAt: null,
        body: MESSAGE,
        relatedType: 'reminder',
        relatedId: REMINDER,
        // One reminder, one bell entry, ever — the key `notifications.dedupe_key`
        // enforces, built by the module that owns that shape.
        dedupeKey: reminderNotificationKey(REMINDER),
      })
    );

    // And the reminder row is written back with the outcome and the guard both, so a
    // second run finds nothing pending and re-raises nothing.
    expect(recordOutcomeMock).toHaveBeenCalledWith(
      CLIENT,
      PHARMACY,
      REMINDER,
      {
        status: 'not_sent',
        notSentReason: SMS_NOT_CONFIGURED_REASON,
        notificationId: NOTIFICATION,
      },
      ['pending']
    );
    // Inside the transaction, which is what makes the summary a true description of
    // what landed rather than of what was attempted before something threw.
    expect(findPatientMock).toHaveBeenCalledWith(CLIENT, PHARMACY, PATIENT);
  });

  it('says there may be more only when the batch came back full', async () => {
    listDueMock.mockResolvedValue(batchOf(DEFAULT_REMINDER_BATCH_LIMIT));
    const full = await call('post', REFRESH, ownerToken());

    // One pass rather than a drain, because this is an HTTP request and a request has
    // to return. `moreDue` is what stops a full batch reading as a finished one: the
    // caller can press the button again, and the quarter-hourly cron picks the
    // remainder up whatever anybody does.
    expect(full.body.data.summary.due).toBe(DEFAULT_REMINDER_BATCH_LIMIT);
    expect(full.body.data.moreDue).toBe(true);

    listDueMock.mockResolvedValue(batchOf(DEFAULT_REMINDER_BATCH_LIMIT - 1));
    const short = await call('post', REFRESH, ownerToken());

    expect(short.body.data.summary.due).toBe(DEFAULT_REMINDER_BATCH_LIMIT - 1);
    expect(short.body.data.moreDue).toBe(false);
  });

  it('reports an empty batch as an empty batch rather than as a failure', async () => {
    const response = await call('post', REFRESH, ownerToken());

    // Nothing due is a normal answer and not an error, so the button can be pressed on
    // a quiet afternoon without anybody wondering whether it worked.
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      summary: {
        now: expect.stringMatching(ISO_INSTANT),
        due: 0,
        sent: 0,
        notSent: 0,
        failed: 0,
        alreadyDealt: 0,
      },
      moreDue: false,
    });
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
    expect(findPatientMock).not.toHaveBeenCalled();
  });
});

/**
 * Every way a request to this router can be wrong, swept for the one answer that is
 * never acceptable.
 *
 * `prescriptions.routes.test.ts` and `consultations.routes.test.ts` have the same
 * sweep. This one covers two read routes with eleven filters between them and one path
 * parameter, because a router whose filters are all `OPTIONAL_QUERY` is a router where
 * a message silently missing from one chain is easy to add and easy to miss.
 */
describe('never answers with the validator\'s own "Invalid value"', () => {
  const CASES: { path: string; method: 'get' | 'post'; body?: object }[] = [
    { path: `${BELL}?limit=0`, method: 'get' },
    { path: `${BELL}?limit=201`, method: 'get' },
    { path: `${BELL}?limit=abc`, method: 'get' },
    { path: `${BELL}?limit=`, method: 'get' },
    { path: `${BELL}?offset=-1`, method: 'get' },
    { path: `${BELL}?offset=abc`, method: 'get' },
    { path: `${BELL}?offset=`, method: 'get' },
    { path: `${BELL}?type=stock_alert`, method: 'get' },
    { path: `${BELL}?type=stock_expiry&type=stock_alert`, method: 'get' },
    { path: `${BELL}?unreadOnly=maybe`, method: 'get' },
    { path: `${BELL}?unreadOnly=2`, method: 'get' },
    { path: '/notifications/not-a-uuid/read', method: 'post' },
    { path: `${REMINDERS}?limit=0`, method: 'get' },
    { path: `${REMINDERS}?limit=`, method: 'get' },
    { path: `${REMINDERS}?offset=`, method: 'get' },
    { path: `${REMINDERS}?patientId=not-a-uuid`, method: 'get' },
    { path: `${REMINDERS}?patientId=0`, method: 'get' },
    { path: `${REMINDERS}?kind=refill_reminder`, method: 'get' },
    { path: `${REMINDERS}?kind=refill&kind=dispensing`, method: 'get' },
    { path: `${REMINDERS}?status=delivered`, method: 'get' },
    { path: `${REMINDERS}?from=01/03/2027`, method: 'get' },
    { path: `${REMINDERS}?to=2027-13-45`, method: 'get' },
    { path: `${REMINDERS}?order=sideways`, method: 'get' },
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
    // The sweep above proves the messages; this proves the refusals happened before the
    // work rather than after it. A router that ran the refresh batch and then
    // complained about a query parameter would answer 400 and still have written a
    // `not sent` onto every reminder it picked up.
    expect(listMock).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
    expect(readMock).not.toHaveBeenCalled();
    expect(readAllMock).not.toHaveBeenCalled();
    expect(listRemindersMock).not.toHaveBeenCalled();
    expect(listDueMock).not.toHaveBeenCalled();
    expect(raiseMock).not.toHaveBeenCalled();
    expect(recordOutcomeMock).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});
