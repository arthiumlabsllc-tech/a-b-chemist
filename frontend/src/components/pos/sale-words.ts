/**
 * The words and colours a sale status and a payment method are shown with.
 *
 * One place rather than a `switch` copied into the receipt, the sales list and the
 * sale detail page, because the three would drift — a status the receipt calls
 * "Partly refunded" and the list calls "Partial" is two vocabularies for one row,
 * and the drift is invisible until the screens are side by side.
 *
 * The tone is a `BadgeTone` rather than a class string, so this file holds no
 * Tailwind and could live in `lib`; it sits beside the components because it is
 * presentation vocabulary and the badge it feeds lives here too.
 */

import type { BadgeTone } from '@/components/ui/display';
import type { SalePaymentMethod, SaleStatus } from '@/lib/api-types';

export const STATUS_WORD: Record<SaleStatus, string> = {
  pending: 'Pending',
  completed: 'Completed',
  voided: 'Voided',
  refunded: 'Refunded',
  partially_refunded: 'Partly refunded',
};

export const STATUS_TONE: Record<SaleStatus, BadgeTone> = {
  pending: 'warning',
  completed: 'positive',
  voided: 'negative',
  refunded: 'neutral',
  partially_refunded: 'warning',
};

export const METHOD_WORD: Record<SalePaymentMethod, string> = {
  cash: 'Cash',
  momo: 'Mobile money',
};
