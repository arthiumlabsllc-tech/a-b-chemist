jest.mock('../database/pool', () => ({
  poolSql: { query: jest.fn() },
  withTransaction: jest.fn(),
}));

jest.mock('../repositories/patients.repository', () => ({
  // Only the export this service reads. The others belong to `patients.service`
  // and nothing in this module graph imports them.
  findPatient: jest.fn(),
}));

jest.mock('../repositories/prescriptions.repository', () => ({
  countPrescriptions: jest.fn(),
  createPrescription: jest.fn(),
  findPrescription: jest.fn(),
  listPrescriptions: jest.fn(),
  updatePrescription: jest.fn(),
}));

jest.mock('../repositories/reminders.repository', () => ({
  scheduleReminder: jest.fn(),
  supersedeRefillReminder: jest.fn(),
}));

jest.mock('../repositories/sales.repository', () => ({
  // Same reason as the patients repository: `saleOrThrow` reads one sale by id and
  // nothing else here touches the till.
  findSaleById: jest.fn(),
}));

jest.mock('../utils/clock', () => ({
  // A spy rather than fake timers. The claim about the reminder is which instant
  // the lead was added to, and that is a fact about the call, not the wall clock.
  nowIso: jest.fn(),
}));

import type { PoolClient } from 'pg';
import { poolSql, withTransaction } from '../database/pool';
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
  type NewReminder,
  scheduleReminder,
  supersedeRefillReminder,
} from '../repositories/reminders.repository';
import { findSaleById } from '../repositories/sales.repository';
import {
  COLLECTED_REASON,
  NOT_SUPPLYING_REASON,
  PRESCRIPTION_LIMITS,
  REATTACHED_REASON,
  REFILL_REMINDER_LEAD_MS,
  TRANSITIONS,
  allowedFromFor,
  approvePrescription,
  correctPrescription,
  dispensePrescription,
  getPrescription,
  listPrescriptionPage,
  recordPrescription,
  refillReminderMessage,
  rejectPrescription,
  type PrescriptionCorrection,
  type PrescriptionInput,
} from '../services/prescriptions.service';
import { PHARMACY_NAME, SMS_BODY_MAX_LENGTH } from '../services/sms';
import { nowIso } from '../utils/clock';
import { HttpError } from '../utils/http';
import { refillReminderKey } from '../utils/reminder-keys';
import { PRESCRIPTION_STATUSES, type PrescriptionStatus } from '../utils/schema-enums';

/**
 * The authority behind a dispensing: who wrote it down, who decided, and the
 * reminder that decision starts.
 *
 * ## The thing this suite exists to hold
 *
 * `reminders` has no `prescription_id`. A collection reminder points at its
 * prescription only through `dedupe_key`, and only `supersedeRefillReminder` can
 * stop the *first* one firing — keying a reminder correctly stops a second being
 * raised and does nothing at all about the row already sitting `pending` with a
 * `due_at` that will arrive. So every move that ends the obligation is asserted to
 * supersede, with the reason it superseded for, and every move that does not end it
 * is asserted not to.
 *
 * The failure mode is silent and it lands on a patient: a script approved on Monday
 * and collected on Monday texts them on Tuesday about medicine they are holding.
 * Nothing errors, because nothing is wrong with the prescription.
 *
 * ## The transition table, whole
 *
 * `TRANSITIONS` is exported so this suite pins all four moves in one assertion. Four
 * separate ones can each pass while the shape between them is wrong, and a route from
 * `rejected` back to `approved` is exactly that shape: it would turn a clinical
 * refusal into an authorisation leaving nothing behind but a moved `updated_at`.
 *
 * ## The signature is written by the move
 *
 * `approvedBy` comes from the token and there is no parameter through which a caller
 * could supply one. Asserted the way `screenings.service.test.ts` asserts
 * `recordedBy`: hand the service a body that tries, and show the object reaching the
 * repository has no such key. A cast is needed to build that body at all, and needing
 * the cast is the point.
 *
 * ## What is deliberately not mocked
 *
 * `services/sms.ts` and `utils/reminder-keys.ts`. Both are real modules with real
 * rules — the trading name, the two-segment body limit, the key shapes — and stubbing
 * either would make every assertion below true by agreement. The reminder's message
 * and its key are asserted against the real builders rather than against strings
 * written out here, which is what makes the length budget a fact rather than a hope.
 */

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const OTHER_PHARMACY = 'a0000000-0000-4000-8000-000000000009';
const OWNER = 'a0000000-0000-4000-8000-000000000002';
const PHARMACIST = 'a0000000-0000-4000-8000-000000000003';
const PATIENT = 'a0000000-0000-4000-8000-000000000040';
const OTHER_PATIENT = 'a0000000-0000-4000-8000-000000000041';
const PRESCRIPTION = 'a0000000-0000-4000-8000-000000000080';
const SALE = 'a0000000-0000-4000-8000-000000000090';

const PRESCRIBER = 'Dr Kwame Antwi';

/** What `nowIso` answers for the whole suite, so the reminder's lead is a fixed fact. */
const NOW = '2026-09-05T09:30:00.000Z';
/** `NOW` plus exactly `REFILL_REMINDER_LEAD_MS`, written out rather than computed. */
const DUE = '2026-09-06T09:30:00.000Z';

const CLIENT = { query: jest.fn() } as unknown as PoolClient;

const withTransactionMock = withTransaction as jest.Mock;
const createMock = createPrescription as jest.Mock;
const findMock = findPrescription as jest.Mock;
const listMock = listPrescriptions as jest.Mock;
const countMock = countPrescriptions as jest.Mock;
const updateMock = updatePrescription as jest.Mock;
const findPatientMock = findPatient as jest.Mock;
const findSaleByIdMock = findSaleById as jest.Mock;
const scheduleMock = scheduleReminder as jest.Mock;
const supersedeMock = supersedeRefillReminder as jest.Mock;
const nowMock = nowIso as jest.Mock;

/** Writes it down. Recording is `patients:write`, so this actor is not the approver. */
const ACTOR = { userId: OWNER, pharmacyId: PHARMACY };
/** Decides it. A different user, so the signature cannot be confused with the recorder. */
const APPROVER = { userId: PHARMACIST, pharmacyId: PHARMACY };

/**
 * `findPatient`'s and `findSaleById`'s answer.
 *
 * Stubs rather than whole rows, because the service reads exactly one thing from
 * either — whether it is null. Copying the full shape here would make this file
 * compile against fields it never touches, and that copy is the kind that drifts.
 */
const FOUND_PATIENT = { id: PATIENT, pharmacyId: PHARMACY };
const FOUND_SALE = { id: SALE, pharmacyId: PHARMACY };

/** Complete rows, so a new required column stops this file compiling. */
function row(overrides: Partial<PrescriptionRow> = {}): PrescriptionRow {
  return {
    id: PRESCRIPTION,
    pharmacyId: PHARMACY,
    patientId: PATIENT,
    saleId: null,
    prescriberName: PRESCRIBER,
    status: 'pending',
    approvedBy: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** What the record form posts: a patient, a prescriber, and a note. */
function input(overrides: Partial<PrescriptionInput> = {}): PrescriptionInput {
  return { patientId: PATIENT, prescriberName: PRESCRIBER, notes: 'Repeat script', ...overrides };
}

function filters(overrides: Partial<PrescriptionFilters> = {}): PrescriptionFilters {
  return {
    patientId: null,
    statuses: [],
    from: null,
    to: null,
    limit: 50,
    offset: 0,
    ...overrides,
  };
}

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string
): Promise<HttpError> {
  const thrown = await promise.then(
    () => null,
    (error: unknown) => error
  );
  if (!(thrown instanceof HttpError)) {
    throw new Error(
      `expected an HttpError ${status}/${code}, got ` +
        (thrown === null ? 'a promise that resolved' : String(thrown))
    );
  }
  expect(thrown.status).toBe(status);
  expect(thrown.code).toBe(code);
  return thrown;
}

/** The exact object handed to `createPrescription`. */
function created(): NewPrescription {
  return createMock.mock.calls[0][1];
}

/**
 * The exact object handed to `updatePrescription`.
 *
 * Every patch assertion below goes through `toStrictEqual`, because `toEqual` treats
 * `{ notes: undefined }` and `{}` as the same object — and keeping absent apart from
 * null is the whole claim.
 */
function patchOf(call = 0): PrescriptionPatch {
  return updateMock.mock.calls[call][3];
}

/** The exact reminder handed to `scheduleReminder`. */
function reminded(): NewReminder {
  return scheduleMock.mock.calls[0][1];
}

/** What the count was asked for, with the paging it must not have been given. */
function counted(): Omit<PrescriptionFilters, 'order' | 'limit' | 'offset'> {
  return countMock.mock.calls[0][2];
}

/**
 * The order two repository calls happened in.
 *
 * Named consts and an explicit throw rather than `mock.invocationCallOrder[0]`
 * inline, because `noUncheckedIndexedAccess` types that as `number | undefined` and
 * the house answer to an unchecked index is a named guard. A non-null assertion would
 * be worse than a compile error here: it would turn "this call never happened" into a
 * comparison against `undefined` that fails with a sentence about ordering, which is
 * the wrong sentence for the thing that went wrong.
 */
function orderOf(first: jest.Mock, second: jest.Mock): [number, number] {
  const earlier = first.mock.invocationCallOrder[0];
  const later = second.mock.invocationCallOrder[0];
  if (earlier === undefined || later === undefined) {
    throw new Error('expected both of the calls to have happened');
  }
  return [earlier, later];
}

beforeEach(() => {
  jest.clearAllMocks();
  nowMock.mockReturnValue(NOW);
  withTransactionMock.mockImplementation(
    async (work: (client: PoolClient) => Promise<unknown>) => work(CLIENT)
  );
  findPatientMock.mockResolvedValue(FOUND_PATIENT);
  findSaleByIdMock.mockResolvedValue(FOUND_SALE);
  createMock.mockResolvedValue(row());
  findMock.mockResolvedValue(row());
  updateMock.mockResolvedValue(row());
  listMock.mockResolvedValue([row()]);
  countMock.mockResolvedValue(1);
  scheduleMock.mockResolvedValue({ scheduled: true, reminder: null });
  supersedeMock.mockResolvedValue(true);
});

describe('the transition table', () => {
  it('spells four moves and no others, with two states that have no exit', () => {
    // Pinned whole rather than one move at a time. A fifth entry — `rejected` back
    // to `approved` — would pass four separate assertions about the four moves that
    // already existed, and it is the one route that turns a refusal into an
    // authorisation leaving nothing on the ledger but a moved `updated_at`.
    expect(TRANSITIONS).toStrictEqual({
      pending: ['approved', 'rejected'],
      approved: ['dispensed', 'rejected'],
      rejected: [],
      dispensed: [],
    } satisfies Readonly<Record<PrescriptionStatus, readonly PrescriptionStatus[]>>);
  });

  it('derives the states a move may start from, in the order the schema spells them', () => {
    // Derived rather than written beside the table: a second map spelling the same
    // four moves backwards agrees with the first for as long as nobody edits one of
    // them, and the day somebody does the guard starts allowing a move the documented
    // table forbids — with both maps looking authoritative and nothing failing.
    expect({
      approved: allowedFromFor('approved'),
      dispensed: allowedFromFor('dispensed'),
      rejected: allowedFromFor('rejected'),
      pending: allowedFromFor('pending'),
    }).toStrictEqual({
      approved: ['pending'],
      dispensed: ['approved'],
      rejected: ['pending', 'approved'],
      // Nothing moves back to `pending`. No exported move targets it either, so the
      // empty-list guard in `movePrescription` is unreachable through the API; it is
      // kept because an empty `allowedFrom` reaching SQL would be `status = any('{}')`,
      // which answers 409 correctly by accident rather than by decision.
      pending: [],
    });
  });
});

describe("the collection reminder's sentence", () => {
  it('signs with the pharmacy alone when nobody was recorded as the prescriber', () => {
    expect(refillReminderMessage(null)).toBe(
      `Your prescription from ${PHARMACY_NAME} is ready for collection. ` +
        'Please call the pharmacy if you need help with it.'
    );
  });

  it('names the prescriber when there is one, because two scripts are otherwise two identical texts', () => {
    expect(refillReminderMessage(PRESCRIBER)).toBe(
      `Your prescription from ${PHARMACY_NAME}, prescribed by ${PRESCRIBER} ` +
        'is ready for collection. Please call the pharmacy if you need help with it.'
    );
  });

  it('fits the two segments at the longest name the form will let through', () => {
    // The form and the builder have to agree, and neither can check that on its own.
    // `PRESCRIPTION_LIMITS.prescriberName.max` is the longest name a route accepts and
    // this is the longest message such a name can produce. When the two were written
    // independently the limit was 200 and the message ran to 326 characters, so a body
    // that had already passed validation turned "approve" into a 500 at the counter —
    // thrown inside the transaction, after the status had moved, so the approval rolled
    // back and the prescription stayed `pending` with no explanation anybody could act on.
    const longest = 'x'.repeat(PRESCRIPTION_LIMITS.prescriberName.max);
    expect(refillReminderMessage(longest).length).toBeLessThanOrEqual(SMS_BODY_MAX_LENGTH);
  });

  it('uses the whole of the budget and no more, because the limit is derived from it', () => {
    // The other half of the same agreement. A limit merely small enough would pass the
    // test above while quietly refusing names the message could have carried, and the
    // only way to see that is to assert the longest accepted name fills the budget
    // exactly.
    const longest = 'x'.repeat(PRESCRIPTION_LIMITS.prescriberName.max);
    expect(refillReminderMessage(longest).length).toBe(SMS_BODY_MAX_LENGTH);
  });

  it("is plain ASCII apart from whatever a prescriber's own name carries", () => {
    // One character outside GSM 7-bit's default alphabet moves the whole message to
    // UCS-2 and halves what a segment carries. The sentence the pharmacy controls is
    // asserted ASCII; the name it does not control is the documented cost.
    expect(/[^\u0020-\u007E]/.test(refillReminderMessage(null))).toBe(false);
    // Kept verbatim rather than stripped or refused: a prescriber's own spelling of
    // their name is not a thing for a reminder to correct, and a diacritic that costs
    // a segment makes the message shorter, not wrong.
    expect(refillReminderMessage('Dr Amélie Nana')).toContain('Dr Amélie Nana');
  });
});

describe('recordPrescription', () => {
  it('writes four fields and no status, because a new prescription cannot arrive already dispensed', async () => {
    await recordPrescription(ACTOR, input({ saleId: SALE }));

    expect(created()).toStrictEqual({
      pharmacyId: PHARMACY,
      patientId: PATIENT,
      saleId: SALE,
      prescriberName: PRESCRIBER,
      notes: 'Repeat script',
    });
    // The structural guarantee `prescriptions.repository.ts` makes: the insert names
    // six columns and `status` is not one of them. Asserted as an absence rather than
    // as a value, because a value could be added to the object here and still be
    // ignored by the repository — the claim is that there is nowhere to put it.
    expect(created()).not.toHaveProperty('status');
  });

  it('takes no approver from a caller, because the contract has no field to take one from', async () => {
    // The cast is the point: `approvedBy` is not on `PrescriptionInput`, so a body
    // carrying one has to be forced through the type system to be tried at all. An
    // approver on a prescription nobody has approved is a signature on a decision
    // nobody made.
    await recordPrescription(ACTOR, {
      ...input(),
      approvedBy: PHARMACIST,
    } as unknown as PrescriptionInput);

    expect(created()).not.toHaveProperty('approvedBy');
    expect(created().patientId).toBe(PATIENT);
  });

  it('checks the patient and the sale inside the transaction it is writing in', async () => {
    await recordPrescription(ACTOR, input({ saleId: SALE }));

    // `CLIENT` and not `poolSql`: a lookup made outside the write can go stale between
    // being made and being relied on, and a miss then answers with the foreign key's
    // constraint name rather than with a sentence.
    expect(findPatientMock).toHaveBeenCalledWith(CLIENT, PHARMACY, PATIENT);
    expect(findSaleByIdMock).toHaveBeenCalledWith(CLIENT, PHARMACY, SALE);
  });

  it('looks neither up for a walk-in, which is the ordinary order of events at a counter', async () => {
    // The paper arrives before the patient has been found in the register. Nothing to
    // look up, so nothing is looked up — and `created()` is honestly null rather than
    // honestly missing.
    await recordPrescription(ACTOR, { prescriberName: PRESCRIBER });

    expect(findPatientMock).not.toHaveBeenCalled();
    expect(findSaleByIdMock).not.toHaveBeenCalled();
    expect(created()).toStrictEqual({
      pharmacyId: PHARMACY,
      patientId: null,
      saleId: null,
      prescriberName: PRESCRIBER,
      notes: null,
    });
  });

  it('refuses a patient who is not on this register, and writes nothing', async () => {
    findPatientMock.mockResolvedValue(null);

    const error = await expectHttpError(
      recordPrescription(ACTOR, input()),
      404,
      'not_found'
    );
    expect(error.message).toBe('No patient matches that id');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a sale that is not on this till, and writes nothing', async () => {
    findSaleByIdMock.mockResolvedValue(null);

    const error = await expectHttpError(
      recordPrescription(ACTOR, input({ saleId: SALE })),
      404,
      'not_found'
    );
    expect(error.message).toBe('No sale matches that id');
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('approvePrescription', () => {
  it('signs with the token, in the same statement as the status', async () => {
    updateMock.mockResolvedValue(row({ status: 'approved', approvedBy: PHARMACIST }));

    await approvePrescription(APPROVER, PRESCRIPTION);

    expect(patchOf()).toStrictEqual({
      approvedBy: PHARMACIST,
      status: 'approved',
      allowedFrom: ['pending'],
    });
    // One statement rather than a move followed by a second update: two updates in a
    // transaction still fire the `updated_at` trigger twice and still leave a window in
    // which the row holds one status and not the other's fields.
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('raises the collection reminder a day out, keyed by the real key builder', async () => {
    await approvePrescription(APPROVER, PRESCRIPTION);

    expect(reminded()).toStrictEqual({
      pharmacyId: PHARMACY,
      patientId: PATIENT,
      kind: 'refill',
      dueAt: DUE,
      message: refillReminderMessage(PRESCRIBER),
      dedupeKey: refillReminderKey(PRESCRIPTION),
    });
    // The lead asserted as an interval as well as an instant, so `REFILL_REMINDER_LEAD_MS`
    // is pinned to what was written rather than to a date chosen to match it.
    expect(Date.parse(reminded().dueAt) - Date.parse(NOW)).toBe(REFILL_REMINDER_LEAD_MS);
  });

  it('takes the patient and the prescriber out of the row, not out of the request', async () => {
    // The id came out of the database, so the foreign key already checked it when the
    // prescription was written. A reminder raised against a request body instead would be
    // a text sent to somebody the row does not name.
    updateMock.mockResolvedValue(
      row({ status: 'approved', patientId: OTHER_PATIENT, prescriberName: 'Dr Efua Mensah' })
    );

    await approvePrescription(APPROVER, PRESCRIPTION);

    expect(reminded().patientId).toBe(OTHER_PATIENT);
    expect(reminded().message).toContain('Dr Efua Mensah');
  });

  it('raises nothing for a walk-in, and still moves the prescription', async () => {
    // Not an error: `reminders.patient_id` is not null, so the alternatives are a
    // reminder that cannot be written or a patient record invented to hold one.
    updateMock.mockResolvedValue(row({ status: 'approved', patientId: null }));

    const approved = await approvePrescription(APPROVER, PRESCRIPTION);

    expect(scheduleMock).not.toHaveBeenCalled();
    expect(approved.status).toBe('approved');
  });

  it('schedules inside the transaction, so a 200 means the reminder exists', async () => {
    await approvePrescription(APPROVER, PRESCRIPTION);

    expect(scheduleMock).toHaveBeenCalledWith(CLIENT, expect.anything());
    const [moved, raised] = orderOf(updateMock, scheduleMock);
    expect(moved).toBeLessThan(raised);
  });

  it('refuses one already dispensed, and raises no reminder for it', async () => {
    findMock.mockResolvedValue(row({ status: 'dispensed', approvedBy: PHARMACIST }));
    updateMock.mockResolvedValue(null);

    const error = await expectHttpError(
      approvePrescription(APPROVER, PRESCRIPTION),
      409,
      'prescription_not_movable'
    );
    // Found above and refused by the guard, so the sentence names the status rather than
    // the id: one is a prescription that has already been handed over and the other is a
    // stale link in somebody's browser.
    expect(error.message).toBe('This prescription is dispensed, so it cannot be marked approved');
    expect(error.details).toStrictEqual({ status: 'dispensed', requested: 'approved' });
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('answers 404 for another pharmacy prescription exactly as for one that does not exist', async () => {
    findMock.mockResolvedValue(null);

    const error = await expectHttpError(
      approvePrescription({ userId: OWNER, pharmacyId: OTHER_PHARMACY }, PRESCRIPTION),
      404,
      'not_found'
    );
    expect(error.message).toBe('No prescription matches that id');
    // The pharmacy comes from the token, so another pharmacy's id is not reachable to be
    // told apart — which is why the two answers are the same one.
    expect(findMock).toHaveBeenCalledWith(CLIENT, OTHER_PHARMACY, PRESCRIPTION);
  });
});

describe('dispensePrescription', () => {
  it('moves from approved only, and supersedes the collection reminder in the same transaction', async () => {
    await dispensePrescription(APPROVER, PRESCRIPTION);

    expect(patchOf()).toStrictEqual({ status: 'dispensed', allowedFrom: ['approved'] });
    expect(supersedeMock).toHaveBeenCalledWith(CLIENT, PHARMACY, PRESCRIPTION, COLLECTED_REASON);
    // The whole reason this move exists in the service rather than as a bare update: a
    // script approved on Monday and collected on Monday still fires on Tuesday without it.
    const [moved, stopped] = orderOf(updateMock, supersedeMock);
    expect(moved).toBeLessThan(stopped);
  });

  it('attaches the sale it went out against, after checking that sale inside the transaction', async () => {
    await dispensePrescription(APPROVER, PRESCRIPTION, SALE);

    expect(patchOf()).toStrictEqual({
      saleId: SALE,
      status: 'dispensed',
      allowedFrom: ['approved'],
    });
    expect(findSaleByIdMock).toHaveBeenCalledWith(CLIENT, PHARMACY, SALE);
    const [checked, moved] = orderOf(findSaleByIdMock, updateMock);
    expect(checked).toBeLessThan(moved);
  });

  it('refuses a sale that is not there, and leaves the prescription approved', async () => {
    findSaleByIdMock.mockResolvedValue(null);

    const error = await expectHttpError(
      dispensePrescription(APPROVER, PRESCRIPTION, SALE),
      404,
      'not_found'
    );
    expect(error.message).toBe('No sale matches that id');
    expect(updateMock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  it('supersedes even when there was no reminder to supersede', async () => {
    // Zero rows is the normal answer, so the boolean is not consulted and not returned:
    // there is nothing a caller could do with it, and a move that behaved differently
    // for a walk-in would be a move with two meanings.
    supersedeMock.mockResolvedValue(false);

    const dispensed = await dispensePrescription(APPROVER, PRESCRIPTION);

    expect(supersedeMock).toHaveBeenCalledTimes(1);
    expect(dispensed.id).toBe(PRESCRIPTION);
  });
});

describe('rejectPrescription', () => {
  it('is available from both pending and approved, and stops the reminder either way', async () => {
    await rejectPrescription(APPROVER, PRESCRIPTION);

    expect(patchOf()).toStrictEqual({
      status: 'rejected',
      allowedFrom: ['pending', 'approved'],
    });
    expect(supersedeMock).toHaveBeenCalledWith(
      CLIENT,
      PHARMACY,
      PRESCRIPTION,
      NOT_SUPPLYING_REASON
    );
  });

  it('records the refusal with no reason attached, because the schema has nowhere to put one', async () => {
    // A gap rather than a choice to hide one: composing a reason into `notes` would
    // either overwrite what a pharmacist wrote or append in a format nothing can parse.
    // A reason of its own is a column, and a column is a migration to decide with A&B.
    await rejectPrescription(APPROVER, PRESCRIPTION);

    expect(patchOf()).not.toHaveProperty('notes');
  });
});

describe('correctPrescription', () => {
  it('refuses a body that changes nothing, rather than answering with an unchanged row', async () => {
    const error = await expectHttpError(
      correctPrescription(APPROVER, PRESCRIPTION, {}),
      400,
      'nothing_to_update'
    );
    expect(error.message).toBe('Nothing to change — send at least one field to correct');
    // Refused before a transaction is opened: there is nothing to read and nothing to
    // roll back, and a silent no-op is a frontend that believes it saved something it
    // did not send.
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('keeps absent and null apart, so a patch cannot clear what nobody mentioned', async () => {
    await correctPrescription(APPROVER, PRESCRIPTION, { notes: null });

    expect(patchOf()).toStrictEqual({ notes: null, allowedFrom: [...PRESCRIPTION_STATUSES] });
    expect(patchOf()).not.toHaveProperty('patientId');
    expect(patchOf()).not.toHaveProperty('saleId');
    expect(patchOf()).not.toHaveProperty('prescriberName');
  });

  it('carries no status, because correcting a typo is not a clinical decision', async () => {
    // A patch that could carry one would be a second route into every transition this
    // module guards, and it would not go through `allowedFromFor` on the way.
    await correctPrescription(APPROVER, PRESCRIPTION, {
      notes: 'Corrected',
      status: 'dispensed',
    } as unknown as PrescriptionCorrection);

    expect(patchOf()).not.toHaveProperty('status');
    expect(patchOf().notes).toBe('Corrected');
  });

  it('is allowed from every status, including dispensed', async () => {
    await correctPrescription(APPROVER, PRESCRIPTION, { prescriberName: 'Dr Kwame Osei' });

    expect(patchOf().allowedFrom).toEqual([...PRESCRIPTION_STATUSES]);
    // A typo on a dispensed prescription is still a typo, and refusing to fix it would
    // leave wrong information on the one row that says medicine went out.
    expect(patchOf().allowedFrom).toContain('dispensed');
  });

  it('stops the reminder when the prescription is moved to a different patient', async () => {
    await correctPrescription(APPROVER, PRESCRIPTION, { patientId: OTHER_PATIENT });

    expect(findPatientMock).toHaveBeenCalledWith(CLIENT, PHARMACY, OTHER_PATIENT);
    // `reminders.patient_id` is a copy taken when the reminder was raised, so leaving it
    // alone would text the *original* patient about medicine prepared for somebody else.
    // That is one patient's information going to another.
    expect(supersedeMock).toHaveBeenCalledWith(CLIENT, PHARMACY, PRESCRIPTION, REATTACHED_REASON);
  });

  it('does not stop it when the patient is restated as the one already there', async () => {
    await correctPrescription(APPROVER, PRESCRIPTION, { patientId: PATIENT });

    expect(patchOf().patientId).toBe(PATIENT);
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  it('does stop it when the patient is cleared, and looks nobody up to do it', async () => {
    // The pair with the test above, and the subtle half: `null` is not the same patient,
    // so it is a re-attachment — but there is no new patient to validate, so the lookup
    // that a re-attachment normally causes does not happen.
    await correctPrescription(APPROVER, PRESCRIPTION, { patientId: null });

    expect(patchOf().patientId).toBeNull();
    expect(findPatientMock).not.toHaveBeenCalled();
    expect(supersedeMock).toHaveBeenCalledWith(CLIENT, PHARMACY, PRESCRIPTION, REATTACHED_REASON);
  });

  it('refuses a patient who is not on this register, and changes nothing', async () => {
    findPatientMock.mockResolvedValue(null);

    const error = await expectHttpError(
      correctPrescription(APPROVER, PRESCRIPTION, { patientId: OTHER_PATIENT }),
      404,
      'not_found'
    );
    expect(error.message).toBe('No patient matches that id');
    expect(updateMock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
  });
});

describe('the reads', () => {
  it('counts the same rows it listed, minus the paging and the ordering', async () => {
    const asked = filters({
      patientId: PATIENT,
      statuses: ['pending', 'approved'],
      from: '2026-09-01',
      to: '2026-09-05',
      order: 'oldest',
      limit: 20,
      offset: 40,
    });

    await listPrescriptionPage(PHARMACY, asked);

    expect(listMock).toHaveBeenCalledWith(poolSql, PHARMACY, asked);
    expect(counted()).toStrictEqual({
      patientId: PATIENT,
      statuses: ['pending', 'approved'],
      from: '2026-09-01',
      to: '2026-09-05',
    });
  });

  it('reads both outside a transaction, because a queue is not worth a lock across two queries', async () => {
    await listPrescriptionPage(PHARMACY, filters());

    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(listMock).toHaveBeenCalledWith(poolSql, expect.anything(), expect.anything());
    expect(countMock).toHaveBeenCalledWith(poolSql, expect.anything(), expect.anything());
  });

  it('carries the badge number beside the page, from the count and not from the list length', async () => {
    countMock.mockResolvedValue(7);
    listMock.mockResolvedValue([row(), row({ id: OTHER_PATIENT })]);

    const page = await listPrescriptionPage(PHARMACY, filters({ limit: 2 }));

    // A badge reading 7 above a list of two rows is the disagreement `countPrescriptions`
    // exists to prevent, and two numbers from two calls are two numbers that can disagree
    // — which is why they share one `FILTERS` definition in the repository.
    expect(page).toStrictEqual({
      prescriptions: [row(), row({ id: OTHER_PATIENT })],
      total: 7,
      limit: 2,
      offset: 0,
    });
  });

  it('answers 404 for a prescription that is not there', async () => {
    findMock.mockResolvedValue(null);

    const error = await expectHttpError(getPrescription(PHARMACY, PRESCRIPTION), 404, 'not_found');
    expect(error.message).toBe('No prescription matches that id');
    expect(findMock).toHaveBeenCalledWith(poolSql, PHARMACY, PRESCRIPTION);
  });
});
