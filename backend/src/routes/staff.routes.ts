import { Router } from 'express';
import { body, param } from 'express-validator';
import { config } from '../config';
import { requireAuth } from '../middleware/authenticate';
import {
  countActiveOwners,
  createStaff,
  findUserById,
  listStaff,
  setPassword,
  updateStaff,
  type StaffPatch,
  type UserRow,
} from '../repositories/users.repository';
import { asyncHandler } from '../utils/async-handler';
import { HttpError, sendOk } from '../utils/http';
import { hashPassword } from '../utils/password';
import { USER_ROLES, type UserRole } from '../utils/permissions';
import { runValidation, strongPassword } from '../utils/validate';

/**
 * Staff management. Owner-only — see `mountRoutes`.
 *
 * There is no DELETE. A staff row is named by `sales.served_by`, and deleting
 * the person who served a sale would either orphan the receipt or cascade away
 * the record of who dispensed what to whom. Deactivation keeps the name on the
 * receipt and stops the token, which is the two things actually wanted.
 *
 * Email is not editable either: it is the login identity, and changing it
 * without a verification step would let one account be handed to a different
 * person while keeping the history of the first.
 */

/**
 * One staff member, as the staff page receives it.
 *
 * Exported because it is the API's contract rather than a local helper type: the
 * frontend copies it into `lib/api-types.ts`, and `api-types.mirror.test.ts`
 * reads *this* declaration to hold the two together. A contract type declared
 * without `export` is one the mirror cannot parse, and every other response shape
 * this API sends — `TillProduct`, `SaleDetail`, `TaxSettingsView` — is exported
 * for exactly that reason.
 */
export interface StaffSummary {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: string | null;
}

/**
 * The shape the staff page gets. `passwordHash` and `sessionVersion` are absent
 * by construction rather than by omission: they are not in this type, so a
 * future edit cannot start returning them without a compile error.
 */
function toStaffSummary(row: UserRow): StaffSummary {
  return {
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    role: row.role,
    isActive: row.isActive,
    lastLoginAt: row.lastLoginAt,
  };
}

/**
 * Looks the target up and proves it belongs to the caller's pharmacy.
 *
 * A miss and a mismatch both answer 404. Distinguishing them would tell a
 * caller that an id exists but belongs to someone else — information nobody
 * outside this pharmacy should be able to gather, even though this build has
 * only one tenant in it.
 *
 * The id is `string | undefined` because `noUncheckedIndexedAccess` does not
 * know that a matched `/:id` route always populates it. Treating the impossible
 * case as the same 404 is cheaper than a guard that cannot run.
 */
async function findStaffMember(
  id: string | undefined,
  pharmacyId: string
): Promise<UserRow> {
  const row = id === undefined ? null : await findUserById(id);
  if (row === null || row.pharmacyId !== pharmacyId) {
    throw new HttpError(404, 'No staff member matches that id', { code: 'not_found' });
  }
  return row;
}

/**
 * Would this edit leave the pharmacy with no active owner?
 *
 * Only an edit to a row that is currently an active owner can do that, and only
 * by demoting or deactivating it. Re-enabling someone or renaming them cannot,
 * so those are not checked against the count at all.
 */
function threatensLastOwner(target: UserRow, patch: StaffPatch): boolean {
  if (target.role !== 'pharmacy_owner' || !target.isActive) return false;
  const demotes = patch.role !== undefined && patch.role !== 'pharmacy_owner';
  const deactivates = patch.isActive === false;
  return demotes || deactivates;
}

/**
 * A role change, or any change to whether the account is active, ends that
 * person's sessions in the same statement as the edit.
 *
 * A token carries the role it was signed with. Without the bump, a cashier
 * demoted mid-shift keeps an access token that says `pharmacist` until it
 * expires — up to an hour of approving prescriptions they were just removed
 * from approving. Renaming someone or editing a phone number changes nothing a
 * token asserts, so those leave the session alone rather than signing the
 * person out for a typo.
 */
function endsSessions(patch: StaffPatch): boolean {
  return patch.role !== undefined || patch.isActive !== undefined;
}

export const staffRoutes = Router();

staffRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const rows = await listStaff(auth.pharmacyId);
    sendOk(res, { staff: rows.map(toStaffSummary) });
  })
);

staffRoutes.post(
  '/',
  body('fullName')
    .isString()
    .trim()
    .isLength({ min: 2, max: 120 })
    .withMessage('Enter the full name as it should appear on receipts'),
  body('email')
    .isString()
    .trim()
    .isEmail()
    .withMessage('Enter a valid email address — this is what they sign in with'),
  // No format check on the phone number. A rule that rejects a Ghanaian number
  // the pharmacist knows is correct teaches them to type something false, and a
  // false number is worse than an oddly formatted one.
  body('phone')
    .optional({ values: 'null' })
    .isString()
    .trim()
    .isLength({ max: 32 })
    .withMessage('That phone number is too long'),
  body('role')
    .isIn(USER_ROLES)
    .withMessage(`Role must be one of ${USER_ROLES.join(', ')}`),
  strongPassword('initialPassword'),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const input = req.body as {
      fullName: string;
      email: string;
      phone?: string | null;
      role: UserRole;
      initialPassword: string;
    };

    const passwordHash = await hashPassword(input.initialPassword, config.bcryptRounds);

    // A duplicate email arrives from the repository as a 409 `email_taken`.
    // Pre-checking would race: two owners adding the same person at the same
    // moment both pass a SELECT and one INSERT wins.
    const created = await createStaff({
      pharmacyId: auth.pharmacyId,
      fullName: input.fullName,
      email: input.email,
      phone: input.phone ?? null,
      role: input.role,
      passwordHash,
    });

    // The initial password is not echoed back. The owner typed it, so they
    // already have it, and a password in a response body ends up in proxy logs,
    // browser devtools history and any error report that captures responses.
    sendOk(res, { staff: toStaffSummary(created) }, 201);
  })
);

staffRoutes.patch(
  '/:id',
  param('id').isUUID().withMessage('That is not a valid staff id'),
  body('fullName')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 2, max: 120 })
    .withMessage('Enter the full name as it should appear on receipts'),
  body('phone')
    .optional({ values: 'null' })
    .isString()
    .trim()
    .isLength({ max: 32 })
    .withMessage('That phone number is too long'),
  body('role')
    .optional()
    .isIn(USER_ROLES)
    .withMessage(`Role must be one of ${USER_ROLES.join(', ')}`),
  body('isActive').optional().isBoolean().withMessage('isActive must be true or false'),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const input = req.body as {
      fullName?: string;
      phone?: string | null;
      role?: UserRole;
      isActive?: boolean;
    };

    // Built field by field rather than spread from the body: an unknown key
    // posted by a stale frontend is dropped here instead of reaching the SQL.
    const patch: StaffPatch = {
      ...(input.fullName === undefined ? {} : { fullName: input.fullName }),
      ...(input.phone === undefined ? {} : { phone: input.phone }),
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    };
    if (Object.keys(patch).length === 0) {
      // Reported rather than answered with an unchanged row. A silent no-op here
      // is a frontend that believes it saved something it did not send.
      throw new HttpError(400, 'Nothing to change — send at least one field to edit', {
        code: 'nothing_to_update',
      });
    }

    const target = await findStaffMember(req.params.id, auth.pharmacyId);

    if (threatensLastOwner(target, patch)) {
      const remaining = await countActiveOwners(auth.pharmacyId, target.id);
      if (remaining === 0) {
        // 409, not 403: the request is understood and permitted, it just cannot
        // be honoured while this is the only active owner. The UI can offer the
        // real way out — promote someone else first.
        throw new HttpError(
          409,
          'This is the last active owner. Promote another owner before demoting or deactivating this one.',
          { code: 'last_owner', details: { staffId: target.id } }
        );
      }
    }

    const sessionsEnded = endsSessions(patch);
    const updated = await updateStaff(target.id, patch, {
      invalidateSessions: sessionsEnded,
    });
    if (updated === null) {
      // Found above, gone by the time of the UPDATE. There is no DELETE route,
      // so this is a concurrent edit against a row that no longer exists.
      throw new HttpError(404, 'No staff member matches that id', { code: 'not_found' });
    }

    // `sessionsEnded` is in the response because the owner needs to know they
    // have just signed that person out — including on a device left at home,
    // and including themselves if they edited their own role.
    sendOk(res, { staff: toStaffSummary(updated), sessionsEnded });
  })
);

staffRoutes.post(
  '/:id/reset-password',
  param('id').isUUID().withMessage('That is not a valid staff id'),
  strongPassword('newPassword'),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const input = req.body as { newPassword: string };

    const target = await findStaffMember(req.params.id, auth.pharmacyId);

    // The owner sets a password for someone else; there is no email to send a
    // reset link to and no provider configured to send one with. That is a real
    // limit of this build and the reason this route exists at all.
    await setPassword(target.id, await hashPassword(input.newPassword, config.bcryptRounds));

    // `setPassword` bumps the session version, so whoever held the old password
    // — including a device that was left signed in — is out from this moment.
    sendOk(res, { staffId: target.id, passwordReset: true, sessionsEnded: true });
  })
);
