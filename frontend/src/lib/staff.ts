/**
 * The staff form's own logic: what changed, and what is out of bounds.
 *
 * ## The diff is the part that matters
 *
 * `PATCH /staff/:id` ends the target's sessions when the patch carries a `role`
 * or an `isActive` — see `endsSessions` in `backend/src/routes/staff.routes.ts`.
 * That is deliberate: a token asserts the role it was signed with, so a demotion
 * has to invalidate it. But it means a form that posted every field on every save
 * would sign a person out for a rename or a corrected phone number, on every
 * device they have ever signed in on, including a tablet left at home. Sending
 * only what actually changed is not an optimisation here; it is the difference
 * between "Bob's number is now 024…" and "Bob has been logged out everywhere".
 *
 * So `staffUpdateBody` diffs the draft against the stored row and returns only the
 * fields that moved. An empty result means "nothing to send", and the page turns
 * that into a disabled Save rather than a 400 `nothing_to_update`.
 *
 * ## The bounds are copies, and that is acceptable
 *
 * `STAFF_LIMITS` restates the `express-validator` rules in the staff route. There
 * is no shared constant to import — these live only in the backend — so this is a
 * copy that could drift. It is safe to copy because the server re-validates and is
 * authoritative: a bound that drifted here would let a too-short name reach the
 * API and come back with the API's own message, which the form shows. The copy
 * exists only so the operator is told *before* the round trip.
 */

import type { StaffSummary, UpdateStaffBody } from './api-types';
import type { UserRole } from './auth-session';

export const STAFF_LIMITS = {
  fullName: { min: 2, max: 120 },
  phone: { max: 32 },
  // 72 is bcrypt's own ceiling; the backend imports it from `utils/password`.
  password: { min: 8, max: 72 },
} as const;

/**
 * The editable fields of the staff form.
 *
 * `email` is absent on purpose: it is the login identity and the backend does not
 * let it be edited, so the edit form has no field for it and this draft has no
 * member for one. `phone` is the text the operator sees (empty for none), not the
 * `string | null` the API stores — the conversion happens in `staffUpdateBody`.
 */
export interface StaffDraft {
  fullName: string;
  phone: string;
  role: UserRole;
  isActive: boolean;
}

/** A draft read back from a stored row, which is how the edit form is seeded. */
export function staffDraftFrom(staff: StaffSummary): StaffDraft {
  return {
    fullName: staff.fullName,
    phone: staff.phone ?? '',
    role: staff.role,
    isActive: staff.isActive,
  };
}

/**
 * Only the fields that changed, as `PATCH /staff/:id` wants them.
 *
 * Text fields are trimmed before comparing, because the server trims on the way
 * in: a draft of `' Bob '` against a stored `'Bob'` is not a change, and sending
 * it would be a no-op write that still looks like an edit. A phone cleared to
 * empty becomes `null` rather than `''`, matching what the column holds and what
 * `StaffSummary.phone` reports back.
 */
export function staffUpdateBody(original: StaffSummary, draft: StaffDraft): UpdateStaffBody {
  const body: UpdateStaffBody = {};

  const fullName = draft.fullName.trim();
  if (fullName !== original.fullName) {
    body.fullName = fullName;
  }

  const phone = draft.phone.trim();
  if (phone !== (original.phone ?? '')) {
    body.phone = phone === '' ? null : phone;
  }

  if (draft.role !== original.role) {
    body.role = draft.role;
  }

  if (draft.isActive !== original.isActive) {
    body.isActive = draft.isActive;
  }

  return body;
}

/** True when `staffUpdateBody` would send nothing, so Save should be held. */
export function staffUnchanged(original: StaffSummary, draft: StaffDraft): boolean {
  return Object.keys(staffUpdateBody(original, draft)).length === 0;
}

// ---------------------------------------------------------------------------
// Field validation — fast feedback; the server remains authoritative.
// ---------------------------------------------------------------------------

export function validateFullName(fullName: string): string | null {
  const trimmed = fullName.trim();
  if (trimmed.length < STAFF_LIMITS.fullName.min) {
    return 'Enter the full name as it should appear on receipts';
  }
  if (trimmed.length > STAFF_LIMITS.fullName.max) {
    return `That name is too long — ${STAFF_LIMITS.fullName.max} characters at most`;
  }
  return null;
}

export function validateEmail(email: string): string | null {
  const trimmed = email.trim();
  if (trimmed === '') {
    return 'Enter an email address — this is what they sign in with';
  }
  // Deliberately permissive: the server's `isEmail` is the real check, and a
  // client regex stricter than it would refuse an address the API accepts.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return 'Enter a valid email address';
  }
  return null;
}

export function validatePhone(phone: string): string | null {
  // No format check, for the backend's reason: a rule that rejects a Ghanaian
  // number the pharmacist knows is correct teaches them to type a false one.
  if (phone.trim().length > STAFF_LIMITS.phone.max) {
    return 'That phone number is too long';
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < STAFF_LIMITS.password.min) {
    return `Use at least ${STAFF_LIMITS.password.min} characters`;
  }
  if (password.length > STAFF_LIMITS.password.max) {
    return `Use at most ${STAFF_LIMITS.password.max} characters`;
  }
  return null;
}
