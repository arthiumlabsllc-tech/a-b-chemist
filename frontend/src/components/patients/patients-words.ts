/**
 * The words the patient pages render, in one place.
 *
 * Same split as `components/inventory/inventory-words.ts`: the maps live beside the
 * components rather than in `lib` because a tone is a `BadgeTone`, a component
 * type, and `lib` holds no Tailwind and no component imports. Each map is a total
 * `Record` over its enum, so a value added to `GENDERS` without a word here is a
 * compile error rather than a blank cell.
 */

import type { Gender } from '@/lib/api-types';

export const GENDER_WORD: Record<Gender, string> = {
  male: 'Male',
  female: 'Female',
  other: 'Other',
  undisclosed: 'Undisclosed',
};

/**
 * The word for a gender that was never asked, kept apart from `'undisclosed'`.
 *
 * `null` means nobody asked and `'undisclosed'` means the patient was asked and
 * declined — the backend holds them apart for a reason, and a record page that
 * showed both as the same dash would collapse an answer into a gap. One is
 * something to ask at the next visit; the other is a boundary to respect.
 */
export const GENDER_UNASKED = 'Not asked';
