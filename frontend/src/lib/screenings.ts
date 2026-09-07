/**
 * The pure logic behind screenings: the history query, and turning a type-aware
 * reading form into the body `POST /screenings` wants.
 *
 * Kept out of the page and the modal for the reason `lib/inventory.ts` gives: the
 * part that breaks silently is *which readings a type needs and where they go in
 * the body*. A blood pressure is two numbers in `values`; a BMI is a weight and a
 * height at the top level, because the server computes the ratio; a weight is one
 * number in `values`. Get that wrong and the reading is refused, or worse, stored
 * against the wrong column. Here it is one map and one builder with tests.
 *
 * ## The risk level is never an input
 *
 * `RecordScreeningBody` has no `riskLevel` and neither does the draft, mirroring
 * the backend's structural guarantee: the level is derived from the measurements by
 * `utils/screening.ts`, so a form that could post one would turn a clinical column
 * into an opinion. This module builds readings; it does not classify them.
 */

import type { RecordScreeningBody, ScreeningType, ScreeningValuesBody } from './api-types';
import { dateTimeLocalToIso } from './dates';

// ---------------------------------------------------------------------------
// Constants copied from the backend, and safe to copy
// ---------------------------------------------------------------------------

/**
 * The cap on a reading's note, copied from `MAX_NOTES_LENGTH` in
 * `screenings.routes.ts`. A copy that could drift, and safe for the reason
 * `STAFF_LIMITS` gives: the server re-validates and is authoritative, so this
 * exists only to tell the pharmacist before the round trip.
 */
export const SCREENING_NOTES_MAX = 500;

/**
 * How far ahead of the clock a `measuredAt` is still believed, copied from
 * `MEASURED_AT_SKEW_MS` in `screenings.service.ts`. The server refuses a
 * forward-dated reading because `latestScreeningOfType` orders by `measured_at
 * desc`, so one future row becomes a patient's most recent reading forever. The
 * allowance is for a phone whose clock runs fast, not for forward-dating.
 */
export const MEASURED_AT_SKEW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// The reading fields, and which ones each type collects
// ---------------------------------------------------------------------------

/**
 * The text inputs a reading form can show. Seven of these are `values` columns and
 * one — `heightCm` — is a top-level field only, because a height is recorded but
 * never classified and is what a BMI is computed from.
 */
export type ReadingKey =
  | 'systolicBp'
  | 'diastolicBp'
  | 'bloodGlucoseMmol'
  | 'weightKg'
  | 'heightCm'
  | 'temperatureC'
  | 'heartRateBpm';

/**
 * Which readings each type collects, and therefore which inputs its form shows and
 * which values `firstScreeningError` requires.
 *
 * A `Record` over `ScreeningType`, so a seventh type added to the enum is a compile
 * error here until somebody says what it measures — the same exhaustiveness the
 * backend's switches buy themselves. `bmi` lists a weight and a height rather than a
 * ratio because that is what the counter actually has: a scale and a stature rod.
 */
export const SCREENING_TYPE_FIELDS: Record<ScreeningType, readonly ReadingKey[]> = {
  blood_pressure: ['systolicBp', 'diastolicBp'],
  blood_sugar: ['bloodGlucoseMmol'],
  bmi: ['weightKg', 'heightCm'],
  weight: ['weightKg'],
  temperature: ['temperatureC'],
  heart_rate: ['heartRateBpm'],
};

/**
 * The reading form's own shape: a type, every input as text, an optional
 * `datetime-local` for when it was taken (empty means "just now"), and a note. The
 * conversion to numbers and to the body lives in `recordScreeningBody`, so a form
 * never parses a reading itself.
 */
export interface ScreeningDraft {
  type: ScreeningType;
  systolicBp: string;
  diastolicBp: string;
  bloodGlucoseMmol: string;
  weightKg: string;
  heightCm: string;
  temperatureC: string;
  heartRateBpm: string;
  measuredAt: string;
  notes: string;
}

export const EMPTY_SCREENING_DRAFT: ScreeningDraft = {
  type: 'blood_pressure',
  systolicBp: '',
  diastolicBp: '',
  bloodGlucoseMmol: '',
  weightKg: '',
  heightCm: '',
  temperatureC: '',
  heartRateBpm: '',
  measuredAt: '',
  notes: '',
};

// ---------------------------------------------------------------------------
// Filters and the history query
// ---------------------------------------------------------------------------

/**
 * The filters on the screening history. `patientId` is empty on the cross-patient
 * `/screenings` page and set on a patient's own page; `type` is a single value
 * rather than a list because `api-client`'s `buildQuery` renders one value per key,
 * so a multi-select would arrive as the comma-joined string the route refuses.
 */
export interface ScreeningFilters {
  patientId: string;
  type: string;
  from: string;
  to: string;
}

export const EMPTY_SCREENING_FILTERS: ScreeningFilters = {
  patientId: '',
  type: '',
  from: '',
  to: '',
};

/** The query for `GET /screenings`, sending only the filters that are set. */
export function screeningQueryFrom(
  filters: ScreeningFilters,
  limit: number,
  offset: number
): Record<string, string | number> {
  const query: Record<string, string | number> = { limit, offset };
  const patientId = filters.patientId.trim();
  if (patientId !== '') query.patientId = patientId;
  const type = filters.type.trim();
  if (type !== '') query.type = type;
  const from = filters.from.trim();
  if (from !== '') query.from = from;
  const to = filters.to.trim();
  if (to !== '') query.to = to;
  return query;
}

/** Whether any filter is set, so the page knows to offer "Clear". */
export function screeningFiltersActive(filters: ScreeningFilters): boolean {
  return (
    filters.patientId.trim() !== '' ||
    filters.type.trim() !== '' ||
    filters.from.trim() !== '' ||
    filters.to.trim() !== ''
  );
}

/** The query for `GET /screenings/latest`, whose two parameters are both required. */
export function latestScreeningQuery(
  patientId: string,
  type: ScreeningType
): Record<string, string> {
  return { patientId, type };
}

// ---------------------------------------------------------------------------
// Building the body
// ---------------------------------------------------------------------------

/**
 * One reading as a number, or null when nothing was typed.
 *
 * Mirrors the backend's `toNumberOrNull`: `Number('')` is 0 and 0 is finite, so
 * without the trim-and-empty step a blank field would arrive as a reading of zero
 * and be refused for being zero — the wrong answer to the right question, sending
 * the pharmacist to look at a field that has nothing in it.
 */
function readingNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The body `POST /screenings` wants, built from the readings this type collects.
 *
 * Every one of the seven `values` keys is written out — the route reads each with
 * `readingsFrom`, which defaults an absent key to null, but sending the whole object
 * states the intent rather than leaving five keys to a default. A weight and a
 * height on a `bmi` reading go at the top level, where the service computes the
 * ratio from them; every other reading is the classified one and goes in `values`.
 * `measuredAt` is omitted when blank, which the service reads as "now".
 */
export function recordScreeningBody(patientId: string, draft: ScreeningDraft): RecordScreeningBody {
  const values: ScreeningValuesBody = {
    systolicBp: null,
    diastolicBp: null,
    bloodGlucoseMmol: null,
    bmi: null,
    weightKg: null,
    temperatureC: null,
    heartRateBpm: null,
  };
  const body: RecordScreeningBody = { patientId, type: draft.type, values };
  const read = (key: ReadingKey): number | null => readingNumber(draft[key]);

  switch (draft.type) {
    case 'blood_pressure':
      values.systolicBp = read('systolicBp');
      values.diastolicBp = read('diastolicBp');
      break;
    case 'blood_sugar':
      values.bloodGlucoseMmol = read('bloodGlucoseMmol');
      break;
    case 'bmi':
      // The scale and the stature rod, not a ratio: the service computes the BMI
      // from these two and classifies that, so `values.bmi` is left null on purpose.
      body.weightKg = read('weightKg');
      body.heightCm = read('heightCm');
      break;
    case 'weight':
      values.weightKg = read('weightKg');
      break;
    case 'temperature':
      values.temperatureC = read('temperatureC');
      break;
    case 'heart_rate':
      values.heartRateBpm = read('heartRateBpm');
      break;
  }

  if (draft.measuredAt.trim() !== '') {
    const measuredAt = dateTimeLocalToIso(draft.measuredAt);
    if (measuredAt !== null) body.measuredAt = measuredAt;
  }
  const notes = draft.notes.trim();
  if (notes !== '') body.notes = notes;

  return body;
}

// ---------------------------------------------------------------------------
// Validation — fast feedback; the server remains authoritative.
// ---------------------------------------------------------------------------

/**
 * The one field that stopped a save, and why. `field` is the input's key so the
 * modal can point at it, matching the `{ field, message }` shape the backend's own
 * `measurementError` returns — two sources of field errors that answer differently
 * would mean the counter shows two kinds of red.
 */
export interface ScreeningDraftError {
  field: ReadingKey | 'measuredAt' | 'notes';
  message: string;
}

/**
 * The first thing wrong with a reading draft, or null when it may be saved.
 *
 * The readings this type needs are each required and each greater than zero — every
 * one is a measurement of a living person, so none can be zero or negative, which is
 * the same rule the backend's `reading` helper states. `labelFor` supplies the human
 * name of a field so the sentences live beside the labels in the words file rather
 * than being a second copy here, following the label-as-a-parameter shape
 * `lib/inventory.ts` uses.
 */
export function firstScreeningError(
  draft: ScreeningDraft,
  labelFor: (key: ReadingKey) => string,
  now: Date = new Date()
): ScreeningDraftError | null {
  for (const key of SCREENING_TYPE_FIELDS[draft.type]) {
    const label = labelFor(key);
    if (draft[key].trim() === '') {
      return { field: key, message: `${label} is needed` };
    }
    const parsed = readingNumber(draft[key]);
    if (parsed === null || parsed <= 0) {
      return { field: key, message: `${label} has to be a number greater than zero` };
    }
  }

  if (draft.measuredAt.trim() !== '') {
    const iso = dateTimeLocalToIso(draft.measuredAt);
    if (iso === null) {
      return { field: 'measuredAt', message: 'Enter the date and time the reading was taken' };
    }
    if (Date.parse(iso) > now.getTime() + MEASURED_AT_SKEW_MS) {
      return {
        field: 'measuredAt',
        message: 'A reading cannot be taken in the future. Leave it blank to record it as now.',
      };
    }
  }

  if (draft.notes.trim().length > SCREENING_NOTES_MAX) {
    return { field: 'notes', message: `Notes must be ${SCREENING_NOTES_MAX} characters or fewer` };
  }

  return null;
}
