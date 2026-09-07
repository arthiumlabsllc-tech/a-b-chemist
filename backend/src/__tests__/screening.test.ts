import {
  BMI_OBESE,
  BMI_OVERWEIGHT,
  BMI_SEVERE_THINNESS,
  BMI_UNDERWEIGHT,
  DIASTOLIC_ELEVATED,
  DIASTOLIC_HYPERTENSION,
  DIASTOLIC_HYPOTENSION,
  GLUCOSE_HYPO_MMOL,
  GLUCOSE_RANDOM_DIABETIC_MMOL,
  GLUCOSE_RANDOM_NORMAL_MMOL,
  HEART_RATE_BRADYCARDIA,
  HEART_RATE_SEVERE_BRADYCARDIA,
  HEART_RATE_SEVERE_TACHYCARDIA,
  HEART_RATE_TACHYCARDIA,
  SYSTOLIC_ELEVATED,
  SYSTOLIC_HYPERTENSION,
  SYSTOLIC_HYPOTENSION,
  TEMPERATURE_FEVER_C,
  TEMPERATURE_HYPOTHERMIA_C,
  TEMPERATURE_LOW_GRADE_C,
  classifyRisk,
  computeBmi,
  measurementFrom,
  type ScreeningMeasurement,
  type ScreeningValues,
} from '../utils/screening';
import {
  RISK_LEVELS,
  SCREENING_TYPES,
  type RiskLevel,
  type ScreeningType,
} from '../utils/schema-enums';

/**
 * Screening risk classification, tested at its boundaries.
 *
 * Every threshold is exercised three ways: the value just below it, the value
 * exactly on it, and the value just above. Two of those three are the ones a
 * `>` written where `>=` belonged would get wrong, and the mistake is invisible
 * in every other respect — the module still returns a valid level, the row still
 * saves, and the only difference is that one patient in a hundred is told their
 * blood pressure is fine when it is 140.
 *
 * The thresholds themselves are deliberately *not* re-derived here from clinical
 * sources. Each is imported from `utils/screening.ts` and the arithmetic is
 * written relative to it, so a threshold that is corrected in one place moves the
 * tests with it instead of leaving them asserting the old number and failing for
 * a reason that looks like a regression.
 */

describe('classifyRisk: blood pressure', () => {
  it('is ordinary below both elevated thresholds, and at the hypotension boundary', async () => {
    expect(classifyRisk({ type: 'blood_pressure', systolic: 119, diastolic: 79 }).level).toBe('low');
    // Exactly on the low thresholds is still ordinary: `<` not `<=`, because
    // 90/60 is the conventional boundary of hypotension and a reading sitting on
    // it is not below it.
    expect(
      classifyRisk({
        type: 'blood_pressure',
        systolic: SYSTOLIC_HYPOTENSION,
        diastolic: DIASTOLIC_HYPOTENSION,
      }).level
    ).toBe('low');
  });

  it('flags the low end as high, because a small number is the urgent direction here', async () => {
    expect(
      classifyRisk({
        type: 'blood_pressure',
        systolic: SYSTOLIC_HYPOTENSION - 1,
        diastolic: 70,
      })
    ).toEqual({
      level: 'high',
      reason: expect.stringContaining('below'),
    });
    // And through the diastolic alone. A classifier written as one `&&` would let
    // 89/95 through as ordinary on the strength of the diastolic being high.
    expect(
      classifyRisk({
        type: 'blood_pressure',
        systolic: 110,
        diastolic: DIASTOLIC_HYPOTENSION - 1,
      }).level
    ).toBe('high');
  });

  it('flags high normal from either number, at the threshold and not below it', async () => {
    expect(
      classifyRisk({
        type: 'blood_pressure',
        systolic: SYSTOLIC_ELEVATED,
        diastolic: 70,
      }).level
    ).toBe('moderate');
    expect(
      classifyRisk({
        type: 'blood_pressure',
        systolic: 110,
        diastolic: DIASTOLIC_ELEVATED,
      }).level
    ).toBe('moderate');
    expect(
      classifyRisk({
        type: 'blood_pressure',
        systolic: SYSTOLIC_ELEVATED - 1,
        diastolic: DIASTOLIC_ELEVATED - 1,
      }).level
    ).toBe('low');
  });

  it('flags hypertension from either number, at the threshold and not below it', async () => {
    expect(
      classifyRisk({
        type: 'blood_pressure',
        systolic: SYSTOLIC_HYPERTENSION,
        diastolic: 85,
      }).level
    ).toBe('high');
    expect(
      classifyRisk({
        type: 'blood_pressure',
        systolic: 130,
        diastolic: DIASTOLIC_HYPERTENSION,
      }).level
    ).toBe('high');
    expect(
      classifyRisk({
        type: 'blood_pressure',
        systolic: SYSTOLIC_HYPERTENSION - 1,
        diastolic: DIASTOLIC_HYPERTENSION - 1,
      }).level
    ).toBe('moderate');
  });

  it('classifies an isolated systolic and an isolated diastolic reading on their own', async () => {
    // Isolated systolic hypertension is the common pattern in an older customer
    // and the one a rule of "both numbers must be up" would miss entirely.
    expect(classifyRisk({ type: 'blood_pressure', systolic: 150, diastolic: 70 }).level).toBe(
      'high'
    );
    expect(classifyRisk({ type: 'blood_pressure', systolic: 118, diastolic: 95 }).level).toBe(
      'high'
    );
  });
});

describe('classifyRisk: blood sugar', () => {
  it('is ordinary between the hypo and the random-normal thresholds', async () => {
    expect(classifyRisk({ type: 'blood_sugar', glucoseMmol: GLUCOSE_HYPO_MMOL }).level).toBe('low');
    expect(classifyRisk({ type: 'blood_sugar', glucoseMmol: 5.4 }).level).toBe('low');
    expect(
      classifyRisk({ type: 'blood_sugar', glucoseMmol: GLUCOSE_HYPO_MMOL - 0.1 }).level
    ).toBe('high');
  });

  it('treats a low reading as more urgent than a middling high one', async () => {
    // The whole reason the reason string exists. 3.2 is a smaller number than 7.9
    // and needs acting on within minutes rather than weeks, and a badge that says
    // "high" beside it looks wrong to somebody expecting bigger to be worse.
    const hypo = classifyRisk({ type: 'blood_sugar', glucoseMmol: 3.2 });
    const impaired = classifyRisk({ type: 'blood_sugar', glucoseMmol: 7.9 });

    expect(hypo.level).toBe('high');
    expect(impaired.level).toBe('moderate');
    expect(hypo.reason).toContain('low is the urgent direction');
    expect(impaired.reason).toContain('fasting recheck');
  });

  it('flags the random diabetic threshold at 11.1 and not at 11.0', async () => {
    expect(
      classifyRisk({ type: 'blood_sugar', glucoseMmol: GLUCOSE_RANDOM_DIABETIC_MMOL }).level
    ).toBe('high');
    expect(
      classifyRisk({ type: 'blood_sugar', glucoseMmol: GLUCOSE_RANDOM_DIABETIC_MMOL - 0.1 }).level
    ).toBe('moderate');
    expect(
      classifyRisk({ type: 'blood_sugar', glucoseMmol: GLUCOSE_RANDOM_NORMAL_MMOL }).level
    ).toBe('moderate');
    expect(
      classifyRisk({ type: 'blood_sugar', glucoseMmol: GLUCOSE_RANDOM_NORMAL_MMOL - 0.1 }).level
    ).toBe('low');
  });

  it('says the reading was taken at a random time of day, because the thresholds depend on it', async () => {
    // The schema has no fasting flag. Saying "random" in the reason is what stops
    // a pharmacist reading a high flag as a fasting result, and it is the honest
    // limit of what one counter reading can support.
    expect(
      classifyRisk({ type: 'blood_sugar', glucoseMmol: 12.4 }).reason
    ).toContain('at a random time of day');
  });
});

describe('classifyRisk: BMI', () => {
  it('classifies both ends of the range, at each threshold and one step inside it', async () => {
    const at = (bmi: number): RiskLevel => classifyRisk({ type: 'bmi', bmi }).level;

    expect(at(BMI_SEVERE_THINNESS - 0.1)).toBe('high');
    expect(at(BMI_SEVERE_THINNESS)).toBe('moderate');
    expect(at(BMI_UNDERWEIGHT - 0.1)).toBe('moderate');
    expect(at(BMI_UNDERWEIGHT)).toBe('low');
    expect(at(24.9)).toBe('low');
    expect(at(BMI_OVERWEIGHT)).toBe('moderate');
    expect(at(BMI_OBESE - 0.1)).toBe('moderate');
    expect(at(BMI_OBESE)).toBe('high');
  });

  it('flags underweight rather than ignoring it', async () => {
    // A classifier written as "bigger is worse" reads 16.8 as the best number on
    // the scale. In this setting unexplained low body mass is as often a signal —
    // TB, untreated diabetes, HIV — as a lifestyle fact, and the reason asks the
    // question that tells them apart.
    const thin = classifyRisk({ type: 'bmi', bmi: 16.8 });
    expect(thin.level).toBe('moderate');
    expect(thin.reason).toContain('whether the weight loss was intended');
  });
});

describe('classifyRisk: weight', () => {
  it('is low at every value, and says that it is not an assessment', async () => {
    // The documented exception to "low means nothing to add". There is no
    // threshold on kilograms that means anything without a height or a previous
    // weight, so the level is the only value the `not null` column allows and the
    // reason is what stops a green badge claiming an assessment nobody made.
    for (const weightKg of [12, 45, 70, 140]) {
      const assessment = classifyRisk({ type: 'weight', weightKg });
      expect(assessment.level).toBe('low');
      expect(assessment.reason).toContain('not a risk reading');
      expect(assessment.reason).toContain(`${weightKg} kg`);
    }
  });
});

describe('classifyRisk: temperature', () => {
  it('classifies both ends, at each threshold and one step inside it', async () => {
    const at = (temperatureC: number): RiskLevel =>
      classifyRisk({ type: 'temperature', temperatureC }).level;

    expect(at(TEMPERATURE_HYPOTHERMIA_C - 0.1)).toBe('high');
    expect(at(TEMPERATURE_HYPOTHERMIA_C)).toBe('low');
    expect(at(TEMPERATURE_LOW_GRADE_C - 0.1)).toBe('low');
    expect(at(TEMPERATURE_LOW_GRADE_C)).toBe('moderate');
    expect(at(TEMPERATURE_FEVER_C - 0.1)).toBe('moderate');
    expect(at(TEMPERATURE_FEVER_C)).toBe('high');
  });

  it('tells a low temperature to be checked against the person, not just re-measured', async () => {
    // A cold reading at a counter is often the thermometer. Saying "check the
    // reading" first is what stops the pharmacy sending home somebody who is
    // actually fine, and "treat the person" second is what stops the opposite.
    expect(classifyRisk({ type: 'temperature', temperatureC: 34.2 }).reason).toContain(
      'treat the person rather than the thermometer'
    );
  });
});

describe('classifyRisk: heart rate', () => {
  it('classifies both ends, at each threshold and one step inside it', async () => {
    const at = (heartRateBpm: number): RiskLevel =>
      classifyRisk({ type: 'heart_rate', heartRateBpm }).level;

    expect(at(HEART_RATE_SEVERE_BRADYCARDIA - 1)).toBe('high');
    expect(at(HEART_RATE_SEVERE_BRADYCARDIA)).toBe('moderate');
    expect(at(HEART_RATE_BRADYCARDIA - 1)).toBe('moderate');
    // The normal band starts at 50 rather than the textbook 60, so the fifties
    // are ordinary: a moderate badge on somebody who walks everywhere would be a
    // flag with nothing behind it.
    expect(at(HEART_RATE_BRADYCARDIA)).toBe('low');
    expect(at(60)).toBe('low');
    expect(at(HEART_RATE_TACHYCARDIA)).toBe('low');
    expect(at(HEART_RATE_TACHYCARDIA + 1)).toBe('moderate');
    expect(at(HEART_RATE_SEVERE_TACHYCARDIA)).toBe('moderate');
    expect(at(HEART_RATE_SEVERE_TACHYCARDIA + 1)).toBe('high');
  });
});

describe('every screening type is classified', () => {
  /** One reading per type, in the ordinary range for each. */
  const ONE_OF_EACH: Record<string, ScreeningMeasurement> = {
    blood_pressure: { type: 'blood_pressure', systolic: 118, diastolic: 76 },
    blood_sugar: { type: 'blood_sugar', glucoseMmol: 5.2 },
    bmi: { type: 'bmi', bmi: 22.4 },
    weight: { type: 'weight', weightKg: 68 },
    temperature: { type: 'temperature', temperatureC: 36.8 },
    heart_rate: { type: 'heart_rate', heartRateBpm: 72 },
  };

  it('has a case for every member of the enum, and answers a level for each', () => {
    // The compile-time guard is the declared return type: a seventh member of
    // `screening_type` makes `classifyRisk` fall through and tsc refuse the file.
    // This is the runtime half, and it is the one that fails with a sentence
    // naming the missing type rather than a type error three layers away.
    expect(Object.keys(ONE_OF_EACH).sort()).toEqual([...SCREENING_TYPES].sort());

    for (const type of SCREENING_TYPES) {
      const measurement = ONE_OF_EACH[type];
      if (measurement === undefined) throw new Error(`no reading built for ${type}`);
      const assessment = classifyRisk(measurement);
      expect({ type, level: assessment.level }).toEqual({ type, level: 'low' });
      expect(RISK_LEVELS).toContain(assessment.level);
    }
  });

  it('gives a reason for every level that is an assessment, and only for the weight that is not', () => {
    // The invariant, and its one documented exception. A moderate or a high with
    // no reason beside it is a badge nobody can act on or explain to a patient;
    // a low with a reason is noise everywhere except the weight, where the reason
    // is the only thing stopping the level from reading as an assessment.
    const flagged: ScreeningMeasurement[] = [
      { type: 'blood_pressure', systolic: 155, diastolic: 95 },
      { type: 'blood_sugar', glucoseMmol: 12.8 },
      { type: 'bmi', bmi: 31.4 },
      { type: 'temperature', temperatureC: 38.6 },
      { type: 'heart_rate', heartRateBpm: 128 },
    ];
    for (const measurement of flagged) {
      const assessment = classifyRisk(measurement);
      expect(assessment.level).not.toBe('low');
      expect(typeof assessment.reason).toBe('string');
      expect((assessment.reason ?? '').length).toBeGreaterThan(0);
    }

    for (const [type, measurement] of Object.entries(ONE_OF_EACH)) {
      const assessment = classifyRisk(measurement);
      if (type === 'weight') {
        expect(typeof assessment.reason).toBe('string');
      } else {
        // An ordinary reading with a sentence beside it is noise, and noise on a
        // clinical record is what gets skimmed past when something important
        // finally appears in it.
        expect(assessment.reason).toBeNull();
      }
    }
  });

  it('never names a diagnosis, because a counter screening is not one', async () => {
    // A reason that said "diabetes" or "hypertension" would be a diagnosis issued
    // by a function, on one reading, by a pharmacy that is not permitted to make
    // one. The sentences say what was measured and how quickly to act.
    const readings: ScreeningMeasurement[] = [
      { type: 'blood_pressure', systolic: 185, diastolic: 115 },
      { type: 'blood_sugar', glucoseMmol: 16.0 },
      { type: 'bmi', bmi: 38.0 },
      { type: 'temperature', temperatureC: 39.4 },
      { type: 'heart_rate', heartRateBpm: 135 },
      { type: 'blood_sugar', glucoseMmol: 2.8 },
      { type: 'weight', weightKg: 40 },
    ];
    for (const reading of readings) {
      const reason = (classifyRisk(reading).reason ?? '').toLowerCase();
      for (const word of ['diabetes', 'diabetic', 'hypertension', 'hypertensive', 'sepsis']) {
        expect(reason).not.toContain(word);
      }
    }
  });
});

describe('computeBmi', () => {
  it('divides by the square of the height in metres, to the decimal the column stores', () => {
    // 70 / 1.75^2 = 22.857..., and `bmi numeric(4, 1)` holds one decimal.
    expect(computeBmi(70, 175)).toBe(22.9);
    expect(computeBmi(80, 175)).toBe(26.1);
    expect(computeBmi(95, 175)).toBe(31);
  });

  it('refuses a figure that cannot be a measurement rather than dividing by it', () => {
    // A height of zero is a form left half-filled. `Infinity` written into a
    // numeric column would surface as a database error about a patient's body,
    // which tells the person at the counter nothing about the field they missed.
    expect(computeBmi(70, 0)).toBeNull();
    expect(computeBmi(0, 175)).toBeNull();
    expect(computeBmi(-70, 175)).toBeNull();
    expect(computeBmi(70, -175)).toBeNull();
    expect(computeBmi(Number.NaN, 175)).toBeNull();
    expect(computeBmi(70, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('rounds before classifying, so the number on the screen and the badge beside it agree', () => {
    // 80.85 kg at 180 cm is a true BMI of 24.9537 — normal. Stored to one decimal
    // it is 25.0, which is the overweight threshold. Classifying the stored value
    // is the choice, and it is the one that keeps the row self-consistent: a
    // screen showing 25.0 beside a "normal" badge would look like a rendering bug
    // to anybody who noticed, and there would be no way to explain it from the row.
    const bmi = computeBmi(80.85, 180);
    expect(bmi).toBe(25);
    expect(classifyRisk({ type: 'bmi', bmi: bmi ?? 0 }).level).toBe('moderate');
  });
});

describe('measurementFrom', () => {
  /** A row with nothing in it, so each case names only what it supplies. */
  const NO_VALUES: ScreeningValues = {
    systolicBp: null,
    diastolicBp: null,
    bloodGlucoseMmol: null,
    bmi: null,
    weightKg: null,
    temperatureC: null,
    heartRateBpm: null,
  };

  function parsed(
    type: ScreeningType,
    values: Partial<ScreeningValues>
  ): ScreeningMeasurement {
    const result = measurementFrom(type, { ...NO_VALUES, ...values });
    if (!result.ok) throw new Error(`${type} was refused: ${result.message}`);
    return result.measurement;
  }

  it('builds the right reading for every type, out of the text the driver returns', () => {
    // `toEqual` against numbers is what makes this a test of the conversion and
    // not of the plumbing: `blood_glucose_mmol numeric(5, 2)` arrives as the
    // string `'7.80'`, and a classifier comparing `'7.80' >= 7.8` is doing
    // string-to-number coercion it never asked for. Every one of these would
    // still pass if the values came through unconverted, except that `toEqual`
    // distinguishes `7.8` from `'7.8'`.
    expect(parsed('blood_pressure', { systolicBp: '140', diastolicBp: '90' })).toEqual({
      type: 'blood_pressure',
      systolic: 140,
      diastolic: 90,
    });
    expect(parsed('blood_sugar', { bloodGlucoseMmol: '7.80' })).toEqual({
      type: 'blood_sugar',
      glucoseMmol: 7.8,
    });
    expect(parsed('bmi', { bmi: '31.0' })).toEqual({ type: 'bmi', bmi: 31 });
    expect(parsed('weight', { weightKg: '68.5' })).toEqual({ type: 'weight', weightKg: 68.5 });
    expect(parsed('temperature', { temperatureC: '38.0' })).toEqual({
      type: 'temperature',
      temperatureC: 38,
    });
    expect(parsed('heart_rate', { heartRateBpm: '72' })).toEqual({
      type: 'heart_rate',
      heartRateBpm: 72,
    });
  });

  it('refuses a blood pressure with only one of its two numbers, and names the missing one', () => {
    // The pairing rule. A cuff reading with one number is not a blood pressure,
    // and classifying it on the strength of the other would produce a level
    // nobody could reproduce from the row.
    expect(measurementFrom('blood_pressure', { ...NO_VALUES, systolicBp: '140' })).toEqual({
      ok: false,
      field: 'diastolicBp',
      message: 'The bottom blood pressure number is needed, and it has to be a number.',
    });
    // And the other way round, so the order the two are checked in cannot decide
    // which field a form is told about.
    expect(measurementFrom('blood_pressure', { ...NO_VALUES, diastolicBp: '90' })).toEqual({
      ok: false,
      field: 'systolicBp',
      message: 'The top blood pressure number is needed, and it has to be a number.',
    });
  });

  it('reads only the columns its own type needs', () => {
    // A pulse row has no glucose in it. Demanding every column would refuse all
    // but six rows in the table, and would do it with a message about a field the
    // form does not have on it.
    const result = measurementFrom('heart_rate', { ...NO_VALUES, heartRateBpm: 72 });
    expect(result).toEqual({ ok: true, measurement: { type: 'heart_rate', heartRateBpm: 72 } });
  });

  it('refuses a blank, a word, a zero and a negative, each pointing at one field', () => {
    for (const value of ['', '   ', 'abc', '12abc', '0', '-4', 0, -4]) {
      const result = measurementFrom('blood_sugar', { ...NO_VALUES, bloodGlucoseMmol: value });
      expect({ value, ok: result.ok, field: result.ok ? null : result.field }).toEqual({
        value,
        ok: false,
        field: 'bloodGlucoseMmol',
      });
    }
  });

  it('says which of two different mistakes was made, because a blank field and a zero reading are not one problem', () => {
    expect(measurementFrom('temperature', { ...NO_VALUES, temperatureC: null })).toEqual({
      ok: false,
      field: 'temperatureC',
      message: 'The temperature in °C is needed, and it has to be a number.',
    });
    // A zero is a number, and the schema agrees that zero is not a reading. One
    // message for both would send somebody looking for a field that is filled in.
    expect(measurementFrom('temperature', { ...NO_VALUES, temperatureC: '0' })).toEqual({
      ok: false,
      field: 'temperatureC',
      message: 'The temperature in °C has to be greater than zero.',
    });

    // And the case that would have merged the two: `Number('')`, `Number('   ')`
    // and `Number('\t')` are all 0, so a blank field parses as a reading of zero
    // unless the emptiness is checked first. These are the assertions that fail if
    // that check is removed, and they fail on the message rather than on the field
    // — which is the part a person actually reads.
    for (const blank of ['', '   ', '\t']) {
      const result = measurementFrom('temperature', { ...NO_VALUES, temperatureC: blank });
      expect({ blank, result }).toEqual({
        blank,
        result: {
          ok: false,
          field: 'temperatureC',
          message: 'The temperature in °C is needed, and it has to be a number.',
        },
      });
    }
  });

  it('accepts a JSON number as readily as the driver text', () => {
    // A request body has no decimal places to protect, so it arrives as a number.
    // One function taking both is the difference between this conversion having
    // one home and having one per caller, where the callers eventually differ.
    const result = measurementFrom('bmi', { ...NO_VALUES, bmi: 24.9 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.measurement).toEqual({ type: 'bmi', bmi: 24.9 });
  });

  it('round-trips into a classification, which is the only thing it exists for', () => {
    const result = measurementFrom('blood_pressure', {
      ...NO_VALUES,
      systolicBp: '158',
      diastolicBp: '84',
    });
    if (!result.ok) throw new Error(result.message);

    // Isolated systolic hypertension, arriving as two strings from the database
    // and leaving as a high flag with a reason beside it.
    expect(classifyRisk(result.measurement)).toEqual({
      level: 'high',
      reason: expect.stringContaining('158/84'),
    });
  });
});
