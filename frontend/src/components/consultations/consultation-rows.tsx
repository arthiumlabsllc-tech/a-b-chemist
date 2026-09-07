'use client';

/**
 * One appointment, rendered the same way everywhere it appears.
 *
 * Shared by `/patients/[id]` (one patient's appointments, with Move and End) and
 * `/consultations` (the whole diary, read-only, with a link to the record), so the
 * two cannot drift into showing a status or a length differently. The optional
 * `action` node carries whatever the page can do with the row: the patient page
 * passes its Move/End buttons, the diary passes a link, and a row that has already
 * ended gets neither.
 *
 * The meeting link is an external `https` link-out and nothing more — this app does
 * not join the call or embed a player, which is why the backend stores a link only
 * for a `video` appointment. `rel="noopener noreferrer"` because a link opened in a
 * new tab from a page holding a session should not get a handle back to it.
 */

import type { ReactNode } from 'react';

import {
  CONSULTATION_STATUS_TONE,
  CONSULTATION_STATUS_WORD,
  CONSULTATION_TYPE_WORD,
} from '@/components/consultations/consultations-words';
import { Badge } from '@/components/ui/display';
import type { ConsultationView } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';

export function ConsultationEntry({
  consultation,
  action,
}: {
  consultation: ConsultationView;
  action?: ReactNode;
}) {
  return (
    <li className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-neutral-900">
            {CONSULTATION_TYPE_WORD[consultation.type]}
          </p>
          <Badge tone={CONSULTATION_STATUS_TONE[consultation.status]}>
            {CONSULTATION_STATUS_WORD[consultation.status]}
          </Badge>
          {consultation.conductedBy === null && <Badge tone="neutral">Unassigned</Badge>}
        </div>
        <span className="text-2xs text-neutral-500">
          {formatDateTime(consultation.scheduledAt)}
          {consultation.durationMinutes !== null ? ` · ${consultation.durationMinutes} min` : ''}
        </span>
      </div>

      {consultation.videoUrl !== null && (
        <a
          href={consultation.videoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-block text-2xs text-primary-700 hover:text-primary-800 hover:underline"
        >
          Open meeting link
        </a>
      )}
      {consultation.notes !== null && (
        <p className="mt-1 text-2xs text-neutral-500">{consultation.notes}</p>
      )}

      {action !== undefined && <div className="mt-2 flex flex-wrap gap-2">{action}</div>}
    </li>
  );
}
