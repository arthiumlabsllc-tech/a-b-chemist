import { poolSql, withTransaction } from '../database/pool';
import { findPatient } from '../repositories/patients.repository';
import {
  createScreening,
  latestScreeningOfType,
  listScreenings,
  type ScreeningFilters,
  type ScreeningRow,
} from '../repositories/screenings.repository';
import type { Actor } from './inventory.service';
import { nowIso } from '../utils/clock';
import { HttpError, notFound } from '../utils/http';
import {
  classifyRisk,
  computeBmi,
  measurementFrom,
  toNumberOrNull,
  type ScreeningValues,
} from '../utils/screening';
import type { ScreeningType } from '../utils/schema-enums';

/**
 * Recording a reading, and reading the history back.
 *
 * ## The level is not an input, and this service is where that could have been undone
 *
 * `repositories/screenings.repository.ts` makes a caller-supplied risk level
 * structurally impossible: `NewScreening` has no such field, so there is nowhere
 * to put one. That guarantee only holds if every layer above it keeps the same
 * shape. A service that accepted `riskLevel` in its input and then dropped it on
 * the floor would be worse than one that never mentioned it — the client would
 * believe it had said something. So `ScreeningInput` has no `riskLevel` either,
 * and a body carrying one has nowhere to land.
 *
 * ## The reason is re-derived on every read
 *
 * The row stores the level and not the sentence, for the asymmetry that
 * repository documents: the level is the decision made at the time and must not
 * move when a threshold is corrected, while the sentence is help text and should
 * improve beside every historical row the moment it is. `toView` is where that
 * happens, and it is the only place it happens — a caller that wanted the reason
 * from the row would not find it.
 */

/** How far ahead of the server's clock a `measuredAt` is still believed. */
export const MEASURED_AT_SKEW_MS = 5 * 60 * 1000;

/** A stored reading, plus the explanation rebuilt from the numbers in it. */
export interface ScreeningView extends ScreeningRow {
  /**
   * `classifyRisk`'s sentence for the measurement this row holds, or null when
   * the reading is an ordinary one and there is nothing to explain.
   *
   * Also null when the row cannot be turned back into a measurement at all,
   * which should be impossible through this service and is possible through a
   * manual `UPDATE`. That case degrades rather than throws: the level the
   * pharmacist decided is still shown, and a history page that 500s because one
   * old row was edited by hand is worse than one row with no sentence beside it.
   */
  riskReason: string | null;
}

/** What the recording form posts. Readings as typed: a string or a number. */
export interface ScreeningInput {
  patientId: string;
  type: ScreeningType;
  values: ScreeningValues;
  /**
   * A weight and a height taken at the same visit.
   *
   * Two jobs. Beside a `bmi` screening with no BMI typed, they are what the BMI
   * is computed from — the thing a pharmacist actually has is a scale and a
   * stature rod, not a ratio. Beside any other type they are recorded as the
   * extra columns the repository carries, so a visit that weighed somebody and
   * took their blood pressure does not throw the weight away.
   */
  weightKg?: string | number | null;
  heightCm?: string | number | null;
  /** Omitted for "just now", which is the common case at a counter. */
  measuredAt?: string | null;
  notes?: string | null;
}

export interface ScreeningPage {
  screenings: ScreeningView[];
}

/**
 * Turns a stored row back into the union `classifyRisk` takes.
 *
 * `measurementFrom` is used rather than a second parser because it is the same
 * function that read the request in the first place, and it already knows that a
 * `numeric` column arriving as the text `'7.80'` and a JSON body arriving as the
 * number `7.8` are one reading. Re-parsing through it is also what makes the
 * re-derivation honest: if the row cannot produce a measurement, the reason is
 * genuinely not knowable rather than merely not looked for.
 */
function measurementOf(row: ScreeningRow) {
  return measurementFrom(row.type, {
    systolicBp: row.systolicBp,
    diastolicBp: row.diastolicBp,
    bloodGlucoseMmol: row.bloodGlucoseMmol,
    bmi: row.bmi,
    weightKg: row.weightKg,
    temperatureC: row.temperatureC,
    heartRateBpm: row.heartRateBpm,
  });
}

function toView(row: ScreeningRow): ScreeningView {
  const parsed = measurementOf(row);
  return {
    ...row,
    riskReason: parsed.ok ? classifyRisk(parsed.measurement).reason : null,
  };
}

/**
 * The envelope `runValidation` produces, for a refusal that came from
 * `measurementFrom` instead of from express-validator.
 *
 * Same status, same message, same `code`, same `details` array of
 * `{ field, message }`. Two sources of field errors that answer differently would
 * mean the counter shows two kinds of red, and the second kind is the one nobody
 * wrote a renderer for.
 */
function measurementError(field: string, message: string): HttpError {
  return new HttpError(400, 'Some details need correcting before this can be saved', {
    code: 'validation_failed',
    details: [{ field, message }],
  });
}

/**
 * Resolves when the reading was taken.
 *
 * A reading dated in the future is refused rather than stored, and this is not
 * tidiness. `latestScreeningOfType` orders by `measured_at desc`, so one
 * forward-dated row becomes that patient's most recent blood pressure forever —
 * it outlives every real reading taken after it, and the comparison that makes a
 * counter screening worth taking quietly starts comparing against a date nobody
 * meant. The skew allowance is for a phone whose clock runs fast, not for
 * forward-dating: five minutes ahead is a wrong clock, five days is a typo.
 */
function measuredAtFrom(input: string | null | undefined, now: string): string {
  if (input === undefined || input === null || input.trim() === '') return now;

  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw measurementError('measuredAt', 'Enter the date and time the reading was taken');
  }
  if (parsed.getTime() > Date.parse(now) + MEASURED_AT_SKEW_MS) {
    throw measurementError(
      'measuredAt',
      'A reading cannot be taken in the future. Leave the date blank to record it as now.'
    );
  }
  return parsed.toISOString();
}

/**
 * Records one reading. `screenings:write`.
 *
 * The patient is looked up inside the transaction rather than before it, so the
 * row is written against a patient that existed at the moment of writing. Without
 * that, a patient deleted between the check and the insert turns a 404 into a
 * foreign-key violation — a 500 naming a constraint, which is a schema disclosure
 * and also simply the wrong answer.
 */
export async function recordScreening(
  actor: Actor,
  input: ScreeningInput
): Promise<ScreeningView> {
  const now = nowIso();
  const measuredAt = measuredAtFrom(input.measuredAt, now);

  const weightKg = toNumberOrNull(input.weightKg ?? null);
  const heightCm = toNumberOrNull(input.heightCm ?? null);

  // A BMI screening arrives as a weight and a height more often than as a ratio,
  // and computing it here is what stops the counter needing a calculator. The
  // typed BMI still wins when there is one: if the pharmacist wrote a figure down,
  // that figure is the reading and second-guessing it would classify a number the
  // row does not show.
  const values: ScreeningValues = { ...input.values };
  if (input.type === 'bmi' && toNumberOrNull(values.bmi) === null) {
    const computed =
      weightKg !== null && heightCm !== null ? computeBmi(weightKg, heightCm) : null;
    if (computed === null) {
      throw measurementError(
        'bmi',
        'Enter the BMI, or enter both a weight in kg and a height in cm and it will be worked out'
      );
    }
    values.bmi = computed;
  }

  const parsed = measurementFrom(input.type, values);
  if (!parsed.ok) throw measurementError(parsed.field, parsed.message);

  const row = await withTransaction(async (client) => {
    const patient = await findPatient(client, actor.pharmacyId, input.patientId);
    if (patient === null) throw notFound('patient');

    return createScreening(client, {
      pharmacyId: actor.pharmacyId,
      patientId: input.patientId,
      // The signer, not a field on the form. A reading attributed to whoever the
      // client said took it is a reading nobody can be sure anybody took.
      recordedBy: actor.userId,
      measurement: parsed.measurement,
      weightKg,
      heightCm,
      measuredAt,
      notes: input.notes ?? null,
    });
  });

  return toView(row);
}

/**
 * The history, newest first. `patients:read`.
 *
 * No total count comes back, because `screenings.repository.ts` has no counting
 * statement and a page that cannot say how many readings there are is still a
 * page that shows them in order. Adding a count is a statement, a harness PREPARE
 * and a test; it is worth doing the day a chart needs to say "1 of 40", and not
 * before.
 */
export async function listScreeningPage(
  pharmacyId: string,
  filters: ScreeningFilters
): Promise<ScreeningPage> {
  const rows = await listScreenings(poolSql, pharmacyId, filters);
  return { screenings: rows.map(toView) };
}

/**
 * The most recent reading of one type for one patient, or null.
 *
 * This is the comparison that makes a single number mean something: 148/92 is a
 * reading, and 148/92 beside a previous 128/82 is a direction. Exposed on its own
 * rather than only inside `recordScreening`'s response because the patient page
 * wants it before anybody has taken a reading today.
 */
export async function latestScreeningView(
  pharmacyId: string,
  patientId: string,
  type: ScreeningType
): Promise<ScreeningView | null> {
  const row = await latestScreeningOfType(poolSql, pharmacyId, patientId, type);
  return row === null ? null : toView(row);
}
