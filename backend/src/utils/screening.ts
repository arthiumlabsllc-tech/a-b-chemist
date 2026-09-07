import type { RiskLevel, ScreeningType } from './schema-enums';

/**
 * Screening risk classification, and the arithmetic a BMI is made of.
 *
 * A pure module. No database, no clock, no HTTP — every function takes the
 * reading it is judging as an argument and returns a value, which is the only
 * shape that can be tested at a boundary. And the boundaries are the whole
 * point: "is 140 systolic high or moderate" is a question with one right answer
 * here and a different one in whichever component guessed.
 *
 * ## Classified here, and never accepted from a caller
 *
 * `screenings.risk_level` is `not null`, so something must always supply it.
 * That something is this module, called by the service on the way in. A request
 * body carrying `riskLevel` is ignored rather than validated, because a level a
 * client chose is a level nobody can explain: the pharmacist reading "high" on
 * the screen has to be able to ask what made it high, and the answer has to be a
 * number on the same row.
 *
 * This is the same rule `services/inventory.service.ts` applies to derived stock
 * and the one Phase 5 applies to tax — the server computes what the server can
 * justify.
 *
 * ## Why this is not in the shared package
 *
 * The tax engine is shared because it has to run in a service worker to price a
 * sale offline. Risk classification does not: a screening captured while the
 * connection is down is classified when it syncs, by this function, once. Two
 * copies of a clinical threshold — one in a browser bundle that updates when
 * the user refreshes and one here that updates when we deploy — would eventually
 * disagree about the same patient, and the disagreement would be invisible
 * because each side would look internally consistent.
 *
 * ## Risk is not one direction
 *
 * Four of the six readings have a dangerous low end as well as a dangerous high
 * end, and a classifier written as "bigger is worse" gets all four wrong in the
 * direction that matters. A glucose of 3.2 mmol/L is a smaller number than 5.0
 * and a far more urgent one. Every threshold below therefore runs in both
 * directions, and each carries a reason string — see `RiskAssessment`.
 */

/**
 * Systolic and diastolic cut-offs, in mmHg.
 *
 * 140/90 is the treatment threshold in the WHO and Ghana Hypertension
 * guidelines, and 180/110 is where a reading stops being a referral and becomes
 * an emergency. Neither is used as a diagnosis here: a screening is one cuff
 * reading taken at a counter, and the classification says how quickly somebody
 * should have it repeated by a clinician, not what they have.
 *
 * 120/80 begins "high normal", which is worth a moderate flag rather than a
 * clean bill because it is the range where a recheck and a conversation about
 * salt actually change the trajectory.
 *
 * The low end is as load-bearing as the high. 90/60 is the conventional
 * hypotension threshold, and a reading below it at a community pharmacy counter
 * is more likely to be sepsis, bleeding or over-medication than fitness — none
 * of which a "low risk" badge should be sitting on top of.
 */
export const SYSTOLIC_HYPOTENSION = 90;
export const DIASTOLIC_HYPOTENSION = 60;
export const SYSTOLIC_ELEVATED = 120;
export const DIASTOLIC_ELEVATED = 80;
export const SYSTOLIC_HYPERTENSION = 140;
export const DIASTOLIC_HYPERTENSION = 90;

/**
 * Plasma glucose cut-offs, in mmol/L — the unit the schema stores
 * (`blood_glucose_mmol`), and the one every Ghanaian laboratory reports in.
 *
 * These are **random** (non-fasting) thresholds, and that is a decision forced
 * by the schema rather than a preference: `screenings` has no fasting flag, so
 * there is no way to know whether the person ate lunch before walking in.
 * Applying the fasting cut-off of 7.0 mmol/L to a post-meal sample would flag a
 * healthy customer as diabetic-range, which is the error that costs the pharmacy
 * its credibility fastest.
 *
 * The cost of the conservative reading is real and worth stating: impaired
 * *fasting* glucose sits at 6.1-6.9 mmol/L and a random reading in that range is
 * classified low here. Somebody in it will be caught by a fasting test at a
 * clinic, not by this screening. 11.1 mmol/L is the WHO's random-plasma
 * diabetic threshold and 7.8 the upper bound of a normal random reading.
 *
 * 4.0 mmol/L is the hypoglycaemia threshold, and it is the most urgent number in
 * this file: a person at 3.2 needs glucose now, not a referral.
 */
export const GLUCOSE_HYPO_MMOL = 4.0;
export const GLUCOSE_RANDOM_NORMAL_MMOL = 7.8;
export const GLUCOSE_RANDOM_DIABETIC_MMOL = 11.1;

/**
 * BMI cut-offs, in kg/m² — the WHO adult classifications.
 *
 * **These are adult cut-offs and the schema cannot tell whether the patient is
 * an adult.** `patients.date_of_birth` is nullable and `screenings` carries no
 * age, so a BMI recorded for a child is classified against a table that does not
 * apply to them and will read as severely underweight for a healthy ten-year-old.
 * That is a limitation of the data model rather than of this function, it cannot
 * be fixed here, and it is stated here because this is where a reader would
 * reasonably expect the classification to be safe. The screening form says so
 * beside the field.
 *
 * 16 is the WHO boundary for severe thinness. Underweight is flagged rather than
 * ignored because in this setting unexplained low body mass is as often a signal
 * — TB, untreated diabetes, HIV — as a lifestyle fact.
 */
export const BMI_SEVERE_THINNESS = 16;
export const BMI_UNDERWEIGHT = 18.5;
export const BMI_OVERWEIGHT = 25;
export const BMI_OBESE = 30;

/**
 * Core temperature cut-offs, in °C.
 *
 * 38.0 is the conventional fever threshold and 35.0 the hypothermia one.
 * `temperature_c` is `numeric(4, 1)`, so both boundaries are exactly
 * representable and a reading cannot fall between 37.9 and 38.0.
 *
 * 37.5 to 37.9 is a low-grade reading: not a fever, and not nothing. It is the
 * range where the useful instruction is "measure it again tomorrow", which is a
 * moderate and not a high.
 */
export const TEMPERATURE_HYPOTHERMIA_C = 35.0;
export const TEMPERATURE_LOW_GRADE_C = 37.5;
export const TEMPERATURE_FEVER_C = 38.0;

/**
 * Resting heart rate cut-offs, in beats per minute.
 *
 * 50 to 100 is treated as the normal band rather than the textbook 60 to 100,
 * because a reading in the fifties is ordinary in somebody who walks everywhere
 * and flagging it would put a moderate badge on a healthy customer. Below 50 is
 * worth a look; below 40 is not a screening finding any more.
 *
 * Above 100 is tachycardia. Above 120 at rest, in a person who has just walked
 * to a counter, is the range where fever, anaemia, dehydration and arrhythmia are
 * all candidates and none of them is a "come back next month".
 */
export const HEART_RATE_SEVERE_BRADYCARDIA = 40;
export const HEART_RATE_BRADYCARDIA = 50;
export const HEART_RATE_TACHYCARDIA = 100;
export const HEART_RATE_SEVERE_TACHYCARDIA = 120;

/**
 * One reading, in the shape its classification needs.
 *
 * A discriminated union rather than one interface with eight optional numbers,
 * and the difference is what the type system enforces. With optional fields a
 * caller can ask for a blood-pressure classification having supplied only a
 * systolic, and the function has to invent an answer; here that call does not
 * compile. `screenings` allows each measurement column to be null because one
 * table holds six kinds of row, but a `blood_pressure` row that reached this
 * function is guaranteed to carry both of its numbers.
 *
 * `services/screenings`' validation enforces the same pairing at the boundary,
 * so the two agree: the route refuses the incomplete row and this signature makes
 * it unrepresentable.
 */
export type ScreeningMeasurement =
  | { type: 'blood_pressure'; systolic: number; diastolic: number }
  | { type: 'blood_sugar'; glucoseMmol: number }
  | { type: 'bmi'; bmi: number }
  | { type: 'weight'; weightKg: number }
  | { type: 'temperature'; temperatureC: number }
  | { type: 'heart_rate'; heartRateBpm: number };

/**
 * The measurement a screening row carries, as the driver hands it back.
 *
 * Every field is nullable because one table holds six kinds of row, and the
 * `numeric` ones arrive as `string | number`: `blood_glucose_mmol numeric(5, 2)`
 * comes over the wire as the decimal text `7.80` rather than as a double, which
 * is what keeps two decimal places from becoming 7.8. A request body carries the
 * same field as a JSON number, so both shapes have to be accepted and converted
 * in one place — `classifyRisk` compares with `>=`, and a string on one side of
 * that gives an answer which is wrong rather than an error.
 */
export interface ScreeningValues {
  systolicBp: string | number | null;
  diastolicBp: string | number | null;
  bloodGlucoseMmol: string | number | null;
  bmi: string | number | null;
  weightKg: string | number | null;
  temperatureC: string | number | null;
  heartRateBpm: string | number | null;
}

/**
 * Either a reading ready to classify, or the one field that stopped it.
 *
 * `field` is the request field path — `systolicBp`, not `the top number` — so a
 * form can point at the input, matching `utils/tax-errors.ts`'s `TaxFault`.
 * `message` is the sentence beside it, written for the person at the counter and
 * naming no table, column or constraint.
 */
export type MeasurementParse =
  | { ok: true; measurement: ScreeningMeasurement }
  | { ok: false; field: string; message: string };

/**
 * One measurement, as a number, or null if there was nothing there to read.
 *
 * Exported because two callers need the *same* answer and they meet the value in
 * two different shapes: `measurementFrom` reads a request body, where a JSON
 * number arrives as a number and a half-filled form arrives as an empty string,
 * while `repositories/screenings.repository.ts` maps a row, where
 * `blood_glucose_mmol numeric(5, 2)` arrives as the decimal text `7.80`. A
 * second parser in the mapper would be a second opinion about what a blank field
 * is, and the two would disagree in the one case that is hard to notice — the
 * blank that `Number('')` turns into a reading of zero.
 */
export function toNumberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // `Number('')` and `Number('   ')` are both 0, and 0 is finite — so without the
  // trim-and-check-empty step a blank field would come through as a reading of
  // zero and be refused for being zero. That is the wrong answer to the right
  // question: the person at the counter would go and look for a field that has
  // nothing in it, and would not find anything wrong with it. "Nothing typed" and
  // "typed 0" have to be two different messages.
  const text = value.trim();
  if (text === '') return null;
  const parsed = Number(text);
  // `Number('12abc')` is NaN, so this is what separates a word from a reading.
  return Number.isFinite(parsed) ? parsed : null;
}

function reading(
  value: string | number | null,
  field: string,
  what: string
): MeasurementParse | { ok: true; value: number } {
  const parsed = toNumberOrNull(value);
  if (parsed === null) {
    return { ok: false, field, message: `${what} is needed, and it has to be a number.` };
  }
  // Every one of these measurements is of a living person, so none of them can be
  // zero or negative — and the schema says the same with `check (is null or > 0)`
  // on the blood pressure columns. Refusing here means the answer is a sentence
  // about the field rather than a database error about a constraint.
  if (parsed <= 0) {
    return { ok: false, field, message: `${what} has to be greater than zero.` };
  }
  return { ok: true, value: parsed };
}

/**
 * Builds the reading a classification needs out of a screening row.
 *
 * This is where the pairing rule lives: a `blood_pressure` screening has to carry
 * both of its numbers, and a `bmi` screening has to carry its BMI. The union in
 * `ScreeningMeasurement` makes an unpaired reading unrepresentable, but something
 * still has to turn a row of seven nullable columns into one, and doing it here
 * means the rule is stated once rather than once per caller.
 *
 * The `switch` is exhaustive by its declared return type, so a seventh member of
 * `screening_type` is a compile error in this file too — and here it is the
 * direction `classifyRisk` cannot check, because this is the function that first
 * meets the enum as a value rather than as a literal.
 */
export function measurementFrom(
  type: ScreeningType,
  values: ScreeningValues
): MeasurementParse {
  switch (type) {
    case 'blood_pressure': {
      const systolic = reading(values.systolicBp, 'systolicBp', 'The top blood pressure number');
      if (!('value' in systolic)) return systolic;
      const diastolic = reading(
        values.diastolicBp,
        'diastolicBp',
        'The bottom blood pressure number'
      );
      if (!('value' in diastolic)) return diastolic;
      return {
        ok: true,
        measurement: { type, systolic: systolic.value, diastolic: diastolic.value },
      };
    }
    case 'blood_sugar': {
      const glucose = reading(
        values.bloodGlucoseMmol,
        'bloodGlucoseMmol',
        'The blood sugar reading in mmol/L'
      );
      if (!('value' in glucose)) return glucose;
      return { ok: true, measurement: { type, glucoseMmol: glucose.value } };
    }
    case 'bmi': {
      const bmi = reading(values.bmi, 'bmi', 'The BMI');
      if (!('value' in bmi)) return bmi;
      return { ok: true, measurement: { type, bmi: bmi.value } };
    }
    case 'weight': {
      const weight = reading(values.weightKg, 'weightKg', 'The weight in kg');
      if (!('value' in weight)) return weight;
      return { ok: true, measurement: { type, weightKg: weight.value } };
    }
    case 'temperature': {
      const temperature = reading(values.temperatureC, 'temperatureC', 'The temperature in °C');
      if (!('value' in temperature)) return temperature;
      return { ok: true, measurement: { type, temperatureC: temperature.value } };
    }
    case 'heart_rate': {
      const pulse = reading(values.heartRateBpm, 'heartRateBpm', 'The pulse in beats per minute');
      if (!('value' in pulse)) return pulse;
      return { ok: true, measurement: { type, heartRateBpm: pulse.value } };
    }
  }
}

/**
 * What a classification decided, and why.
 *
 * `reason` is a sentence for the person at the counter, and it exists because a
 * level on its own is misleading in exactly the cases that matter most. "High"
 * beside a glucose of 3.2 looks like a mistake to somebody expecting bigger
 * numbers to be worse, and it is not — it is hypoglycaemia, and the reason says
 * so. `null` means an ordinary reading with nothing to add.
 *
 * Reasons quote the reading and the threshold it crossed, never a diagnosis. This
 * module is not qualified to say "diabetes" and a pharmacy screening must not
 * imply it: the sentence says what was measured and how quickly to act on it.
 */
export interface RiskAssessment {
  level: RiskLevel;
  reason: string | null;
}

const ORDINARY: RiskAssessment = { level: 'low', reason: null };

/**
 * Classifies one reading.
 *
 * The `switch` is exhaustive by its declared return type rather than by a
 * `never` assertion at the bottom: a seventh member added to `screening_type`
 * makes this function fall through, and "lacks ending return statement" is then a
 * compile error naming the file. The same addition to `SCREENING_TYPES` in
 * `utils/schema-enums.ts` is caught against the real schema by
 * `__tests__/schema-enums.test.ts`, so a new screening type cannot arrive
 * without both gates firing.
 */
export function classifyRisk(measurement: ScreeningMeasurement): RiskAssessment {
  switch (measurement.type) {
    case 'blood_pressure':
      return classifyBloodPressure(measurement.systolic, measurement.diastolic);
    case 'blood_sugar':
      return classifyGlucose(measurement.glucoseMmol);
    case 'bmi':
      return classifyBmi(measurement.bmi);
    case 'weight':
      return classifyWeight(measurement.weightKg);
    case 'temperature':
      return classifyTemperature(measurement.temperatureC);
    case 'heart_rate':
      return classifyHeartRate(measurement.heartRateBpm);
  }
}

function classifyBloodPressure(systolic: number, diastolic: number): RiskAssessment {
  const reading = `${systolic}/${diastolic}`;

  if (systolic < SYSTOLIC_HYPOTENSION || diastolic < DIASTOLIC_HYPOTENSION) {
    return {
      level: 'high',
      reason: `A blood pressure of ${reading} is below the ${SYSTOLIC_HYPOTENSION}/${DIASTOLIC_HYPOTENSION} low-blood-pressure threshold. Low readings need attention now, not later.`,
    };
  }
  if (systolic >= SYSTOLIC_HYPERTENSION || diastolic >= DIASTOLIC_HYPERTENSION) {
    return {
      level: 'high',
      reason: `A blood pressure of ${reading} has reached the ${SYSTOLIC_HYPERTENSION}/${DIASTOLIC_HYPERTENSION} high-blood-pressure threshold. Refer for a repeat measurement by a clinician.`,
    };
  }
  if (systolic >= SYSTOLIC_ELEVATED || diastolic >= DIASTOLIC_ELEVATED) {
    return {
      level: 'moderate',
      reason: `A blood pressure of ${reading} is above the ${SYSTOLIC_ELEVATED}/${DIASTOLIC_ELEVATED} threshold but below ${SYSTOLIC_HYPERTENSION}/${DIASTOLIC_HYPERTENSION}. Worth rechecking within a few weeks.`,
    };
  }
  return ORDINARY;
}

function classifyGlucose(glucoseMmol: number): RiskAssessment {
  if (glucoseMmol < GLUCOSE_HYPO_MMOL) {
    return {
      level: 'high',
      reason: `A blood sugar of ${glucoseMmol} mmol/L is below ${GLUCOSE_HYPO_MMOL}. This reading is low, and low is the urgent direction — treat now.`,
    };
  }
  if (glucoseMmol >= GLUCOSE_RANDOM_DIABETIC_MMOL) {
    return {
      level: 'high',
      reason: `A blood sugar of ${glucoseMmol} mmol/L is at or above ${GLUCOSE_RANDOM_DIABETIC_MMOL}, taken at a random time of day. Refer for a fasting test.`,
    };
  }
  if (glucoseMmol >= GLUCOSE_RANDOM_NORMAL_MMOL) {
    return {
      level: 'moderate',
      reason: `A blood sugar of ${glucoseMmol} mmol/L is above ${GLUCOSE_RANDOM_NORMAL_MMOL} for a reading taken at a random time of day. Worth a fasting recheck.`,
    };
  }
  return ORDINARY;
}

function classifyBmi(bmi: number): RiskAssessment {
  if (bmi < BMI_SEVERE_THINNESS) {
    return {
      level: 'high',
      reason: `A BMI of ${bmi} is below ${BMI_SEVERE_THINNESS}. This needs a clinical assessment, and it is not a screening finding.`,
    };
  }
  if (bmi < BMI_UNDERWEIGHT) {
    return {
      level: 'moderate',
      reason: `A BMI of ${bmi} is below ${BMI_UNDERWEIGHT}. Worth asking whether the weight loss was intended.`,
    };
  }
  if (bmi >= BMI_OBESE) {
    return {
      level: 'high',
      reason: `A BMI of ${bmi} is at or above ${BMI_OBESE}.`,
    };
  }
  if (bmi >= BMI_OVERWEIGHT) {
    return {
      level: 'moderate',
      reason: `A BMI of ${bmi} is at or above ${BMI_OVERWEIGHT}.`,
    };
  }
  return ORDINARY;
}

/**
 * A body mass on its own is not a risk, and this says so rather than pretending
 * otherwise.
 *
 * There is no threshold on kilograms that means anything without a height or a
 * previous weight to compare against — 45 kg is ordinary for one adult and an
 * emergency for another. The level is `'low'` because the column is `not null`
 * and there is nothing to act on, and the reason is set because a green "low"
 * badge on a weight reading would claim an assessment nobody made.
 *
 * A weight is still worth recording: the trend across visits is the useful fact,
 * and that is a question for the patient's history rather than for one row.
 */
function classifyWeight(weightKg: number): RiskAssessment {
  return {
    level: 'low',
    reason: `A weight of ${weightKg} kg on its own is not a risk reading. Record a height with it for a BMI, or compare it against this patient's previous weights.`,
  };
}

function classifyTemperature(temperatureC: number): RiskAssessment {
  if (temperatureC < TEMPERATURE_HYPOTHERMIA_C) {
    return {
      level: 'high',
      reason: `A temperature of ${temperatureC} °C is below ${TEMPERATURE_HYPOTHERMIA_C}. Check the reading, and treat the person rather than the thermometer if it holds.`,
    };
  }
  if (temperatureC >= TEMPERATURE_FEVER_C) {
    return {
      level: 'high',
      reason: `A temperature of ${temperatureC} °C is at or above ${TEMPERATURE_FEVER_C}.`,
    };
  }
  if (temperatureC >= TEMPERATURE_LOW_GRADE_C) {
    return {
      level: 'moderate',
      reason: `A temperature of ${temperatureC} °C is above ${TEMPERATURE_LOW_GRADE_C} but below ${TEMPERATURE_FEVER_C}. Worth measuring again tomorrow.`,
    };
  }
  return ORDINARY;
}

function classifyHeartRate(heartRateBpm: number): RiskAssessment {
  if (heartRateBpm < HEART_RATE_SEVERE_BRADYCARDIA) {
    return {
      level: 'high',
      reason: `A pulse of ${heartRateBpm} beats per minute is below ${HEART_RATE_SEVERE_BRADYCARDIA}. This needs clinical attention today.`,
    };
  }
  if (heartRateBpm > HEART_RATE_SEVERE_TACHYCARDIA) {
    return {
      level: 'high',
      reason: `A pulse of ${heartRateBpm} beats per minute is above ${HEART_RATE_SEVERE_TACHYCARDIA} at rest. This needs clinical attention today.`,
    };
  }
  if (heartRateBpm < HEART_RATE_BRADYCARDIA) {
    return {
      level: 'moderate',
      reason: `A pulse of ${heartRateBpm} beats per minute is below ${HEART_RATE_BRADYCARDIA}. Worth asking about dizziness or medication.`,
    };
  }
  if (heartRateBpm > HEART_RATE_TACHYCARDIA) {
    return {
      level: 'moderate',
      reason: `A pulse of ${heartRateBpm} beats per minute is above ${HEART_RATE_TACHYCARDIA} at rest. Worth measuring again once they have sat down.`,
    };
  }
  return ORDINARY;
}

/**
 * BMI from a weight and a height, rounded to the one decimal the column stores.
 *
 * Returns null rather than throwing when either figure cannot be a measurement:
 * a height of zero is a form left half-filled, and `Infinity` written into a
 * `numeric(4, 1)` column would be a database error about a patient's body rather
 * than about a missing field.
 *
 * The rounding happens here and the classification happens on the rounded value,
 * in that order, so the number on the screen and the badge beside it are always
 * describing the same figure. Classifying before rounding would let a true BMI
 * of 24.96 be stored as 25.0 — displayed as overweight — while the badge said
 * normal, and the two would look like a rendering bug to anybody who noticed.
 */
export function computeBmi(weightKg: number, heightCm: number): number | null {
  if (!Number.isFinite(weightKg) || !Number.isFinite(heightCm)) return null;
  if (weightKg <= 0 || heightCm <= 0) return null;

  const metres = heightCm / 100;
  return Math.round((weightKg / (metres * metres)) * 10) / 10;
}
