'use client';

/**
 * Staff. `/staff`, gated by `staff:manage` — the owner, and only the owner.
 *
 * A list of who can sign in, and the three things an owner does to it: add
 * somebody, edit somebody, reset a password. There is no delete, because a staff
 * row is named by `sales.served_by`; deactivating keeps the name on the receipts
 * they served and stops the token, which is the two things actually wanted. Email
 * is not editable either — it is the login identity.
 *
 * The page is the one place that talks to the API. The dialogs in
 * `components/staff/staff-modals.tsx` are forms: they collect values, validate
 * them with `lib/staff.ts`, and hand a body up. `submitting` and the error come
 * back down. Only one dialog is open at a time, so they share one `submitting`
 * and one error.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  CreateStaffModal,
  EditStaffModal,
  ResetPasswordModal,
} from '@/components/staff/staff-modals';
import { Button } from '@/components/ui/button';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Spinner,
  StatusNotice,
} from '@/components/ui/display';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api-error-message';
import type {
  CreateStaffBody,
  PasswordResetResponse,
  ResetPasswordBody,
  StaffCreatedResponse,
  StaffListResponse,
  StaffSummary,
  StaffUpdatedResponse,
  UpdateStaffBody,
} from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { ROLE_LABELS } from '@/lib/navigation';

type OpenModal =
  | { kind: 'create' }
  | { kind: 'edit'; staff: StaffSummary }
  | { kind: 'reset'; staff: StaffSummary }
  | null;

export default function StaffPage() {
  const { api } = useAuth();

  const [staff, setStaff] = useState<StaffSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [modal, setModal] = useState<OpenModal>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const result = await api.get<StaffListResponse>('/staff');
        if (!cancelled) setStaff(result.staff);
      } catch (error) {
        if (!cancelled) setLoadError(apiErrorMessage(error, 'Could not load the staff list.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, reloadToken]);

  function open(next: OpenModal) {
    setSubmitError(null);
    setModal(next);
  }

  function closeModal() {
    setModal(null);
    setSubmitError(null);
  }

  async function onCreate(body: CreateStaffBody) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.post<StaffCreatedResponse>('/staff', body);
      setNotice(`${result.staff.fullName} can now sign in with the email and password you set.`);
      closeModal();
      reload();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'The account could not be created.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function onEdit(body: UpdateStaffBody) {
    if (modal?.kind !== 'edit') return;
    const target = modal.staff;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.patch<StaffUpdatedResponse>(`/staff/${target.id}`, body);
      setNotice(
        result.sessionsEnded
          ? `Changes saved. ${result.staff.fullName} was signed out on every device.`
          : 'Changes saved.'
      );
      closeModal();
      reload();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'The changes could not be saved.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function onReset(body: ResetPasswordBody) {
    if (modal?.kind !== 'reset') return;
    const target = modal.staff;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.post<PasswordResetResponse>(`/staff/${target.id}/reset-password`, body);
      setNotice(`Password reset for ${target.fullName}. They were signed out on every device.`);
      closeModal();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'The password could not be reset.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Staff"
        subtitle="Who can sign in, and what they can do"
        actions={
          <Button variant="primary" onClick={() => open({ kind: 'create' })}>
            Add staff
          </Button>
        }
      />

      <div className="mx-auto w-full max-w-3xl space-y-3 p-4 sm:p-6">
        {notice !== null && <StatusNotice>{notice}</StatusNotice>}

        {loadError !== null && (
          <div className="space-y-3">
            <ErrorNotice>{loadError}</ErrorNotice>
            <Button variant="secondary" onClick={reload}>
              Try again
            </Button>
          </div>
        )}

        {loading && loadError === null && (
          <div className="flex justify-center p-12">
            <Spinner label="Loading staff…" />
          </div>
        )}

        {!loading && loadError === null && staff.length === 0 && (
          <Card padded={false}>
            <EmptyState
              title="No staff accounts"
              message="Add somebody to give them access to the till and the back office."
              action={
                <Button variant="primary" onClick={() => open({ kind: 'create' })}>
                  Add staff
                </Button>
              }
            />
          </Card>
        )}

        {!loading && loadError === null && staff.length > 0 && (
          <ul className="space-y-2">
            {staff.map((person) => (
              <li key={person.id}>
                <Card className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-neutral-900">{person.fullName}</p>
                      <Badge tone="neutral">{ROLE_LABELS[person.role]}</Badge>
                      <Badge tone={person.isActive ? 'positive' : 'warning'}>
                        {person.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </div>
                    <p className="mt-0.5 truncate text-sm text-neutral-600">{person.email}</p>
                    <p className="text-sm text-neutral-500">
                      {person.phone === null ? 'No phone' : person.phone}
                      {' · last login '}
                      {person.lastLoginAt === null ? 'never' : formatDateTime(person.lastLoginAt)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => open({ kind: 'edit', staff: person })}>
                      Edit
                    </Button>
                    <Button variant="ghost" onClick={() => open({ kind: 'reset', staff: person })}>
                      Reset password
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>

      <CreateStaffModal
        open={modal?.kind === 'create'}
        submitting={submitting}
        error={submitError}
        onClose={closeModal}
        onSubmit={(body) => void onCreate(body)}
      />
      <EditStaffModal
        open={modal?.kind === 'edit'}
        staff={modal?.kind === 'edit' ? modal.staff : null}
        submitting={submitting}
        error={submitError}
        onClose={closeModal}
        onSubmit={(body) => void onEdit(body)}
      />
      <ResetPasswordModal
        open={modal?.kind === 'reset'}
        staff={modal?.kind === 'reset' ? modal.staff : null}
        submitting={submitting}
        error={submitError}
        onClose={closeModal}
        onSubmit={(body) => void onReset(body)}
      />
    </div>
  );
}
