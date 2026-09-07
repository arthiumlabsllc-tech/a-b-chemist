/**
 * The pure logic behind the consultation diary: the list query, the booking body,
 * and — the part that has to be right — the three-way reschedule diff.
 *
 * ## Why the reschedule diff is the whole module
 *
 * `PATCH /consultations/:id` reads an absent key as "leave it alone", a present
 * `null` as "clear it" and a value as "set it", and `consultations.service.ts` goes
 * out of its way to keep that distinction alive: collapsing `undefined` into `null`
 * on the way in would take the meeting link and the length away from every
 * appointment a form moved by posting only the new time, and the row would still
 * look perfectly ordinary afterwards. So `rescheduleBody` sends a field only when it
 * differs from the stored row, and sends `null` — never `''` — to clear one.
 *
 * `scheduledAt` is the exception: the route requires it on a reschedule as well as
 * on a booking, because a move with no new time is not a move. It is always sent.
 *
 * ## Video is a link-out, and only for a video consultation
 *
 * The meeting link is shown and validated only when the type is `video`, mirroring
 * the backend: `videoUrlFrom` allows `https:` and nothing else, and a reschedule
 * that moves the type off `video` clears the link. A form that showed a link field
 * beside an in-person visit would be offering to store an address for a meeting that
 * is not happening online.
 */

import type { BookConsultationBody, ConsultationType, ConsultationView, RescheduleBody } from './api-types';
import { dateTimeLocalToIso, isoToDateTimeLocal } from './dates';

// ---------------------------------------------------------------------------
// Constants copied from the backend, and safe to copy
// ---------------------------------------------------------------------------

/** The cap on an appointment note, copied from `MAX_NOTES_LENGTH` in the route. */
export const CONSULTATION_NOTES_MAX = 500;

/**
 * The cap on a meeting link, copied from `MAX_VIDEO_URL_LENGTH` in the route. The
 * `video_url` column is `text` with no limit, so the route's cap is the only one —
 * and the value ends up in an `href`, which is where an unbounded field stops being
 * a harmless one.
 */
export const MAX_VIDEO_URL_LENGTH = 2048;

// ---------------------------------------------------------------------------
// The editable draft — one shape for booking and for rescheduling
// ---------------------------------------------------------------------------

/**
 * The appointment fields a form edits. One shape serves both a booking and a
 * reschedule, because the two accept the same fields — the only difference is that
 * a reschedule diffs against a stored row and a booking does not. `scheduledAt` is a
 * `datetime-local` value and `durationMinutes` is text, so neither is a type a form
 * has to convert.
 */
export interface ConsultationDraft {
  type: ConsultationType;
  scheduledAt: string;
  durationMinutes: string;
  videoUrl: string;
  notes: string;
}

export const EMPTY_CONSULTATION_DRAFT: ConsultationDraft = {
  type: 'in_person',
  scheduledAt: '',
  durationMinutes: '',
  videoUrl: '',
  notes: '',
};

/** A draft seeded from a stored row, which is how the reschedule form is opened. */
export function consultationDraftFrom(consultation: ConsultationView): ConsultationDraft {
  return {
    type: consultation.type,
    scheduledAt: isoToDateTimeLocal(consultation.scheduledAt),
    durationMinutes: consultation.durationMinutes === null ? '' : String(consultation.durationMinutes),
    videoUrl: consultation.videoUrl ?? '',
    notes: consultation.notes ?? '',
  };
}

function nullIfEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * A whole number of minutes, or null when the field is blank.
 *
 * Blank and zero are different: null is "no length was given", which is not the
 * same as a zero-minute appointment, and the column is nullable for exactly that
 * reason. Non-numeric text also folds to null here, but `firstConsultationError`
 * refuses it before a builder ever sees it, so a builder can trust this.
 */
function durationNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * The meeting link for this draft, or null. Only a `video` consultation carries one,
 * so any other type folds the field to null whatever text is in it — the same rule
 * the backend applies when a reschedule moves the type off `video`.
 */
function videoUrlOf(draft: ConsultationDraft): string | null {
  return draft.type === 'video' ? nullIfEmpty(draft.videoUrl) : null;
}

// ---------------------------------------------------------------------------
// Building the two bodies
// ---------------------------------------------------------------------------

/**
 * What `POST /consultations` is given.
 *
 * `conductedBy` is a parameter rather than a draft field because there is no staff
 * directory to pick from — `GET /staff` is owner-only, so a pharmacist booking an
 * appointment cannot be offered a list of colleagues. The page passes the signed-in
 * user's id to assign the appointment to the person booking it, or null to leave it
 * unassigned; either is a value the backend's `resolveConductor` accepts, because
 * whoever holds `consultations:write` may hold a consultation. The key is omitted
 * when null so the row is written unassigned rather than explicitly cleared.
 */
export function bookConsultationBody(
  patientId: string,
  draft: ConsultationDraft,
  conductedBy: string | null
): BookConsultationBody {
  const body: BookConsultationBody = {
    patientId,
    type: draft.type,
    scheduledAt: dateTimeLocalToIso(draft.scheduledAt) ?? draft.scheduledAt.trim(),
  };
  if (conductedBy !== null) body.conductedBy = conductedBy;

  const duration = durationNumber(draft.durationMinutes);
  if (duration !== null) body.durationMinutes = duration;

  const videoUrl = videoUrlOf(draft);
  if (videoUrl !== null) body.videoUrl = videoUrl;

  const notes = nullIfEmpty(draft.notes);
  if (notes !== null) body.notes = notes;

  return body;
}

/**
 * Only the fields that moved, as `PATCH /consultations/:id` wants them, with
 * `scheduledAt` always present. See the module docstring for why the omit/null/set
 * distinction is the part that matters.
 */
export function rescheduleBody(original: ConsultationView, draft: ConsultationDraft): RescheduleBody {
  const body: RescheduleBody = {
    scheduledAt: dateTimeLocalToIso(draft.scheduledAt) ?? draft.scheduledAt.trim(),
  };

  if (draft.type !== original.type) body.type = draft.type;

  const duration = durationNumber(draft.durationMinutes);
  if (duration !== original.durationMinutes) body.durationMinutes = duration;

  const videoUrl = videoUrlOf(draft);
  if (videoUrl !== original.videoUrl) body.videoUrl = videoUrl;

  const notes = nullIfEmpty(draft.notes);
  if (notes !== original.notes) body.notes = notes;

  return body;
}

/**
 * True when a reschedule would change nothing, so Save can be held.
 *
 * Worth having even though `rescheduleBody` always sends `scheduledAt`: a reschedule
 * is not a no-op on the server, it supersedes the old appointment reminder and
 * raises a new one, so re-saving an untouched form churns the reminder for no
 * reason. The time is compared as the instant it becomes, not as the text.
 */
export function rescheduleUnchanged(original: ConsultationView, draft: ConsultationDraft): boolean {
  return (
    dateTimeLocalToIso(draft.scheduledAt) === original.scheduledAt &&
    draft.type === original.type &&
    durationNumber(draft.durationMinutes) === original.durationMinutes &&
    videoUrlOf(draft) === original.videoUrl &&
    nullIfEmpty(draft.notes) === original.notes
  );
}

// ---------------------------------------------------------------------------
// Filters and the diary query
// ---------------------------------------------------------------------------

/**
 * The diary's filters. Each is a single value rather than a list, because
 * `api-client`'s `buildQuery` renders one value per key; `order` is a view toggle
 * (`upcoming` or `recent`) rather than a filter, and is left out of
 * `consultationFiltersActive` for that reason.
 */
export interface ConsultationFilters {
  patientId: string;
  conductedBy: string;
  status: string;
  from: string;
  to: string;
  order: string;
}

export const EMPTY_CONSULTATION_FILTERS: ConsultationFilters = {
  patientId: '',
  conductedBy: '',
  status: '',
  from: '',
  to: '',
  order: '',
};

/** The query for `GET /consultations`, sending only the filters that are set. */
export function consultationQueryFrom(
  filters: ConsultationFilters,
  limit: number,
  offset: number
): Record<string, string | number> {
  const query: Record<string, string | number> = { limit, offset };
  const patientId = filters.patientId.trim();
  if (patientId !== '') query.patientId = patientId;
  const conductedBy = filters.conductedBy.trim();
  if (conductedBy !== '') query.conductedBy = conductedBy;
  const status = filters.status.trim();
  if (status !== '') query.status = status;
  const from = filters.from.trim();
  if (from !== '') query.from = from;
  const to = filters.to.trim();
  if (to !== '') query.to = to;
  const order = filters.order.trim();
  if (order !== '') query.order = order;
  return query;
}

/** Whether a filter — not the order toggle — is set, so the page offers "Clear". */
export function consultationFiltersActive(filters: ConsultationFilters): boolean {
  return (
    filters.patientId.trim() !== '' ||
    filters.conductedBy.trim() !== '' ||
    filters.status.trim() !== '' ||
    filters.from.trim() !== '' ||
    filters.to.trim() !== ''
  );
}

// ---------------------------------------------------------------------------
// Validation — fast feedback; the server remains authoritative.
// ---------------------------------------------------------------------------

/** The one field that stopped a save, and why, as `{ field, message }`. */
export interface ConsultationDraftError {
  field: 'scheduledAt' | 'durationMinutes' | 'videoUrl' | 'notes';
  message: string;
}

/**
 * The first thing wrong with an appointment draft, or null when it may be saved.
 *
 * The messages mirror the backend's own so the counter shows one kind of red: a
 * whole number of minutes, an `https` meeting link, a note within the cap. A past
 * appointment is not refused — the server does not refuse one either, and booking a
 * consultation that is happening now is a legitimate thing to record; the only
 * consequence is that no reminder is raised for a slot that has already passed.
 */
export function firstConsultationError(draft: ConsultationDraft): ConsultationDraftError | null {
  if (draft.scheduledAt.trim() === '' || dateTimeLocalToIso(draft.scheduledAt) === null) {
    return { field: 'scheduledAt', message: 'Enter the date and time of the appointment' };
  }

  const durationText = draft.durationMinutes.trim();
  if (durationText !== '' && !/^\d+$/.test(durationText)) {
    return {
      field: 'durationMinutes',
      message: 'Enter the length of the consultation as a whole number of minutes',
    };
  }

  const videoUrl = draft.videoUrl.trim();
  if (draft.type === 'video' && videoUrl !== '') {
    if (videoUrl.length > MAX_VIDEO_URL_LENGTH) {
      return {
        field: 'videoUrl',
        message: `A meeting link must be ${MAX_VIDEO_URL_LENGTH} characters or fewer`,
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(videoUrl);
    } catch {
      return { field: 'videoUrl', message: 'That is not a web address' };
    }
    if (parsed.protocol !== 'https:') {
      return { field: 'videoUrl', message: 'The meeting link must start with https://' };
    }
  }

  if (draft.notes.trim().length > CONSULTATION_NOTES_MAX) {
    return { field: 'notes', message: `Notes must be ${CONSULTATION_NOTES_MAX} characters or fewer` };
  }

  return null;
}
