import { poolSql, withTransaction } from '../database/pool';
import {
  listActiveProducts,
  listBatchesHoldingStock,
  type BatchRow,
  type ProductRow,
} from '../repositories/inventory.repository';
import {
  listNotifications,
  raiseNotification,
  type NewNotification,
  type NotificationRow,
} from '../repositories/notifications.repository';
import {
  daysUntilExpiry,
  expiringWithin,
  sellableUnits,
  EXPIRY_ALERT_WINDOW_DAYS,
} from '../utils/fefo';
import { SMS_NOT_CONFIGURED_REASON } from './sms';

/**
 * Reorder and expiry alerts.
 *
 * The scan reads widely and decides in TypeScript rather than asking the
 * database for "everything expiring within 90 days". That looks like the slower
 * choice and is the correct one: `utils/fefo.ts` is the single home of the
 * expiry rule, and a SQL `where expiry_date between today and today + 90` would
 * be a second statement of it — one that has to get the boundary right a second
 * time, in a second language, with no shared test. At one pharmacy's scale the
 * difference is a few hundred rows either way.
 *
 * Both alert kinds are deduplicated against history by key, so running the scan
 * ten times in a morning produces one alert per problem rather than ten.
 */

/**
 * Why every alert raised here is `not_sent`.
 *
 * Nothing is delivered anywhere: there is no SMS provider configured and no
 * email transport. Saying so beside the row is the honest version of a status
 * that would otherwise read as "queued" or, worse, as a delivery that silently
 * never happened.
 *
 * Phase 4 wrote this as its own literal, with a note that Phase 8 owns delivery
 * and would have to replace it rather than discover it. Phase 8 did, and the
 * replacement is this: one string in `services/sms.ts`, re-exported under the
 * name this file's callers already use. A stock alert and a patient reminder
 * that cannot be texted are not two situations, and two sentences for one fact
 * is how a panel and a bell drift into saying different things about the same
 * missing configuration.
 */
export const ALERT_NOT_SENT_REASON = SMS_NOT_CONFIGURED_REASON;

/** The two stock alert types, so the panel asks for exactly these and nothing else. */
export const STOCK_ALERT_TYPES = ['stock_reorder', 'stock_expiry'] as const;

export interface AlertCounts {
  /** Rows this scan created. */
  raised: number;
  /** Problems this scan found that were already alerted, so nothing was written. */
  alreadyRaised: number;
}

export interface ScanSummary {
  /** The date the scan reasoned about, echoed so the caller can see it. */
  today: string;
  windowDays: number;
  productsScanned: number;
  batchesScanned: number;
  reorder: AlertCounts;
  expiry: AlertCounts;
}

export interface AlertListOptions {
  limit: number;
  offset: number;
}

/**
 * Does this product want a reorder alert?
 *
 * `reorderLevel > 0` is load-bearing rather than tidy. The column defaults to
 * 0 and 0 means "this pharmacy does not track a threshold for this product",
 * not "alert me when it hits zero". Without the guard every product that has
 * never been given a reorder level raises an alert the moment it sells out, and
 * the panel fills with noise about lines nobody intended to track — which is how
 * a real alert gets missed.
 *
 * The figure compared is *sellable* units, not `product.quantity`. The derived
 * quantity counts expired stock, so a shelf holding thirty out-of-date boxes
 * would read as well-stocked and suppress the alert for the product that most
 * needs ordering.
 */
export function needsReorder(
  product: Pick<ProductRow, 'reorderLevel'>,
  batches: readonly BatchRow[],
  today: string
): boolean {
  if (product.reorderLevel <= 0) return false;
  return sellableUnits(batches, today) <= product.reorderLevel;
}

/** Groups batches by product, preserving the FEFO order the query returns them in. */
function groupByProduct(batches: readonly BatchRow[]): Map<string, BatchRow[]> {
  const grouped = new Map<string, BatchRow[]>();
  for (const batch of batches) {
    const existing = grouped.get(batch.inventoryId);
    if (existing === undefined) {
      grouped.set(batch.inventoryId, [batch]);
    } else {
      existing.push(batch);
    }
  }
  return grouped;
}

function reorderAlert(
  pharmacyId: string,
  product: ProductRow,
  sellable: number,
  today: string
): NewNotification {
  return {
    pharmacyId,
    type: 'stock_reorder',
    title: `Reorder ${product.name}`,
    body:
      `${sellable} sellable unit${sellable === 1 ? '' : 's'} left against a reorder level of ` +
      `${product.reorderLevel}.`,
    relatedType: 'inventory',
    relatedId: product.id,
    // Keyed by day. A product still below its level tomorrow raises a fresh
    // alert, which is right: the problem has persisted for another day and the
    // panel should say so. Keyed with no date at all it would alert once and
    // never again, and a month-old row would be the only trace of a line that
    // has been empty for a month.
    dedupeKey: `stock_reorder:${product.id}:${today}`,
    status: 'not_sent',
    notSentReason: ALERT_NOT_SENT_REASON,
  };
}

function expiryAlert(
  pharmacyId: string,
  product: ProductRow,
  batch: BatchRow,
  today: string
): NewNotification {
  const days = daysUntilExpiry(batch.expiryDate, today);
  const when =
    days === null
      ? 'has no recorded expiry date'
      : days < 0
        ? `expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`
        : days === 0
          ? 'expires today'
          : `expires in ${days} day${days === 1 ? '' : 's'}`;

  return {
    pharmacyId,
    type: 'stock_expiry',
    title: `${product.name} — lot ${batch.lotNumber} ${when}`,
    body:
      `${batch.quantity} unit${batch.quantity === 1 ? '' : 's'} on the shelf` +
      `${batch.expiryDate === null ? '' : `, expiry ${batch.expiryDate}`}.`,
    relatedType: 'inventory_batch',
    relatedId: batch.id,
    // Keyed by batch with no date, so once ever. A batch's expiry date never
    // changes, so re-raising daily would repeat the same sentence until the
    // stock is gone and bury everything else in the panel. Already-expired
    // batches are included by `expiringWithin` on purpose: an alert that stops
    // firing the day after the date passes hides exactly the stock that most
    // needs pulling off the shelf.
    dedupeKey: `stock_expiry:${batch.id}`,
    status: 'not_sent',
    notSentReason: ALERT_NOT_SENT_REASON,
  };
}

/**
 * Raises every reorder and expiry alert the shelves currently warrant.
 *
 * One transaction. Each insert is independently idempotent, so the transaction
 * is not what makes the scan safe to repeat — it makes the returned counts a
 * true description of what landed. A scan that had raised six alerts and then
 * failed on the seventh would otherwise report six raised and leave the caller
 * believing the work was done.
 */
export async function scanStockAlerts(
  pharmacyId: string,
  today: string,
  windowDays: number = EXPIRY_ALERT_WINDOW_DAYS
): Promise<ScanSummary> {
  return withTransaction(async (client) => {
    const products = await listActiveProducts(client, pharmacyId);
    const batches = await listBatchesHoldingStock(client, pharmacyId);
    const byProduct = groupByProduct(batches);

    const summary: ScanSummary = {
      today,
      windowDays,
      productsScanned: products.length,
      batchesScanned: batches.length,
      reorder: { raised: 0, alreadyRaised: 0 },
      expiry: { raised: 0, alreadyRaised: 0 },
    };

    const raise = async (
      alert: NewNotification,
      counts: AlertCounts
    ): Promise<void> => {
      const result = await raiseNotification(client, alert);
      if (result.raised) counts.raised += 1;
      else counts.alreadyRaised += 1;
    };

    for (const product of products) {
      const productBatches = byProduct.get(product.id) ?? [];

      if (needsReorder(product, productBatches, today)) {
        await raise(
          reorderAlert(pharmacyId, product, sellableUnits(productBatches, today), today),
          summary.reorder
        );
      }

      // Expiring batches of this product only. `expiringWithin` is the shared
      // rule, including the "already expired still counts" half of it.
      for (const batch of expiringWithin(productBatches, today, windowDays)) {
        await raise(expiryAlert(pharmacyId, product, batch, today), summary.expiry);
      }
    }

    return summary;
  });
}

/** The stock alert panel. Newest first, both alert kinds and nothing else. */
export async function listStockAlerts(
  pharmacyId: string,
  options: AlertListOptions
): Promise<NotificationRow[]> {
  return listNotifications(poolSql, pharmacyId, {
    types: STOCK_ALERT_TYPES,
    limit: options.limit,
    offset: options.offset,
  });
}
