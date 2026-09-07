'use client';

/**
 * The three dialogs the consultation diary opens: book one, move one, end one.
 *
 * Each owns its form state and validates with `lib/consultations.ts`, then hands a
 * body to the page — the same split as every other modal here. The reschedule is
 * the one with a consequence worth stating on screen: `rescheduleBody` sends a
 * field only when it differs from the stored row, and `null` to clear one, because
 * `PATCH /consultations/:id` reads an absent key as "leave it alone". Posting
 * `videoUrl: null` for a field nobody touched would strip the meeting link from
 * every appointment the form moved, and the row would still look ordinary.
 *
 * ## Why the booking form has no conductor picker
 *
 * `GET /staff` is owner-only, so a pharmacist booking an appointment cannot be
 * offered a list of colleagues. The page passes the signed-in user's id as
 * `conductedBy` to assign the appointment to whoever is booking it, or null to
 * leave it unassigned; the reschedule never touches it, so a move keeps whoever
 * was named.
 */

import { useEffect, useState } from 'react';

import {
  CONSULTATION_STATUS_WORD,
  CONSULTATION_TYPE_WORD,
} from '@/components/consultations/consultations-words';
import { Button } from '@/components/ui/button';
import { ErrorNotice, WarningNotice } from '@/components/ui/display';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import type {
  BookConsultationBody,
  ConsultationType,
  ConsultationView,
  EndConsultationBody,
  RescheduleBody,
} from '@/lib/api-types';
import { CONSULTATION_TYPES, ENDED_CONSULTATION_STATUSES } from '@/lib/api-types';
import {
  bookConsultationBody,
  consultationDraftFrom,
  EMPTY_CONSULTATION_DRAFT,
  firstConsultationError,
  rescheduleBody,
  rescheduleUnchanged,
  type ConsultationDraft,
  type ConsultationDraftError,
} from '@/lib/consultations';

type EndedStatus = EndConsultationBody['status'];

/**
 * The appointment fields the book and reschedule dialogs share. `idPrefix` keeps
 * the two sets of `htmlFor`/`id` apart so a label always points at its own control
 * even though both dialogs are mounted (closed) on the same page.
 */
function ConsultationFields({
  draft,
  fieldError,
  idPrefix,
  onField,
}: {
  draft: ConsultationDraft;
  fieldError: ConsultationDraftError | null;
  idPrefix: string;
  onField: <K extends keyof ConsultationDraft>(key: K, value: ConsultationDraft[K]) => void;
}) {
  return (
    <>
      <Field label="How" htmlFor={`${idPrefix}-type`}>
        <Select
          id={`${idPrefix}-type`}
          value={draft.type}
          onChange={(event) => onField('type', event.target.value as ConsultationType)}
        >
          {CONSULTATION_TYPES.map((type) => (
            <option key={type} value={type}>
              {CONSULTATION_TYPE_WORD[type]}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="When"
        htmlFor={`${idPrefix}-when`}
        error={fieldError?.field === 'scheduledAt' ? fieldError.message : undefined}
        required
      >
        <Input
          id={`${idPrefix}-when`}
          type="datetime-local"
          value={draft.scheduledAt}
          onChange={(event) => onField('scheduledAt', event.target.value)}
        />
      </Field>

      <Field
        label="Length in minutes"
        htmlFor={`${idPrefix}-duration`}
        hint="Optional. Blank means no length was given."
        error={fieldError?.field === 'durationMinutes' ? fieldError.message : undefined}
      >
        <Input
          id={`${idPrefix}-duration`}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={draft.durationMinutes}
          onChange={(event) => onField('durationMinutes', event.target.value)}
        />
      </Field>

      {/* The link is shown only for a video consultation, mirroring the backend:
          it is stored for a video type and cleared when a reschedule moves off it. */}
      {draft.type === 'video' && (
        <Field
          label="Meeting link"
          htmlFor={`${idPrefix}-video`}
          hint="Must start with https://"
          error={fieldError?.field === 'videoUrl' ? fieldError.message : undefined}
        >
          <Input
            id={`${idPrefix}-video`}
            type="url"
            autoComplete="off"
            value={draft.videoUrl}
            onChange={(event) => onField('videoUrl', event.target.value)}
          />
        </Field>
      )}

      <Field
        label="Notes"
        htmlFor={`${idPrefix}-notes`}
        error={fieldError?.field === 'notes' ? fieldError.message : undefined}
      >
        <Textarea
          id={`${idPrefix}-notes`}
          rows={2}
          value={draft.notes}
          autoComplete="off"
          onChange={(event) => onField('notes', event.target.value)}
        />
      </Field>
    </>
  );
}

// ---------------------------------------------------------------------------
// Book
// ---------------------------------------------------------------------------

export interface BookConsultationModalProps {
  open: boolean;
  patientId: string;
  patientName?: string;
  /** The signed-in user's id, to assign the appointment to whoever books it. */
  conductedBy: string | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: BookConsultationBody) => void;
}

export function BookConsultationModal({
  open,
  patientId,
  patientName,
  conductedBy,
  submitting,
  error,
  onClose,
  onSubmit,
}: BookConsultationModalProps) {
  const [draft, setDraft] = useState<ConsultationDraft>(EMPTY_CONSULTATION_DRAFT);

  useEffect(() => {
    if (open) setDraft(EMPTY_CONSULTATION_DRAFT);
  }, [open]);

  function onField<K extends keyof ConsultationDraft>(key: K, value: ConsultationDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const fieldError = firstConsultationError(draft);
  const canSubmit = fieldError === null && !submitting;

  function submit() {
    if (!canSubmit) return;
    onSubmit(bookConsultationBody(patientId, draft, conductedBy));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={patientName === undefined ? 'Book a consultation' : `Book · ${patientName}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} disabled={!canSubmit} onClick={submit}>
            Book appointment
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error !== null && <ErrorNotice>{error}</ErrorNotice>}
        <ConsultationFields draft={draft} fieldError={fieldError} idPrefix="book" onField={onField} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Reschedule
// ---------------------------------------------------------------------------

export interface RescheduleConsultationModalProps {
  open: boolean;
  consultation: ConsultationView | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: RescheduleBody) => void;
}

export function RescheduleConsultationModal({
  open,
  consultation,
  submitting,
  error,
  onClose,
  onSubmit,
}: RescheduleConsultationModalProps) {
  const [draft, setDraft] = useState<ConsultationDraft>(EMPTY_CONSULTATION_DRAFT);

  useEffect(() => {
    if (open && consultation !== null) setDraft(consultationDraftFrom(consultation));
  }, [open, consultation]);

  if (consultation === null) {
    return null;
  }

  function onField<K extends keyof ConsultationDraft>(key: K, value: ConsultationDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const fieldError = firstConsultationError(draft);
  // A reschedule is not a no-op on the server — it supersedes the old appointment
  // reminder and raises a new one — so an untouched form is held rather than
  // churning the reminder for nothing.
  const unchanged = rescheduleUnchanged(consultation, draft);
  const canSubmit = fieldError === null && !unchanged && !submitting;

  function submit() {
    if (!canSubmit || consultation === null) return;
    onSubmit(rescheduleBody(consultation, draft));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Move appointment"
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
        <WarningNotice>
          Moving the appointment moves its reminder to the new time. The reminder for
          the old slot is cancelled.
        </WarningNotice>
        <ConsultationFields
          draft={draft}
          fieldError={fieldError}
          idPrefix="reschedule"
          onField={onField}
        />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// End
// ---------------------------------------------------------------------------

export interface EndConsultationModalProps {
  open: boolean;
  consultation: ConsultationView | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: EndConsultationBody) => void;
}

export function EndConsultationModal({
  open,
  consultation,
  submitting,
  error,
  onClose,
  onSubmit,
}: EndConsultationModalProps) {
  const [status, setStatus] = useState<EndedStatus>('completed');

  useEffect(() => {
    if (open) setStatus('completed');
  }, [open]);

  if (consultation === null) {
    return null;
  }

  function submit() {
    if (submitting) return;
    onSubmit({ status });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="End appointment"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} disabled={submitting} onClick={submit}>
            End appointment
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error !== null && <ErrorNotice>{error}</ErrorNotice>}
        <WarningNotice>
          Ending it stops any reminder that has not gone out yet. A reminder already
          sent cannot be un-sent.
        </WarningNotice>
        <Field label="How it ended" htmlFor="end-status">
          <Select
            id="end-status"
            value={status}
            onChange={(event) => setStatus(event.target.value as EndedStatus)}
          >
            {ENDED_CONSULTATION_STATUSES.map((ended) => (
              <option key={ended} value={ended}>
                {CONSULTATION_STATUS_WORD[ended]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
