import type { PatientView } from '../api-types';
import {
  createPatientBody,
  EMPTY_PATIENT_DRAFT,
  formatClinicalList,
  parseClinicalList,
  patientDraftFrom,
  patientFiltersActive,
  patientQueryFrom,
  patientUnchanged,
  patientUpdateBody,
  sameClinicalList,
  validateClinicalList,
  validateDateOfBirth,
  validatePatientName,
  validatePatientNotes,
  validatePatientPhone,
  type PatientDraft,
} from '../patients';

const kwame: PatientView = {
  id: '6f1e0b6a-0000-4000-8000-000000000001',
  pharmacyId: '6f1e0b6a-0000-4000-8000-0000000000ff',
  fullName: 'Kwame Mensah',
  phone: '0244000000',
  dateOfBirth: '1990-04-18',
  gender: 'male',
  allergies: ['Penicillin'],
  conditions: ['Hypertension'],
  medications: ['Amlodipine'],
  notes: 'Prefers morning visits',
  smsNumber: '233244000000',
  createdAt: '2026-09-01T09:00:00.000Z',
  updatedAt: '2026-09-01T09:00:00.000Z',
};

function draft(overrides: Partial<PatientDraft> = {}): PatientDraft {
  return { ...patientDraftFrom(kwame), ...overrides };
}

describe('patientQueryFrom', () => {
  it('always sends limit and offset', () => {
    expect(patientQueryFrom({ search: '' }, 50, 0)).toEqual({ limit: 50, offset: 0 });
  });

  it('omits an empty search rather than sending ?search=', () => {
    expect(patientQueryFrom({ search: '   ' }, 50, 0)).not.toHaveProperty('search');
  });

  it('trims and sends a real search', () => {
    expect(patientQueryFrom({ search: '  kwame  ' }, 50, 100)).toEqual({
      limit: 50,
      offset: 100,
      search: 'kwame',
    });
  });

  it('reports the filter as active only when a search is set', () => {
    expect(patientFiltersActive({ search: '' })).toBe(false);
    expect(patientFiltersActive({ search: '  ' })).toBe(false);
    expect(patientFiltersActive({ search: 'kw' })).toBe(true);
  });
});

describe('the clinical lists', () => {
  it('parses one entry per line, dropping blanks and surrounding space', () => {
    expect(parseClinicalList('Penicillin\n\n  Aspirin  \n')).toEqual(['Penicillin', 'Aspirin']);
    expect(parseClinicalList('')).toEqual([]);
  });

  it('round-trips an array through the textarea', () => {
    expect(parseClinicalList(formatClinicalList(['A', 'B']))).toEqual(['A', 'B']);
  });

  it('compares lists by entries and order', () => {
    expect(sameClinicalList(['A', 'B'], ['A', 'B'])).toBe(true);
    expect(sameClinicalList(['A', 'B'], ['B', 'A'])).toBe(false);
    expect(sameClinicalList(['A'], ['A', 'B'])).toBe(false);
  });
});

describe('createPatientBody', () => {
  it('turns empty text into null and textareas into arrays', () => {
    const body = createPatientBody({
      ...EMPTY_PATIENT_DRAFT,
      fullName: '  Ama Serwaa  ',
      allergies: 'Latex\nIbuprofen',
      gender: 'female',
    });
    expect(body).toEqual({
      fullName: 'Ama Serwaa',
      phone: null,
      dateOfBirth: null,
      gender: 'female',
      allergies: ['Latex', 'Ibuprofen'],
      conditions: [],
      medications: [],
      notes: null,
    });
  });
});

/**
 * The behaviour the module exists for: an edit must send only what moved, and a
 * cleared field must go as `null` rather than `''`, so `updated_at` does not move
 * on a save that changed nothing.
 */
describe('patientUpdateBody', () => {
  it('sends nothing when the draft matches the stored row', () => {
    expect(patientUpdateBody(kwame, draft())).toEqual({});
    expect(patientUnchanged(kwame, draft())).toBe(true);
  });

  it('sends only the phone when the phone is corrected', () => {
    expect(patientUpdateBody(kwame, draft({ phone: '0209999999' }))).toEqual({
      phone: '0209999999',
    });
  });

  it('sends null when a phone is cleared, not an empty string', () => {
    expect(patientUpdateBody(kwame, draft({ phone: '' }))).toEqual({ phone: null });
  });

  it('treats a rename that only adds surrounding space as no change', () => {
    expect(patientUpdateBody(kwame, draft({ fullName: '  Kwame Mensah  ' }))).toEqual({});
  });

  it('sends a clinical list only when its entries moved', () => {
    expect(patientUpdateBody(kwame, draft({ allergies: 'Penicillin' }))).toEqual({});
    expect(patientUpdateBody(kwame, draft({ allergies: 'Penicillin\nLatex' }))).toEqual({
      allergies: ['Penicillin', 'Latex'],
    });
  });

  it('sends an emptied clinical list as an empty array, not null', () => {
    expect(patientUpdateBody(kwame, draft({ conditions: '' }))).toEqual({ conditions: [] });
  });

  it('sends gender when it is cleared to "never asked"', () => {
    expect(patientUpdateBody(kwame, draft({ gender: null }))).toEqual({ gender: null });
  });

  it('sends every field that moved, and only those', () => {
    expect(
      patientUpdateBody(kwame, draft({ fullName: 'Kwame O Mensah', notes: '' }))
    ).toEqual({ fullName: 'Kwame O Mensah', notes: null });
  });
});

describe('patient field validation', () => {
  it('requires a full name of at least two characters, bounded above', () => {
    expect(validatePatientName('')).not.toBeNull();
    expect(validatePatientName('K')).not.toBeNull();
    expect(validatePatientName('Kwame')).toBeNull();
    expect(validatePatientName('x'.repeat(121))).not.toBeNull();
    expect(validatePatientName('x'.repeat(120))).toBeNull();
  });

  it('bounds the phone by length only, and allows none', () => {
    expect(validatePatientPhone('')).toBeNull();
    expect(validatePatientPhone('0244000000')).toBeNull();
    expect(validatePatientPhone('x'.repeat(33))).not.toBeNull();
    expect(validatePatientPhone('x'.repeat(32))).toBeNull();
  });

  it('accepts an absent date of birth but refuses an impossible one', () => {
    expect(validateDateOfBirth('')).toBeNull();
    expect(validateDateOfBirth('1990-04-18')).toBeNull();
    expect(validateDateOfBirth('1990-02-30')).not.toBeNull();
    expect(validateDateOfBirth('18/04/1990')).not.toBeNull();
  });

  it('bounds the notes and allows none', () => {
    expect(validatePatientNotes('')).toBeNull();
    expect(validatePatientNotes('x'.repeat(2000))).toBeNull();
    expect(validatePatientNotes('x'.repeat(2001))).not.toBeNull();
  });

  it('bounds a clinical list by count and by entry length', () => {
    expect(validateClinicalList('', 'allergies')).toBeNull();
    expect(validateClinicalList('Penicillin\nLatex', 'allergies')).toBeNull();
    expect(
      validateClinicalList(Array.from({ length: 101 }, (_, i) => `e${i}`).join('\n'), 'allergies')
    ).not.toBeNull();
    expect(validateClinicalList('x'.repeat(201), 'allergies')).not.toBeNull();
    expect(validateClinicalList('x'.repeat(200), 'allergies')).toBeNull();
  });
});
