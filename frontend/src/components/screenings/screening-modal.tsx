'use client';

/**
 * The dialog that records one reading: `/patients/[id]` opens it against a known
 * patient.
 *
 * The form is *type-aware* — it shows only the inputs the chosen type collects,
 * read straight from `SCREENING_TYPE_FIELDS`, so a blood pressure asks for two
 * numbers, a BMI for a weight and a height, a temperature for one number. Which
 * fields a type needs and where they go in the body is the part that breaks
 * silently, and it lives in `lib/screenings.ts` with tests; this component only
 * renders what that map says and hands the draft back.
 *
 * ## What is never on this form
 *
 * There is no risk-level field and no BMI field. The server derives the level from
 * the measurements and computes a BMI from the weight and height, so a form that
 * could type either would turn a clinical column into an opinion — the reason
 * `RecordScreeningBody` has no `riskLevel` at all.
 */

import { useEffect, useState } from 'react';

import {
  READING_UNIT,
  READING_WORD,
  SCREENING_TYPE_WORD,
} from '@/components/screenings/screenings-words';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/display';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import type { RecordScreeningBody, ScreeningType } from '@/lib/api-types';
import { SCREENING_TYPES } from '@/lib/api-types';
import {
  EMPTY_SCREENING_DRAFT,
  firstScreeningError,
  recordScreeningBody,
  SCREENING_TYPE_FIELDS,
  type ReadingKey,
  type ScreeningDraft,
} from '@/lib/screenings';

export interface RecordScreeningModalProps {
  open: boolean;
  patientId: string;
  /** Shown in the title so the pharmacist is never unsure whose reading this is. */
  patientName?: string;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: RecordScreeningBody) => void;
}

export function RecordScreeningModal({
  open,
  patientId,
  patientName,
  submitting,
  error,
  onClose,
  onSubmit,
}: RecordScreeningModalProps) {
  const [draft, setDraft] = useState<ScreeningDraft>(EMPTY_SCREENING_DRAFT);

  useEffect(() => {
    if (open) setDraft(EMPTY_SCREENING_DRAFT);
  }, [open]);

  function onField<K extends keyof ScreeningDraft>(key: K, value: ScreeningDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const fieldError = firstScreeningError(draft, (key) => READING_WORD[key]);
  const canSubmit = fieldError === null && !submitting;
  const readings = SCREENING_TYPE_FIELDS[draft.type];

  function submit() {
    if (!canSubmit) return;
    onSubmit(recordScreeningBody(patientId, draft));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={patientName === undefined ? 'Record a reading' : `Record a reading · ${patientName}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} disabled={!canSubmit} onClick={submit}>
            Save reading
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error !== null && <ErrorNotice>{error}</ErrorNotice>}

        <Field label="What was measured" htmlFor="screening-type">
          <Select
            id="screening-type"
            value={draft.type}
            onChange={(event) => onField('type', event.target.value as ScreeningType)}
          >
            {SCREENING_TYPES.map((type) => (
              <option key={type} value={type}>
                {SCREENING_TYPE_WORD[type]}
              </option>
            ))}
          </Select>
        </Field>

        {/* Only the inputs this type collects. A leftover value from a type the
            pharmacist switched away from is never read into the body. */}
        <div className="grid gap-4 sm:grid-cols-2">
          {readings.map((key: ReadingKey) => (
            <Field
              key={key}
              label={`${READING_WORD[key]} (${READING_UNIT[key]})`}
              htmlFor={`screening-${key}`}
              error={fieldError?.field === key ? fieldError.message : undefined}
              required
            >
              <Input
                id={`screening-${key}`}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={draft[key]}
                onChange={(event) => onField(key, event.target.value)}
              />
            </Field>
          ))}
        </div>

        <Field
          label="Taken at"
          htmlFor="screening-measured-at"
          hint="Leave blank to record it as now."
          error={fieldError?.field === 'measuredAt' ? fieldError.message : undefined}
        >
          <Input
            id="screening-measured-at"
            type="datetime-local"
            value={draft.measuredAt}
            onChange={(event) => onField('measuredAt', event.target.value)}
          />
        </Field>

        <Field
          label="Notes"
          htmlFor="screening-notes"
          error={fieldError?.field === 'notes' ? fieldError.message : undefined}
        >
          <Textarea
            id="screening-notes"
            rows={2}
            value={draft.notes}
            autoComplete="off"
            onChange={(event) => onField('notes', event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
