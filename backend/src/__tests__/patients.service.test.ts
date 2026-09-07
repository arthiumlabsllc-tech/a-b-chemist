jest.mock('../database/pool', () => ({
  poolSql: { query: jest.fn() },
  withTransaction: jest.fn(),
}));

jest.mock('../repositories/patients.repository', () => ({
  countPatients: jest.fn(),
  createPatient: jest.fn(),
  findPatient: jest.fn(),
  listPatients: jest.fn(),
  updatePatient: jest.fn(),
}));

jest.mock('../utils/clock', () => ({
  // Only the export this service reads. A spy rather than fake timers, because
  // the assertion that matters is which day the future-date check reasoned about
  // and that a future date is refused *before* anything is written — both of
  // which are about the call, not about the wall clock.
  todayDateOnly: jest.fn(),
}));

import type { PoolClient } from 'pg';
import { poolSql, withTransaction } from '../database/pool';
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
import {
  PATIENT_LIMITS,
  changePatient,
  getPatient,
  listPatientPage,
  registerPatient,
  tidyList,
  type PatientInput,
} from '../services/patients.service';
import { todayDateOnly } from '../utils/clock';
import { HttpError } from '../utils/http';
import type { Gender } from '../utils/schema-enums';

/**
 * The patient record: what it stores, what it refuses, and what it reports.
 *
 * Three things are under test, and none of them is "does the service call the
 * repository", which is what a mocked-repository suite degenerates into once it
 * has run out of anything to say.
 *
 * `tidyList` is the first. It is exported rather than private because a second
 * copy of a de-duplication rule is two rules, but it is also the one piece of
 * logic here that changes what a pharmacist reads back: an allergy list carrying
 * a blank row is a list they have to read past to find the allergies, on the one
 * record in the system where skimming has consequences.
 *
 * The future-date refusal is the second. `dateOfBirth` is a relationship with the
 * clock and express-validator has no "not after today" that also knows which day
 * it is, so the route owns the format and this owns the meaning. Both halves are
 * pinned: that a forward-dated birth date is refused with a field the form can
 * point at, and that it is refused before a transaction is opened.
 *
 * `smsNumber` is the third, and it is a report rather than a rule — a number that
 * cannot be texted does not stop the record being saved, it says so on the record.
 * `utils/phone.ts` is deliberately NOT mocked for that reason, following
 * `reminders.service.test.ts` and its refusal to mock `services/sms.ts`. The claim
 * is that a real Ghanaian spelling produces a destination and a typo produces
 * null; a stubbed normaliser would make both assertions true by agreement.
 *
 * The repositories and the pool are mocked, because what matters at this level is
 * which statement was asked for with which patch. That the statements are valid
 * SQL is `patients.repository.test.ts` and section 14 of the harness.
 */

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const OTHER_PHARMACY = 'a0000000-0000-4000-8000-000000000009';
const PATIENT = 'a0000000-0000-4000-8000-000000000040';
const USER = 'a0000000-0000-4000-8000-000000000002';
const TODAY = '2026-09-05';

/** A Ghana mobile in the spelling the counter would type it. */
const PHONE = '024 123 4567';
const PHONE_INTERNATIONAL = '+233241234567';

const CLIENT = { query: jest.fn() } as unknown as PoolClient;

const withTransactionMock = withTransaction as jest.Mock;
const createMock = createPatient as jest.Mock;
const findMock = findPatient as jest.Mock;
const listMock = listPatients as jest.Mock;
const countMock = countPatients as jest.Mock;
const updateMock = updatePatient as jest.Mock;
const todayMock = todayDateOnly as jest.Mock;

const ACTOR = { userId: USER, pharmacyId: PHARMACY };

/**
 * Complete rows rather than partial ones cast to the interface: if `PatientRow`
 * grows a required field this file stops compiling, instead of quietly feeding
 * the service a row no database would ever return.
 */
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

/** What the registration form posts, minus everything the test is not about. */
function input(overrides: Partial<PatientInput> = {}): PatientInput {
  return { fullName: 'Ama Mensah', ...overrides };
}

/**
 * A PATCH body, in which nothing is implied.
 *
 * Separate from `input` because a registration and a patch are not the same
 * request. `input` supplies a name, which is right for a POST and wrong here: an
 * omitted field on a patch means "leave it alone", and a helper that filled one
 * in would make every patch assertion below a statement about a body nobody sent.
 *
 * `PatientInput.fullName` is required because a registration needs a name, and
 * `patients.routes.ts` hands `req.body` to the service as `PatientInput` on both
 * routes. So on a patch the signature is narrower than the runtime and the fields
 * omitted below arrive as `undefined` whatever the type says — the gap
 * `patchFrom` exists to handle, and the assertion is the route's own rather than
 * one invented for the test.
 */
function patchBody(fields: Partial<PatientInput>): PatientInput {
  return fields as PatientInput;
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

/** Every `NewPatient` the service asked to be inserted. */
function created(): NewPatient[] {
  return createMock.mock.calls.map((call) => (call as unknown[])[1] as NewPatient);
}

/** Every patch the service handed to `updatePatient`. */
function patches(): PatientPatch[] {
  return updateMock.mock.calls.map((call) => (call as unknown[])[3] as PatientPatch);
}

beforeEach(() => {
  jest.clearAllMocks();
  todayMock.mockReturnValue(TODAY);
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
  updateMock.mockImplementation(async (_sql, _pharmacyId, _id, patch: PatientPatch) =>
    // All three lists copied out. `PatientPatch` types them `readonly` because a
    // patch is something the caller keeps, and `PatientRow` types them mutable
    // because a row is something the database handed over; a row built from a
    // patch is the one place the two meet.
    row({
      ...patch,
      allergies: [...(patch.allergies ?? [])],
      conditions: [...(patch.conditions ?? [])],
      medications: [...(patch.medications ?? [])],
    })
  );
});

describe('PATIENT_LIMITS', () => {
  it('is pinned, so a change is a reviewed change rather than a quieter form', async () => {
    // These columns are `text` with no schema limit, so this table is the only
    // thing between a pasted document and a record that takes a second to render.
    // `fullName` and `phone` match `staff.routes.ts`'s ceilings for the same two
    // fields, and two numbers for one kind of value is a difference nobody at the
    // counter could explain.
    expect(PATIENT_LIMITS).toEqual({
      fullName: { min: 2, max: 120 },
      phone: { min: 0, max: 32 },
      notes: { min: 0, max: 2000 },
      listItem: { min: 1, max: 200 },
      listLength: { min: 0, max: 100 },
    });
  });
});

describe('tidyList', () => {
  it('trims every entry, so a pasted list stores the same as a typed one', () => {
    expect(tidyList(['  Penicillin ', '\tIbuprofen'])).toEqual(['Penicillin', 'Ibuprofen']);
  });

  it('empties out, because a blank row in an allergy list is a row to read past', () => {
    expect(tidyList(['Penicillin', '', '   ', 'Ibuprofen'])).toEqual(['Penicillin', 'Ibuprofen']);
  });

  it('drops a repeat of the same trimmed text', () => {
    // Whitespace apart, these are one entry typed three times: a form that adds a
    // row for each medicine the patient names, and a pharmacist who named the
    // same one twice because the first attempt looked like it had not taken.
    expect(tidyList(['Penicillin', 'Penicillin ', ' Penicillin', '\tPenicillin'])).toEqual([
      'Penicillin',
    ]);
  });

  it('keeps two spellings that differ in case, which to the typist may be two things', () => {
    // Merging these would be an allergy list that no longer says what the
    // pharmacist wrote, and the merge is invisible on the record afterwards.
    expect(tidyList(['Aspirin', 'aspirin'])).toEqual(['Aspirin', 'aspirin']);
  });

  it('preserves the order it was given rather than sorting', () => {
    // The first entry is usually the one that matters most to whoever typed it.
    // Alphabetising puts "Aspirin" above "Penicillin" in a country where neither
    // is the reason the list was written.
    expect(tidyList(['Penicillin', 'Aspirin', 'Ibuprofen'])).toEqual([
      'Penicillin',
      'Aspirin',
      'Ibuprofen',
    ]);
  });

  it('answers an empty list for absent and for null, which are the same fact here', () => {
    expect(tidyList(undefined)).toEqual([]);
    expect(tidyList(null)).toEqual([]);
    expect(tidyList([])).toEqual([]);
  });
});

describe('registerPatient', () => {
  it('stores the phone number exactly as it was typed', async () => {
    await registerPatient(ACTOR, input({ phone: PHONE }));
    // Not normalised on the way in. A rule that rewrites a number the pharmacist
    // knows is correct teaches them to type something false, and a false number
    // is worse than an oddly formatted one.
    expect(created()[0]?.phone).toBe(PHONE);
  });

  it('reports the number it could text beside the one it stored', async () => {
    createMock.mockResolvedValue(row({ phone: PHONE }));
    const view = await registerPatient(ACTOR, input({ phone: PHONE }));
    expect({ stored: view.phone, smsNumber: view.smsNumber }).toEqual({
      stored: PHONE,
      smsNumber: PHONE_INTERNATIONAL,
    });
  });

  it('reports null rather than refusing a number it cannot text', async () => {
    // A Togo visitor, a landline reached through an extension, or a digit short.
    // None of them stops the record being saved; all of them mean the reminders
    // for this patient will be raised `not sent` with a reason beside them.
    createMock.mockResolvedValue(row({ phone: '024 123' }));
    const view = await registerPatient(ACTOR, input({ phone: '024 123' }));
    expect(view.phone).toBe('024 123');
    expect(view.smsNumber).toBeNull();
  });

  it('reports null for a patient who gave no number at all', async () => {
    createMock.mockResolvedValue(row({ phone: null }));
    const view = await registerPatient(ACTOR, input());
    expect(view.smsNumber).toBeNull();
  });

  it('writes the pharmacy from the actor and never from the body', async () => {
    // The body has no pharmacy field to post, and this asserts the statement was
    // given the caller's. A single-tenant build is not a reason to leave the
    // parameter shaped so that a second tenant would be one line away.
    await registerPatient(ACTOR, input());
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(created()[0]?.pharmacyId).toBe(PHARMACY);
    expect(createMock.mock.calls[0]?.[0]).toBe(poolSql);
  });

  it('stores null for every field the form left out', async () => {
    await registerPatient(ACTOR, input());
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

  it('tidies all three clinical lists on the way in', async () => {
    await registerPatient(
      ACTOR,
      input({
        allergies: ['Penicillin', 'Penicillin', ' '],
        conditions: [' Hypertension '],
        medications: ['Amlodipine 5mg', 'Amlodipine 5mg'],
      })
    );
    expect({
      allergies: created()[0]?.allergies,
      conditions: created()[0]?.conditions,
      medications: created()[0]?.medications,
    }).toEqual({
      allergies: ['Penicillin'],
      conditions: ['Hypertension'],
      medications: ['Amlodipine 5mg'],
    });
  });

  it('accepts today as a date of birth, which is the boundary rather than past it', async () => {
    // A baby registered on the day it was born. `>` and not `>=` is the whole of
    // this test: an off-by-one here refuses the youngest patient in the pharmacy.
    await registerPatient(ACTOR, input({ dateOfBirth: TODAY }));
    expect(created()[0]?.dateOfBirth).toBe(TODAY);
  });

  it('refuses a date of birth in the future, naming the field', async () => {
    const error = await expectHttpError(
      registerPatient(ACTOR, input({ dateOfBirth: '2026-09-06' })),
      400,
      'validation_failed'
    );
    expect(error.message).toBe('The date of birth cannot be in the future');
    expect(error.details).toEqual([
      { field: 'dateOfBirth', message: 'Enter a date that has already happened' },
    ]);
    // Every screen that shows an age derives it from this column, so one wrong
    // keystroke produces a negative age on a record a pharmacist is reading while
    // deciding a dose — and the number looks like a number, not like a mistake.
    expect(createMock).not.toHaveBeenCalled();
  });

  it('compares the date as text, so a malformed value cannot slip through as not-future', async () => {
    // `YYYY-MM-DD` sorts the same way it compares. A parsed comparison would have
    // to decide what `'05/09/2026'` means, and every answer to that is a date the
    // route already refused for its format — except the one that parses as a day
    // later this year.
    const error = await expectHttpError(
      registerPatient(ACTOR, input({ dateOfBirth: '2026-09-05T00:00:00Z' })),
      400,
      'validation_failed'
    );
    expect(error.details).toEqual([
      { field: 'dateOfBirth', message: 'Enter a date that has already happened' },
    ]);
  });
});

describe('getPatient', () => {
  it('answers 404 for a miss, in the words every lookup uses', async () => {
    findMock.mockResolvedValue(null);
    const error = await expectHttpError(getPatient(PHARMACY, PATIENT), 404, 'not_found');
    expect(error.message).toBe('No patient matches that id');
  });

  it('scopes the lookup to the caller\'s pharmacy, so another tenant\'s id is a miss', async () => {
    // The proof of scoping is the argument, not the status: `findPatient` is
    // given the pharmacy, and a row from anywhere else cannot come back. The 404
    // above is then the same answer for both cases on purpose — telling them
    // apart hands a caller a way to enumerate which ids exist elsewhere.
    await getPatient(OTHER_PHARMACY, PATIENT);
    expect(findMock).toHaveBeenCalledWith(poolSql, OTHER_PHARMACY, PATIENT);
  });

  it('carries the textable number on the record it returns', async () => {
    const view = await getPatient(PHARMACY, PATIENT);
    expect(view.smsNumber).toBe(PHONE_INTERNATIONAL);
    expect(view.id).toBe(PATIENT);
  });
});

describe('listPatientPage', () => {
  it('counts the search and not the page', async () => {
    listMock.mockResolvedValue([row(), row({ id: 'a0000000-0000-4000-8000-000000000041' })]);
    countMock.mockResolvedValue(57);

    const page = await listPatientPage(PHARMACY, { search: 'ama', limit: 2, offset: 4 });

    // A pager total that describes the page it sits beside rather than the whole
    // search is worse than no total at all, because it is believed. The two reads
    // share one search term and the count is given no limit to apply.
    expect(countMock).toHaveBeenCalledWith(poolSql, PHARMACY, { search: 'ama' });
    expect(listMock).toHaveBeenCalledWith(poolSql, PHARMACY, {
      search: 'ama',
      limit: 2,
      offset: 4,
    });
    expect(page).toEqual({
      patients: expect.any(Array),
      total: 57,
      limit: 2,
      offset: 4,
    });
    expect(page.patients).toHaveLength(2);
  });

  it('maps every row it returns, so no record arrives without its smsNumber', async () => {
    listMock.mockResolvedValue([
      row({ phone: PHONE }),
      row({ id: 'a0000000-0000-4000-8000-000000000041', phone: 'not a number' }),
      row({ id: 'a0000000-0000-4000-8000-000000000042', phone: null }),
    ]);
    countMock.mockResolvedValue(3);

    const page = await listPatientPage(PHARMACY, { search: null, limit: 50, offset: 0 });
    // The register is where a pharmacist would notice that twelve patients cannot
    // be texted, and a list that omitted the field on some rows would hide them.
    expect(page.patients.map((patient) => patient.smsNumber)).toEqual([
      PHONE_INTERNATIONAL,
      null,
      null,
    ]);
  });

  it('reads both halves against the pool, in parallel, outside a transaction', async () => {
    listMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);
    await listPatientPage(PHARMACY, { search: null, limit: 50, offset: 0 });
    // A serialisable transaction would make the pair exact, and the cost is a lock
    // held across two queries to serve a search box. The inaccuracy it buys is a
    // total one registration out for the milliseconds between the two, which is
    // what the page would show a moment later on refresh anyway.
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});

describe('changePatient', () => {
  it('refuses an empty patch rather than answering with an unchanged row', async () => {
    const error = await expectHttpError(
      changePatient(ACTOR, PATIENT, patchBody({})),
      400,
      'nothing_to_update'
    );
    // A silent no-op is a frontend that believes it saved something it did not send.
    expect(error.message).toBe('Nothing to change — send at least one field to edit');
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('refuses a future date of birth before opening a transaction', async () => {
    await expectHttpError(
      changePatient(ACTOR, PATIENT, patchBody({ dateOfBirth: '2027-01-01' })),
      400,
      'validation_failed'
    );
    // The patch is built first, so a refusal here leaves no connection taken and
    // no row locked. The opposite ordering would open a transaction to discover
    // the request was never going to be valid.
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('keeps undefined and null apart, which is the whole of a patch', async () => {
    await changePatient(ACTOR, PATIENT, patchBody({
      fullName: 'Ama Mensah-Owusu',
      phone: null,
      notes: 'Asked about the amlodipine.',
    }));

    // `phone: null` is "clear the number". An omitted `dateOfBirth` is "leave the
    // date alone", and it must not arrive in the patch as null or the repository's
    // `case when $flag::boolean` would read the omission as a decision.
    expect(patches()[0]).toEqual({
      fullName: 'Ama Mensah-Owusu',
      phone: null,
      notes: 'Asked about the amlodipine.',
    });
    expect(Object.keys(patches()[0] ?? {})).toEqual(['fullName', 'phone', 'notes']);
  });

  it('drops a field the contract does not have, rather than passing it to the statement', async () => {
    /**
     * What a stale frontend posts. The cast is the route's own — `patients.routes.ts`
     * hands `req.body` to the service as `PatientInput` with no runtime check
     * between the two — so this is the shape that actually arrives rather than one
     * invented for the test. `memberNumber` stands for any key the contract does
     * not name, including every identifier from a national scheme: the patch is
     * built field by field precisely so that an unknown one cannot reach the
     * statement's parameter list.
     */
    const stale = { fullName: 'Ama Mensah', memberNumber: 'GHA-99120' } as unknown as PatientInput;

    await changePatient(ACTOR, PATIENT, stale);
    expect(patches()[0]).toEqual({ fullName: 'Ama Mensah' });
  });

  it('tidies a list it is given, and leaves a list it is not given alone', async () => {
    await changePatient(
      ACTOR,
      PATIENT,
      patchBody({ allergies: ['Penicillin', 'Penicillin', 'Sulfa '] })
    );
    // The conditions and medications the record already holds are not in the
    // patch, so the repository's `case when` leaves them where they are. Sending
    // them back as empty arrays would read as "the pharmacist cleared these".
    expect(patches()[0]).toEqual({ allergies: ['Penicillin', 'Sulfa'] });
  });

  it('looks the record up inside the same transaction as the update', async () => {
    await changePatient(ACTOR, PATIENT, patchBody({ notes: 'x' }));
    // One client for both. A lookup against the pool and an update against a
    // transaction are two views of the row, and the second can differ from the
    // first by whatever committed in between.
    expect(findMock).toHaveBeenCalledWith(CLIENT, PHARMACY, PATIENT);
    expect(updateMock).toHaveBeenCalledWith(CLIENT, PHARMACY, PATIENT, { notes: 'x' });
  });

  it('answers 404 when the record is not there, and does not attempt the update', async () => {
    findMock.mockResolvedValue(null);
    await expectHttpError(
      changePatient(ACTOR, PATIENT, patchBody({ notes: 'x' })),
      404,
      'not_found'
    );
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('answers 404 when the row went between the lookup and the update', async () => {
    // There is no delete route, so a null from `updatePatient` after a successful
    // lookup is a concurrent edit against a patient another session removed by
    // hand. Without the lookup the two cases are indistinguishable and the honest
    // 404 becomes a guess.
    updateMock.mockResolvedValue(null);
    const error = await expectHttpError(
      changePatient(ACTOR, PATIENT, patchBody({ notes: 'x' })),
      404,
      'not_found'
    );
    expect(error.message).toBe('No patient matches that id');
    expect(findMock).toHaveBeenCalledTimes(1);
  });

  it('returns the stored record, with the number it can text', async () => {
    updateMock.mockResolvedValue(row({ phone: '+233 24 123 4567', notes: 'Updated.' }));
    const view = await changePatient(ACTOR, PATIENT, patchBody({ notes: 'Updated.' }));
    expect({ notes: view.notes, smsNumber: view.smsNumber }).toEqual({
      notes: 'Updated.',
      smsNumber: PHONE_INTERNATIONAL,
    });
  });
});
