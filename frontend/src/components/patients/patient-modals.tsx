'use client';

/**
 * The two dialogs `/patients` and `/patients/[id]` open: add a patient, edit one.
 *
 * Each owns its form state and validates with `lib/patients.ts`, then hands a body
 * to the page, which is the one place that talks to the API — the same split as
 * `components/staff/staff-modals.tsx`. The create builds a whole record; the edit
 * sends only the fields that moved, because `PATCH /patients/:id` treats an absent
 * key as "leave it alone" and `updated_at` should not move on a save that changed
 * nothing.
 *
 * ## The three clinical lists are a textarea, not a widget
 *
 * Allergies, conditions and medications each live in the database as an array and
 * here as one-entry-per-line text, because at a counter the fastest way to add
 * three allergies is to type three lines. `parseClinicalList` drops the blank lines
 * a trailing newline leaves, so the server is never handed an empty entry it would
 * refuse — and the pharmacist is never told an allergy was too short when what they
 * left was a gap.
 */

import { useEffect, useState } from 'react';

import { GENDER_UNASKED, GENDER_WORD } from '@/components/patients/patients-words';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/display';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { shownError, useTouchedFields } from '@/hooks/use-touched';
import type { CreatePatientBody, Gender, PatientView, UpdatePatientBody } from '@/lib/api-types';
import { GENDERS } from '@/lib/api-types';
import {
  createPatientBody,
  EMPTY_PATIENT_DRAFT,
  patientDraftFrom,
  patientUnchanged,
  patientUpdateBody,
  validateClinicalList,
  validateDateOfBirth,
  validatePatientName,
  validatePatientNotes,
  validatePatientPhone,
  type PatientDraft,
} from '@/lib/patients';

function GenderSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: Gender | null;
  onChange: (gender: Gender | null) => void;
}) {
  return (
    <Select
      id={id}
      value={value ?? ''}
      onChange={(event) =>
        onChange(event.target.value === '' ? null : (event.target.value as Gender))
      }
    >
      {/* An empty value is "never asked", which is not the same as "undisclosed". */}
      <option value="">{GENDER_UNASKED}</option>
      {GENDERS.map((gender) => (
        <option key={gender} value={gender}>
          {GENDER_WORD[gender]}
        </option>
      ))}
    </Select>
  );
}

function ClinicalListField({
  id,
  label,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} htmlFor={id} hint="One per line." error={error ?? undefined}>
      <Textarea
        id={id}
        rows={3}
        value={value}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/**
 * The record fields both dialogs share, given the draft, the per-field errors and a
 * setter. Kept as one function so create and edit cannot drift into showing a
 * different set of fields or wording an error differently.
 */
function PatientFields({
  draft,
  errors,
  touched,
  onField,
}: {
  draft: PatientDraft;
  errors: PatientFieldErrors;
  touched: Record<string, boolean>;
  onField: <K extends keyof PatientDraft>(key: K, value: PatientDraft[K]) => void;
}) {
  return (
    <>
      <Field
        label="Full name"
        htmlFor="patient-name"
        error={shownError(touched, 'fullName', errors.fullName)}
        required
      >
        <Input
          id="patient-name"
          value={draft.fullName}
          autoComplete="off"
          onChange={(event) => onField('fullName', event.target.value)}
        />
      </Field>
      <Field
        label="Phone"
        htmlFor="patient-phone"
        hint="A reminder can only be texted to a number that can receive one."
        error={shownError(touched, 'phone', errors.phone)}
      >
        <Input
          id="patient-phone"
          type="tel"
          value={draft.phone}
          autoComplete="off"
          onChange={(event) => onField('phone', event.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Date of birth"
          htmlFor="patient-dob"
          error={shownError(touched, 'dateOfBirth', errors.dateOfBirth)}
        >
          <Input
            id="patient-dob"
            type="date"
            value={draft.dateOfBirth}
            onChange={(event) => onField('dateOfBirth', event.target.value)}
          />
        </Field>
        <Field label="Gender" htmlFor="patient-gender">
          <GenderSelect
            id="patient-gender"
            value={draft.gender}
            onChange={(gender) => onField('gender', gender)}
          />
        </Field>
      </div>
      <ClinicalListField
        id="patient-allergies"
        label="Allergies"
        value={draft.allergies}
        error={shownError(touched, 'allergies', errors.allergies)}
        onChange={(value) => onField('allergies', value)}
      />
      <ClinicalListField
        id="patient-conditions"
        label="Conditions"
        value={draft.conditions}
        error={shownError(touched, 'conditions', errors.conditions)}
        onChange={(value) => onField('conditions', value)}
      />
      <ClinicalListField
        id="patient-medications"
        label="Medications"
        value={draft.medications}
        error={shownError(touched, 'medications', errors.medications)}
        onChange={(value) => onField('medications', value)}
      />
      <Field
        label="Notes"
        htmlFor="patient-notes"
        error={shownError(touched, 'notes', errors.notes)}
      >
        <Textarea
          id="patient-notes"
          rows={3}
          value={draft.notes}
          autoComplete="off"
          onChange={(event) => onField('notes', event.target.value)}
        />
      </Field>
    </>
  );
}

interface PatientFieldErrors {
  fullName: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  notes: string | null;
  allergies: string | null;
  conditions: string | null;
  medications: string | null;
}

function errorsFor(draft: PatientDraft): PatientFieldErrors {
  return {
    fullName: validatePatientName(draft.fullName),
    phone: validatePatientPhone(draft.phone),
    dateOfBirth: validateDateOfBirth(draft.dateOfBirth),
    notes: validatePatientNotes(draft.notes),
    allergies: validateClinicalList(draft.allergies, 'allergies'),
    conditions: validateClinicalList(draft.conditions, 'conditions'),
    medications: validateClinicalList(draft.medications, 'medications'),
  };
}

function hasError(errors: PatientFieldErrors): boolean {
  return Object.values(errors).some((error) => error !== null);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreatePatientModalProps {
  open: boolean;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: CreatePatientBody) => void;
}

export function CreatePatientModal({
  open,
  submitting,
  error,
  onClose,
  onSubmit,
}: CreatePatientModalProps) {
  const [draft, setDraft] = useState<PatientDraft>(EMPTY_PATIENT_DRAFT);
  const { touched, touch, resetTouched } = useTouchedFields();

  useEffect(() => {
    if (open) {
      setDraft(EMPTY_PATIENT_DRAFT);
      resetTouched();
    }
  }, [open, resetTouched]);

  const errors = errorsFor(draft);
  const canSubmit = !hasError(errors) && !submitting;

  function onField<K extends keyof PatientDraft>(key: K, value: PatientDraft[K]) {
    touch(key);
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function submit() {
    if (!canSubmit) return;
    onSubmit(createPatientBody(draft));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add patient"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} disabled={!canSubmit} onClick={submit}>
            Create record
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error !== null && <ErrorNotice>{error}</ErrorNotice>}
        <PatientFields draft={draft} errors={errors} touched={touched} onField={onField} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export interface EditPatientModalProps {
  open: boolean;
  patient: PatientView | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: UpdatePatientBody) => void;
}

export function EditPatientModal({
  open,
  patient,
  submitting,
  error,
  onClose,
  onSubmit,
}: EditPatientModalProps) {
  const [draft, setDraft] = useState<PatientDraft>(EMPTY_PATIENT_DRAFT);
  const { touched, touch, resetTouched } = useTouchedFields();

  useEffect(() => {
    if (open && patient !== null) {
      setDraft(patientDraftFrom(patient));
      resetTouched();
    }
  }, [open, patient, resetTouched]);

  if (patient === null) {
    return null;
  }

  const errors = errorsFor(draft);
  // Held when nothing moved, so a save neither writes an empty patch nor moves
  // `updated_at` on a record the pharmacist opened and closed.
  const unchanged = patientUnchanged(patient, draft);
  const canSubmit = !hasError(errors) && !unchanged && !submitting;

  function onField<K extends keyof PatientDraft>(key: K, value: PatientDraft[K]) {
    touch(key);
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function submit() {
    if (!canSubmit || patient === null) return;
    onSubmit(patientUpdateBody(patient, draft));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit ${patient.fullName}`}
      size="lg"
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
        <PatientFields draft={draft} errors={errors} touched={touched} onField={onField} />
      </div>
    </Modal>
  );
}
