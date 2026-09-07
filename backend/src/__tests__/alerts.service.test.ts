jest.mock('../database/pool', () => ({
  poolSql: { query: jest.fn() },
  withTransaction: jest.fn(),
}));

jest.mock('../repositories/notifications.repository', () => ({
  raiseNotification: jest.fn(),
  listNotifications: jest.fn(),
}));

jest.mock('../repositories/inventory.repository', () => ({
  listActiveProducts: jest.fn(),
  listBatchesHoldingStock: jest.fn(),
}));

import type { PoolClient } from 'pg';
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
} from '../repositories/notifications.repository';
import {
  ALERT_NOT_SENT_REASON,
  STOCK_ALERT_TYPES,
  listStockAlerts,
  needsReorder,
  scanStockAlerts,
} from '../services/alerts.service';
import { NOTIFICATION_TYPES } from '../utils/schema-enums';

/**
 * Which alerts the scan decides to raise.
 *
 * `utils/fefo` is deliberately NOT mocked here, and that is the point of the
 * suite. The service reads widely and decides in TypeScript so that the expiry
 * rule has one home; mocking fefo would replace the thing under test with a stub
 * that agrees with whatever the test assumed, and every boundary below — sellable
 * on the expiry date, undated never expiring, already-expired still alerting —
 * would be asserted against a fiction.
 *
 * The repositories and the pool are mocked, because what matters at this level is
 * which alerts were built, what they were keyed by, and whether the counts
 * describe what landed. That the statements themselves are valid SQL is
 * `notifications.repository.test.ts` and section 11 of the harness.
 */

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const PRODUCT = 'a0000000-0000-4000-8000-000000000010';
const OTHER_PRODUCT = 'a0000000-0000-4000-8000-000000000011';
const BATCH = 'a0000000-0000-4000-8000-000000000012';
const TODAY = '2026-03-15';

/** Exactly 90 days after TODAY, so it is inside the default window. */
const DAY_90 = '2026-06-13';
/** One day past it. */
const DAY_91 = '2026-06-14';
const YESTERDAY = '2026-03-14';

const CLIENT = { query: jest.fn() } as unknown as PoolClient;

const withTransactionMock = withTransaction as jest.Mock;
const raiseMock = raiseNotification as jest.Mock;
const listNotificationsMock = listNotifications as jest.Mock;
const listActiveProductsMock = listActiveProducts as jest.Mock;
const listBatchesHoldingStockMock = listBatchesHoldingStock as jest.Mock;

/**
 * Complete rows rather than partial ones cast to the interface: if `ProductRow` or
 * `BatchRow` grows a required field, this file stops compiling instead of quietly
 * feeding the service a row no database would ever return.
 */
function product(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: PRODUCT,
    pharmacyId: PHARMACY,
    name: 'Paracetamol 500mg',
    code: 'PARA-500',
    genericName: 'Paracetamol',
    category: 'Analgesic',
    manufacturer: 'Lab',
    packSize: 10,
    defaultSellUnit: 'single',
    shelfLocation: 'A1',
    barcode: '1234567890',
    requiresPrescription: false,
    reorderLevel: 20,
    unitPrice: '12.50',
    vatTreatment: 'exempt',
    isActive: true,
    quantity: 100,
    batchNumber: 'LOT-1',
    expiryDate: DAY_90,
    costPrice: '8.2500',
    createdAt: '2026-01-05T09:00:00.000Z',
    updatedAt: '2026-01-05T09:00:00.000Z',
    ...overrides,
  };
}

function batch(overrides: Partial<BatchRow> = {}): BatchRow {
  return {
    id: BATCH,
    pharmacyId: PHARMACY,
    inventoryId: PRODUCT,
    lotNumber: 'LOT-1',
    expiryDate: DAY_90,
    quantity: 100,
    costPrice: '8.2500',
    receivedAt: '2026-01-05T09:00:00.000Z',
    createdAt: '2026-01-05T09:00:00.000Z',
    updatedAt: '2026-01-05T09:00:00.000Z',
    ...overrides,
  };
}

/** Every alert the scan built, in the order it built them. */
function raisedAlerts(): NewNotification[] {
  return raiseMock.mock.calls.map((call) => (call as unknown[])[1] as NewNotification);
}

beforeEach(() => {
  withTransactionMock.mockImplementation(
    async (work: (client: PoolClient) => Promise<unknown>) => work(CLIENT)
  );
  raiseMock.mockResolvedValue({ raised: true, notification: null });
  listActiveProductsMock.mockResolvedValue([]);
  listBatchesHoldingStockMock.mockResolvedValue([]);
  listNotificationsMock.mockResolvedValue([]);
});

describe('needsReorder', () => {
  it('is false when the reorder level is zero, because zero means nobody tracks this line', async () => {
    // The guard is load-bearing rather than tidy. `reorder_level` defaults to 0,
    // and 0 means "this pharmacy has not set a threshold here", not "tell me when
    // it hits zero". Without it, every product that was never given a level raises
    // an alert the moment it sells out, and the panel fills with noise about lines
    // nobody intended to track — which is how the one real alert gets missed.
    expect(needsReorder({ reorderLevel: 0 }, [], TODAY)).toBe(false);
    expect(needsReorder({ reorderLevel: 0 }, [batch({ quantity: 0 })], TODAY)).toBe(false);
  });

  it('is false for a negative level too, rather than comparing against it', () => {
    expect(needsReorder({ reorderLevel: -5 }, [], TODAY)).toBe(false);
  });

  it('fires at exactly the level, because "at or below" is the point', () => {
    // Off by one here means the alert arrives a selling-day late, which for the
    // line that prompted it is the difference between reordering and running out.
    expect(needsReorder({ reorderLevel: 20 }, [batch({ quantity: 20 })], TODAY)).toBe(true);
    expect(needsReorder({ reorderLevel: 20 }, [batch({ quantity: 21 })], TODAY)).toBe(false);
  });

  it('counts expired stock as unavailable, which is why it never reads product.quantity', () => {
    // The signature is `Pick<ProductRow, 'reorderLevel'>`, so the derived quantity
    // is not merely ignored here — it is unreachable. That matters because the
    // derived column counts expired stock: a shelf holding thirty out-of-date boxes
    // reads as well-stocked, and the product that most needs ordering is the one
    // whose alert gets suppressed.
    const expired = batch({ quantity: 30, expiryDate: YESTERDAY });
    expect(needsReorder({ reorderLevel: 10 }, [expired], TODAY)).toBe(true);
  });

  it('counts stock expiring today as available, and stock that expired yesterday as not', () => {
    // Sellable on the expiry date, not after it. The boundary is the plan's, and
    // getting it wrong in either direction is visible at the till: a day early and
    // stock is written off while it can still be sold, a day late and the scan
    // counts something the till would refuse.
    expect(needsReorder({ reorderLevel: 10 }, [batch({ quantity: 50, expiryDate: TODAY })], TODAY)).toBe(false);
    expect(needsReorder({ reorderLevel: 10 }, [batch({ quantity: 50, expiryDate: YESTERDAY })], TODAY)).toBe(true);
  });

  it('counts undated stock as available, because undated means always sellable', () => {
    expect(needsReorder({ reorderLevel: 10 }, [batch({ quantity: 50, expiryDate: null })], TODAY)).toBe(false);
  });

  it('sums across batches, so a product split over two lots is judged on the total', () => {
    const first = batch({ id: 'a0000000-0000-4000-8000-0000000000a1', quantity: 8 });
    const second = batch({ id: 'a0000000-0000-4000-8000-0000000000a2', quantity: 7 });
    expect(needsReorder({ reorderLevel: 20 }, [first, second], TODAY)).toBe(true);
    expect(needsReorder({ reorderLevel: 14 }, [first, second], TODAY)).toBe(false);
  });
});

describe('the dedupe keys', () => {
  it('keys a reorder alert by product and day, so a problem that persists is reported again', async () => {
    listActiveProductsMock.mockResolvedValue([product({ reorderLevel: 20 })]);
    listBatchesHoldingStockMock.mockResolvedValue([batch({ quantity: 5 })]);

    await scanStockAlerts(PHARMACY, TODAY);

    // Keyed by day on purpose. Still below the level tomorrow means the problem has
    // persisted for another day and the panel should say so. With no date in the key
    // it would alert once and never again, and a month-old row would be the only
    // trace of a line that has been empty for a month.
    expect(raisedAlerts()[0]?.dedupeKey).toBe(`stock_reorder:${PRODUCT}:${TODAY}`);
  });

  it('keys an expiry alert by batch alone, so one batch is announced once and not daily', async () => {
    listActiveProductsMock.mockResolvedValue([product({ reorderLevel: 0 })]);
    listBatchesHoldingStockMock.mockResolvedValue([batch({ quantity: 5, expiryDate: DAY_90 })]);

    await scanStockAlerts(PHARMACY, TODAY);

    const alert = raisedAlerts()[0];
    expect(alert?.dedupeKey).toBe(`stock_expiry:${BATCH}`);
    // The contrast with the reorder key, and the reason it is worth asserting
    // negatively: a batch's expiry date never changes, so re-raising daily would
    // repeat the same sentence until the stock is gone and bury everything else.
    expect(alert?.dedupeKey).not.toContain(TODAY);
  });

  it('marks every alert not_sent and says why beside it', async () => {
    listActiveProductsMock.mockResolvedValue([product({ reorderLevel: 20 })]);
    listBatchesHoldingStockMock.mockResolvedValue([batch({ quantity: 5, expiryDate: DAY_90 })]);

    await scanStockAlerts(PHARMACY, TODAY);

    // Nothing is delivered anywhere: there is no SMS provider and no email
    // transport. `not_sent` with the reason beside it is a true statement, where
    // `pending` would read as queued and `sent` would be a lie. Phase 8 owns
    // delivery and this string is what it replaces rather than discovers.
    for (const alert of raisedAlerts()) {
      expect(alert.status).toBe('not_sent');
      expect(alert.notSentReason).toBe(ALERT_NOT_SENT_REASON);
    }
    expect(raisedAlerts()).toHaveLength(2);
  });

  it('names the related row precisely, so the panel can link to the thing it is talking about', async () => {
    listActiveProductsMock.mockResolvedValue([product({ reorderLevel: 20 })]);
    listBatchesHoldingStockMock.mockResolvedValue([batch({ quantity: 5, expiryDate: DAY_90 })]);

    await scanStockAlerts(PHARMACY, TODAY);

    // Two different targets and mixing them up sends the pharmacist to a product
    // page when the problem is one lot of it.
    expect(raisedAlerts()[0]).toMatchObject({ relatedType: 'inventory', relatedId: PRODUCT });
    expect(raisedAlerts()[1]).toMatchObject({ relatedType: 'inventory_batch', relatedId: BATCH });
  });
});

describe('scanStockAlerts', () => {
  it('runs every write on one transaction client, so the counts describe what landed', async () => {
    listActiveProductsMock.mockResolvedValue([product({ reorderLevel: 20 })]);
    listBatchesHoldingStockMock.mockResolvedValue([batch({ quantity: 5, expiryDate: DAY_90 })]);

    await scanStockAlerts(PHARMACY, TODAY);

    expect(withTransactionMock).toHaveBeenCalledTimes(1);
    // Each insert is independently idempotent, so the transaction is not what makes
    // the scan safe to repeat — it makes the returned counts true. A scan that
    // raised six alerts and then failed on the seventh would otherwise report six
    // raised and leave the caller believing the work was done.
    expect(raiseMock).toHaveBeenCalledTimes(2);
    for (const call of raiseMock.mock.calls) {
      expect((call as unknown[])[0]).toBe(CLIENT);
    }
    // And the reads went through the same client, not the pool behind its back.
    expect(listActiveProductsMock).toHaveBeenCalledWith(CLIENT, PHARMACY);
    expect(listBatchesHoldingStockMock).toHaveBeenCalledWith(CLIENT, PHARMACY);
  });

  it('counts what it raised separately from what was already raised', async () => {
    listActiveProductsMock.mockResolvedValue([product({ reorderLevel: 20 })]);
    listBatchesHoldingStockMock.mockResolvedValue([
      batch({ quantity: 5, expiryDate: DAY_90 }),
      batch({ id: 'a0000000-0000-4000-8000-0000000000a2', quantity: 3, expiryDate: DAY_90 }),
    ]);
    // The reorder alert is new; both expiry alerts were raised on an earlier scan.
    raiseMock
      .mockResolvedValueOnce({ raised: true, notification: null })
      .mockResolvedValueOnce({ raised: false, notification: null })
      .mockResolvedValueOnce({ raised: false, notification: null });

    const summary = await scanStockAlerts(PHARMACY, TODAY);

    expect(summary.reorder).toEqual({ raised: 1, alreadyRaised: 0 });
    expect(summary.expiry).toEqual({ raised: 0, alreadyRaised: 2 });
  });

  it('reports the day and the window it reasoned about, so the summary can be checked against them', async () => {
    listActiveProductsMock.mockResolvedValue([product(), product({ id: OTHER_PRODUCT })]);
    listBatchesHoldingStockMock.mockResolvedValue([batch()]);

    const summary = await scanStockAlerts(PHARMACY, TODAY, 45);

    expect(summary.today).toBe(TODAY);
    expect(summary.windowDays).toBe(45);
    expect(summary.productsScanned).toBe(2);
    expect(summary.batchesScanned).toBe(1);
  });

  it('raises nothing at all when the shelves are healthy', async () => {
    listActiveProductsMock.mockResolvedValue([product({ reorderLevel: 20 })]);
    listBatchesHoldingStockMock.mockResolvedValue([batch({ quantity: 100, expiryDate: DAY_91 })]);

    const summary = await scanStockAlerts(PHARMACY, TODAY);

    expect(raiseMock).not.toHaveBeenCalled();
    expect(summary.reorder).toEqual({ raised: 0, alreadyRaised: 0 });
    expect(summary.expiry).toEqual({ raised: 0, alreadyRaised: 0 });
  });

  it('alerts an already-expired batch, and never an undated one', async () => {
    listActiveProductsMock.mockResolvedValue([product({ reorderLevel: 0 })]);
    listBatchesHoldingStockMock.mockResolvedValue([
      batch({ id: 'a0000000-0000-4000-8000-0000000000a1', lotNumber: 'LOT-OLD', quantity: 4, expiryDate: YESTERDAY }),
      batch({ id: 'a0000000-0000-4000-8000-0000000000a2', lotNumber: 'LOT-NODATE', quantity: 4, expiryDate: null }),
    ]);

    await scanStockAlerts(PHARMACY, TODAY);

    const alerts = raisedAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.relatedId).toBe('a0000000-0000-4000-8000-0000000000a1');
    // Already-expired is included on purpose: an alert that stops firing the day
    // after the date passes hides exactly the stock that most needs pulling off the
    // shelf. Undated is excluded because it is never expiring — that stock is
    // sellable, so there is nothing to pull.
    expect(alerts[0]?.title).toContain('expired 1 day ago');
  });

  it('honours the window boundary, at exactly 90 days and one day past', async () => {
    listActiveProductsMock.mockResolvedValue([product({ reorderLevel: 0 })]);
    listBatchesHoldingStockMock.mockResolvedValue([
      batch({ id: 'a0000000-0000-4000-8000-0000000000a1', quantity: 4, expiryDate: DAY_90 }),
      batch({ id: 'a0000000-0000-4000-8000-0000000000a2', quantity: 4, expiryDate: DAY_91 }),
    ]);

    await scanStockAlerts(PHARMACY, TODAY);

    // Inclusive at the edge: "within 90 days" includes the ninetieth.
    expect(raisedAlerts().map((alert) => alert.relatedId)).toEqual([
      'a0000000-0000-4000-8000-0000000000a1',
    ]);
  });

  it('narrows the window when asked to', async () => {
    listActiveProductsMock.mockResolvedValue([product({ reorderLevel: 0 })]);
    listBatchesHoldingStockMock.mockResolvedValue([batch({ quantity: 4, expiryDate: DAY_90 })]);

    await scanStockAlerts(PHARMACY, TODAY, 30);

    expect(raiseMock).not.toHaveBeenCalled();
  });

  it('alerts only the batches belonging to the product it is scanning', async () => {
    listActiveProductsMock.mockResolvedValue([
      product({ id: PRODUCT, name: 'Paracetamol 500mg', reorderLevel: 0 }),
      product({ id: OTHER_PRODUCT, name: 'Amoxicillin 250mg', reorderLevel: 0 }),
    ]);
    listBatchesHoldingStockMock.mockResolvedValue([
      batch({ id: 'a0000000-0000-4000-8000-0000000000a1', inventoryId: PRODUCT, quantity: 4, expiryDate: DAY_90 }),
      batch({ id: 'a0000000-0000-4000-8000-0000000000a2', inventoryId: OTHER_PRODUCT, quantity: 4, expiryDate: DAY_90 }),
    ]);

    await scanStockAlerts(PHARMACY, TODAY);

    // The scan reads every batch holding stock in one statement and groups by
    // product in TypeScript. A grouping that leaked would announce one product's lot
    // under another's name, which is worse than no alert: it sends somebody to the
    // wrong shelf during a recall.
    const alerts = raisedAlerts();
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.title).toContain('Paracetamol 500mg');
    expect(alerts[0]?.relatedId).toBe('a0000000-0000-4000-8000-0000000000a1');
    expect(alerts[1]?.title).toContain('Amoxicillin 250mg');
    expect(alerts[1]?.relatedId).toBe('a0000000-0000-4000-8000-0000000000a2');
  });

  it('says how much stock is left in the reorder alert, singular and plural', async () => {
    listActiveProductsMock.mockResolvedValue([product({ reorderLevel: 20 })]);
    listBatchesHoldingStockMock.mockResolvedValue([batch({ quantity: 1 })]);

    await scanStockAlerts(PHARMACY, TODAY);

    // The body is the part somebody reads on a phone at the counter. "1 units left"
    // is a small thing and it is the kind of small thing that makes a panel look
    // untrustworthy.
    expect(raisedAlerts()[0]?.body).toBe('1 sellable unit left against a reorder level of 20.');

    raiseMock.mockClear();
    listBatchesHoldingStockMock.mockResolvedValue([batch({ quantity: 4 })]);
    await scanStockAlerts(PHARMACY, TODAY);
    expect(raisedAlerts()[0]?.body).toBe('4 sellable units left against a reorder level of 20.');
  });
});

describe('listStockAlerts', () => {
  it('asks for exactly the two stock alert types', async () => {
    await listStockAlerts(PHARMACY, { limit: 25, offset: 0 });

    expect(listNotificationsMock).toHaveBeenCalledWith(poolSql, PHARMACY, {
      types: ['stock_reorder', 'stock_expiry'],
      limit: 25,
      offset: 0,
    });
  });

  it('reads through the pool, not a transaction', async () => {
    await listStockAlerts(PHARMACY, { limit: 25, offset: 0 });

    // A read that opened a transaction would hold a connection for no reason, and
    // on a panel that refreshes often that is a pool exhausted by people looking at
    // alerts rather than by anything that needed one.
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect((listNotificationsMock.mock.calls[0] as unknown[])[0]).toBe(poolSql);
  });

  it('names only types the schema actually has', () => {
    // The panel's filter is a hardcoded list, and the enum lives in SQL. Renaming
    // `stock_reorder` there would leave this asking for a type that does not exist,
    // which Postgres refuses at execution — so the panel would empty out rather than
    // show a partial list. `schema-enums.test.ts` ties the mirror to the schema;
    // this ties the panel to the mirror.
    const known: readonly string[] = NOTIFICATION_TYPES;
    for (const type of STOCK_ALERT_TYPES) {
      expect({ type, known: known.includes(type) }).toEqual({ type, known: true });
    }
  });
});
