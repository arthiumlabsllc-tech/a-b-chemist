/**
 * The words and badge tones the consultation diary renders, in one place.
 *
 * `no_show` reads "Did not attend" rather than the enum's own `no_show`, because
 * the diary keeps it apart from `cancelled` on purpose — one was called off, the
 * other did not arrive — and the two want different follow-up. The tone follows:
 * a cancellation is a warning (a plan changed) and a missed appointment is a
 * negative (a patient was expected and did not come).
 */

import type { BadgeTone } from '@/components/ui/display';
import type { ConsultationStatus, ConsultationType } from '@/lib/api-types';

export const CONSULTATION_TYPE_WORD: Record<ConsultationType, string> = {
  in_person: 'In person',
  video: 'Video',
  chat: 'Chat',
  phone: 'Phone',
};

export const CONSULTATION_STATUS_WORD: Record<ConsultationStatus, string> = {
  scheduled: 'Scheduled',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'Did not attend',
};

export const CONSULTATION_STATUS_TONE: Record<ConsultationStatus, BadgeTone> = {
  scheduled: 'neutral',
  completed: 'positive',
  cancelled: 'warning',
  no_show: 'negative',
};
