/**
 * The words and badge tones the inventory pages render, in one place.
 *
 * Same split as `components/pos/sale-words.ts`: the maps live beside the
 * components rather than in `lib` because a tone is a `BadgeTone`, which is a
 * component type, and `lib` holds no Tailwind and no component imports. Each map
 * is a total `Record` over its enum, so a value added to `MOVEMENT_TYPES`,
 * `StockLevel` or `ExpiryState` without a word here is a compile error rather
 * than a blank cell — the same guarantee `MOVEMENT_WORD`'s comment in
 * `api-types.ts` promises.
 */

import type { BadgeTone } from '@/components/ui/display';
import type { MovementType, SellUnit, VatTreatment } from '@/lib/api-types';
import type { ExpiryState, StockLevel } from '@/lib/inventory';

/** `stock_movement_type`, as a ledger row names it. */
export const MOVEMENT_WORD: Record<MovementType, string> = {
  opening: 'Opening balance',
  receive: 'Received',
  adjust: 'Adjustment',
  write_off: 'Write-off',
  sale: 'Sale',
  void_restore: 'Void restore',
};

/**
 * The ledger's colour coding. Stock arriving is positive, leaving is negative, a
 * correction is a warning because it means the count was wrong, and a void
 * restore is positive because it puts stock back.
 */
export const MOVEMENT_TONE: Record<MovementType, BadgeTone> = {
  opening: 'neutral',
  receive: 'positive',
  adjust: 'warning',
  write_off: 'negative',
  sale: 'neutral',
  void_restore: 'positive',
};

export const STOCK_LEVEL_WORD: Record<StockLevel, string> = {
  out: 'Out of stock',
  low: 'Low stock',
  ok: 'In stock',
};

export const STOCK_LEVEL_TONE: Record<StockLevel, BadgeTone> = {
  out: 'negative',
  low: 'warning',
  ok: 'positive',
};

export const EXPIRY_WORD: Record<ExpiryState, string> = {
  none: 'No expiry date',
  expired: 'Expired',
  soon: 'Expiring soon',
  ok: 'In date',
};

export const EXPIRY_TONE: Record<ExpiryState, BadgeTone> = {
  none: 'neutral',
  expired: 'negative',
  soon: 'warning',
  ok: 'positive',
};

export const SELL_UNIT_WORD: Record<SellUnit, string> = {
  single: 'Single',
  pack: 'Pack',
};

export const VAT_TREATMENT_WORD: Record<VatTreatment, string> = {
  standard: 'Standard',
  exempt: 'Exempt',
  zero_rated: 'Zero-rated',
};
