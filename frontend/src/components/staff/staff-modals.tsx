'use client';

/**
 * The three dialogs `/staff` opens: add somebody, edit somebody, reset a password.
 *
 * Each owns its form state and validates with `lib/staff.ts`, then hands a body
 * to the page, which is the one place that talks to the API. That split is the
 * same as the till's payment modal: the dialog is a form, the page is the writer,
 * so `submitting` and `error` come down and the values go up and neither half
 * knows how the other works.
 *
 * The edit dialog is the one with a consequence worth naming on screen. Changing
 * a role or turning an account off ends that person's sessions everywhere — the
 * backend does it in the same statement as the edit, because a token asserts the
 * role it was signed with. So the dialog says so before the owner saves, rather
 * than letting them discover it when the person they demoted is signed out on a
 * tablet at home mid-shift.
 */

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorNotice, WarningNotice } from '@/components/ui/display';
import { Field, Input, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { shownError, useTouchedFields } from '@/hooks/use-touched';
import type {
  CreateStaffBody,
  ResetPasswordBody,
  StaffSummary,
  UpdateStaffBody,
} from '@/lib/api-types';
import { USER_ROLES, type UserRole } from '@/lib/auth-session';
import { ROLE_LABELS } from '@/lib/navigation';
import {
  staffDraftFrom,
  staffUnchanged,
  staffUpdateBody,
  validateEmail,
  validateFullName,
  validatePassword,
  validatePhone,
  type StaffDraft,
} from '@/lib/staff';

function RoleSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: UserRole;
  onChange: (role: UserRole) => void;
}) {
  return (
    <Select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value as UserRole)}
    >
      {USER_ROLES.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABELS[role]}
        </option>
      ))}
    </Select>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateStaffModalProps {
  open: boolean;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: CreateStaffBody) => void;
}

export function CreateStaffModal({
  open,
  submitting,
  error,
  onClose,
  onSubmit,
}: CreateStaffModalProps) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<UserRole>('staff');
  const [password, setPassword] = useState('');
  const { touched, touch, resetTouched } = useTouchedFields();

  useEffect(() => {
    if (open) {
      setFullName('');
      setEmail('');
      setPhone('');
      setRole('staff');
      setPassword('');
      resetTouched();
    }
  }, [open, resetTouched]);

  const nameError = validateFullName(fullName);
  const emailError = validateEmail(email);
  const phoneError = validatePhone(phone);
  const passwordError = validatePassword(password);
  const canSubmit =
    nameError === null && emailError === null && phoneError === null && passwordError === null && !submitting;

  function submit() {
    if (!canSubmit) return;
    const trimmedPhone = phone.trim();
    onSubmit({
      fullName: fullName.trim(),
      email: email.trim(),
      phone: trimmedPhone === '' ? null : trimmedPhone,
      role,
      initialPassword: password,
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add staff"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} disabled={!canSubmit} onClick={submit}>
            Create account
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error !== null && <ErrorNotice>{error}</ErrorNotice>}
        <Field
          label="Full name"
          htmlFor="create-name"
          error={shownError(touched, 'fullName', nameError)}
          required
        >
          <Input
            id="create-name"
            value={fullName}
            autoComplete="off"
            onChange={(event) => {
              touch('fullName');
              setFullName(event.target.value);
            }}
          />
        </Field>
        <Field
          label="Email"
          htmlFor="create-email"
          hint="This is what they sign in with. It cannot be changed later."
          error={shownError(touched, 'email', emailError)}
          required
        >
          <Input
            id="create-email"
            type="email"
            value={email}
            autoComplete="off"
            onChange={(event) => {
              touch('email');
              setEmail(event.target.value);
            }}
          />
        </Field>
        <Field label="Phone" htmlFor="create-phone" error={shownError(touched, 'phone', phoneError)}>
          <Input
            id="create-phone"
            type="tel"
            value={phone}
            autoComplete="off"
            onChange={(event) => {
              touch('phone');
              setPhone(event.target.value);
            }}
          />
        </Field>
        <Field label="Role" htmlFor="create-role">
          <RoleSelect id="create-role" value={role} onChange={setRole} />
        </Field>
        <Field
          label="Initial password"
          htmlFor="create-password"
          hint="At least 8 characters. They will use this to sign in the first time."
          error={shownError(touched, 'password', passwordError)}
          required
        >
          <Input
            id="create-password"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(event) => {
              touch('password');
              setPassword(event.target.value);
            }}
          />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export interface EditStaffModalProps {
  open: boolean;
  staff: StaffSummary | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: UpdateStaffBody) => void;
}

export function EditStaffModal({
  open,
  staff,
  submitting,
  error,
  onClose,
  onSubmit,
}: EditStaffModalProps) {
  const [draft, setDraft] = useState<StaffDraft>({
    fullName: '',
    phone: '',
    role: 'staff',
    isActive: true,
  });
  const { touched, touch, resetTouched } = useTouchedFields();

  useEffect(() => {
    if (open && staff !== null) {
      setDraft(staffDraftFrom(staff));
      resetTouched();
    }
  }, [open, staff, resetTouched]);

  if (staff === null) {
    return null;
  }

  const nameError = validateFullName(draft.fullName);
  const phoneError = validatePhone(draft.phone);
  const unchanged = staffUnchanged(staff, draft);
  const canSubmit = nameError === null && phoneError === null && !unchanged && !submitting;
  // A role change or a deactivation ends their sessions; say so before saving.
  const endsSessions = draft.role !== staff.role || draft.isActive !== staff.isActive;

  function submit() {
    if (!canSubmit || staff === null) return;
    onSubmit(staffUpdateBody(staff, draft));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit ${staff.fullName}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} disabled={!canSubmit} onClick={submit}>
            Save changes
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error !== null && <ErrorNotice>{error}</ErrorNotice>}
        {endsSessions && (
          <WarningNotice>
            Changing the role or turning the account off signs this person out on every device,
            including one left signed in at home.
          </WarningNotice>
        )}
        <Field
          label="Full name"
          htmlFor="edit-name"
          error={shownError(touched, 'fullName', nameError)}
          required
        >
          <Input
            id="edit-name"
            value={draft.fullName}
            autoComplete="off"
            onChange={(event) => {
              touch('fullName');
              setDraft((current) => ({ ...current, fullName: event.target.value }));
            }}
          />
        </Field>
        <Field
          label="Email"
          htmlFor="edit-email"
          hint="The login identity cannot be changed."
        >
          <Input id="edit-email" value={staff.email} disabled readOnly />
        </Field>
        <Field label="Phone" htmlFor="edit-phone" error={shownError(touched, 'phone', phoneError)}>
          <Input
            id="edit-phone"
            type="tel"
            value={draft.phone}
            autoComplete="off"
            onChange={(event) => {
              touch('phone');
              setDraft((current) => ({ ...current, phone: event.target.value }));
            }}
          />
        </Field>
        <Field label="Role" htmlFor="edit-role">
          <RoleSelect
            id="edit-role"
            value={draft.role}
            onChange={(role) => setDraft((current) => ({ ...current, role }))}
          />
        </Field>
        <label
          htmlFor="edit-active"
          className="flex items-start gap-3 rounded-md border border-surface-200 p-3"
        >
          <input
            id="edit-active"
            type="checkbox"
            className="mt-0.5 h-5 w-5 accent-primary-500"
            checked={draft.isActive}
            onChange={(event) =>
              setDraft((current) => ({ ...current, isActive: event.target.checked }))
            }
          />
          <span className="text-sm">
            <span className="font-medium text-neutral-800">Account is active</span>
            <span className="mt-0.5 block text-neutral-600">
              Off stops them signing in and ends any session they have open. The name stays on the
              receipts they served.
            </span>
          </span>
        </label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Reset password
// ---------------------------------------------------------------------------

export interface ResetPasswordModalProps {
  open: boolean;
  staff: StaffSummary | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: ResetPasswordBody) => void;
}

export function ResetPasswordModal({
  open,
  staff,
  submitting,
  error,
  onClose,
  onSubmit,
}: ResetPasswordModalProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { touched, touch, resetTouched } = useTouchedFields();

  useEffect(() => {
    if (open) {
      setPassword('');
      setConfirm('');
      resetTouched();
    }
  }, [open, resetTouched]);

  if (staff === null) {
    return null;
  }

  const passwordError = validatePassword(password);
  const confirmError = confirm === password ? null : 'The two passwords do not match';
  const canSubmit = passwordError === null && confirmError === null && !submitting;

  function submit() {
    if (!canSubmit) return;
    onSubmit({ newPassword: password });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Reset password for ${staff.fullName}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} disabled={!canSubmit} onClick={submit}>
            Reset password
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error !== null && <ErrorNotice>{error}</ErrorNotice>}
        <WarningNotice>
          There is no email to send a reset link to, so you set a new password here and tell them
          it in person. Resetting signs them out on every device.
        </WarningNotice>
        <Field
          label="New password"
          htmlFor="reset-password"
          hint="At least 8 characters."
          error={shownError(touched, 'password', passwordError)}
          required
        >
          <Input
            id="reset-password"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(event) => {
              touch('password');
              setPassword(event.target.value);
            }}
          />
        </Field>
        <Field
          label="Confirm password"
          htmlFor="reset-confirm"
          error={shownError(touched, 'confirm', confirmError)}
          required
        >
          <Input
            id="reset-confirm"
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(event) => {
              touch('confirm');
              setConfirm(event.target.value);
            }}
          />
        </Field>
      </div>
    </Modal>
  );
}
