jest.mock('../database/pool', () => ({
  poolSql: { query: jest.fn() },
  withTransaction: jest.fn(),
}));

jest.mock('../repositories/patients.repository', () => ({
  // Only the export this service reads. The other four are `patients.service`'s
  // and nothing in this module graph imports them.
  findPatient: jest.fn(),
}));

jest.mock('../repositories/screenings.repository', () => ({
  createScreening: jest.fn(),
  latestScreeningOfType: jest.fn(),
  listScreenings: jest.fn(),
}));

jest.mock('../utils/clock', () => ({
  // A spy rather than fake timers, because the assertion that matters is which
  // instant the future-reading check reasoned about, and that a forward-dated
  // reading is refused *before* a transaction is opened. Both are about the
  // call, not about the wall clock.
  nowIso: jest.fn(),
}));

import type { PoolClient } from 'pg';
import { poolSql, withTransaction } from '../database/pool';
import { findPatient } from '../repositories/patients.repository';
import {
  createScreening,
  latestScreeningOfType,
  listScreenings,
  type NewScreening,
  type ScreeningFilters,
  type ScreeningRow,
} from '../repositories/screenings.repository';
import {
  MEASURED_AT_SKEW_MS,
  latestScreeningView,
  listScreeningPage,
  recordScreening,
  type ScreeningInput,
  type ScreeningView,
} from '../services/screenings.service';
import { nowIso } from '../utils/clock';
import { HttpError } from '../utils/http';
import type { ScreeningValues } from '../utils/screening';

/**
 * Recording a reading, and the sentence that comes back beside it.
 *
 * Three things are under test, and none of them is "does the service call the
 * repository".
 *
 * The **write path** is the first: what shape reaches `createScreening`. Two
 * claims live there and both are structural rather than conventional. A body
 * carrying `riskLevel` has nowhere to land, and a body carrying `recordedBy`
 * does not get to sign the reading — the token does. Neither is enforceable by
 * a validator, because neither field is one: the guarantee is that
 * `NewScreening` has no such key, and asserting the exact object the service
 * builds is the only way to see it hold.
 *
 * The **clock** is the second. `measuredAt` is the one field on this form whose
 * meaning depends on when it arrives, and a forward-dated reading is not a
 * tidiness problem: `latestScreeningOfType` orders by `measured_at desc`, so one
 * row dated next week becomes that patient's most recent blood pressure forever.
 * Both halves are pinned — the five-minute allowance for a fast phone clock, and
 * the refusal of anything past it, before a transaction is opened.
 *
 * The **reason** is the third, and it is the asymmetry
 * `repositories/screenings.repository.ts` documents: the level is frozen at the
 * decision made at the time, the sentence is rebuilt on every read. Nothing else
 * in the codebase tests that the two can disagree, and a service that started
 * re-deriving the level would quietly re-triage every patient the pharmacy has
 * ever screened the first time a threshold was corrected.
 *
 * `utils/screening.ts` is deliberately NOT mocked, following
 * `patients.service.test.ts` and its refusal to mock `utils/phone.ts`. The
 * thresholds, the BMI arithmetic and the pairing rule are the logic under test;
 * a stubbed classifier would make every assertion below true by agreement.
 *
 * The repositories and the pool are mocked, because what matters at this level
 * is which object was handed over. That the statements are valid SQL is
 * `screenings.repository.test.ts` and section 15 of the harness.
 */

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const PATIENT = 'a0000000-0000-4000-8000-000000000040';
const USER = 'a0000000-0000-4000-8000-000000000002';
const SCREENING = 'a0000000-0000-4000-8000-000000000060';

/** Somebody else's user id, for the body that tries to sign its own reading. */
const IMPOSTOR = 'a0000000-0000-4000-8000-000000000003';

/** What `nowIso` answers for the whole suite, so "the future" is a fixed point. */
const NOW = '2026-09-05T09:30:00.000Z';

const CLIENT = { query: jest.fn() } as unknown as PoolClient;

const withTransactionMock = withTransaction as jest.Mock;
const createMock = createScreening as jest.Mock;
const listMock = listScreenings as jest.Mock;
const latestMock = latestScreeningOfType as jest.Mock;
const findMock = findPatient as jest.Mock;
const nowMock = nowIso as jest.Mock;

const ACTOR = { userId: USER, pharmacyId: PHARMACY };

/**
 * `findPatient`'s answer.
 *
 * A stub rather than a copy of `patients.service.test.ts`'s full row, because
 * the service reads exactly one thing from it — whether it is null. Copying that
 * row here would make this file compile against a shape it never touches, and
 * the copy is the kind that drifts.
 */
const FOUND_PATIENT = { id: PATIENT, pharmacyId: PHARMACY };

/**
 * Complete rows rather than partial ones cast to the interface: if
 * `ScreeningRow` grows a required field this file stops compiling, instead of
 * quietly feeding the service a row no database would ever return.
 */
function row(overrides: Partial<ScreeningRow> = {}): ScreeningRow {
  return {
    id: SCREENING,
    pharmacyId: PHARMACY,
    patientId: PATIENT,
    recordedBy: USER,
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
    measuredAt: NOW,
    notes: null,
    createdAt: NOW,
    ...overrides,
  };
}

/**
 * The seven reading columns, all present.
 *
 * `ScreeningValues` requires every key and `toNumberOrNull` is typed
 * `string | number | null`, so an absent key would arrive as `undefined` and
 * throw inside the classifier. `screenings.routes.ts` builds the full object for
 * the same reason; building it here means a test can name the one reading it
 * cares about and the other six are honestly null rather than honestly missing.
 */
function values(overrides: Partial<ScreeningValues> = {}): ScreeningValues {
  return {
    systolicBp: null,
    diastolicBp: null,
    bloodGlucoseMmol: null,
    bmi: null,
    weightKg: null,
    temperatureC: null,
    heartRateBpm: null,
    ...overrides,
  };
}

/** What the recording form posts: a blood pressure, minus everything else. */
function input(overrides: Partial<ScreeningInput> = {}): ScreeningInput {
  return {
    patientId: PATIENT,
    type: 'blood_pressure',
    values: values({ systolicBp: 148, diastolicBp: 92 }),
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

/**
 * Asserts a measurement refusal in full: the status, the code, the sentence the
 * counter shows above the form, and the one field the form should point at.
 *
 * Written as a helper rather than repeated, because the claim is that every one
 * of these refusals is *indistinguishable in shape* from the ones
 * `utils/validate.ts` produces — and a helper that checked the shape once would
 * let a later refusal drift.
 */
async function expectRefusal(
  promise: Promise<unknown>,
  field: string,
  message: string
): Promise<HttpError> {
  const error = await expectHttpError(promise, 400, 'validation_failed');
  expect(error.message).toBe('Some details need correcting before this can be saved');
  expect(error.details).toEqual([{ field, message }]);
  return error;
}

/** The `NewScreening` the service asked to be inserted. */
function written(): NewScreening {
  const call = createMock.mock.calls[0];
  if (call === undefined) {
    // Named rather than left to surface as a property read on undefined, which
    // reads like a broken service instead of a test that expected a write.
    throw new Error('createScreening was never called');
  }
  return (call as unknown[])[1] as NewScreening;
}

/**
 * Records a reading and reports the instant it was stamped with.
 *
 * Clears the write mock each time so several spellings of "no time given" can be
 * asked about in one test without the first one's row answering for the rest.
 */
async function recordedMeasuredAt(measuredAt?: string | null): Promise<string> {
  createMock.mockClear();
  await recordScreening(ACTOR, input({ measuredAt }));
  return written().measuredAt;
}

beforeEach(() => {
  jest.clearAllMocks();
  nowMock.mockReturnValue(NOW);
  withTransactionMock.mockImplementation(
    async (work: (client: PoolClient) => Promise<unknown>) => work(CLIENT)
  );
  findMock.mockResolvedValue(FOUND_PATIENT);
  // A fixed row rather than one built from the write. Mapping the measurement
  // back over the eight columns is `createScreening`'s job, and re-implementing
  // it here would make every assertion about the returned view true by
  // construction. The write path is asserted on `written()` and the read path on
  // rows this file controls, and the two never lean on each other.
  createMock.mockResolvedValue(row());
  listMock.mockResolvedValue([]);
  latestMock.mockResolvedValue(null);
});

describe('MEASURED_AT_SKEW_MS', () => {
  it('is five minutes, which is a fast clock and not a typo', () => {
    // Pinned because the constant is the whole difference between "this phone
    // runs fast" and "somebody dated a reading next week". Widening it to an hour
    // would still pass every other test in this file.
    expect(MEASURED_AT_SKEW_MS).toBe(5 * 60 * 1000);
  });
});

describe('recordScreening: what reaches the table', () => {
  /**
   * A body that tries to sign the reading itself and to choose its own level.
   *
   * Cast rather than built, and the cast is the point: `ScreeningInput` has
   * neither field. `screenings.routes.ts` picks named fields out of `req.body`,
   * so neither key can arrive over the wire — but a second caller, or a route
   * edited to spread the body, would send exactly this, and what holds then is
   * that `NewScreening` has nowhere to put either one.
   */
  const CLAIMED = {
    patientId: PATIENT,
    type: 'blood_pressure',
    values: values({ systolicBp: 210, diastolicBp: 120 }),
    recordedBy: IMPOSTOR,
    riskLevel: 'low',
  } as unknown as ScreeningInput;

  it('signs with the token and carries no level a caller could have chosen', async () => {
    const view = await recordScreening(ACTOR, CLAIMED);

    expect(written()).toEqual({
      pharmacyId: PHARMACY,
      patientId: PATIENT,
      recordedBy: USER,
      measurement: { type: 'blood_pressure', systolic: 210, diastolic: 120 },
      weightKg: null,
      heightCm: null,
      measuredAt: NOW,
      notes: null,
    });
    expect(written()).not.toHaveProperty('riskLevel');
    // And the response is the repository's row read back through `toView`, not
    // an echo of what was posted: the reason describes 148/92, the row this suite
    // returns, and not the 210/120 the body asked to be recorded.
    expect(view.riskReason).toContain('148/92');
  });

  it('looks the patient up inside the transaction', async () => {
    await recordScreening(ACTOR, input());

    // The client, not the pool. Outside the transaction a patient deleted
    // between the check and the insert turns a 404 into a foreign-key violation,
    // which is a 500 naming a constraint.
    expect(findMock).toHaveBeenCalledWith(CLIENT, PHARMACY, PATIENT);
  });

  it('refuses a reading for a patient who is not there, and writes nothing', async () => {
    findMock.mockResolvedValue(null);

    const error = await expectHttpError(recordScreening(ACTOR, input()), 404, 'not_found');

    expect(error.message).toBe('No patient matches that id');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('keeps a weight and a height taken beside a blood pressure', async () => {
    await recordScreening(
      ACTOR,
      input({ weightKg: '70.5', heightCm: 175, notes: 'Taken at the counter' })
    );

    // Recorded on a type that does not classify them, so a visit that weighed
    // somebody and took their pressure does not throw the weight away.
    expect(written().weightKg).toBe(70.5);
    expect(written().heightCm).toBe(175);
    expect(written().notes).toBe('Taken at the counter');
  });

  it('turns a blank weight into null rather than into a reading of zero', async () => {
    await recordScreening(ACTOR, input({ weightKg: '', heightCm: '   ' }));

    // `Number('')` is 0. A weight of zero on the row is a measurement nobody
    // took, stored as one that was.
    expect(written().weightKg).toBeNull();
    expect(written().heightCm).toBeNull();
    expect(written().notes).toBeNull();
  });

  it('passes both weights on a weight screening and lets the repository decide', async () => {
    await recordScreening(
      ACTOR,
      input({ type: 'weight', values: values({ weightKg: 68 }), weightKg: 70 })
    );

    // The classified measurement and the extra column both travel, and the
    // service does not silently prefer one: which wins is
    // `measurementColumns`' decision, made where the columns are built.
    expect(written().measurement).toEqual({ type: 'weight', weightKg: 68 });
    expect(written().weightKg).toBe(70);
  });
});

describe('recordScreening: when the reading was taken', () => {
  it('treats an omitted, null, empty and blank time as "just now"', async () => {
    expect(await recordedMeasuredAt(undefined)).toBe(NOW);
    expect(await recordedMeasuredAt(null)).toBe(NOW);
    expect(await recordedMeasuredAt('')).toBe(NOW);
    expect(await recordedMeasuredAt('   ')).toBe(NOW);
  });

  it('stores an instant whatever the client spelled', async () => {
    expect(await recordedMeasuredAt('2026-09-04')).toBe('2026-09-04T00:00:00.000Z');
    expect(await recordedMeasuredAt('2026-09-04T14:05:00+01:00')).toBe(
      '2026-09-04T13:05:00.000Z'
    );
  });

  it('believes a clock running five minutes fast', async () => {
    expect(await recordedMeasuredAt('2026-09-05T09:34:00.000Z')).toBe(
      '2026-09-05T09:34:00.000Z'
    );
    // Exactly at the allowance, which is the boundary the `>` in the service is
    // written for: a phone five minutes fast is wrong, not dishonest.
    expect(await recordedMeasuredAt('2026-09-05T09:35:00.000Z')).toBe(
      '2026-09-05T09:35:00.000Z'
    );
  });

  it('refuses a reading taken after that, before opening a transaction', async () => {
    await expectRefusal(
      recordScreening(ACTOR, input({ measuredAt: '2026-09-05T09:35:00.001Z' })),
      'measuredAt',
      'A reading cannot be taken in the future. Leave the date blank to record it as now.'
    );
    await expectRefusal(
      recordScreening(ACTOR, input({ measuredAt: '2026-09-06T09:30:00.000Z' })),
      'measuredAt',
      'A reading cannot be taken in the future. Leave the date blank to record it as now.'
    );

    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a time that is not a time, and says which field', async () => {
    await expectRefusal(
      recordScreening(ACTOR, input({ measuredAt: 'yesterday morning' })),
      'measuredAt',
      'Enter the date and time the reading was taken'
    );

    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('accepts a reading taken in the past, which is the point of the field', async () => {
    expect(await recordedMeasuredAt('2026-08-01T08:00:00.000Z')).toBe(
      '2026-08-01T08:00:00.000Z'
    );
  });
});

describe('recordScreening: the readings themselves', () => {
  it('works a BMI out of a weight and a height, rounded before anything classifies it', async () => {
    await recordScreening(
      ACTOR,
      input({ type: 'bmi', values: values(), weightKg: '76.44', heightCm: '175' })
    );

    // 76.44 kg over 1.75 m is 24.96, which the column stores as 25.0 — the
    // figure `computeBmi`'s own documentation picks. Rounding here rather than
    // after classification is what stops the screen showing 25.0 beside a badge
    // that was decided from 24.96.
    expect(written().measurement).toEqual({ type: 'bmi', bmi: 25 });
    expect(written().weightKg).toBe(76.44);
    expect(written().heightCm).toBe(175);
  });

  it('lets a typed BMI win over one it could have computed', async () => {
    await recordScreening(
      ACTOR,
      input({ type: 'bmi', values: values({ bmi: '31.4' }), weightKg: 76.44, heightCm: 175 })
    );

    // If the pharmacist wrote a figure down, that figure is the reading.
    // Second-guessing it would classify a number the row does not show.
    expect(written().measurement).toEqual({ type: 'bmi', bmi: 31.4 });
  });

  it('refuses a BMI it cannot work out, and looks nothing up first', async () => {
    const sentence =
      'Enter the BMI, or enter both a weight in kg and a height in cm and it will be worked out';

    await expectRefusal(
      recordScreening(ACTOR, input({ type: 'bmi', values: values() })),
      'bmi',
      sentence
    );
    // A weight and no height is the half-filled form the counter actually sees.
    await expectRefusal(
      recordScreening(ACTOR, input({ type: 'bmi', values: values(), weightKg: 70 })),
      'bmi',
      sentence
    );

    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('refuses a blood pressure with one number, naming the missing one', async () => {
    await expectRefusal(
      recordScreening(ACTOR, input({ values: values({ systolicBp: 148 }) })),
      'diastolicBp',
      'The bottom blood pressure number is needed, and it has to be a number.'
    );
    await expectRefusal(
      recordScreening(ACTOR, input({ values: values({ diastolicBp: 92 }) })),
      'systolicBp',
      'The top blood pressure number is needed, and it has to be a number.'
    );
  });

  it('tells "nothing typed" apart from "typed zero"', async () => {
    await expectRefusal(
      recordScreening(ACTOR, input({ values: values({ systolicBp: '   ', diastolicBp: 80 }) })),
      'systolicBp',
      'The top blood pressure number is needed, and it has to be a number.'
    );
    await expectRefusal(
      recordScreening(ACTOR, input({ values: values({ systolicBp: 0, diastolicBp: 80 }) })),
      'systolicBp',
      'The top blood pressure number has to be greater than zero.'
    );
  });

  it('refuses a word where a reading belongs', async () => {
    await expectRefusal(
      recordScreening(
        ACTOR,
        input({ type: 'blood_sugar', values: values({ bloodGlucoseMmol: 'high' }) })
      ),
      'bloodGlucoseMmol',
      'The blood sugar reading in mmol/L is needed, and it has to be a number.'
    );
  });

  it('accepts decimal text, which is what a numeric column hands back', async () => {
    await recordScreening(
      ACTOR,
      input({ type: 'blood_sugar', values: values({ bloodGlucoseMmol: '7.80' }) })
    );

    // The same reading arrives as `7.8` from a JSON body and as `'7.80'` from a
    // row. One parser for both is what stops a re-read classifying differently
    // from the write that produced it.
    expect(written().measurement).toEqual({ type: 'blood_sugar', glucoseMmol: 7.8 });
  });
});

describe('the envelope a measurement refusal arrives in', () => {
  it('is the one the counter already renders', async () => {
    const error = await expectRefusal(
      recordScreening(ACTOR, input({ values: values({ systolicBp: 148 }) })),
      'diastolicBp',
      'The bottom blood pressure number is needed, and it has to be a number.'
    );

    // `runValidation` answers with an array of `{ field, message }`. A refusal
    // from the classifier that arrived as an object keyed by field, or as a bare
    // string, would be a second kind of red — and the second kind is the one
    // nobody wrote a renderer for.
    expect(Array.isArray(error.details)).toBe(true);
    const entries = error.details as { field: string; message: string }[];
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (entry === undefined) {
      throw new Error('the envelope named no field');
    }
    expect(Object.keys(entry).sort()).toEqual(['field', 'message']);
  });
});

describe('the reason beside a reading', () => {
  /**
   * Drives one row through the history read, which is where `toView` runs.
   *
   * Returns the view rather than a possible one, so that an empty page fails as
   * "the history came back empty" instead of as a property read on undefined
   * three assertions later.
   */
  async function reasonFor(overrides: Partial<ScreeningRow>): Promise<ScreeningView> {
    listMock.mockResolvedValue([row(overrides)]);
    const page = await listScreeningPage(PHARMACY, { limit: 50, offset: 0 });
    const view = page.screenings[0];
    if (view === undefined) {
      throw new Error('the history came back empty');
    }
    return view;
  }

  it('is null for an ordinary reading', async () => {
    const view = await reasonFor({
      riskLevel: 'low',
      systolicBp: 118,
      diastolicBp: 76,
    });

    expect(view.riskLevel).toBe('low');
    expect(view.riskReason).toBeNull();
  });

  it('quotes the reading and the threshold it crossed', async () => {
    const view = await reasonFor({ systolicBp: 148, diastolicBp: 92 });

    expect(view.riskReason).toContain('148/92');
    expect(view.riskReason).toContain('140/90');
    // And never a diagnosis: this module is not qualified to say the word, and a
    // pharmacy screening must not imply it.
    expect(view.riskReason).not.toMatch(/hypertension|diabetes|stroke/i);
  });

  it('keeps the level that was decided and rebuilds only the sentence', async () => {
    // A row stored `low` whose numbers are not. The level is the decision made
    // at the time and does not move when a threshold is corrected...
    const understated = await reasonFor({
      riskLevel: 'low',
      systolicBp: 210,
      diastolicBp: 120,
    });
    expect(understated.riskLevel).toBe('low');
    expect(understated.riskReason).toContain('210/120');

    // ...and the sentence is help text, so a row stored `high` whose numbers
    // came back down explains nothing rather than inventing a reason to match.
    const overstated = await reasonFor({
      riskLevel: 'high',
      systolicBp: 118,
      diastolicBp: 76,
    });
    expect(overstated.riskLevel).toBe('high');
    expect(overstated.riskReason).toBeNull();
  });

  it('explains a weight even though a weight is never a risk', async () => {
    const view = await reasonFor({
      type: 'weight',
      riskLevel: 'low',
      systolicBp: null,
      diastolicBp: null,
      weightKg: 68,
    });

    // A green "low" badge on a kilogram figure would claim an assessment nobody
    // made, so the reason says plainly that there was not one.
    expect(view.riskLevel).toBe('low');
    expect(view.riskReason).toContain('not a risk reading');
  });

  it('degrades rather than throwing on a row that cannot be read back', async () => {
    // Possible only through a manual UPDATE, and the honest answer is "the
    // reason is not knowable". A history page that 500s because one old row was
    // edited by hand is worse than one row with no sentence beside it.
    const view = await reasonFor({
      riskLevel: 'moderate',
      systolicBp: null,
      diastolicBp: 92,
    });

    expect(view.riskReason).toBeNull();
    expect(view.riskLevel).toBe('moderate');
    expect(view.id).toBe(SCREENING);
  });
});

describe('listScreeningPage', () => {
  const FILTERS: ScreeningFilters = {
    patientId: PATIENT,
    types: ['bmi', 'weight'],
    from: '2026-08-01',
    to: '2026-08-31',
    limit: 25,
    offset: 50,
  };

  it('maps every row, counts none, and holds no transaction', async () => {
    const glucose = row({
      id: 'a0000000-0000-4000-8000-000000000061',
      type: 'blood_sugar',
      riskLevel: 'moderate',
      systolicBp: null,
      diastolicBp: null,
      bloodGlucoseMmol: 7.8,
    });
    listMock.mockResolvedValue([row(), glucose]);

    const page = await listScreeningPage(PHARMACY, FILTERS);

    expect(page.screenings).toHaveLength(2);
    const [pressure, sugar] = page.screenings;
    if (pressure === undefined || sugar === undefined) {
      throw new Error('the history came back short');
    }
    // Each row's reason is rebuilt from that row's own numbers, which is the
    // claim worth making with two rows of different types side by side.
    expect(pressure.riskReason).toContain('148/92');
    expect(sugar.riskReason).toContain('7.8');
    // No total comes back, because the repository has no counting statement.
    // Asserted so that adding one is a decision rather than an accident.
    expect(page).not.toHaveProperty('total');
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('hands the filters to the repository untouched', async () => {
    await listScreeningPage(PHARMACY, FILTERS);

    // Folding an empty `types` into "every type" is the repository's job, where
    // the `= any('{}')` trap lives, and it has its own test for it.
    expect(listMock).toHaveBeenCalledWith(poolSql, PHARMACY, FILTERS);
  });
});

describe('latestScreeningView', () => {
  it('answers null for a patient with no reading of that type yet', async () => {
    latestMock.mockResolvedValue(null);

    // Null is an answer and not an absence: this is the ordinary case the first
    // time anybody takes one, and a 404 would make the patient page treat
    // "nothing recorded yet" as "record not found".
    await expect(latestScreeningView(PHARMACY, PATIENT, 'blood_pressure')).resolves.toBeNull();
    expect(latestMock).toHaveBeenCalledWith(poolSql, PHARMACY, PATIENT, 'blood_pressure');
  });

  it('explains the reading it found', async () => {
    latestMock.mockResolvedValue(row({ systolicBp: 128, diastolicBp: 82, riskLevel: 'moderate' }));

    const view = await latestScreeningView(PHARMACY, PATIENT, 'blood_pressure');

    expect(view).not.toBeNull();
    expect(view?.riskLevel).toBe('moderate');
    expect(view?.riskReason).toContain('128/82');
  });
});
