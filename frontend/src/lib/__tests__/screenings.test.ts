import type { ScreeningType } from '../api-types';
import {
  EMPTY_SCREENING_DRAFT,
  firstScreeningError,
  latestScreeningQuery,
  recordScreeningBody,
  screeningFiltersActive,
  screeningQueryFrom,
  SCREENING_TYPE_FIELDS,
  type ScreeningDraft,
} from '../screenings';

const PATIENT = '6f1e0b6a-0000-4000-8000-000000000001';

/** A label stub: the words file owns the real sentences, the logic only needs a name. */
const labelFor = (key: string): string => key;

function draft(overrides: Partial<ScreeningDraft> = {}): ScreeningDraft {
  return { ...EMPTY_SCREENING_DRAFT, ...overrides };
}

describe('screeningQueryFrom', () => {
  it('sends only limit and offset when no filter is set', () => {
    expect(
      screeningQueryFrom({ patientId: '', type: '', from: '', to: '' }, 50, 0)
    ).toEqual({ limit: 50, offset: 0 });
    expect(
      screeningFiltersActive({ patientId: '', type: '', from: '', to: '' })
    ).toBe(false);
  });

  it('sends the filters that are set, trimmed', () => {
    expect(
      screeningQueryFrom(
        { patientId: ` ${PATIENT} `, type: 'bmi', from: '2026-01-01', to: '' },
        50,
        100
      )
    ).toEqual({ limit: 50, offset: 100, patientId: PATIENT, type: 'bmi', from: '2026-01-01' });
  });

  it('reports a single filter as active', () => {
    expect(screeningFiltersActive({ patientId: '', type: 'weight', from: '', to: '' })).toBe(true);
  });
});

describe('latestScreeningQuery', () => {
  it('sends both required parameters', () => {
    expect(latestScreeningQuery(PATIENT, 'blood_pressure')).toEqual({
      patientId: PATIENT,
      type: 'blood_pressure',
    });
  });
});

describe('SCREENING_TYPE_FIELDS', () => {
  it('names a field list for every screening type', () => {
    const types: ScreeningType[] = [
      'blood_pressure',
      'blood_sugar',
      'bmi',
      'weight',
      'temperature',
      'heart_rate',
    ];
    for (const type of types) {
      expect(SCREENING_TYPE_FIELDS[type].length).toBeGreaterThan(0);
    }
  });
});

describe('recordScreeningBody', () => {
  it('puts both blood-pressure numbers in values', () => {
    const body = recordScreeningBody(
      PATIENT,
      draft({ type: 'blood_pressure', systolicBp: '148', diastolicBp: '92' })
    );
    expect(body).toEqual({
      patientId: PATIENT,
      type: 'blood_pressure',
      values: {
        systolicBp: 148,
        diastolicBp: 92,
        bloodGlucoseMmol: null,
        bmi: null,
        weightKg: null,
        temperatureC: null,
        heartRateBpm: null,
      },
    });
  });

  it('sends a BMI reading as a top-level weight and height, leaving values.bmi null', () => {
    // The server computes the ratio; the form never types one.
    const body = recordScreeningBody(
      PATIENT,
      draft({ type: 'bmi', weightKg: '80', heightCm: '180' })
    );
    expect(body.weightKg).toBe(80);
    expect(body.heightCm).toBe(180);
    expect(body.values.bmi).toBeNull();
    expect(body.values.weightKg).toBeNull();
  });

  it('puts a weight reading in values, not at the top level', () => {
    const body = recordScreeningBody(PATIENT, draft({ type: 'weight', weightKg: '72.5' }));
    expect(body.values.weightKg).toBe(72.5);
    expect(body.weightKg).toBeUndefined();
  });

  it('ignores readings that belong to a different type', () => {
    // A leftover systolic from a type switch must not leak into a temperature body.
    const body = recordScreeningBody(
      PATIENT,
      draft({ type: 'temperature', temperatureC: '38.4', systolicBp: '120' })
    );
    expect(body.values.temperatureC).toBe(38.4);
    expect(body.values.systolicBp).toBeNull();
  });

  it('converts a typed measuredAt to a pinned UTC instant, and omits it when blank', () => {
    const withTime = recordScreeningBody(
      PATIENT,
      draft({ type: 'heart_rate', heartRateBpm: '72', measuredAt: '2026-09-07T09:15' })
    );
    expect(withTime.measuredAt).toBe('2026-09-07T09:15:00.000Z');
    const without = recordScreeningBody(
      PATIENT,
      draft({ type: 'heart_rate', heartRateBpm: '72', measuredAt: '' })
    );
    expect(without.measuredAt).toBeUndefined();
  });

  it('sends a note only when there is one, trimmed', () => {
    expect(
      recordScreeningBody(PATIENT, draft({ type: 'weight', weightKg: '70', notes: '  ' })).notes
    ).toBeUndefined();
    expect(
      recordScreeningBody(PATIENT, draft({ type: 'weight', weightKg: '70', notes: ' Post-meal ' }))
        .notes
    ).toBe('Post-meal');
  });
});

describe('firstScreeningError', () => {
  it('is null for a complete blood-pressure reading', () => {
    expect(
      firstScreeningError(draft({ type: 'blood_pressure', systolicBp: '120', diastolicBp: '80' }), labelFor)
    ).toBeNull();
  });

  it('names the first missing reading', () => {
    const error = firstScreeningError(draft({ type: 'blood_pressure', systolicBp: '120' }), labelFor);
    expect(error).toEqual({ field: 'diastolicBp', message: 'diastolicBp is needed' });
  });

  it('refuses a reading that is zero or negative', () => {
    expect(
      firstScreeningError(draft({ type: 'weight', weightKg: '0' }), labelFor)
    ).not.toBeNull();
    expect(
      firstScreeningError(draft({ type: 'blood_sugar', bloodGlucoseMmol: '-1' }), labelFor)
    ).not.toBeNull();
  });

  it('requires both a weight and a height for a BMI', () => {
    expect(firstScreeningError(draft({ type: 'bmi', weightKg: '80' }), labelFor)).toEqual({
      field: 'heightCm',
      message: 'heightCm is needed',
    });
    expect(
      firstScreeningError(draft({ type: 'bmi', weightKg: '80', heightCm: '180' }), labelFor)
    ).toBeNull();
  });

  it('refuses a measuredAt in the future beyond the clock skew', () => {
    const now = new Date('2026-09-07T12:00:00.000Z');
    const error = firstScreeningError(
      draft({ type: 'temperature', temperatureC: '37', measuredAt: '2026-09-08T12:00' }),
      labelFor,
      now
    );
    expect(error?.field).toBe('measuredAt');
    // Within the skew is a fast clock, not forward-dating.
    expect(
      firstScreeningError(
        draft({ type: 'temperature', temperatureC: '37', measuredAt: '2026-09-07T12:02' }),
        labelFor,
        now
      )
    ).toBeNull();
  });

  it('refuses a note past the cap', () => {
    expect(
      firstScreeningError(
        draft({ type: 'weight', weightKg: '70', notes: 'x'.repeat(501) }),
        labelFor
      )
    ).toEqual({ field: 'notes', message: 'Notes must be 500 characters or fewer' });
  });
});
