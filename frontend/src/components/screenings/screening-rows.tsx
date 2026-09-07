'use client';

/**
 * One reading, rendered the same way everywhere it appears.
 *
 * Shared by `/patients/[id]` (one patient's readings) and `/screenings` (every
 * patient's), for the reason `notification-rows.tsx` gives: two pages each drawing
 * a reading are two copies that drift, and the drift lands on a clinical row — a
 * blood pressure shown as two numbers on one page and one on the next. The optional
 * `action` node is how the cross-patient page adds its "open the record" link
 * without the patient page carrying a link to itself.
 */

import type { ReactNode } from 'react';

import {
  READING_UNIT,
  READING_WORD,
  RISK_LEVEL_TONE,
  RISK_LEVEL_WORD,
  SCREENING_TYPE_WORD,
} from '@/components/screenings/screenings-words';
import { Badge } from '@/components/ui/display';
import type { ScreeningView } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';

/**
 * The measurements a reading actually carries, as short "label value unit" strings.
 *
 * Only the non-null ones, because a blood-pressure row has nothing in the glucose or
 * weight columns and listing those as "—" would bury the two numbers that matter. A
 * blood pressure reads as one `120/80 mmHg` rather than two rows, which is how it is
 * said out loud at a counter. `bmi` is server-computed and has no `READING_WORD` —
 * it is not something anybody typed — so it is named directly.
 */
export function readingSummary(reading: ScreeningView): string[] {
  const parts: string[] = [];
  if (reading.systolicBp !== null && reading.diastolicBp !== null) {
    parts.push(`${reading.systolicBp}/${reading.diastolicBp} ${READING_UNIT.systolicBp}`);
  } else if (reading.systolicBp !== null) {
    parts.push(`${READING_WORD.systolicBp} ${reading.systolicBp} ${READING_UNIT.systolicBp}`);
  } else if (reading.diastolicBp !== null) {
    parts.push(`${READING_WORD.diastolicBp} ${reading.diastolicBp} ${READING_UNIT.diastolicBp}`);
  }
  if (reading.bloodGlucoseMmol !== null) {
    parts.push(
      `${READING_WORD.bloodGlucoseMmol} ${reading.bloodGlucoseMmol} ${READING_UNIT.bloodGlucoseMmol}`
    );
  }
  if (reading.bmi !== null) parts.push(`BMI ${reading.bmi}`);
  if (reading.weightKg !== null) {
    parts.push(`${READING_WORD.weightKg} ${reading.weightKg} ${READING_UNIT.weightKg}`);
  }
  if (reading.heightCm !== null) {
    parts.push(`${READING_WORD.heightCm} ${reading.heightCm} ${READING_UNIT.heightCm}`);
  }
  if (reading.temperatureC !== null) {
    parts.push(`${READING_WORD.temperatureC} ${reading.temperatureC} ${READING_UNIT.temperatureC}`);
  }
  if (reading.heartRateBpm !== null) {
    parts.push(`${READING_WORD.heartRateBpm} ${reading.heartRateBpm} ${READING_UNIT.heartRateBpm}`);
  }
  return parts;
}

export function ScreeningEntry({
  screening,
  action,
}: {
  screening: ScreeningView;
  action?: ReactNode;
}) {
  return (
    <li className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-neutral-900">
            {SCREENING_TYPE_WORD[screening.type]}
          </p>
          <Badge tone={RISK_LEVEL_TONE[screening.riskLevel]}>
            {RISK_LEVEL_WORD[screening.riskLevel]}
          </Badge>
        </div>
        <span className="text-2xs text-neutral-500">{formatDateTime(screening.measuredAt)}</span>
      </div>
      <p className="mt-1 text-sm text-neutral-700">{readingSummary(screening).join(' · ')}</p>
      {screening.riskReason !== null && (
        <p className="mt-1 text-2xs text-neutral-600">{screening.riskReason}</p>
      )}
      {screening.notes !== null && (
        <p className="mt-1 text-2xs text-neutral-500">{screening.notes}</p>
      )}
      {action !== undefined && <div className="mt-2">{action}</div>}
    </li>
  );
}
