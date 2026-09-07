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

jest.mock('../repositories/prescriptions.repository', () => ({
  countPrescriptions: jest.fn(),
  createPrescription: jest.fn(),
  findPrescription: jest.fn(),
  listPrescriptions: jest.fn(),
  updatePrescription: jest.fn(),
}));

jest.mock('../repositories/reminders.repository', () => ({
  // Every export, not only the two this router's services call. `createApp` loads the
  // whole route tree, so `notifications.routes.ts` imports this module too, and a mock
  // naming two functions hands it `undefined` for the other five — which stays silent
  // until a test that never touches reminders fails for a reason nobody can see from
  // its own file.
  scheduleReminder: jest.fn(),
  findReminder: jest.fn(),
  listDueReminders: jest.fn(),
  listReminders: jest.fn(),
  recordReminderOutcome: jest.fn(),
  supersedeAppointmentReminders: jest.fn(),
  supersedeRefillReminder: jest.fn(),
}));

jest.mock('../repositories/sales.repository', () => ({
  // Every export for the same reason, and this module has more of them than any other
  // in the tree: `sales.routes.ts`, `pos.routes.ts` and the Paystack webhook all import
  // it, so a partial mock here would be a partial mock of the whole application.
  nextSaleNumber: jest.fn(),
  insertSale: jest.fn(),
  insertSaleItem: jest.fn(),
  insertSaleItemBatch: jest.fn(),
  insertSalePayment: jest.fn(),
  findSaleById: jest.fn(),
  findSaleByClientSaleId: jest.fn(),
  patientExists: jest.fn(),
  lockSale: jest.fn(),
  listSaleItems: jest.fn(),
  listSaleItemBatches: jest.fn(),
  listSalePayments: jest.fn(),
  listSales: jest.fn(),
  updateSaleSettlement: jest.fn(),
  markSaleVoided: jest.fn(),
  findSalePayment: jest.fn(),
  findSalePaymentByReference: jest.fn(),
  updateSalePaymentStatus: jest.fn(),
}));

import request from 'supertest';
import type { PoolClient } from 'pg';
import { createApp } from '../app';
import { withTransaction } from '../database/pool';
import { findPatient } from '../repositories/patients.repository';
import {
  countPrescriptions,
  createPrescription,
  findPrescription,
  listPrescriptions,
  updatePrescription,
  type NewPrescription,
  type PrescriptionFilters,
  type PrescriptionPatch,
  type PrescriptionRow,
} from '../repositories/prescriptions.repository';
import {
  scheduleReminder,
  supersedeRefillReminder,
  type NewReminder,
} from '../repositories/reminders.repository';
import { findSaleById } from '../repositories/sales.repository';
import {
  COLLECTED_REASON,
  NOT_SUPPLYING_REASON,
  PRESCRIPTION_LIMITS,
  REATTACHED_REASON,
  REFILL_REMINDER_LEAD_MS,
  refillReminderMessage,
} from '../services/prescriptions.service';
import { findUserById, type UserRow } from '../repositories/users.repository';
import { signAccessToken } from '../utils/jwt';
import type { UserRole } from '../utils/permissions';
import { refillReminderKey } from '../utils/reminder-keys';
import { PRESCRIPTION_STATUSES } from '../utils/schema-enums';

/**
 * The prescription queue, over HTTP.
 *
 * ## The split this router exists to prove
 *
 * Recording is `patients:write` and deciding is `prescriptions:approve`, and counter
 * staff hold the first and not the second. That is the opposite of
 * `consultations.routes.ts`, where staff can neither book nor end an appointment, and
 * the difference is the point: writing down that a script was handed across the
 * counter is the same kind of act as noting an allergy, while approving one is a
 * clinical decision with a signature on it.
 *
 * Both halves are run for all three roles. A suite that tested only the refusal would
 * not notice the day somebody widened `patients:write`, and the failure would arrive
 * as a dispensary queue that starts at the till.
 *
 * ## The limit the form validates against is the one the reminder can carry
 *
 * `prescriberName`'s maximum is derived from the two GSM segments a body may cost, so
 * the longest name this router accepts is exactly the longest name
 * `refillReminderMessage` can put in a text. It was 200 and the message ran to 326,
 * which meant a script could be written down at the counter and the failure would
 * arrive later — a 500 thrown inside the approval transaction, so the prescription
 * stayed `pending` with nothing on screen to explain why. Both sides of the boundary
 * are pinned here, from the wire, because that is where the two ends have to meet.
 *
 * ## Absent, null and a value, on one body
 *
 * `PATCH /prescriptions/:id` reads the four fields one at a time rather than casting
 * over the body, because `null` clears a column and `undefined` leaves it alone. A
 * cast that turned an absent key into a null one would detach a patient nobody asked
 * it to — and detaching a patient also supersedes their collection reminder, so the
 * cost of getting this wrong is a patient who stops being told their medicine is ready.
 *
 * ## An empty cell means two different things on one route
 *
 * On `GET /prescriptions` a cleared filter is no filter, which is what
 * `routes/shared.ts`'s `OPTIONAL_QUERY` makes true — and that constant's own
 * documentation says every router importing it has to prove it here. `limit` and
 * `offset` are the exception on the same route and in the same query string:
 * `pagination` uses a bare `.optional()`, so `?limit=` is a 400 while `?patientId=` is
 * not. Both are pinned.
 */

const app = createApp();

const createMock = createPrescription as jest.Mock;
const findMock = findPrescription as jest.Mock;
const listMock = listPrescriptions as jest.Mock;
const countMock = countPrescriptions as jest.Mock;
const updateMock = updatePrescription as jest.Mock;
const findPatientMock = findPatient as jest.Mock;
const findSaleByIdMock = findSaleById as jest.Mock;
const findUserByIdMock = findUserById as jest.Mock;
const scheduleMock = scheduleReminder as jest.Mock;
const supersedeMock = supersedeRefillReminder as jest.Mock;
const withTransactionMock = withTransaction as jest.Mock;

/**
 * One client for the whole suite, handed to whatever work a transaction is given.
 *
 * Without this, `withTransaction` resolves `undefined` and the service's patient and
 * sale lookups are called with nothing — which reads as a missing row and answers 404
 * from a route that was never reached. A 404 from a missing test double is
 * indistinguishable from a 404 from a broken route.
 */
const CLIENT = { query: jest.fn() } as unknown as PoolClient;

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'a0000000-0000-4000-8000-000000000002';
const PHARMACIST_ID = 'a0000000-0000-4000-8000-000000000003';
const CASHIER_ID = 'a0000000-0000-4000-8000-000000000004';
const PATIENT = 'a0000000-0000-4000-8000-000000000040';
const PRESCRIPTION = 'a0000000-0000-4000-8000-000000000080';
const SALE = 'a0000000-0000-4000-8000-000000000090';

const PRESCRIBER = 'Dr Kwame Antwi';
const STORED_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpMbS0nVBM7iFtXJGvYxQmC5nqJZS';
const CASHIER_NAME = 'Kofi Mensah';
const PHARMACIST_NAME = 'Dr Ama Boateng';

/**
 * A badge number deliberately different from the length of the list, so a page that
 * reported `prescriptions.length` instead of the count would fail rather than
 * coincidentally agree.
 */
const TOTAL = 3;

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
 * All three, because this router refuses one of them on four of its seven routes and
 * answers all three on the other three — which is only visible if all three are run.
 */
const EVERY_ROLE: [UserRole, () => string][] = [
  ['pharmacy_owner', ownerToken],
  ['pharmacist', pharmacistToken],
  ['staff', cashierToken],
];

/**
 * A complete row, and deliberately an *approved* one with a patient and a prescriber.
 *
 * The default is the row that has something to lose: an approved prescription with a
 * patient on it is the one whose collection reminder has to be stopped when the
 * medicine goes. Against a `pending` walk-in every supersede assertion would pass by
 * having nothing to supersede.
 */
function prescriptionRow(overrides: Partial<PrescriptionRow> = {}): PrescriptionRow {
  return {
    id: PRESCRIPTION,
    pharmacyId: PHARMACY,
    patientId: PATIENT,
    saleId: null,
    prescriberName: PRESCRIBER,
    status: 'approved',
    approvedBy: PHARMACIST_ID,
    notes: 'Repeat script',
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

/**
 * The row the repository hands back, whatever was written.
 *
 * Not built *from* the write. What reached the table is read off the repository call's
 * argument and what reached the browser is read off this row, so the two are asserted
 * separately and a mapping bug cannot cancel itself out.
 */
const STORED = prescriptionRow();

/** A patient, in the only shape this router's path needs. */
const FOUND_PATIENT = { id: PATIENT, pharmacyId: PHARMACY };
const FOUND_SALE = { id: SALE, pharmacyId: PHARMACY };

/** What the record form posts: a patient, a prescriber, and a note. */
const RECORD = {
  patientId: PATIENT,
  saleId: null,
  prescriberName: PRESCRIBER,
  notes: 'Repeat script',
};

/**
 * The four parameterised paths, as constants.
 *
 * Not for brevity, though it helps: a path built inline in forty places is a path that
 * can be built slightly differently in one of them, and a test that hits the wrong url
 * fails with a 404 that reads like a broken route.
 */
const ONE = `/prescriptions/${PRESCRIPTION}`;
const ONE_APPROVE = `${ONE}/approve`;
const ONE_DISPENSE = `${ONE}/dispense`;
const ONE_REJECT = `${ONE}/reject`;

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
   * `unknown` rather than the field-error array, because three shapes arrive here and
   * all are correct: a list of `{ field, message }` from validation, `{ missing }` from
   * `authorize`, and `{ status, requested }` from the service's own refusals. Typing it
   * as one would make the others casts, and a cast in a test is an assertion nobody
   * checks.
   */
  error: { message: string; code?: string; details?: unknown };
}

function errorOf(body: unknown): ErrorBody {
  return body as ErrorBody;
}

/** The `NewPrescription` the recording route asked to be inserted. */
function written(): NewPrescription {
  const first = createMock.mock.calls[0];
  if (first === undefined) {
    // Named rather than left to surface as a property read on undefined, which reads
    // like a broken route instead of a test that expected a write.
    throw new Error('createPrescription was never called');
  }
  return (first as unknown[])[1] as NewPrescription;
}

/**
 * The `PrescriptionPatch` a correction or a move asked for.
 *
 * Indexed, because one test below sends two dispensings in a row and the claim it makes
 * is about the *second* one — a helper that always read call zero would have asserted
 * the first request twice and passed either way.
 */
function patchOf(call = 0): PrescriptionPatch {
  const first = updateMock.mock.calls[call];
  if (first === undefined) throw new Error(`updatePrescription was never called for ${call}`);
  return (first as unknown[])[3] as PrescriptionPatch;
}

/**
 * The filters the queue route handed to the repository.
 *
 * Indexed for the same reason `patchOf` is, and found the same way — by a test going
 * red. Two tests below send a cleared filter and a filled one in the same test, because
 * the claim is about the *contrast* between them and a contrast needs both halves in
 * one place. Reading call zero for the second half asserts the first request twice,
 * and passes whatever the route does with the second.
 */
function filtersOf(call = 0): PrescriptionFilters {
  const first = listMock.mock.calls[call];
  if (first === undefined) throw new Error(`listPrescriptions was never called for ${call}`);
  return (first as unknown[])[2] as PrescriptionFilters;
}

/** The reminder an approval raised. */
function reminded(): NewReminder {
  const first = scheduleMock.mock.calls[0];
  if (first === undefined) throw new Error('scheduleReminder was never called');
  return (first as unknown[])[1] as NewReminder;
}

/** Why a dispensing, a rejection or a re-attachment stopped the reminder. */
function supersededReason(): string {
  const first = supersedeMock.mock.calls[0];
  if (first === undefined) throw new Error('supersedeRefillReminder was never called');
  return (first as unknown[])[3] as string;
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
  findSaleByIdMock.mockResolvedValue(FOUND_SALE);
  createMock.mockResolvedValue(STORED);
  findMock.mockResolvedValue(STORED);
  updateMock.mockResolvedValue(STORED);
  listMock.mockResolvedValue([STORED]);
  countMock.mockResolvedValue(TOTAL);
  scheduleMock.mockResolvedValue({ scheduled: true, reminder: null });
  supersedeMock.mockResolvedValue(true);
});

describe('who may use this router', () => {
  it('answers every role on the reads and on recording, and refuses counter staff on the four decisions', async () => {
    for (const [role, token] of EVERY_ROLE) {
      const queue = await call('get', '/prescriptions', token());
      const one = await call('get', ONE, token());
      const record = await call('post', '/prescriptions', token(), RECORD);
      const correct = await call('patch', ONE, token(), { notes: 'Corrected' });
      const approve = await call('post', ONE_APPROVE, token());
      const dispense = await call('post', ONE_DISPENSE, token());
      const reject = await call('post', ONE_REJECT, token());

      // Pinned as one object per role, so a failure names the role and the route
      // together rather than leaving seven assertions to be counted by hand.
      expect({
        role,
        queue: queue.status,
        one: one.status,
        // 201 because the prescription did not exist before the request, and 201 for
        // counter staff too — writing it down is the act they are allowed.
        record: record.status,
        correct: correct.status,
        approve: approve.status,
        dispense: dispense.status,
        reject: reject.status,
      }).toEqual({
        role,
        queue: 200,
        one: 200,
        record: 201,
        correct: role === 'staff' ? 403 : 200,
        approve: role === 'staff' ? 403 : 200,
        dispense: role === 'staff' ? 403 : 200,
        reject: role === 'staff' ? 403 : 200,
      });
    }
  });

  it('names the permission it refused, and does no work behind the refusal', async () => {
    const correct = await call('patch', ONE, cashierToken(), { notes: 'Corrected' });
    const approve = await call('post', ONE_APPROVE, cashierToken());
    const dispense = await call('post', ONE_DISPENSE, cashierToken());
    const reject = await call('post', ONE_REJECT, cashierToken());

    for (const response of [correct, approve, dispense, reject]) {
      const body = errorOf(response.body);
      expect(response.status).toBe(403);
      expect(body.error.code).toBe('forbidden');
      expect(body.error.message).toBe('Your role does not permit this action');
      // The permission, not the route: one sentence covers four buttons, and naming the
      // permission is what tells a pharmacist this is a role question rather than a
      // broken form.
      expect(body.error.details).toEqual({ missing: ['prescriptions:approve'] });
    }

    // `authorize` runs before the validators and before the handler, so a refusal here
    // is a refusal that cost nothing. A router that approved the prescription and then
    // checked who asked would answer 403 and still have raised the reminder.
    expect(updateMock).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  it('lets the person who wrote one down be somebody who cannot approve it', async () => {
    const recorded = await call('post', '/prescriptions', cashierToken(), RECORD);
    expect(recorded.status).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(1);

    const approved = await call('post', ONE_APPROVE, cashierToken());
    expect(approved.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
    // The control is on the role rather than on the combination: nothing anywhere
    // compares the recorder to the approver, and nothing has to, because
    // `prescriptions:approve` is simply not in the staff permission set. That is what
    // makes the split hold on a shift where the owner is the one at the counter.
    expect(errorOf(approved.body).error.details).toEqual({
      missing: ['prescriptions:approve'],
    });
  });
});

describe('GET /prescriptions', () => {
  it('lists the queue with the badge number beside it, and the statuses a filter can be built from', async () => {
    const response = await call('get', '/prescriptions', pharmacistToken());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: {
        prescriptions: [STORED],
        total: TOTAL,
        limit: 50,
        offset: 0,
        // Carried so the counter builds its filter from the answer rather than from a
        // second copy of the enum in the frontend, which is a copy that can drift.
        statuses: [...PRESCRIPTION_STATUSES],
      },
    });
  });

  it('treats a cleared filter cell as no filter, on all five of them at once', async () => {
    const response = await call(
      'get',
      '/prescriptions?patientId=&status=&from=&to=&order=',
      pharmacistToken()
    );

    expect(response.status).toBe(200);
    // `toStrictEqual`, because the claim about `order` is that the key is absent rather
    // than that it is null — the default ordering belongs to the repository that owns
    // the two orderings, and a route that sent `'newest'` would be a second place
    // stating it.
    expect(filtersOf()).toStrictEqual({
      patientId: null,
      statuses: [],
      from: null,
      to: null,
      limit: 50,
      offset: 0,
    });
    expect(filtersOf()).not.toHaveProperty('order');
  });

  it('still refuses a value that is not an id, so the widening opened no uuid cast', async () => {
    for (const value of ['0', 'false', 'not-a-uuid']) {
      const response = await call('get', `/prescriptions?patientId=${value}`, ownerToken());
      const body = errorOf(response.body);
      expect({ value, status: response.status, details: body.error.details }).toEqual({
        value,
        status: 400,
        details: [{ field: 'patientId', message: 'That is not a valid patient id' }],
      });
    }
    expect(listMock).not.toHaveBeenCalled();
  });

  it('folds an empty status list into every status rather than into no rows', async () => {
    // `status = any('{}')` is valid SQL matching nothing, so an approval queue asked for
    // no statuses would show no statuses and read as a pharmacy with nothing waiting.
    await call('get', '/prescriptions?status=', pharmacistToken());
    expect(filtersOf().statuses).toEqual([]);

    await call('get', '/prescriptions?status=pending&status=approved', pharmacistToken());
    expect(filtersOf(1).statuses).toEqual(['pending', 'approved']);
  });

  it('sends an ordering through only when one was asked for', async () => {
    await call('get', '/prescriptions?order=oldest', pharmacistToken());
    expect(filtersOf().order).toBe('oldest');

    await call('get', '/prescriptions', pharmacistToken());
    expect(filtersOf(1)).not.toHaveProperty('order');
  });

  it('refuses a cleared limit where it accepts a cleared patient, on the same query string', async () => {
    // The asymmetry `routes/shared.ts` documents: `pagination` uses a bare `.optional()`,
    // which skips `undefined` and `null` but not `''`, so `?limit=` reaches `isInt` and
    // fails. Widening it would mean a page size of "whatever the empty string casts to".
    const cleared = await call('get', '/prescriptions?limit=', pharmacistToken());
    const absent = await call('get', '/prescriptions?patientId=', pharmacistToken());

    expect(cleared.status).toBe(400);
    expect(errorOf(cleared.body).error.details).toEqual([
      { field: 'limit', message: 'limit must be between 1 and 200' },
    ]);
    expect(absent.status).toBe(200);
  });

  it('answers 404 for a prescription that is not there, and for one that is not a uuid with a 400', async () => {
    findMock.mockResolvedValue(null);
    const missing = await call('get', ONE, pharmacistToken());
    expect(missing.status).toBe(404);
    expect(errorOf(missing.body).error.message).toBe('No prescription matches that id');

    const malformed = await call('get', '/prescriptions/not-a-uuid', pharmacistToken());
    expect(malformed.status).toBe(400);
    expect(errorOf(malformed.body).error.details).toEqual([
      { field: 'id', message: 'That is not a valid prescription id' },
    ]);
    expect(findMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /prescriptions', () => {
  it('writes down a script with no status and no approver, and answers 201', async () => {
    const response = await call('post', '/prescriptions', pharmacistToken(), RECORD);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ success: true, data: { prescription: STORED } });
    expect(written()).toStrictEqual({
      pharmacyId: PHARMACY,
      patientId: PATIENT,
      saleId: null,
      prescriberName: PRESCRIBER,
      notes: 'Repeat script',
    });
    // Both absences are the structural guarantee rather than a convention: the insert
    // names six columns and `status` is not one of them, and `approvedBy` is not on the
    // body at all, so an approver on a prescription nobody has approved — a signature on
    // a decision nobody made — has nowhere to arrive from.
    expect(written()).not.toHaveProperty('status');
    expect(written()).not.toHaveProperty('approvedBy');
  });

  it('takes an empty body, because the paper arrives before the patient is on the register', async () => {
    const response = await call('post', '/prescriptions', cashierToken(), {});

    expect(response.status).toBe(201);
    expect(written()).toStrictEqual({
      pharmacyId: PHARMACY,
      patientId: null,
      saleId: null,
      prescriberName: null,
      notes: null,
    });
    // Nothing to look up, so nothing was looked up.
    expect(findPatientMock).not.toHaveBeenCalled();
    expect(findSaleByIdMock).not.toHaveBeenCalled();
  });

  it('accepts the longest prescriber name the reminder can carry, and refuses the next character', async () => {
    const longest = 'x'.repeat(PRESCRIPTION_LIMITS.prescriberName.max);

    const accepted = await call('post', '/prescriptions', pharmacistToken(), {
      ...RECORD,
      prescriberName: longest,
    });
    const refused = await call('post', '/prescriptions', pharmacistToken(), {
      ...RECORD,
      prescriberName: `${longest}y`,
    });

    expect(accepted.status).toBe(201);
    expect(refused.status).toBe(400);
    // Asserted against the derived constant rather than against a number written here,
    // so the sentence the counter shows always agrees with the limit that produced it.
    expect(errorOf(refused.body).error.details).toEqual([
      {
        field: 'prescriberName',
        message: `A prescriber's name must be ${PRESCRIPTION_LIMITS.prescriberName.max} characters or fewer`,
      },
    ]);
  });

  it('refuses a patient or a sale that is not an id, naming the field either time', async () => {
    for (const [field, message, body] of [
      ['patientId', 'That is not a valid patient id', { ...RECORD, patientId: 'nope' }],
      ['saleId', 'That is not a valid sale id', { ...RECORD, saleId: 'nope' }],
    ] as [string, string, object][]) {
      const response = await call('post', '/prescriptions', pharmacistToken(), body);
      expect({ field, status: response.status, details: errorOf(response.body).error.details }).toEqual(
        { field, status: 400, details: [{ field, message }] }
      );
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  it('answers 404 for a patient who is not on this register, rather than the foreign key constraint name', async () => {
    findPatientMock.mockResolvedValue(null);

    const response = await call('post', '/prescriptions', pharmacistToken(), RECORD);

    expect(response.status).toBe(404);
    expect(errorOf(response.body).error.message).toBe('No patient matches that id');
    // Looked up inside the transaction, so the id cannot go stale between being checked
    // and being written.
    expect(findPatientMock).toHaveBeenCalledWith(CLIENT, PHARMACY, PATIENT);
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /prescriptions/:id', () => {
  it('keeps absent and null apart across the wire, so a correction cannot clear what nobody mentioned', async () => {
    const response = await call('patch', ONE, pharmacistToken(), { notes: 'Label reprinted' });

    expect(response.status).toBe(200);
    expect(patchOf()).toStrictEqual({
      notes: 'Label reprinted',
      allowedFrom: [...PRESCRIPTION_STATUSES],
    });
    // Three absences rather than three nulls. A cast over the body would have produced
    // `patientId: null` here, which detaches the patient — and detaching a patient also
    // supersedes their collection reminder, so the cost of getting this wrong is a
    // patient who stops being told their medicine is ready.
    expect(patchOf()).not.toHaveProperty('patientId');
    expect(patchOf()).not.toHaveProperty('saleId');
    expect(patchOf()).not.toHaveProperty('prescriberName');
  });

  it('clears a patient on an explicit null, and stops the reminder that belonged to them', async () => {
    const response = await call('patch', ONE, pharmacistToken(), { patientId: null });

    expect(response.status).toBe(200);
    expect(patchOf().patientId).toBeNull();
    // `reminders.patient_id` is a copy taken when the reminder was raised, so leaving it
    // alone would keep texting somebody about a prescription that is no longer theirs.
    expect(supersededReason()).toBe(REATTACHED_REASON);
    expect(supersedeMock).toHaveBeenCalledWith(CLIENT, PHARMACY, PRESCRIPTION, REATTACHED_REASON);
  });

  it('does not stop the reminder when the patient is restated as the one already there', async () => {
    const response = await call('patch', ONE, pharmacistToken(), { patientId: PATIENT });

    expect(response.status).toBe(200);
    expect(patchOf().patientId).toBe(PATIENT);
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  it('refuses a body that changes nothing, rather than answering with an unchanged row', async () => {
    const response = await call('patch', ONE, pharmacistToken(), {});

    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.code).toBe('nothing_to_update');
    expect(errorOf(response.body).error.message).toBe(
      'Nothing to change — send at least one field to correct'
    );
    // A silent no-op is a frontend that believes it saved something it did not send.
    expect(updateMock).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('carries no status, so a correction cannot be a second route into the transitions', async () => {
    const response = await call('patch', ONE, pharmacistToken(), {
      notes: 'Corrected',
      status: 'dispensed',
    });

    expect(response.status).toBe(200);
    expect(patchOf()).not.toHaveProperty('status');
    expect(patchOf().notes).toBe('Corrected');
  });

  it('corrects a dispensed prescription, because a typo on the row that says medicine went out is still a typo', async () => {
    findMock.mockResolvedValue(prescriptionRow({ status: 'dispensed' }));
    updateMock.mockResolvedValue(prescriptionRow({ status: 'dispensed' }));

    const response = await call('patch', ONE, pharmacistToken(), {
      prescriberName: 'Dr Kwame Osei',
    });

    expect(response.status).toBe(200);
    // Refusing here would leave wrong information on the one row that says medicine left
    // the shelf, and correcting the attribution does not un-record the supply.
    expect(patchOf().allowedFrom).toEqual([...PRESCRIPTION_STATUSES]);
    expect(patchOf().prescriberName).toBe('Dr Kwame Osei');
  });
});

describe('the three moves', () => {
  it('signs the approval with the token, and raises the collection reminder in the same request', async () => {
    const response = await call('post', ONE_APPROVE, pharmacistToken());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: { prescription: STORED } });
    expect(patchOf()).toStrictEqual({
      approvedBy: PHARMACIST_ID,
      status: 'approved',
      allowedFrom: ['pending'],
    });

    const reminder = reminded();
    // Six keys and no seventh, so a reminder that arrived carrying a `sent` flag or a
    // provider nobody configured would fail here rather than at the scheduler.
    expect(Object.keys(reminder).sort()).toEqual([
      'dedupeKey',
      'dueAt',
      'kind',
      'message',
      'patientId',
      'pharmacyId',
    ]);
    expect(reminder.pharmacyId).toBe(PHARMACY);
    expect(reminder.patientId).toBe(PATIENT);
    expect(reminder.kind).toBe('refill');
    // Asserted against the real key builder rather than a string written out here. A
    // wrong key is the silent failure: it supersedes nothing, stays `pending`, stays due,
    // and fires. Nothing errors, because nothing is wrong with the prescription.
    expect(reminder.dedupeKey).toBe(refillReminderKey(PRESCRIPTION));
    // And against the real message builder, so the prescriber the row names is the
    // prescriber the patient is told about — two scripts are otherwise two identical
    // texts with nothing to tell them apart.
    expect(reminder.message).toBe(refillReminderMessage(PRESCRIBER));

    // Due one lead out. `utils/clock` is deliberately not mocked here: this suite is
    // about what crosses the wire, so the honest assertion is "a lead from now" with a
    // minute of slack for the request, rather than an instant frozen to match.
    const lead = Date.parse(reminder.dueAt) - Date.now();
    expect(lead).toBeGreaterThan(REFILL_REMINDER_LEAD_MS - 60_000);
    expect(lead).toBeLessThanOrEqual(REFILL_REMINDER_LEAD_MS);
  });

  it('stops the collection reminder when the medicine goes, so nobody is texted about what they are holding', async () => {
    const response = await call('post', ONE_DISPENSE, pharmacistToken());

    expect(response.status).toBe(200);
    expect(patchOf()).toStrictEqual({ status: 'dispensed', allowedFrom: ['approved'] });
    expect(supersedeMock).toHaveBeenCalledWith(CLIENT, PHARMACY, PRESCRIPTION, COLLECTED_REASON);
    expect(supersededReason()).toBe(COLLECTED_REASON);
  });

  it('passes a sale the dispensing went out against, and leaves one nobody named alone', async () => {
    await call('post', ONE_DISPENSE, pharmacistToken(), { saleId: SALE });
    expect(patchOf()).toStrictEqual({
      saleId: SALE,
      status: 'dispensed',
      allowedFrom: ['approved'],
    });
    expect(findSaleByIdMock).toHaveBeenCalledWith(CLIENT, PHARMACY, SALE);

    await call('post', ONE_DISPENSE, pharmacistToken(), {});
    // Absent rather than null: a dispensing nobody attached a receipt to must not clear
    // the sale a colleague attached a moment ago. Call 1, not call 0 — the first
    // dispensing in this test did carry a sale, and reading it again would have proved
    // nothing about the second.
    expect(patchOf(1)).not.toHaveProperty('saleId');
    expect(patchOf(1).status).toBe('dispensed');
    expect(findSaleByIdMock).toHaveBeenCalledTimes(1);
  });

  it('stops the reminder on a rejection too, and takes no reason because the schema has nowhere to put one', async () => {
    const response = await call('post', ONE_REJECT, pharmacistToken());

    expect(response.status).toBe(200);
    expect(patchOf()).toStrictEqual({
      status: 'rejected',
      allowedFrom: ['pending', 'approved'],
    });
    expect(supersededReason()).toBe(NOT_SUPPLYING_REASON);
    // A gap rather than a choice to hide one. Composing a reason into `notes` would either
    // overwrite what a pharmacist wrote or append in a format nothing can parse, and a
    // reason of its own is a column — a migration to decide with A&B rather than invent
    // here. The refusal itself is recorded, with its status and its `updated_at`.
    expect(patchOf()).not.toHaveProperty('notes');
  });

  it('answers 409 rather than 404 when the guard refuses, and says which status it found', async () => {
    findMock.mockResolvedValue(prescriptionRow({ status: 'dispensed' }));
    updateMock.mockResolvedValue(null);

    const response = await call('post', ONE_APPROVE, pharmacistToken());

    expect(response.status).toBe(409);
    const body = errorOf(response.body);
    expect(body.error.code).toBe('prescription_not_movable');
    // Found and then refused, so the sentence names the status rather than the id: one is
    // a prescription that has already been handed over and the other is a stale link in
    // somebody's browser, and those are different things to tell a pharmacist.
    expect(body.error.message).toBe(
      'This prescription is dispensed, so it cannot be marked approved'
    );
    expect(body.error.details).toEqual({ status: 'dispensed', requested: 'approved' });
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('refuses a sale id that is not an id on the dispensing body', async () => {
    const response = await call('post', ONE_DISPENSE, pharmacistToken(), { saleId: 'nope' });

    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      { field: 'saleId', message: 'That is not a valid sale id' },
    ]);
    expect(updateMock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
  });
});

/**
 * Every way a request to this router can be wrong, swept for the one answer that is
 * never acceptable.
 *
 * `consultations.routes.test.ts` has the same sweep and `patients.routes.test.ts`
 * extends it to query and path parameters; this one covers all three plus a `PATCH` and
 * three `POST` moves, because a router with four write routes behind two different
 * permissions is a router whose messages are worth re-reading in one pass rather than
 * one chain at a time.
 */
describe('never answers with the validator\'s own "Invalid value"', () => {
  const OVER = PRESCRIPTION_LIMITS.prescriberName.max + 1;

  const CASES: { path: string; method: 'get' | 'post' | 'patch'; body?: object }[] = [
    { path: '/prescriptions?limit=0', method: 'get' },
    { path: '/prescriptions?limit=201', method: 'get' },
    { path: '/prescriptions?limit=abc', method: 'get' },
    { path: '/prescriptions?limit=', method: 'get' },
    { path: '/prescriptions?offset=-1', method: 'get' },
    { path: '/prescriptions?offset=abc', method: 'get' },
    { path: '/prescriptions?offset=', method: 'get' },
    { path: '/prescriptions?patientId=not-a-uuid', method: 'get' },
    { path: '/prescriptions?patientId=0', method: 'get' },
    { path: '/prescriptions?status=finished', method: 'get' },
    { path: '/prescriptions?status=pending&status=finished', method: 'get' },
    { path: '/prescriptions?from=01/03/2027', method: 'get' },
    { path: '/prescriptions?to=2027-13-45', method: 'get' },
    { path: '/prescriptions?order=sideways', method: 'get' },
    { path: '/prescriptions/not-a-uuid', method: 'get' },
    { path: '/prescriptions', method: 'post', body: { ...RECORD, patientId: 'nope' } },
    { path: '/prescriptions', method: 'post', body: { ...RECORD, saleId: 42 } },
    {
      path: '/prescriptions',
      method: 'post',
      body: { ...RECORD, prescriberName: 'x'.repeat(OVER) },
    },
    { path: '/prescriptions', method: 'post', body: { ...RECORD, prescriberName: [] } },
    { path: '/prescriptions', method: 'post', body: { ...RECORD, notes: 'n'.repeat(501) } },
    { path: '/prescriptions', method: 'post', body: { ...RECORD, notes: 42 } },
    { path: ONE, method: 'patch', body: {} },
    { path: ONE, method: 'patch', body: { patientId: 'nope' } },
    { path: ONE, method: 'patch', body: { saleId: 'nope' } },
    { path: ONE, method: 'patch', body: { prescriberName: 'x'.repeat(OVER) } },
    { path: ONE, method: 'patch', body: { notes: 'n'.repeat(501) } },
    { path: '/prescriptions/not-a-uuid', method: 'patch', body: { notes: 'x' } },
    { path: '/prescriptions/not-a-uuid/approve', method: 'post' },
    { path: ONE_DISPENSE, method: 'post', body: { saleId: 'nope' } },
    { path: '/prescriptions/not-a-uuid/dispense', method: 'post', body: { saleId: SALE } },
    { path: '/prescriptions/not-a-uuid/reject', method: 'post' },
  ];

  it('gives every refusal a sentence a person can act on', async () => {
    const offenders: string[] = [];

    for (const entry of CASES) {
      const response = await call(entry.method, entry.path, ownerToken(), entry.body);
      const body = JSON.stringify(response.body);

      // Both halves matter. A 200 would mean the case was not a case at all and the sweep
      // was quietly testing nothing; "Invalid value" is the defect, because it tells the
      // pharmacist that something was wrong and not what.
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
    // work rather than after it. A router that approved the prescription and then
    // complained about a field would answer 400 and still have raised a reminder for a
    // patient nobody meant to text.
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(findMock).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
  });
});
