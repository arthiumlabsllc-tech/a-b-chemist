/**
 * The words and badge tones the screening UI renders, in one place.
 *
 * The risk tone is the one worth a word: `low` is positive, `moderate` a warning
 * and `high` a negative, so a pharmacist scanning a list of readings sees the ones
 * that need a follow-up in red without reading a single number. The colour is a
 * reading of the level the *server* derived — this file never re-derives it from
 * the measurements, for the reason `lib/screenings.ts` gives about the level never
 * being an input.
 */

import type { BadgeTone } from '@/components/ui/display';
import type { RiskLevel, ScreeningType } from '@/lib/api-types';
import type { ReadingKey } from '@/lib/screenings';

export const SCREENING_TYPE_WORD: Record<ScreeningType, string> = {
  blood_pressure: 'Blood pressure',
  blood_sugar: 'Blood sugar',
  bmi: 'BMI',
  weight: 'Weight',
  temperature: 'Temperature',
  heart_rate: 'Heart rate',
};

export const RISK_LEVEL_WORD: Record<RiskLevel, string> = {
  low: 'Low risk',
  moderate: 'Moderate risk',
  high: 'High risk',
};

export const RISK_LEVEL_TONE: Record<RiskLevel, BadgeTone> = {
  low: 'positive',
  moderate: 'warning',
  high: 'negative',
};

/**
 * The human name of each reading input. This is the `labelFor` that
 * `firstScreeningError` builds its sentences from, so the field a pharmacist is
 * told about reads "Systolic blood pressure is needed" rather than "systolicBp is
 * needed" — the words live here, beside the labels on the inputs, not in the logic.
 */
export const READING_WORD: Record<ReadingKey, string> = {
  systolicBp: 'Systolic blood pressure',
  diastolicBp: 'Diastolic blood pressure',
  bloodGlucoseMmol: 'Blood glucose',
  weightKg: 'Weight',
  heightCm: 'Height',
  temperatureC: 'Temperature',
  heartRateBpm: 'Heart rate',
};

/** The unit each reading is taken in, shown beside the input and the stored value. */
export const READING_UNIT: Record<ReadingKey, string> = {
  systolicBp: 'mmHg',
  diastolicBp: 'mmHg',
  bloodGlucoseMmol: 'mmol/L',
  weightKg: 'kg',
  heightCm: 'cm',
  temperatureC: '\u00b0C',
  heartRateBpm: 'bpm',
};
