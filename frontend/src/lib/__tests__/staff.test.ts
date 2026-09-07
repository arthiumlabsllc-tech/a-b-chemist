import type { StaffSummary } from '../api-types';
import {
  staffDraftFrom,
  staffUnchanged,
  staffUpdateBody,
  validateEmail,
  validateFullName,
  validatePassword,
  validatePhone,
  type StaffDraft,
} from '../staff';

const bob: StaffSummary = {
  id: '6f1e0b6a-0000-4000-8000-000000000001',
  fullName: 'Bob Mensah',
  email: 'bob@abchemist.test',
  phone: '0244000000',
  role: 'staff',
  isActive: true,
  lastLoginAt: '2026-09-01T09:00:00.000Z',
};

function draft(overrides: Partial<StaffDraft> = {}): StaffDraft {
  return { ...staffDraftFrom(bob), ...overrides };
}

/**
 * The behaviour the whole module exists for: `PATCH /staff/:id` signs the person
 * out everywhere when the patch carries `role` or `isActive`. A rename or a
 * corrected phone number must therefore send *only* that field — if it also sent
 * the unchanged role, every harmless edit would log the person out on every
 * device, which is the bug these tests are red for.
 */
describe('staffUpdateBody', () => {
  it('sends nothing when the draft matches the stored row', () => {
    expect(staffUpdateBody(bob, draft())).toEqual({});
    expect(staffUnchanged(bob, draft())).toBe(true);
  });

  it('sends only fullName for a rename — never the role or isActive', () => {
    const body = staffUpdateBody(bob, draft({ fullName: 'Bobby Mensah' }));
    expect(body).toEqual({ fullName: 'Bobby Mensah' });
    // The trap, stated outright: these two would end Bob's sessions.
    expect(body).not.toHaveProperty('role');
    expect(body).not.toHaveProperty('isActive');
    expect(staffUnchanged(bob, draft({ fullName: 'Bobby Mensah' }))).toBe(false);
  });

  it('treats a rename that only adds surrounding space as no change', () => {
    // The server trims on the way in, so ' Bob Mensah ' is the name it already has.
    expect(staffUpdateBody(bob, draft({ fullName: '  Bob Mensah  ' }))).toEqual({});
  });

  it('sends only the phone when the phone is corrected', () => {
    expect(staffUpdateBody(bob, draft({ phone: '0244111111' }))).toEqual({ phone: '0244111111' });
  });

  it('sends null when a phone is cleared, not an empty string', () => {
    expect(staffUpdateBody(bob, draft({ phone: '' }))).toEqual({ phone: null });
  });

  it('sends a phone added to a row that had none', () => {
    const noPhone: StaffSummary = { ...bob, phone: null };
    expect(staffUpdateBody(noPhone, staffDraftFrom(noPhone))).toEqual({});
    expect(
      staffUpdateBody(noPhone, { ...staffDraftFrom(noPhone), phone: '0209999999' })
    ).toEqual({ phone: '0209999999' });
  });

  it('sends the role when it is genuinely changed', () => {
    expect(staffUpdateBody(bob, draft({ role: 'pharmacist' }))).toEqual({ role: 'pharmacist' });
  });

  it('sends isActive when an account is deactivated', () => {
    expect(staffUpdateBody(bob, draft({ isActive: false }))).toEqual({ isActive: false });
  });

  it('sends every field that moved, and only those', () => {
    expect(
      staffUpdateBody(bob, draft({ fullName: 'Bobby Mensah', role: 'pharmacist' }))
    ).toEqual({ fullName: 'Bobby Mensah', role: 'pharmacist' });
  });
});

describe('staffDraftFrom', () => {
  it('reads a row back into the form, empty-string for a null phone', () => {
    expect(staffDraftFrom(bob)).toEqual({
      fullName: 'Bob Mensah',
      phone: '0244000000',
      role: 'staff',
      isActive: true,
    });
    expect(staffDraftFrom({ ...bob, phone: null }).phone).toBe('');
  });
});

describe('staff field validation', () => {
  it('requires a full name of at least two characters', () => {
    expect(validateFullName('')).not.toBeNull();
    expect(validateFullName('B')).not.toBeNull();
    expect(validateFullName('Bo')).toBeNull();
    expect(validateFullName('x'.repeat(121))).not.toBeNull();
    expect(validateFullName('x'.repeat(120))).toBeNull();
  });

  it('requires an email that looks like one', () => {
    expect(validateEmail('')).not.toBeNull();
    expect(validateEmail('nope')).not.toBeNull();
    expect(validateEmail('bob@abchemist.test')).toBeNull();
  });

  it('bounds the phone by length only, and allows none', () => {
    expect(validatePhone('')).toBeNull();
    expect(validatePhone('0244000000')).toBeNull();
    expect(validatePhone('x'.repeat(33))).not.toBeNull();
    expect(validatePhone('x'.repeat(32))).toBeNull();
  });

  it('requires a password of eight to seventy-two characters', () => {
    expect(validatePassword('1234567')).not.toBeNull();
    expect(validatePassword('12345678')).toBeNull();
    expect(validatePassword('x'.repeat(73))).not.toBeNull();
    expect(validatePassword('x'.repeat(72))).toBeNull();
  });
});
