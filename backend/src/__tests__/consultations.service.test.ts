jest.mock('../database/pool', () => ({
  poolSql: { query: jest.fn() },
  withTransaction: jest.fn(),
}));

jest.mock('../repositories/patients.repository', () => ({
  // Only the export this service reads. The other four are `patients.service`'s
  // and nothing in this module graph imports them.
  findPatient: jest.fn(),
}));

jest.mock('../repositories/users.repository', () => ({
  // Same reason. `resolveConductor` reads one user by id and nothing else here
  // touches the staff register.
  findUserById: jest.fn(),
}));

jest.mock('../repositories/consultations.repository', () => ({
  createConsultation: jest.fn(),
  findConsultation: jest.fn(),
  listConsultations: jest.fn(),
  updateConsultation: jest.fn(),
}));

jest.mock('../repositories/reminders.repository', () => ({
  scheduleReminder: jest.fn(),
  supersedeAppointmentReminders: jest.fn(),
}));

jest.mock('../utils/clock', () => ({
  // A spy rather than fake timers. The claims below are about which instant the
  // reminder was reasoned about and about the order two repository calls happened
  // in, and neither is a fact about the wall clock.
  nowIso: jest.fn(),
}));

import type { PoolClient } from 'pg';
import { poolSql, withTransaction } from '../database/pool';
import { findPatient } from '../repositories/patients.repository';
import { findUserById, type UserRow } from '../repositories/users.repository';
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
  type NewReminder,
  scheduleReminder,
  supersedeAppointmentReminders,
} from '../repositories/reminders.repository';
import {
  APPOINTMENT_REMINDER_LEAD_MS,
  APPOINTMENT_TIME_ZONE,
  SUPERSEDE_ALL_KEYS,
  appointmentReminderFor,
  bookConsultation,
  endConsultation,
  getConsultation,
  listConsultationPage,
  rescheduleConsultation,
  videoUrlFrom,
  type ConsultationInput,
  type RescheduleInput,
} from '../services/consultations.service';
import { PHARMACY_NAME, SMS_BODY_MAX_LENGTH } from '../services/sms';
import { nowIso } from '../utils/clock';
import { HttpError } from '../utils/http';
import type { UserRole } from '../utils/permissions';
import { appointmentReminderKey } from '../utils/reminder-keys';
import type { ConsultationStatus } from '../utils/schema-enums';

/**
 * Booking an appointment, moving it, ending it — and the reminder that has to move
 * and end with it.
 *
 * ## The thing this suite exists to hold
 *
 * `reminders` has no `consultation_id`. It points at an appointment only through
 * `dedupe_key`, which `utils/reminder-keys.ts` builds from the consultation's id
 * *and its slot*. That indirection is what makes the failure mode here silent: a
 * reschedule that computes the wrong key supersedes nothing, and the stale reminder
 * stays `pending`, stays due, stays in the index that exists for exactly that query,
 * and fires. Nothing errors. The patient is told to attend a slot that no longer
 * exists.
 *
 * So the key is asserted byte for byte, against the real `appointmentReminderKey`
 * rather than a string written out here, and it is asserted to be built from the
 * **stored** spelling of the instant rather than the parsed one — because a
 * reschedule reads the row back out of the database, and two spellings of one
 * instant are two keys.
 *
 * ## The three-way patch, which is not a two-way one
 *
 * `updateConsultation` writes four nullable columns with `case when $n::boolean`,
 * so `undefined` means "leave it alone" and `null` means "clear it". A reschedule
 * that collapsed the two would wipe a meeting link and a duration on every booking
 * moved without restating them, and the row would still look perfectly ordinary.
 * `toStrictEqual` rather than `toEqual` throughout the patch assertions, because
 * `toEqual` treats `{ videoUrl: undefined }` and `{}` as the same object and the
 * difference is the whole claim.
 *
 * ## What is deliberately not mocked
 *
 * `services/sms.ts` and `utils/reminder-keys.ts`. Both are real modules with real
 * rules — the pharmacy's trading name, the two-segment body limit, the key shapes —
 * and stubbing either would make the assertions below true by agreement.
 * `utils/permissions.ts` is real for the same reason: that counter staff cannot hold
 * a consultation is `can()`'s answer, not this service's.
 */

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const OTHER_PHARMACY = 'a0000000-0000-4000-8000-000000000009';
const OWNER = 'a0000000-0000-4000-8000-000000000002';
const PHARMACIST = 'a0000000-0000-4000-8000-000000000003';
const CASHIER = 'a0000000-0000-4000-8000-000000000004';
const PATIENT = 'a0000000-0000-4000-8000-000000000040';
const CONSULTATION = 'a0000000-0000-4000-8000-000000000070';

const PHARMACIST_NAME = 'Dr Ama Boateng';
const CASHIER_NAME = 'Kofi Mensah';
const STORED_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpMbS0nVBM7iFtXJGvYxQmC5nqJZS';

/** What `nowIso` answers for the whole suite, so "still to come" is a fixed fact. */
const NOW = '2026-09-05T09:30:00.000Z';

/** Far enough ahead that the reminder's due instant is a day before it. */
const NEXT_WEEK = '2026-09-12T09:00:00.000Z';
/** Close enough that a day before it is already past. */
const SOON = '2026-09-05T15:00:00.000Z';
const PAST = '2026-09-01T09:00:00.000Z';

/**
 * An instant whose Accra rendering and Tokyo rendering disagree about the day as
 * well as the hour.
 *
 * `jest.config.js` sets `process.env.TZ = 'Asia/Tokyo'`, so a formatter that
 * forgot to name its zone would say "Friday, 11 September 2026" and "07:30" here.
 * Picking an instant where only the zone explains the answer is what makes the
 * assertion about `APPOINTMENT_TIME_ZONE` rather than about a coincidence — Ghana
 * is UTC+0 with no daylight saving, so half the year an offset-free rendering
 * happens to look right.
 */
const ACCRA_INSTANT = '2026-09-10T22:30:00.000Z';

const LINK = 'https://meet.example/room/9';

const CLIENT = { query: jest.fn() } as unknown as PoolClient;

const withTransactionMock = withTransaction as jest.Mock;
const createMock = createConsultation as jest.Mock;
const findMock = findConsultation as jest.Mock;
const listMock = listConsultations as jest.Mock;
const updateMock = updateConsultation as jest.Mock;
const findPatientMock = findPatient as jest.Mock;
const findUserByIdMock = findUserById as jest.Mock;
const scheduleMock = scheduleReminder as jest.Mock;
const supersedeMock = supersedeAppointmentReminders as jest.Mock;
const nowMock = nowIso as jest.Mock;

const ACTOR = { userId: OWNER, pharmacyId: PHARMACY };

/**
 * `findPatient`'s answer.
 *
 * A stub rather than a whole `PatientRow`, because the service reads exactly one
 * thing from it — whether it is null.
 */
const FOUND_PATIENT = { id: PATIENT, pharmacyId: PHARMACY };

let users: Record<string, UserRow>;

function staff(id: string, role: UserRole, overrides: Partial<UserRow> = {}): UserRow {
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
    ...overrides,
  };
}

/** Complete rows, so a new required column stops this file compiling. */
function row(overrides: Partial<ConsultationRow> = {}): ConsultationRow {
  return {
    id: CONSULTATION,
    pharmacyId: PHARMACY,
    patientId: PATIENT,
    conductedBy: PHARMACIST,
    type: 'in_person',
    status: 'scheduled',
    scheduledAt: NEXT_WEEK,
    durationMinutes: 30,
    videoUrl: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** What the booking form posts: an in-person visit next week, minus everything else. */
function booking(overrides: Partial<ConsultationInput> = {}): ConsultationInput {
  return {
    patientId: PATIENT,
    type: 'in_person',
    // Deliberately a *different spelling* of `NEXT_WEEK` — no milliseconds — so the
    // normalisation on the way in is visible rather than assumed.
    scheduledAt: '2026-09-12T09:00:00Z',
    ...overrides,
  };
}

/** What a reschedule posts: a new time, and nothing else mentioned. */
function reschedule(overrides: Partial<RescheduleInput> = {}): RescheduleInput {
  return { scheduledAt: '2026-09-12T09:00:00Z', ...overrides };
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

/**
 * Asserts a field refusal in full, in the envelope `runValidation` produces.
 *
 * A helper rather than repetition, because the claim is that every one of these is
 * indistinguishable in shape from the ones `utils/validate.ts` produces — and a
 * helper that checked the shape once would let a later refusal drift into a second
 * kind of 400.
 */
async function expectFieldError(
  promise: Promise<unknown>,
  field: string,
  message: string
): Promise<HttpError> {
  const error = await expectHttpError(promise, 400, 'validation_failed');
  expect(error.details).toEqual([{ field, message }]);
  return error;
}

function booked(): NewConsultation {
  const call = createMock.mock.calls[0];
  if (call === undefined) throw new Error('createConsultation was never called');
  return (call as unknown[])[1] as NewConsultation;
}

function patchOf(): ConsultationPatch {
  const call = updateMock.mock.calls[0];
  if (call === undefined) throw new Error('updateConsultation was never called');
  return (call as unknown[])[3] as ConsultationPatch;
}

function reminded(): NewReminder {
  const call = scheduleMock.mock.calls[0];
  if (call === undefined) throw new Error('scheduleReminder was never called');
  return (call as unknown[])[1] as NewReminder;
}

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
    [OWNER]: staff(OWNER, 'pharmacy_owner'),
    [PHARMACIST]: staff(PHARMACIST, 'pharmacist'),
    [CASHIER]: staff(CASHIER, 'staff'),
  };
  nowMock.mockReturnValue(NOW);
  withTransactionMock.mockImplementation(
    async (work: (client: PoolClient) => Promise<unknown>) => work(CLIENT)
  );
  findPatientMock.mockResolvedValue(FOUND_PATIENT);
  findUserByIdMock.mockImplementation(async (id: string) => users[id] ?? null);
  createMock.mockResolvedValue(row());
  findMock.mockResolvedValue(row());
  updateMock.mockResolvedValue(row());
  listMock.mockResolvedValue([row()]);
  scheduleMock.mockResolvedValue({ scheduled: true, reminder: null });
  supersedeMock.mockResolvedValue(1);
});

describe('the meeting link', () => {
  it('answers null for every spelling of "there is no link"', () => {
    for (const value of [undefined, null, '', '   ']) {
      expect({ value: JSON.stringify(value), link: videoUrlFrom(value) }).toEqual({
        value: JSON.stringify(value),
        link: null,
      });
    }
  });

  it('keeps an https link, trimmed, and accepts a scheme written in capitals', () => {
    expect(videoUrlFrom(`  ${LINK}  `)).toBe(LINK);
    // `new URL` lowercases the scheme, so `HTTPS://` is the same link and refusing
    // it would be refusing a paste from a document that capitalised it.
    expect(videoUrlFrom('HTTPS://meet.example/room/9')).toBe(LINK);
  });

  it('refuses a javascript: URL, and a data: URL, by allowlist rather than by blocklist', () => {
    for (const value of [
      'javascript:alert(document.cookie)',
      'JaVaScRiPt:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'file:///etc/passwd',
    ]) {
      const error = videoUrlRefusal(value);
      // The value ends up in an `href` on the consultation page, so a stored scheme
      // is a stored script. Refusing everything that is not the one scheme a video
      // call is hosted on leaves nothing to remember; a blocklist of `javascript:`
      // and `data:` is a list of the schemes somebody thought of.
      expect({ value, message: error.message }).toEqual({
        value,
        message: 'The meeting link must start with https://',
      });
      expect(error.details).toEqual([
        {
          field: 'videoUrl',
          message:
            'Only an https link can be stored, because it is opened from a page served over https',
        },
      ]);
    }
  });

  it('refuses plain http, which is a privacy problem rather than a script one', () => {
    const error = videoUrlRefusal('http://meet.example/room/9');
    expect(error.message).toBe('The meeting link must start with https://');
  });

  it('refuses something that is not a web address at all, in different words', () => {
    const error = videoUrlRefusal('meet.example/room/9');
    expect(error.message).toBe(
      'Enter the meeting link as a full web address, starting https://'
    );
    expect(error.details).toEqual([
      { field: 'videoUrl', message: 'That is not a web address' },
    ]);
  });
});

/** One place to assert the shape of a link refusal, so the four above can differ. */
function videoUrlRefusal(value: string): HttpError {
  let thrown: unknown = null;
  try {
    videoUrlFrom(value);
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof HttpError)) {
    throw new Error(`expected ${value} to be refused, and it was not`);
  }
  expect(thrown.status).toBe(400);
  expect(thrown.code).toBe('validation_failed');
  return thrown;
}

describe('the reminder an appointment raises', () => {
  it('raises nothing for an appointment that has already happened', () => {
    expect(appointmentReminderFor(PAST, NOW)).toBeNull();
  });

  it('raises nothing for one that is starting now', () => {
    // `<=` and not `<`. An appointment at this exact instant is not one the patient
    // can still be told to attend, and a reminder due now for a slot starting now
    // is a text that arrives while they are sitting in the chair.
    expect(appointmentReminderFor(NOW, NOW)).toBeNull();
  });

  it('raises nothing for an instant that does not parse, on either side', () => {
    expect(appointmentReminderFor('next Tuesday', NOW)).toBeNull();
    expect(appointmentReminderFor(NEXT_WEEK, 'whenever')).toBeNull();
  });

  it('dues one a day ahead of an appointment that is further off than that', () => {
    const planned = appointmentReminderFor(NEXT_WEEK, NOW);
    if (planned === null) throw new Error('no reminder was planned');

    expect(planned.dueAt).toBe('2026-09-11T09:00:00.000Z');
    expect(Date.parse(NEXT_WEEK) - Date.parse(planned.dueAt)).toBe(
      APPOINTMENT_REMINDER_LEAD_MS
    );
  });

  it('never dues a reminder before the row that holds it', () => {
    const planned = appointmentReminderFor(SOON, NOW);
    if (planned === null) throw new Error('no reminder was planned');

    // Booked three hours ahead, so a day before it is yesterday. `due_at` cannot
    // precede the row, and the honest answer is the next scheduler run rather than
    // no reminder at all — the patient still gets told, just not a day early.
    expect(planned.dueAt).toBe(NOW);
  });

  it('names the clock on the wall in Accra rather than the server\'s', () => {
    const planned = appointmentReminderFor(ACCRA_INSTANT, NOW);
    if (planned === null) throw new Error('no reminder was planned');

    // The suite runs with `TZ=Asia/Tokyo`. A formatter that inherited the server's
    // zone would say Friday, 11 September and 07:30 for this instant.
    expect(planned.message).toContain('Thursday, 10 September 2026');
    expect(planned.message).toContain('22:30');
    expect(APPOINTMENT_TIME_ZONE).toBe('Africa/Accra');
  });

  it('signs itself with the pharmacy, and stays inside two GSM segments', () => {
    const planned = appointmentReminderFor(ACCRA_INSTANT, NOW);
    if (planned === null) throw new Error('no reminder was planned');

    expect(planned.message).toContain(PHARMACY_NAME);
    expect(planned.message.length).toBeLessThanOrEqual(SMS_BODY_MAX_LENGTH);
    // Plain ASCII, asserted rather than trusted: one character outside GSM 7-bit's
    // default alphabet moves the whole message to UCS-2 and halves the characters a
    // segment carries, which is how a body that fits stops fitting. `A&B` is in the
    // default alphabet; a curly apostrophe in the trading name would not be.
    expect(/[^\u0020-\u007E]/.test(planned.message)).toBe(false);
    expect(planned.message).toBe(
      'Your appointment at A&B Chemist is on Thursday, 10 September 2026 at 22:30. ' +
        'Please call the pharmacy if you need to change it.'
    );
  });
});

describe('bookConsultation', () => {
  it('books the appointment with no status, because a booking cannot arrive finished', async () => {
    await bookConsultation(ACTOR, booking({ conductedBy: PHARMACIST }));

    expect(booked()).toStrictEqual({
      pharmacyId: PHARMACY,
      patientId: PATIENT,
      conductedBy: PHARMACIST,
      type: 'in_person',
      scheduledAt: NEXT_WEEK,
      durationMinutes: null,
      videoUrl: null,
      notes: null,
    });
    // The structural guarantee `consultations.repository.ts` makes: the insert
    // names eight columns and `status` is not one of them, so there is no
    // parameter a caller could create a `completed` consultation through.
    expect(booked()).not.toHaveProperty('status');
  });

  it('normalises the instant on the way in', async () => {
    await bookConsultation(ACTOR, booking());
    // `2026-09-12T09:00:00Z` in, `.000Z` out — the spelling `mapConsultation` will
    // read back, which is the spelling a reschedule has to reproduce to find this
    // reminder by prefix.
    expect(booked().scheduledAt).toBe(NEXT_WEEK);
  });

  it('looks the patient up inside the transaction, and answers 404 without writing', async () => {
    findPatientMock.mockResolvedValue(null);
    const error = await expectHttpError(
      bookConsultation(ACTOR, booking()),
      404,
      'not_found'
    );

    expect(error.message).toBe('No patient matches that id');
    // `CLIENT`, not `expect.anything()`: without the lookup on the transaction's own
    // connection, a patient removed a moment earlier turns the 404 into a foreign-key
    // violation — a 500 naming a constraint, which is a schema disclosure as well as
    // the wrong status.
    expect(findPatientMock).toHaveBeenCalledWith(CLIENT, PHARMACY, PATIENT);
    expect(createMock).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('raises the reminder in the same transaction, keyed to the row', async () => {
    await bookConsultation(ACTOR, booking());

    expect(scheduleMock).toHaveBeenCalledWith(CLIENT, {
      pharmacyId: PHARMACY,
      patientId: PATIENT,
      kind: 'appointment',
      dueAt: '2026-09-11T09:00:00.000Z',
      message: expect.stringContaining(PHARMACY_NAME),
      dedupeKey: appointmentReminderKey(CONSULTATION, NEXT_WEEK),
    });
    expect(reminded().dedupeKey).toBe(`appointment:${CONSULTATION}:${NEXT_WEEK}`);
  });

  it('builds the key from the stored spelling of the instant, not the parsed one', async () => {
    const stored = '2026-09-12T09:00:00.500Z';
    createMock.mockResolvedValue(row({ scheduledAt: stored }));

    await bookConsultation(ACTOR, booking());

    // The two describe one instant and only one of them is the key. A reschedule
    // reads the row back out of the database and builds its prefix from that, so a
    // key built here from the parsed input would not match the reminder it was
    // supposed to supersede — and nothing anywhere would error.
    expect(reminded().dedupeKey).toBe(appointmentReminderKey(CONSULTATION, stored));
    expect(reminded().dedupeKey).not.toBe(appointmentReminderKey(CONSULTATION, NEXT_WEEK));
  });

  it('raises nothing for an appointment booked into the past', async () => {
    createMock.mockResolvedValue(row({ scheduledAt: PAST }));
    await bookConsultation(ACTOR, booking({ scheduledAt: PAST }));

    // Not an edge case: a consultation recorded after it happened is a record of
    // something that took place, and a reminder for it is a text telling somebody to
    // attend an appointment they were sitting in.
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('refuses an instant that does not parse, before opening a transaction', async () => {
    const error = await expectFieldError(
      bookConsultation(ACTOR, booking({ scheduledAt: 'next Tuesday' })),
      'scheduledAt',
      'That is not a date and time'
    );
    expect(error.message).toBe('Enter the date and time of the appointment');
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('refuses a link that is not https, before opening a transaction', async () => {
    await expectHttpError(
      bookConsultation(ACTOR, booking({ videoUrl: 'javascript:alert(1)' })),
      400,
      'validation_failed'
    );
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a length that is not a whole number of minutes, before opening a transaction', async () => {
    for (const durationMinutes of [-5, 2.5]) {
      await expectFieldError(
        bookConsultation(ACTOR, booking({ durationMinutes })),
        'durationMinutes',
        'Enter a whole number of minutes'
      );
    }
    // The schema says the same with `check (duration_minutes is null or
    // duration_minutes >= 0)`, and a CHECK violation would arrive as a 500 whose
    // message the error middleware withholds in production.
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('books an unheld appointment without looking anybody up', async () => {
    await bookConsultation(ACTOR, booking());
    expect(findUserByIdMock).not.toHaveBeenCalled();
    expect(booked().conductedBy).toBeNull();
  });

  it('refuses a conductor who does not work here, in the same words as one who does not exist', async () => {
    // One message for both, deliberately: telling them apart hands a caller a way to
    // enumerate which user ids exist in another tenant.
    for (const conductedBy of [CASHIER, 'a0000000-0000-4000-8000-0000000000ff']) {
      users[conductedBy] = staff(conductedBy, 'pharmacist', { pharmacyId: OTHER_PHARMACY });
      const error = await expectHttpError(
        bookConsultation(ACTOR, booking({ conductedBy })),
        404,
        'not_found'
      );
      expect({ conductedBy, message: error.message }).toEqual({
        conductedBy,
        message: 'No member of staff matches that id',
      });
    }
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('refuses a login that is no longer active, naming the person', async () => {
    users[PHARMACIST] = staff(PHARMACIST, 'pharmacist', { isActive: false });
    const error = await expectHttpError(
      bookConsultation(ACTOR, booking({ conductedBy: PHARMACIST })),
      400,
      'conductor_inactive'
    );
    expect(error.message).toBe(
      `${PHARMACIST_NAME} cannot hold this consultation: that login is no longer active`
    );
    expect(error.details).toEqual({ field: 'conductedBy' });
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('refuses counter staff as a conductor, because they could not have booked it either', async () => {
    const error = await expectHttpError(
      bookConsultation(ACTOR, booking({ conductedBy: CASHIER })),
      400,
      'conductor_not_permitted'
    );
    expect(error.message).toBe(
      `${CASHIER_NAME} cannot hold this consultation. A pharmacist or the owner has to.`
    );
    expect(error.details).toEqual({ field: 'conductedBy' });
  });

  it('resolves the conductor through the pool, not through the transaction', async () => {
    await bookConsultation(ACTOR, booking({ conductedBy: PHARMACIST }));

    // One argument and no client: `findUserById` reads through the module-level pool
    // and cannot join a transaction, so resolving it inside one would be a claim
    // about all-or-nothing the code could not back. The lookup therefore happens
    // before the transaction opens, which is why every refusal above asserts that
    // nothing was written rather than that a write was rolled back.
    expect(findUserByIdMock).toHaveBeenCalledWith(PHARMACIST);
    expect(booked().conductedBy).toBe(PHARMACIST);
  });
});

describe('rescheduleConsultation', () => {
  it('moves the time and leaves everything nobody mentioned alone', async () => {
    await rescheduleConsultation(ACTOR, CONSULTATION, reschedule());

    // `toStrictEqual`, because `toEqual` treats `{ videoUrl: undefined }` and `{}` as
    // the same object and the difference is the entire claim: the repository reads
    // `patch.x !== undefined` to decide whether to write the column at all.
    expect(patchOf()).toStrictEqual({
      scheduledAt: NEXT_WEEK,
      conductedBy: undefined,
      durationMinutes: undefined,
      videoUrl: undefined,
      notes: undefined,
      allowedFrom: ['scheduled'],
    });
    // And no `type` key: a reschedule that moved an in-person visit to next week
    // should not have to restate that it is in person.
    expect(patchOf()).not.toHaveProperty('type');
    expect(updateMock).toHaveBeenCalledWith(CLIENT, PHARMACY, CONSULTATION, patchOf());
  });

  it('keeps a meeting link and a length that the request did not restate', async () => {
    findMock.mockResolvedValue(row({ type: 'video', videoUrl: LINK, durationMinutes: 45 }));
    updateMock.mockResolvedValue(row({ type: 'video', videoUrl: LINK, durationMinutes: 45 }));

    await rescheduleConsultation(ACTOR, CONSULTATION, reschedule());

    // The failure this pins is silent and it is the reason the route builds its
    // `RescheduleInput` field by field with five spreads: a video appointment moved
    // to next week by a form that posts only the new time would come back with no
    // link and no length, and the row would still look perfectly ordinary.
    expect(patchOf().videoUrl).toBeUndefined();
    expect(patchOf().durationMinutes).toBeUndefined();
    expect(patchOf().conductedBy).toBeUndefined();
    expect(patchOf().notes).toBeUndefined();
  });

  it('takes the link away when a video consultation moves to a counter visit', async () => {
    findMock.mockResolvedValue(row({ type: 'video', videoUrl: LINK }));
    await rescheduleConsultation(ACTOR, CONSULTATION, reschedule({ type: 'in_person' }));

    // An explicit null, and only here. A `coalesce` in the statement would keep
    // handing out an address for a meeting that is now happening across a counter.
    expect(patchOf().type).toBe('in_person');
    expect(patchOf().videoUrl).toBeNull();
  });

  it('takes the link away even when the request restated it', async () => {
    findMock.mockResolvedValue(row({ type: 'video', videoUrl: LINK }));
    await rescheduleConsultation(
      ACTOR,
      CONSULTATION,
      reschedule({ type: 'phone', videoUrl: 'https://meet.example/room/10' })
    );
    // The type wins over the field: a phone consultation has no meeting to join, and
    // storing a link beside it is storing an address the page will offer.
    expect(patchOf().videoUrl).toBeNull();
  });

  it('answers 404 for a consultation that is not there, and changes nothing', async () => {
    findMock.mockResolvedValue(null);
    const error = await expectHttpError(
      rescheduleConsultation(ACTOR, CONSULTATION, reschedule()),
      404,
      'not_found'
    );
    expect(error.message).toBe('No consultation matches that id');
    expect(findMock).toHaveBeenCalledWith(CLIENT, PHARMACY, CONSULTATION);
    expect(updateMock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  it('answers 409 rather than 404 when the guard refused, naming the state it is in', async () => {
    findMock.mockResolvedValue(row({ status: 'completed' }));
    updateMock.mockResolvedValue(null);

    const error = await expectHttpError(
      rescheduleConsultation(ACTOR, CONSULTATION, reschedule()),
      409,
      'consultation_not_movable'
    );
    // Found on the line above and refused by the guard, so this is the status rather
    // than the id. One consultation has already happened; the other is a stale link
    // in somebody's browser, and the two are different sentences.
    expect(error.message).toBe(
      'This consultation is completed, so its time can no longer be changed'
    );
    expect(error.details).toEqual({ status: 'completed' });
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('stops the old reminder before raising the new one, and keeps the new one out of the sweep', async () => {
    await rescheduleConsultation(ACTOR, CONSULTATION, reschedule());

    const keepDedupeKey = appointmentReminderKey(CONSULTATION, NEXT_WEEK);
    expect(superseded().keepDedupeKey).toBe(keepDedupeKey);
    // The `dedupe_key <> $2` clause exists so a reschedule can raise the new reminder
    // without immediately cancelling it. Excluding nothing here would supersede the
    // row the same transaction is about to write.
    expect(superseded().keepDedupeKey).not.toBe(SUPERSEDE_ALL_KEYS);
    expect(superseded().reason).toBe(
      'The appointment moved to Saturday, 12 September 2026 at 09:00, so this reminder ' +
        'is for a time that is no longer booked.'
    );
    expect(reminded().dedupeKey).toBe(keepDedupeKey);

    // The order is the readable one and both are in one transaction, so it cannot
    // leave a half-done state — but "stop telling the patient about the old slot,
    // then tell them about the new one" is a claim about the code, and this is where
    // it is checked rather than in the comment.
    const stopped = supersedeMock.mock.invocationCallOrder[0];
    const raised = scheduleMock.mock.invocationCallOrder[0];
    if (stopped === undefined || raised === undefined) {
      throw new Error('one of the two reminder calls did not happen');
    }
    expect(stopped).toBeLessThan(raised);
  });

  it('supersedes the old reminder and raises nothing when the new slot has already passed', async () => {
    updateMock.mockResolvedValue(row({ scheduledAt: PAST }));
    await rescheduleConsultation(ACTOR, CONSULTATION, reschedule({ scheduledAt: PAST }));

    // Moving an appointment into the past is a record of something that took place.
    // The stale reminder still has to go — it is for a slot nobody is booked into —
    // and no new one is raised to replace it.
    expect(superseded().keepDedupeKey).toBe(appointmentReminderKey(CONSULTATION, PAST));
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('refuses a link that is not https, and a length that is not a number of minutes', async () => {
    await expectHttpError(
      rescheduleConsultation(ACTOR, CONSULTATION, reschedule({ videoUrl: 'http://meet.example' })),
      400,
      'validation_failed'
    );
    await expectFieldError(
      rescheduleConsultation(ACTOR, CONSULTATION, reschedule({ durationMinutes: -1 })),
      'durationMinutes',
      'Enter a whole number of minutes'
    );
    expect(updateMock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  it('checks a conductor named on a reschedule, and lets an explicit null unassign one', async () => {
    await rescheduleConsultation(ACTOR, CONSULTATION, reschedule({ conductedBy: null }));
    // Legitimate on its own: a pharmacist calling in sick leaves the appointment
    // booked and unheld rather than cancelled, so this needs no lookup.
    expect(findUserByIdMock).not.toHaveBeenCalled();
    expect(patchOf().conductedBy).toBeNull();

    // Naming somebody is the other half, and this is where the check lives: a
    // reschedule is the one operation that can move an appointment to a person,
    // so a cashier named here would end up holding a consultation they cannot
    // conduct, and the booking route is the only other place that could have said
    // no.
    const error = await expectHttpError(
      rescheduleConsultation(ACTOR, CONSULTATION, reschedule({ conductedBy: CASHIER })),
      400,
      'conductor_not_permitted'
    );
    expect(error.message).toBe(
      `${CASHIER_NAME} cannot hold this consultation. A pharmacist or the owner has to.`
    );
    expect(error.details).toEqual({ field: 'conductedBy' });
    // `resolveConductor` runs before the transaction is opened, so the one patch
    // that reached the repository is still the first call's.
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});

describe('endConsultation', () => {
  const ENDINGS: [Exclude<ConsultationStatus, 'scheduled'>, string, string][] = [
    ['completed', 'completed', 'The appointment has already taken place.'],
    [
      'cancelled',
      'cancelled',
      'The appointment was cancelled, so there is nothing to remind about.',
    ],
    [
      'no_show',
      'no show',
      'The appointment was not attended, so there is nothing to remind about.',
    ],
  ];

  it.each(ENDINGS)(
    'marks one %s, and supersedes everything still pending for it',
    async (status, _phrase, reason) => {
      await endConsultation(ACTOR, CONSULTATION, status);

      expect(patchOf()).toStrictEqual({ status, allowedFrom: ['scheduled'] });
      // `SUPERSEDE_ALL_KEYS` is the empty string, and the empty string is the value
      // that expresses "keep nothing": every key this system writes begins with
      // `appointment:` or `refill:`, so `dedupe_key <> ''` excludes no row. A
      // reminder that fires after the appointment ended tells a patient to attend
      // something that already happened.
      expect(superseded().keepDedupeKey).toBe(SUPERSEDE_ALL_KEYS);
      expect(superseded().reason).toBe(reason);
      // One function for all three endings, because the reminder rule is the same
      // for each and only the sentence differs — three functions would be three
      // places to forget it.
      expect(scheduleMock).not.toHaveBeenCalled();
    }
  );

  it('answers 409 with the ending in words, when the consultation already moved', async () => {
    findMock.mockResolvedValue(row({ status: 'cancelled' }));
    updateMock.mockResolvedValue(null);

    const error = await expectHttpError(
      endConsultation(ACTOR, CONSULTATION, 'no_show'),
      409,
      'consultation_not_movable'
    );
    // `no_show` reaches the sentence as "no show", because an underscore is not a
    // word a person at a counter reads.
    expect(error.message).toBe(
      'This consultation is cancelled, so it cannot be marked no show'
    );
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  it('answers 404 for a consultation that is not there', async () => {
    findMock.mockResolvedValue(null);
    await expectHttpError(endConsultation(ACTOR, CONSULTATION, 'completed'), 404, 'not_found');
    expect(updateMock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
  });
});

describe('the reads', () => {
  it('answers one consultation through the pool, and 404 for a miss', async () => {
    await expect(getConsultation(PHARMACY, CONSULTATION)).resolves.toEqual(row());
    expect(findMock).toHaveBeenCalledWith(poolSql, PHARMACY, CONSULTATION);

    findMock.mockResolvedValue(null);
    const error = await expectHttpError(
      getConsultation(PHARMACY, CONSULTATION),
      404,
      'not_found'
    );
    expect(error.message).toBe('No consultation matches that id');
  });

  it('hands the diary its filters untouched, and returns no total', async () => {
    const filters: ConsultationFilters = {
      patientId: PATIENT,
      statuses: ['scheduled'],
      conductedBy: PHARMACIST,
      from: '2026-09-01',
      to: '2026-09-30',
      order: 'upcoming',
      limit: 50,
      offset: 0,
    };
    const page = await listConsultationPage(PHARMACY, filters);

    expect(listMock).toHaveBeenCalledWith(poolSql, PHARMACY, filters);
    expect(page).toEqual({ consultations: [row()] });
    // No total, and that is a decision rather than a gap: both of this list's real
    // views are "what is coming up" and "the last few", and neither shows a count.
    expect(page).not.toHaveProperty('total');
  });

  it('returns the rows it was given, in the order the repository put them in', async () => {
    const upcoming = row({ id: CONSULTATION, scheduledAt: NEXT_WEEK });
    const later = row({ id: 'a0000000-0000-4000-8000-000000000071', scheduledAt: SOON });
    listMock.mockResolvedValue([later, upcoming]);

    const page = await listConsultationPage(PHARMACY, { limit: 50, offset: 0 });
    // Nothing here re-sorts: the ordering is the repository's, where it belongs, and
    // a service that reordered a page would be a second place to change it.
    expect(page.consultations.map((entry) => entry.scheduledAt)).toEqual([SOON, NEXT_WEEK]);
  });
});
