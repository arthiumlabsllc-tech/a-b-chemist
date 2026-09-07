/**
 * The shapes this app and the API agree on.
 *
 * ## Why this file exists at all
 *
 * The backend emits declarations for nothing: `tsconfig.build.json` has
 * `declaration` off because it builds an application, not a library, and
 * `backend/package.json` has no `types` field. So the frontend cannot
 * `import type` a response shape from it, and every payload type here is a copy.
 *
 * A copy of a contract is a contract that can drift, and the drift is invisible
 * in exactly the place it matters. Rename `TillProduct.available` to
 * `availableUnits` in the service and the backend still compiles, still passes
 * its 853 tests, and still answers correctly; the till receives `undefined`,
 * renders an empty in-stock badge, and lets a cashier ring a sale the write path
 * then refuses. Nothing fails at build time on either side.
 *
 * So the copy is guarded rather than commented. `__tests__/api-types.mirror.test.ts`
 * reads the backend's source files, parses the interface this one claims to
 * mirror, and fails when a member is added, removed, renamed or retyped. That is
 * the same trick `backend/src/utils/schema-enums.test.ts` plays against the
 * `CREATE TYPE` statements in `database/init.sql`, and for the same reason: two
 * lists that must agree are a list and a check, not two lists and a hope.
 *
 * ## What is mirrored and what is not
 *
 * **Responses are mirrored.** The server decides their shape and this app has no
 * vote, so a `@mirrors` tag names the file and interface each one was copied
 * from and the guard holds the two together.
 *
 * **Requests are not.** `SaleLineInput` and friends type every field as
 * `unknown` on purpose — the service coerces and validates, because Phase 9's
 * offline queue replays baskets no validator ever saw. Mirroring `unknown`
 * would give the till a type that accepts anything, which is worse than no type.
 * The outgoing shapes below are this app's own, written as precisely as it can
 * send them, and the server remains free to refuse them.
 *
 * **Enums are not mirrored either, when they live in `a-and-b-chemist-shared`.**
 * `SellUnit` and `VatTreatment` are imported from there, because that package
 * exists so the till and the engine cannot disagree about them. Only the values
 * that live in the backend alone — payment methods, and the sale limits — are
 * copied here, and the guard compares those as values.
 */

import { MAX_LINE_QUANTITY } from 'a-and-b-chemist-shared';
import type { SellUnit, VatTreatment } from 'a-and-b-chemist-shared';

import type { UserRole } from './auth-session';

export type { SellUnit, VatTreatment };

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/** @mirrors backend/src/services/sales.service.ts TillProduct */
export interface TillProduct {
  id: string;
  name: string;
  code: string;
  genericName: string | null;
  category: string | null;
  manufacturer: string | null;
  shelfLocation: string | null;
  barcode: string | null;
  packSize: number;
  defaultSellUnit: SellUnit;
  /**
   * Decimal string, **per base unit** — one tablet, one sachet, one millilitre.
   * Never the price of a pack, and never a number: `pg` hands back `numeric` as
   * a string and the API does not override that. Convert with
   * `pesewasFromDecimalString` and then with `sellingUnitPricePesewas`, both from
   * the shared package, which is where the pack rule lives.
   */
  baseUnitPrice: string;
  vatTreatment: VatTreatment;
  requiresPrescription: boolean;
  /** Physical count, expired stock included. Not what may be sold. */
  quantity: number;
  batchNumber: string | null;
  expiryDate: string | null;
  /**
   * Selling units at `defaultSellUnit` that may actually be handed over: expired
   * lots excluded, floored to whole packs. This is the figure the grid shows and
   * the in-stock filter uses — `quantity` is the one that misleads.
   */
  available: number;
}

/** `GET /sales/products`. */
export interface TillProductsResponse {
  products: TillProduct[];
  limit: number;
  offset: number;
}

/** `GET /sales/categories`. */
export interface TillCategoriesResponse {
  categories: string[];
}

// ---------------------------------------------------------------------------
// Counterparty and gateway
// ---------------------------------------------------------------------------

/** @mirrors backend/src/services/sales.service.ts Approver */
export interface Approver {
  id: string;
  fullName: string;
  role: UserRole;
}

/** `GET /sales/approvers`. */
export interface ApproversResponse {
  approvers: Approver[];
}

/** @mirrors backend/src/services/sales.service.ts PaymentConfig */
export interface PaymentConfig {
  publicKey: string;
  configured: boolean;
  /** `live`, `test` or `unconfigured`. Stated rather than implied. */
  mode: GatewayMode;
  methods: SalePaymentMethod[];
  currency: 'GHS';
}

/** `GET /sales/payment-config`. */
export interface PaymentConfigResponse {
  paymentConfig: PaymentConfig;
}

/**
 * Copied from `backend/src/config/index.ts` rather than derived, because the
 * mode decides whether the payment modal warns that a charge is real.
 */
export type GatewayMode = 'live' | 'test' | 'unconfigured';

/**
 * The two tenders this pharmacy takes.
 *
 * Mirrored from `backend/src/utils/schema-enums.ts`, which is itself pinned to
 * the `CREATE TYPE sale_payment_method` in `database/init.sql` by
 * `schema-enums.test.ts`. Card, bank transfer and credit were removed from the
 * enum by direction, so they are absent here too and the payment modal cannot
 * offer a tender the database would refuse — which is the failure mode that
 * matters, because a rejected tender is discovered after the customer has been
 * asked to pay.
 */
export const SALE_PAYMENT_METHODS = ['cash', 'momo'] as const;
export type SalePaymentMethod = (typeof SALE_PAYMENT_METHODS)[number];

/**
 * The bounds the API enforces on a basket, copied so the till can refuse a
 * basket it knows will be refused.
 *
 * Worth having locally rather than discovering by round trip for two reasons.
 * A discount with a two-character reason is refused by
 * `discountReason.min`, and telling the operator that *before* they press pay
 * is the difference between a correction and an abandoned sale. And Phase 9's
 * queue validates before it stores, because a basket it accepted and cannot
 * send is a basket that silently never rings.
 */
export const SALE_LIMITS = {
  lines: { min: 1, max: 100 },
  // Not `1000000` written out again. The bound is a property of the engine's
  // integer arithmetic, so the engine's own constant is imported and the two
  // cannot disagree — a copied literal here would be a second copy of a figure
  // whose derivation lives in a comment in `shared/src/basket.ts`.
  quantity: { min: 1, max: MAX_LINE_QUANTITY },
  clientSaleId: { min: 8, max: 128 },
  voidReason: { min: 3, max: 500 },
  note: { min: 1, max: 200 },
  discountReason: { min: 3, max: 200 },
} as const;

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

/** @mirrors backend/src/services/tax-settings.service.ts RateView */
export interface RateView {
  /** Whole ten-thousandths. What the engine prices with. */
  rate: number;
  /** `'15%'`. What a receipt names it as, which GRA requires it to do. */
  label: string;
  /** `'0.1500'`. What a form field shows and what the column stores. */
  decimal: string;
}

/** @mirrors backend/src/services/tax-settings.service.ts TaxSettingsView */
export interface TaxSettingsView {
  taxInclusivePricing: boolean;
  vat: RateView;
  nhil: RateView;
  getfund: RateView;
  /** The three added: what a customer experiences and an owner means by "what do we charge". */
  combinedRate: number;
  /** Null when the sum passes 100%, which `rateLabel` refuses to print. */
  combinedLabel: string | null;
  /**
   * Whether the stored rates are Act 1151's. Reported rather than assumed: GRA's
   * registration threshold rose to GHS 750,000, which puts a small community
   * pharmacy on either side of the line, so the API says whether they match and
   * leaves the meaning to the owner.
   */
  matchesAct1151: boolean;
  /** GRA's own figures and where they came from, so the settings page can offer them. */
  act1151: {
    instrument: string;
    inForceFrom: string;
    source: string;
    retrieved: string;
    vatRate: number;
    nhilRate: number;
    getfundRate: number;
  };
  updatedAt: string;
}

/** `GET /tax/settings`. */
export interface TaxSettingsResponse {
  taxSettings: TaxSettingsView;
}

/**
 * `PUT /tax/settings`.
 *
 * This app's own shape, not a mirror — the backend's `TaxSettingsInput` is
 * identical today but it is the server's to change, and the form posts rates as
 * the field holds them, which is a string.
 */
export interface TaxSettingsBody {
  taxInclusivePricing: boolean;
  vatRate: string | number;
  nhilRate: string | number;
  getfundRate: string | number;
}

// ---------------------------------------------------------------------------
// Pricing and the sale write path
// ---------------------------------------------------------------------------

/** @mirrors backend/src/services/sales.service.ts BasketView */
export interface BasketView {
  subtotal: string;
  discount: string;
  discountReason: string | null;
  vatAmount: string;
  nhilAmount: string;
  getfundAmount: string;
  taxTotal: string;
  taxableBase: string;
  total: string;
  /** The four figures snapshotted onto the sale beside the money. */
  vatRate: string;
  nhilRate: string;
  getfundRate: string;
  taxInclusivePricing: boolean;
  /** `15%`, `2.5%`, `2.5%`. GRA requires the receipt to name what it charged. */
  vatLabel: string;
  nhilLabel: string;
  getfundLabel: string;
}

/** @mirrors backend/src/services/sales.service.ts QuoteLine */
export interface QuoteLine {
  productId: string;
  name: string;
  code: string;
  sellUnit: SellUnit;
  /** Selling units, as the receipt will read. */
  quantity: number;
  /** Base units, as the drawer will lose. */
  baseUnits: number;
  unitPrice: string;
  lineGross: string;
  lineDiscount: string;
  taxableBase: string;
  vatAmount: string;
  nhilAmount: string;
  getfundAmount: string;
  lineTotal: string;
  vatTreatment: string;
  requiresPrescription: boolean;
  /** Selling units available. What the till shows beside the quantity stepper. */
  available: number;
  shortfall: number;
}

/** @mirrors backend/src/services/sales.service.ts QuoteResult */
export interface QuoteResult {
  lines: QuoteLine[];
  basket: BasketView;
  /** False when any line's shortfall is above zero. */
  canFulfil: boolean;
}

/**
 * One line of a basket this app sends.
 *
 * No price. `POST /sales` takes `productId`, `quantity` and an optional
 * `sellUnit` and derives the money itself from `inventory.unit_price`, so a
 * client that sent a price would be a client the server had to either trust or
 * ignore. Which means the local pricer in `pricing.ts` is a *preview*: fast, on
 * the device, and authoritative for nothing. `POST /sales/quote` is the
 * confirmation, and it exists precisely so the operator can see the server's
 * figure before asking the customer for money.
 */
export interface CreateSaleLine {
  productId: string;
  quantity: number;
  /** Omitted means the product's own `defaultSellUnit`. */
  sellUnit?: SellUnit;
}

/** One tender this app sends. `reference` is the operator's note on a cash line. */
export interface CreateSalePayment {
  method: SalePaymentMethod;
  /** Decimal string in cedis, as the money columns store it. */
  amount: string;
  reference?: string;
}

/**
 * `POST /sales`.
 *
 * `payments` may be empty: a customer who cannot pay yet leaves the sale
 * pending rather than unsold. `clientSaleId` is minted by the till before the
 * request is made, not after a failure, because its whole job is to make a lost
 * response replayable — a UUID generated at retry time would be a second sale.
 */
export interface CreateSaleBody {
  lines: CreateSaleLine[];
  discount?: string;
  discountReason?: string | null;
  payments?: CreateSalePayment[];
  patientId?: string;
  approvedBy?: string;
  clientSaleId?: string;
}

/** `POST /sales/quote`, which takes the basket and nothing else. */
export type QuoteBody = Pick<CreateSaleBody, 'lines' | 'discount' | 'discountReason'>;

// ---------------------------------------------------------------------------
// Sale statuses
// ---------------------------------------------------------------------------

/**
 * `sale_status`, copied from `backend/src/utils/schema-enums.ts`.
 *
 * Not `@mirrors`-tagged, because the guard compares interfaces member for
 * member and this is a value list; it is copied exactly and the till only ever
 * reads it to label a sale and to fill the history filter. `partially_refunded`
 * and `refunded` are states this build can reach through the void path and a
 * later refund, so they are named rather than collapsed into `voided`.
 */
export const SALE_STATUSES = [
  'pending',
  'completed',
  'voided',
  'refunded',
  'partially_refunded',
] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

/**
 * `sale_payment_status`, copied from `backend/src/utils/schema-enums.ts`.
 *
 * `pending` is a mobile-money tender the gateway has been asked about and has
 * not answered; `reversed` is money that moved and then moved back, which is not
 * `failed` and must not render as it. Cash is written `succeeded` in the same
 * transaction as the sale, so a cash tender is never `pending`.
 */
export const SALE_PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'reversed'] as const;
export type SalePaymentStatus = (typeof SALE_PAYMENT_STATUSES)[number];

// ---------------------------------------------------------------------------
// A stored sale
// ---------------------------------------------------------------------------

/**
 * The sale row. Every money field is a decimal string, because `pg` returns
 * `numeric` as a string and the API does not convert it — the till formats it
 * with `lib/format.ts` and never with `Number`, which would put a float between
 * the drawer and the receipt.
 *
 * @mirrors backend/src/repositories/sales.repository.ts SaleRow
 */
export interface SaleRow {
  id: string;
  pharmacyId: string;
  saleNumber: string;
  status: SaleStatus;
  servedBy: string;
  approvedBy: string | null;
  patientId: string | null;
  subtotal: string;
  discount: string;
  discountReason: string | null;
  vatAmount: string;
  nhilAmount: string;
  getfundAmount: string;
  taxTotal: string;
  total: string;
  amountPaid: string;
  changeGiven: string;
  vatRate: string;
  nhilRate: string;
  getfundRate: string;
  taxInclusivePricing: boolean;
  clientSaleId: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One receipt line. `description` is the name snapshotted at the moment of sale,
 * so renaming a product later cannot rewrite an old receipt.
 *
 * @mirrors backend/src/repositories/sales.repository.ts SaleItemRow
 */
export interface SaleItemRow {
  id: string;
  saleId: string;
  inventoryId: string;
  description: string;
  sellUnit: SellUnit;
  quantity: number;
  unitPrice: string;
  lineGross: string;
  lineDiscount: string;
  taxableBase: string;
  vatAmount: string;
  nhilAmount: string;
  getfundAmount: string;
  lineTotal: string;
  vatTreatment: VatTreatment;
  createdAt: string;
}

/**
 * One lot a line drew from, with the batch's cost snapshotted. The cost is what
 * makes profitability answerable later and is why it is never read back from the
 * product row.
 *
 * @mirrors backend/src/repositories/sales.repository.ts SaleItemBatchRow
 */
export interface SaleItemBatchRow {
  id: string;
  saleItemId: string;
  batchId: string;
  lotNumber: string;
  quantity: number;
  unitCost: string;
}

/**
 * One tender on a sale. `gatewayResponse` is the gateway's own payload verbatim
 * and is typed `unknown` because its shape belongs to Paystack, not to us.
 *
 * @mirrors backend/src/repositories/sales.repository.ts SalePaymentRow
 */
export interface SalePaymentRow {
  id: string;
  saleId: string;
  method: SalePaymentMethod;
  status: SalePaymentStatus;
  amount: string;
  reference: string | null;
  gatewayResponse: unknown;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One row of the `/sales` history list: enough to render the list and say "3
 * items" without fetching the lines.
 *
 * @mirrors backend/src/repositories/sales.repository.ts SaleListItem
 */
export interface SaleListItem {
  id: string;
  saleNumber: string;
  status: SaleStatus;
  createdAt: string;
  servedByName: string;
  patientName: string | null;
  total: string;
  amountPaid: string;
  changeGiven: string;
  itemCount: number;
  paymentMethods: SalePaymentMethod[];
}

/**
 * A stored sale and everything hanging off it — the lines, the lots each line
 * drew, the tenders and the two names. One response so a receipt and a refund
 * conversation need one round trip at the counter.
 *
 * @mirrors backend/src/services/sales.service.ts SaleDetail
 */
export interface SaleDetail {
  sale: SaleRow;
  items: SaleItemRow[];
  batches: Array<SaleItemBatchRow & { inventoryId: string }>;
  payments: SalePaymentRow[];
  servedByName: string | null;
  approvedByName: string | null;
}

/**
 * The answer to `POST /sales`. `replayed` is true when this `clientSaleId` had
 * already been recorded and the stored sale is being handed back — not an error,
 * but the till's answer to "did that sale go through" after it lost a response.
 *
 * @mirrors backend/src/services/sales.service.ts CreateSaleResult
 */
export interface CreateSaleResult {
  detail: SaleDetail;
  replayed: boolean;
}

/**
 * `GET /sales`. A `type` alias rather than an `interface` because it is an
 * envelope assembled inline in the route, so there is no backend interface to
 * mirror — and the exhaustiveness guard in `api-types.mirror.test.ts` checks
 * interfaces, not aliases, by design.
 */
export type SalesListResponse = {
  sales: SaleListItem[];
  limit: number;
  offset: number;
  statuses: SaleStatus[];
};

/**
 * `POST /sales/payments/:paymentId/verify` — the answer to asking the gateway
 * about a mobile-money tender that already exists.
 *
 * `unsettled` is the case the till must name rather than guess: the gateway would
 * not say either way, so the tender stayed pending and `detail` is null because
 * nothing was written. `arrivedAfterVoid` is money that turned up on a sale
 * already voided, which is a reconciliation conversation and not a success.
 *
 * @mirrors backend/src/services/paystack.service.ts ConfirmChargeResult
 */
export interface ConfirmChargeResult {
  detail: SaleDetail | null;
  changed: boolean;
  arrivedAfterVoid: boolean;
  unsettled: boolean;
}

/**
 * `POST /sales/:id/void`. This app's own shape; the server re-validates the reason
 * against `SALE_LIMITS.voidReason`, because a void with no readable reason is an
 * audit trail with a hole in it.
 */
export type VoidSaleBody = {
  reason: string;
};

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

/**
 * One staff member, as `/staff` receives it.
 *
 * `passwordHash` and `sessionVersion` are absent by construction on the backend
 * — they are not in the mirrored interface, so a future edit cannot start
 * sending them without failing `api-types.mirror.test.ts`. `role` is the same
 * `UserRole` union `auth-session.ts` copies, so the staff page and the session
 * cannot disagree about what a role is called.
 *
 * @mirrors backend/src/routes/staff.routes.ts StaffSummary
 */
export interface StaffSummary {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: string | null;
}

/**
 * The staff envelopes and request bodies, as `type` aliases rather than
 * interfaces, for the reason `SalesListResponse` gives: each is assembled inline
 * in the route, so there is no backend interface to mirror, and the
 * exhaustiveness guard in `api-types.mirror.test.ts` checks interfaces, not
 * aliases, by design.
 */

/** `GET /staff`. */
export type StaffListResponse = {
  staff: StaffSummary[];
};

/** `POST /staff`, answered 201. The initial password is never echoed back. */
export type StaffCreatedResponse = {
  staff: StaffSummary;
};

/**
 * `PATCH /staff/:id`. `sessionsEnded` is true when the edit changed the role or
 * whether the account is active, either of which signs that person out everywhere
 * — the owner needs to know they just did that, including to themselves.
 */
export type StaffUpdatedResponse = {
  staff: StaffSummary;
  sessionsEnded: boolean;
};

/** `POST /staff/:id/reset-password`. */
export type PasswordResetResponse = {
  staffId: string;
  passwordReset: boolean;
  sessionsEnded: boolean;
};

/** `POST /staff`. This app's own shape; the server coerces and re-validates. */
export type CreateStaffBody = {
  fullName: string;
  email: string;
  phone?: string | null;
  role: UserRole;
  initialPassword: string;
};

/** `PATCH /staff/:id`. At least one field must be present or the API refuses. */
export type UpdateStaffBody = {
  fullName?: string;
  phone?: string | null;
  role?: UserRole;
  isActive?: boolean;
};

/** `POST /staff/:id/reset-password`. */
export type ResetPasswordBody = {
  newPassword: string;
};

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/**
 * The bounds the API enforces on a product, a receive, an adjustment and a
 * write-off, copied from `backend/src/services/inventory.service.ts` so the
 * inventory forms can refuse a value they know will be refused — and say why in
 * the operator's words rather than the validator's.
 *
 * Copied rather than imported for the reason `SALE_LIMITS` gives: the backend
 * emits no declarations. `__tests__/api-types.mirror.test.ts` reads the service's
 * `PRODUCT_LIMITS` and fails when a bound here drifts from one there, so this is
 * a list and a check, not two lists and a hope.
 */
export const PRODUCT_LIMITS = {
  name: { min: 1, max: 200 },
  code: { min: 1, max: 64 },
  genericName: { min: 0, max: 200 },
  category: { min: 0, max: 100 },
  manufacturer: { min: 0, max: 200 },
  shelfLocation: { min: 0, max: 100 },
  barcode: { min: 0, max: 64 },
  packSize: { min: 1, max: 100_000 },
  reorderLevel: { min: 0, max: 1_000_000 },
  quantity: { min: 1, max: 1_000_000 },
  lotNumber: { min: 1, max: 100 },
  /** A reason shorter than this is a shrug, and a shrug is not an audit trail. */
  reason: { min: 3, max: 200 },
  note: { min: 0, max: 500 },
} as const;

/**
 * `stock_movement_type`, copied from `backend/src/utils/schema-enums.ts`.
 *
 * Not `@mirrors`-tagged — the guard compares interfaces member for member and this
 * is a value list, copied exactly and read only to label a ledger row. The
 * `MOVEMENT_WORD` map beside the inventory components is a
 * `Record<MovementType, string>`, so a value added here without a label is a
 * compile error rather than a blank cell.
 */
export const MOVEMENT_TYPES = [
  'opening',
  'receive',
  'adjust',
  'write_off',
  'sale',
  'void_restore',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/**
 * The stock a batch holds, without the row's own bookkeeping columns.
 *
 * Mirrored from `utils/fefo.ts` rather than the repository, because that is where
 * the shape is declared and `BatchRow` extends it. The guard does not follow
 * `extends`, so the two are mirrored as the two interfaces they are: this one
 * carries the six fields FEFO allocates over, and `BatchRow` below adds the four
 * the repository stamps on.
 *
 * @mirrors backend/src/utils/fefo.ts BatchStock
 */
export interface BatchStock {
  id: string;
  lotNumber: string;
  /** `'YYYY-MM-DD'`, or null for undated stock. */
  expiryDate: string | null;
  /** ISO-8601. The FEFO tie-break between two lots with the same expiry. */
  receivedAt: string;
  quantity: number;
  costPrice: string;
}

/**
 * One lot on the shelf.
 *
 * @mirrors backend/src/repositories/inventory.repository.ts BatchRow
 */
export interface BatchRow extends BatchStock {
  pharmacyId: string;
  inventoryId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A product row, with the four batch-derived columns the triggers own.
 *
 * `unitPrice` is a decimal string **per base unit** — one tablet, one sachet —
 * exactly as `TillProduct.baseUnitPrice` is, and for the same reason: `pg` hands
 * back `numeric` as a string and the API does not convert it. `quantity`,
 * `batchNumber`, `expiryDate` and `costPrice` are derived from the batches and
 * cannot be written through the API; a form that sent one would have it discarded
 * and be told so in `discardedFields`.
 *
 * @mirrors backend/src/repositories/inventory.repository.ts ProductRow
 */
export interface ProductRow {
  id: string;
  pharmacyId: string;
  name: string;
  code: string;
  genericName: string | null;
  category: string | null;
  manufacturer: string | null;
  packSize: number;
  defaultSellUnit: SellUnit;
  shelfLocation: string | null;
  barcode: string | null;
  requiresPrescription: boolean;
  reorderLevel: number;
  unitPrice: string;
  vatTreatment: VatTreatment;
  isActive: boolean;
  /** Derived. Total base units on hand, expired stock included. */
  quantity: number;
  /** Derived. Lot at the front of the shelf, sellable or not. */
  batchNumber: string | null;
  /** Derived. Expiry of that lot. */
  expiryDate: string | null;
  /** Derived. Quantity-weighted average cost across batches holding stock. */
  costPrice: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One row of the movement ledger.
 *
 * `quantityChange` is signed — positive for stock arriving, negative for stock
 * leaving — and `quantityAfter` is the batch's count after it, so the ledger reads
 * as a running balance without the client adding anything up.
 *
 * @mirrors backend/src/repositories/inventory.repository.ts MovementRow
 */
export interface MovementRow {
  id: string;
  pharmacyId: string;
  inventoryId: string;
  batchId: string | null;
  saleId: string | null;
  movementType: MovementType;
  quantityChange: number;
  quantityAfter: number;
  reason: string | null;
  note: string | null;
  performedBy: string;
  performedByName: string | null;
  createdAt: string;
}

/**
 * A product and everything the detail page shows: its lots in FEFO order, the base
 * units sellable today, and the leading lot with its days-to-expiry.
 *
 * @mirrors backend/src/services/inventory.service.ts ProductDetail
 */
export interface ProductDetail {
  product: ProductRow;
  batches: BatchRow[];
  sellable: number;
  leading: BatchRow | null;
  /** Negative means already expired; null means the leading lot is undated. */
  leadingDaysToExpiry: number | null;
}

/**
 * What a receive, an adjustment or a write-off did: the product and batch as they
 * now stand, and the signed ledger entry it wrote.
 *
 * @mirrors backend/src/services/inventory.service.ts StockWriteResult
 */
export interface StockWriteResult {
  product: ProductRow;
  batch: BatchRow;
  movementType: MovementType;
  quantityChange: number;
  quantityAfter: number;
  /** True when a receive landed on an existing lot rather than creating one. */
  merged: boolean;
}

/**
 * One person a recalled lot reached, and how many of the recalled sales were
 * theirs.
 *
 * @mirrors backend/src/services/inventory.service.ts RecallContact
 */
export interface RecallContact {
  name: string;
  phone: string | null;
  sales: number;
}

/**
 * One sale that drew from a recalled lot, with the patient to contact if there was
 * one.
 *
 * @mirrors backend/src/repositories/inventory.repository.ts RecallSaleRow
 */
export interface RecallSaleRow {
  saleId: string;
  saleNumber: string;
  status: SaleStatus;
  soldAt: string;
  /** Base units this sale took from the recalled batch. */
  units: number;
  unitCost: string;
  description: string;
  sellUnit: SellUnit;
  servedBy: string;
  patientName: string | null;
  patientPhone: string | null;
}

/**
 * A recall trace: the lot, every sale that drew from it, the people to contact, and
 * how many sales were untraceable walk-ins.
 *
 * @mirrors backend/src/services/inventory.service.ts RecallResult
 */
export interface RecallResult {
  product: ProductRow;
  batch: BatchRow;
  sales: RecallSaleRow[];
  contacts: RecallContact[];
  untraceableSales: number;
}

/**
 * The inventory envelopes and request bodies, as `type` aliases for the reason
 * `SalesListResponse` gives: each envelope is assembled inline in the route, and
 * each body is this app's own shape that the service coerces and re-validates.
 */

/** `GET /inventory`. */
export type ProductListResponse = {
  products: ProductRow[];
  limit: number;
  offset: number;
};

/** `GET /inventory/:id/movements`. */
export type MovementsResponse = {
  movements: MovementRow[];
};

/** `GET /inventory/:id/batches` — the batch panel's slice of `ProductDetail`. */
export type BatchesResponse = {
  batches: BatchRow[];
  sellable: number;
  leading: BatchRow | null;
  leadingDaysToExpiry: number | null;
};

/** `POST /inventory` (201) and `PATCH /inventory/:id`. */
export type ProductWriteResponse = {
  product: ProductRow;
  /** Derived fields the caller sent and the API threw away. */
  discardedFields: string[];
  derivedFields: readonly string[];
};

/** `POST /inventory` and `PATCH /inventory/:id`. Presence rules differ by route. */
export type ProductBody = {
  name?: string;
  code?: string;
  genericName?: string | null;
  category?: string | null;
  manufacturer?: string | null;
  shelfLocation?: string | null;
  barcode?: string | null;
  packSize?: number;
  defaultSellUnit?: SellUnit;
  requiresPrescription?: boolean;
  reorderLevel?: number;
  /** Decimal string per base unit, as the money columns store it. */
  unitPrice?: string;
  vatTreatment?: VatTreatment;
  isActive?: boolean;
};

/** `POST /inventory/:id/batches`. */
export type ReceiveStockBody = {
  lotNumber: string;
  quantity: number;
  costPrice: string;
  expiryDate: string | null;
  receivedAt?: string;
  reason?: string | null;
  note?: string | null;
};

/** `POST /inventory/:id/batches/:batchId/adjust`. `quantity` is the counted total. */
export type AdjustBatchBody = {
  quantity: number;
  reason: string;
  note: string;
};

/** `POST /inventory/:id/batches/:batchId/write-off`. Omit `quantity` for the whole batch. */
export type WriteOffBody = {
  quantity?: number;
  reason: string;
  note: string;
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * What one report may cover, copied so the date picker can refuse a range the API
 * will refuse.
 *
 * `rangeDays` is the inclusive calendar-day count, so a single day is 1. The
 * ceiling is not a business rule; it is what keeps the response bounded, because
 * `daily` is one row per day in the window. A picker that offered four years would
 * offer a range that arrives back as a 400 after the operator has waited for eight
 * aggregates to be refused — and the refusal would read as the app being broken
 * rather than as the range being too wide.
 */
export const REPORT_LIMITS = {
  rangeDays: { min: 1, max: 366 },
} as const;

/**
 * The window a report answers for, as the API resolved it — both ends filled in.
 *
 * The page shows this rather than the two dates it sent, because the API defaults
 * an omitted end to today and a page that displayed its own empty input would say
 * nothing about which day it was actually reading.
 *
 * @mirrors backend/src/repositories/reports.repository.ts ReportWindow
 */
export interface ReportWindow {
  /** `'YYYY-MM-DD'`, inclusive. */
  from: string;
  /** `'YYYY-MM-DD'`, inclusive. */
  to: string;
}

/**
 * One calendar day of completed sales.
 *
 * `day` is the wire string, not a `Date`: `database/pg-types.ts` stops the driver
 * turning a `date` into a `Date` at local midnight, which is the conversion that
 * would move a day for anybody whose browser is not on UTC.
 *
 * @mirrors backend/src/repositories/reports.repository.ts DailyRow
 */
export interface DailyRow {
  day: string;
  saleCount: number;
  revenue: string;
  discount: string;
  taxTotal: string;
  costOfGoods: string;
  /** Negative when the day sold below cost. The page shows the sign. */
  grossProfit: string;
}

/**
 * One product's contribution over the window.
 *
 * `baseUnits` counts base units drawn from the lots, not selling units: a product
 * sold both by the strip and by the tablet appears as both, and summing selling
 * units across those lines would add strips to tablets.
 *
 * @mirrors backend/src/repositories/reports.repository.ts ProductProfitRow
 */
export interface ProductProfitRow {
  productId: string;
  /** The name the shelf carries now, not the receipt's snapshot. */
  name: string;
  lineCount: number;
  baseUnits: number;
  revenue: string;
  costOfGoods: string;
  grossProfit: string;
  /** One decimal place, or null when there was no revenue to take a margin of. */
  grossMarginPercent: string | null;
  /** Lines whose lots carry no cost price, whose profit is therefore overstated. */
  zeroCostLines: number;
}

/**
 * One member of staff who served at least one sale in the window — not the whole
 * roster with zeros beside most of it.
 *
 * @mirrors backend/src/repositories/reports.repository.ts StaffRow
 */
export interface StaffRow {
  userId: string;
  fullName: string;
  role: UserRole;
  saleCount: number;
  revenue: string;
  discount: string;
  pendingCount: number;
  voidedCount: number;
}

/**
 * One tender method, split by whether the money has arrived.
 *
 * `unsettled` is "not succeeded" and not "pending": a `failed` or `reversed`
 * charge is neither arrived nor awaited, and a split that named only `pending`
 * would put both in the settled column.
 *
 * @mirrors backend/src/repositories/reports.repository.ts TenderRow
 */
export interface TenderRow {
  method: SalePaymentMethod;
  settledCount: number;
  settledAmount: string;
  unsettledCount: number;
  unsettledAmount: string;
}

/**
 * What the cash drawer should hold at the end of the window.
 *
 * All three figures rather than the answer alone. A cash tender is stored at the
 * note handed over, so `cashTaken` is not the drawer: a GHS 50 note against a
 * GHS 45 basket is a tender of 50.00 and change of 5.00. Showing the two halves
 * beside the difference is what lets a count that is short by the change be
 * recognised as the change rather than investigated as a theft.
 *
 * @mirrors backend/src/repositories/reports.repository.ts DrawerRow
 */
export interface DrawerRow {
  cashTaken: string;
  changeGiven: string;
  cashRetained: string;
}

/**
 * One VAT treatment, for the return.
 *
 * Every figure is a stored amount, not a rate applied now, so a return for June
 * read in September still says what June charged — which is the only thing a
 * return to GRA can say.
 *
 * @mirrors backend/src/repositories/reports.repository.ts VatRow
 */
export interface VatRow {
  treatment: VatTreatment;
  lineCount: number;
  taxableBase: string;
  gross: string;
  discount: string;
  vatAmount: string;
  nhilAmount: string;
  getfundAmount: string;
  lineTotal: string;
}

/**
 * The headline figures, taken from the completed sales and from nothing else.
 *
 * `uncountedSaleCount` is the reason this is not just a total: a zero on the
 * headline is only trustworthy if the reader can see what is not in it, and five
 * mobile-money charges still settling is a pending count of five.
 *
 * @mirrors backend/src/services/reports.service.ts ReportSummary
 */
export interface ReportSummary {
  saleCount: number;
  revenue: string;
  subtotal: string;
  discount: string;
  vatAmount: string;
  nhilAmount: string;
  getfundAmount: string;
  taxTotal: string;
  /** Mean basket, or null when the window has no completed sale to average. */
  averageSale: string | null;
  patientSaleCount: number;
  uncountedSaleCount: number;
}

/**
 * One status's row in the breakdown.
 *
 * `counted` is false for everything but `completed`, so the page can show all five
 * statuses and still say which of them are in the headline. All five arrive
 * whether or not the window held any: a section that is empty because it was
 * dropped and one that is empty because nothing happened are the same JSON.
 *
 * @mirrors backend/src/services/reports.service.ts StatusBreakdownRow
 */
export interface StatusBreakdownRow {
  status: SaleStatus;
  saleCount: number;
  total: string;
  counted: boolean;
}

/**
 * The window's profit, at the sale-line grain, with the page of products beside it.
 *
 * `lineRevenue` is the same money as `summary.revenue`, from the grain the cost is
 * available at. Reported beside the profit rather than hidden inside it, because a
 * difference nobody can see the two halves of is a figure nobody can check.
 *
 * @mirrors backend/src/services/reports.service.ts ReportProfitability
 */
export interface ReportProfitability {
  lineCount: number;
  lineRevenue: string;
  costOfGoods: string;
  grossProfit: string;
  grossMarginPercent: string | null;
  zeroCostLines: number;
  products: ProductProfitRow[];
  limit: number;
  offset: number;
  hasMoreProducts: boolean;
}

/**
 * The whole report: eight sections over one window, in one response.
 *
 * One bundle rather than five endpoints, because they are one question asked over
 * one range. A page showing takings from Tuesday and a VAT return from Monday is
 * not obviously wrong; it is just wrong, and nothing else in the response would
 * give it away.
 *
 * @mirrors backend/src/services/reports.service.ts SalesReport
 */
export interface SalesReport {
  range: ReportWindow;
  /** When the bundle was assembled, so a cached copy can say how old it is. */
  generatedAt: string;
  summary: ReportSummary;
  byStatus: StatusBreakdownRow[];
  daily: DailyRow[];
  profitability: ReportProfitability;
  staff: StaffRow[];
  tenders: TenderRow[];
  drawer: DrawerRow;
  vat: VatRow[];
}

/**
 * `GET /reports/sales`.
 *
 * A `type` alias for the reason `SalesListResponse` gives: the envelope is
 * assembled inline in the route, so there is no backend interface to tag.
 */
export type SalesReportResponse = {
  report: SalesReport;
  limit: number;
  offset: number;
  /** Echoed so the picker's ceiling comes from the API rather than from a copy. */
  maxRangeDays: number;
};

// ---------------------------------------------------------------------------
// Patients, readings, appointments, prescriptions and the bell
// ---------------------------------------------------------------------------

/**
 * `gender`, copied from `backend/src/utils/schema-enums.ts`.
 *
 * Not `@mirrors`-tagged, for the reason `SALE_STATUSES` gives: the guard compares
 * interfaces member for member and this is a value list. It is compared as a value
 * by `api-types.mirror.test.ts` instead.
 *
 * `undisclosed` is a value and not an absence, and the two are kept apart on the
 * record form for the backend's reason: a patient who was asked and declined has
 * answered, and folding that into `null` would make "declined" and "never asked"
 * the same row. One is a gap to fill in at the next visit and the other is a
 * boundary to respect.
 */
export const GENDERS = ['male', 'female', 'other', 'undisclosed'] as const;
export type Gender = (typeof GENDERS)[number];

/**
 * `screening_type`, copied from `backend/src/utils/schema-enums.ts`.
 *
 * What was measured, not what was found. `weight` and `bmi` stay separate even
 * though a BMI screening also records a weight, because the type names the thing
 * the pharmacist set out to check and the measurement columns hold whatever was
 * actually taken.
 */
export const SCREENING_TYPES = [
  'blood_pressure',
  'blood_sugar',
  'bmi',
  'weight',
  'temperature',
  'heart_rate',
] as const;
export type ScreeningType = (typeof SCREENING_TYPES)[number];

/**
 * `risk_level`, copied from `backend/src/utils/schema-enums.ts`.
 *
 * Three values and no fourth for "unclassified": every screening is classified,
 * because the server derives the level from the measurements and does not accept
 * one from the caller. That is why `RecordScreeningBody` below has no `riskLevel`
 * field — a form that could post `low` beside a systolic of 210 would turn the
 * column into an opinion.
 */
export const RISK_LEVELS = ['low', 'moderate', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * `consultation_type`, copied from `backend/src/utils/schema-enums.ts`.
 *
 * `video` is a link-out and not a media feature: the call happens on somebody
 * else's infrastructure, reached through `videoUrl`, and this app renders that as
 * an external link rather than as a waiting room.
 */
export const CONSULTATION_TYPES = ['in_person', 'video', 'chat', 'phone'] as const;
export type ConsultationType = (typeof CONSULTATION_TYPES)[number];

/**
 * `consultation_status`, copied from `backend/src/utils/schema-enums.ts`.
 *
 * `no_show` is kept apart from `cancelled` because they are different facts about
 * a patient — one was called off, the other did not arrive — and a diary that
 * collapsed them could not tell a pharmacist whether to rebook or to follow up.
 */
export const CONSULTATION_STATUSES = [
  'scheduled',
  'completed',
  'cancelled',
  'no_show',
] as const;
export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];

/**
 * The three statuses `POST /consultations/:id/end` accepts.
 *
 * A copy of the route's own `ENDED_STATUSES`, which is `CONSULTATION_STATUSES`
 * minus `'scheduled'`. Written as a filter over the list rather than as three
 * literals, so a status added to the enum arrives here as a candidate and the
 * modal offers it — where three hardcoded names would silently stop offering it.
 */
export const ENDED_CONSULTATION_STATUSES = CONSULTATION_STATUSES.filter(
  (status): status is Exclude<ConsultationStatus, 'scheduled'> => status !== 'scheduled'
);

/**
 * `prescription_status`, copied from `backend/src/utils/schema-enums.ts`.
 *
 * One direction, with `rejected` as the only exit. `dispensed` is a fact about
 * medicine that has left the shelf, so nothing moves out of it: a dispensing that
 * was wrong is corrected on the stock ledger and on the sale, not by putting the
 * prescription back to `pending` and losing the record that it was ever supplied.
 * The buttons on the queue are gated by `prescriptionMoves`, which restates the
 * backend's `TRANSITIONS` table.
 */
export const PRESCRIPTION_STATUSES = ['pending', 'approved', 'rejected', 'dispensed'] as const;
export type PrescriptionStatus = (typeof PRESCRIPTION_STATUSES)[number];

/**
 * `notification_type`, copied from `backend/src/utils/schema-enums.ts`.
 *
 * The two reminders and the three stock alerts share one table and one bell, which
 * is why the bell can filter by type at all.
 */
export const NOTIFICATION_TYPES = [
  'refill_reminder',
  'appointment_reminder',
  'stock_expiry',
  'stock_reorder',
  'product_recall',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * `notification_status`, copied from `backend/src/utils/schema-enums.ts`.
 *
 * `not_sent` is the one worth reading carefully, because it is not a failure and
 * not a pending: it means nothing was attempted, and `notSentReason` says why.
 * With no SMS provider configured — which is the state this pharmacy is in until
 * A&B sets `SMS_API_URL` and `SMS_API_KEY` — **every** reminder is `not_sent`, and
 * a bell that rendered that as a spinner or as a quiet nothing would be claiming a
 * text was on its way to a patient who will never get one.
 */
export const NOTIFICATION_STATUSES = ['pending', 'sent', 'not_sent', 'failed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * `reminder_kind`, copied from `backend/src/utils/schema-enums.ts`.
 *
 * Two kinds with two different dedupe shapes: a refill belongs to a prescription
 * and is raised once, an appointment belongs to a consultation *and its scheduled
 * time*, so moving the slot raises a fresh reminder and supersedes the old one.
 */
export const REMINDER_KINDS = ['refill', 'appointment'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/**
 * The bounds the API enforces on a patient record, copied so the form can refuse
 * a value it knows will be refused.
 *
 * `fullName` and `phone` are the same two figures `STAFF_LIMITS` uses for the same
 * two fields on a member of staff, because a name is a name whichever table it is
 * in. `listItem` is one entry in allergies, conditions or medications, and
 * `listLength` is how many entries one of those three lists may hold — the second
 * is the one a form is likeliest to forget, since a textarea of two hundred lines
 * is a perfectly ordinary thing to paste.
 *
 * @mirrors-checked as a value by `api-types.mirror.test.ts`, against
 * `backend/src/services/patients.service.ts`.
 */
export const PATIENT_LIMITS = {
  fullName: { min: 2, max: 120 },
  phone: { min: 0, max: 32 },
  notes: { min: 0, max: 2000 },
  listItem: { min: 1, max: 200 },
  listLength: { min: 0, max: 100 },
} as const;

// ---------------------------------------------------------------------------
// A patient record
// ---------------------------------------------------------------------------

/**
 * The stored record.
 *
 * There is no member number field of any kind, and that is the whole point of
 * authoring this schema fresh rather than editing the multi-tenant one: a column
 * that was never created cannot be filled in by accident, and an enum value that
 * was never created cannot be dropped — Postgres has no `ALTER TYPE ... DROP
 * VALUE`, so a payment method added to a shared schema is legal forever.
 *
 * @mirrors backend/src/repositories/patients.repository.ts PatientRow
 */
export interface PatientRow {
  id: string;
  pharmacyId: string;
  fullName: string;
  /** Stored exactly as typed and displayed exactly as stored. Never reformatted. */
  phone: string | null;
  /** `'YYYY-MM-DD'`, or null for a patient who does not know it. */
  dateOfBirth: string | null;
  /** Null means never asked; `'undisclosed'` means asked and declined. */
  gender: Gender | null;
  allergies: string[];
  conditions: string[];
  medications: string[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One patient, as the API returns it.
 *
 * Mirrored as the two interfaces it is, following `BatchStock`/`BatchRow`: the
 * guard does not follow `extends`, so the row and the field the service adds are
 * tagged separately and each is compared against its own declaration.
 *
 * @mirrors backend/src/services/patients.service.ts PatientView
 */
export interface PatientView extends PatientRow {
  /**
   * The number in the form an SMS provider would be given, or null when there is
   * no number on the record or the one there cannot be sent to.
   *
   * Not an error and it stops nothing being recorded. It means this patient's
   * reminders will be raised as `not sent` with a reason beside them — and the
   * reason it is returned here rather than left to the reminders panel is that
   * this way the pharmacist sees it while the patient is still at the counter,
   * rather than reading it back in the bell after they have gone.
   */
  smsNumber: string | null;
}

/**
 * @mirrors backend/src/services/patients.service.ts PatientPage
 */
export interface PatientPage {
  patients: PatientView[];
  /** Every patient matching the search, not just the page of them. */
  total: number;
  limit: number;
  offset: number;
}

/** `GET /patients`. */
export type PatientListResponse = PatientPage;

/** `GET /patients/:id`, `PATCH /patients/:id`. */
export type PatientResponse = { patient: PatientView };

/** `POST /patients`. */
export type PatientCreatedResponse = { patient: PatientView };

/**
 * What the record form posts. Every field except the name is optional.
 *
 * Not mirrored: requests are this app's own, for the reason the header gives —
 * the service types its inputs as `unknown` and coerces them, so there is no
 * backend declaration to copy that would be worth holding still.
 */
export type CreatePatientBody = {
  fullName: string;
  phone?: string | null;
  dateOfBirth?: string | null;
  gender?: Gender | null;
  allergies?: string[];
  conditions?: string[];
  medications?: string[];
  notes?: string | null;
};

/**
 * What the edit form posts: only the fields that moved.
 *
 * Every field optional, and `patientUpdateBody` in `lib/patients.ts` is what keeps
 * it that way. Posting all eight on every save would be harmless to the data and
 * bad to the audit: `updated_at` would move on a save that changed nothing, and a
 * record whose timestamp says "edited today" when only the phone was corrected
 * last month is a record nobody can reason about.
 */
export type UpdatePatientBody = {
  fullName?: string;
  phone?: string | null;
  dateOfBirth?: string | null;
  gender?: Gender | null;
  allergies?: string[];
  conditions?: string[];
  medications?: string[];
  notes?: string | null;
};

// ---------------------------------------------------------------------------
// A screening
// ---------------------------------------------------------------------------

/**
 * One stored reading.
 *
 * Every measurement is `number | null` and not a string, because these are
 * `numeric` columns holding a reading rather than money: `pg` returns `numeric` as
 * a string, and `screenings.repository.ts` casts each one on the way out so a
 * chart can plot it without a parse. `heightCm` is recorded but never classified —
 * a height on its own is not a risk reading, and it is here because a BMI without
 * the height it came from cannot be checked by anybody reading the record later.
 *
 * @mirrors backend/src/repositories/screenings.repository.ts ScreeningRow
 */
export interface ScreeningRow {
  id: string;
  pharmacyId: string;
  patientId: string;
  /** Never null: a reading nobody took is not a reading. */
  recordedBy: string;
  type: ScreeningType;
  /** The level as it was decided when the row was written. Never re-derived. */
  riskLevel: RiskLevel;
  systolicBp: number | null;
  diastolicBp: number | null;
  bloodGlucoseMmol: number | null;
  weightKg: number | null;
  heightCm: number | null;
  bmi: number | null;
  temperatureC: number | null;
  heartRateBpm: number | null;
  measuredAt: string;
  notes: string | null;
  /** And no `updatedAt`: a reading is a fact about a moment, not a record to edit. */
  createdAt: string;
}

/**
 * A stored reading plus the explanation rebuilt from the numbers in it.
 *
 * @mirrors backend/src/services/screenings.service.ts ScreeningView
 */
export interface ScreeningView extends ScreeningRow {
  /**
   * The classifier's sentence for this row's measurements, or null when the reading
   * is an ordinary one and there is nothing to explain.
   *
   * Rebuilt on every read while `riskLevel` is frozen, and the two are allowed to
   * disagree: a corrected threshold should improve the explanation beside every
   * historical row, and should not retroactively re-triage the patients in them.
   * Show the level as the decision that was made and the sentence as the current
   * reading of the numbers.
   */
  riskReason: string | null;
}

/** @mirrors backend/src/services/screenings.service.ts ScreeningPage */
export interface ScreeningPage {
  screenings: ScreeningView[];
}

/**
 * `GET /screenings`.
 *
 * `types` is echoed so the filter dropdown is filled from the API rather than from
 * the copy above — the copy exists to type a row, and the response exists to say
 * what the server will accept today.
 */
export type ScreeningListResponse = ScreeningPage & {
  limit: number;
  offset: number;
  types: ScreeningType[];
};

/**
 * `GET /screenings/latest`.
 *
 * `null` is an answer and not an absence: a patient with no previous reading of
 * this type is the ordinary case the first time anybody takes one, and a 404 would
 * make the patient page treat "nothing recorded yet" as "record not found" — two
 * states that look the same on a screen and mean opposite things.
 */
export type ScreeningLatestResponse = { screening: ScreeningView | null };

/** `POST /screenings`. */
export type ScreeningCreatedResponse = { screening: ScreeningView };

/**
 * What the recording form posts. Readings as typed: a string or a number.
 *
 * No `riskLevel` and no `recordedBy`. The level is derived from the measurements
 * server-side, and the recorder is taken from the token — so neither has anywhere
 * to land, and a body carrying one is refused rather than quietly honoured.
 */
export type RecordScreeningBody = {
  patientId: string;
  type: ScreeningType;
  /** The seven readings, every key present. Absent means `undefined`, not null. */
  values: ScreeningValuesBody;
  /** Taken with the reading; what a BMI is computed from when none was typed. */
  weightKg?: string | number | null;
  heightCm?: string | number | null;
  /** Omitted for "just now", which is the common case at a counter. */
  measuredAt?: string | null;
  notes?: string | null;
};

/**
 * The seven measurement cells.
 *
 * Every key required and every value `string | number | null`, which is why the
 * form builds the whole object rather than only the cells somebody filled in: a
 * key left off a text box arrives as `undefined`, and `undefined` is neither a
 * reading nor an honest absence.
 */
export type ScreeningValuesBody = {
  systolicBp: string | number | null;
  diastolicBp: string | number | null;
  bloodGlucoseMmol: string | number | null;
  bmi: string | number | null;
  weightKg: string | number | null;
  temperatureC: string | number | null;
  heartRateBpm: string | number | null;
};

// ---------------------------------------------------------------------------
// An appointment
// ---------------------------------------------------------------------------

/**
 * One booked consultation.
 *
 * `videoUrl` is a link-out and nothing more. This app does not join the call, does
 * not embed a player and does not pretend to: it renders the address as an
 * external link, which is why the backend stores it only for a `video` type and
 * only over `https` — a link opened from a page served over https has to be one.
 *
 * @mirrors backend/src/repositories/consultations.repository.ts ConsultationRow
 */
export interface ConsultationRow {
  id: string;
  pharmacyId: string;
  /** Never null: a consultation is with somebody. */
  patientId: string;
  /** Null until somebody is assigned, and clearable again. */
  conductedBy: string | null;
  type: ConsultationType;
  status: ConsultationStatus;
  scheduledAt: string;
  /** Null means no length was given, which is not the same as zero minutes. */
  durationMinutes: number | null;
  /** The link-out. Only ever set for a `video` consultation. */
  videoUrl: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The name the API gives the row, kept so `ConsultationPage` below is a copy of
 * the backend's declaration rather than a paraphrase of it.
 *
 * A `type` alias and not an interface, which is also why it carries no `@mirrors`
 * tag: the guard pairs a tag with the next `export interface` it finds, so a tag
 * above an alias would be read as belonging to whatever interface came after it.
 */
export type ConsultationView = ConsultationRow;

/** @mirrors backend/src/services/consultations.service.ts ConsultationPage */
export interface ConsultationPage {
  consultations: ConsultationView[];
}

/**
 * `GET /consultations`.
 *
 * Both enum lists are echoed, so the diary's two dropdowns are filled from the API
 * rather than from the copies above.
 */
export type ConsultationListResponse = ConsultationPage & {
  limit: number;
  offset: number;
  statuses: ConsultationStatus[];
  types: ConsultationType[];
};

/** `GET /consultations/:id`, `PATCH /consultations/:id`, `POST /consultations/:id/end`. */
export type ConsultationResponse = { consultation: ConsultationView };

/** `POST /consultations`. */
export type ConsultationCreatedResponse = { consultation: ConsultationView };

/** What the booking form posts. */
export type BookConsultationBody = {
  patientId: string;
  type: ConsultationType;
  scheduledAt: string;
  conductedBy?: string | null;
  durationMinutes?: number | null;
  videoUrl?: string | null;
  notes?: string | null;
};

/**
 * What a reschedule posts. The patient cannot be changed: that is a new booking.
 *
 * The three-way distinction on every optional field here is the one thing this
 * body has to get right, and `rescheduleBody` in `lib/consultations.ts` is where
 * it is got right. **Omit** a key to leave that column alone; send **`null`** to
 * clear it; send a value to set it. A form that posted `videoUrl: null` for a
 * field nobody touched would take the meeting link away from every appointment it
 * moved, and the row would still look perfectly ordinary afterwards.
 */
export type RescheduleBody = {
  scheduledAt: string;
  type?: ConsultationType;
  conductedBy?: string | null;
  durationMinutes?: number | null;
  videoUrl?: string | null;
  notes?: string | null;
};

/**
 * What ending an appointment posts.
 *
 * `scheduled` is not a member, and cannot become one: `ENDED_CONSULTATION_STATUSES`
 * is the list this is typed against, and it is `CONSULTATION_STATUSES` minus the
 * one status that means the appointment has not happened yet.
 */
export type EndConsultationBody = {
  status: (typeof ENDED_CONSULTATION_STATUSES)[number];
};

// ---------------------------------------------------------------------------
// A prescription
// ---------------------------------------------------------------------------

/**
 * One prescription on the queue.
 *
 * `prescriberName` is a name typed at the counter and not a foreign key: there is
 * no prescribers table and there should not be one for a single pharmacy, because
 * the prescriber is whoever wrote the script and most of them will never be seen
 * twice. `approvedBy` is null until somebody approves it, and it is the one field
 * a correction cannot touch — an approval re-attributed is a signature on a
 * decision somebody else made.
 *
 * @mirrors backend/src/repositories/prescriptions.repository.ts PrescriptionRow
 */
export interface PrescriptionRow {
  id: string;
  pharmacyId: string;
  /** Null for a walk-in who is not on the books. */
  patientId: string | null;
  /** The sale this was dispensed against, or null. */
  saleId: string | null;
  prescriberName: string | null;
  status: PrescriptionStatus;
  approvedBy: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The name the API gives the row. An alias, for the reason `ConsultationView`
 * gives, and untagged for the one it gives about tags above aliases.
 */
export type PrescriptionView = PrescriptionRow;

/** @mirrors backend/src/services/prescriptions.service.ts PrescriptionPage */
export interface PrescriptionPage {
  prescriptions: PrescriptionView[];
  /**
   * Every prescription matching the filters, not just the page of them.
   *
   * The badge on an approval queue. A badge reading 3 above a list of two rows is
   * a disagreement somebody notices immediately and then stops trusting either
   * number for, which is why it travels with the rows rather than being a second
   * request.
   */
  total: number;
  limit: number;
  offset: number;
}

/** `GET /prescriptions`. */
export type PrescriptionListResponse = PrescriptionPage & {
  statuses: PrescriptionStatus[];
};

/** `GET /prescriptions/:id`, `PATCH /prescriptions/:id` and the three moves. */
export type PrescriptionResponse = { prescription: PrescriptionView };

/** `POST /prescriptions`. */
export type PrescriptionCreatedResponse = { prescription: PrescriptionView };

/**
 * What the record form posts. Everything is optional: a walk-in has no patient
 * record, and a script written down at the counter has not been dispensed against
 * a sale yet.
 *
 * No `status` and no `approvedBy`. A prescription arrives `pending`, and the
 * approver is taken from the token of whoever presses Approve — an approver on a
 * prescription nobody has approved is a signature on a decision nobody made.
 */
export type RecordPrescriptionBody = {
  patientId?: string | null;
  saleId?: string | null;
  prescriberName?: string | null;
  notes?: string | null;
};

/**
 * What a correction may change.
 *
 * No `status`, because correcting a typo is not a clinical decision and a patch
 * that could carry one would be a second route into every transition the service
 * guards. No `approvedBy` either, for the reason the backend gives at length:
 * re-attributing an approval is not undoing a mistake, it is writing a different
 * signature onto a decision that was made. A pharmacist who approved the wrong
 * script corrects it by rejecting and re-recording, which leaves both acts on the
 * ledger.
 */
export type CorrectPrescriptionBody = {
  patientId?: string | null;
  saleId?: string | null;
  prescriberName?: string | null;
  notes?: string | null;
};

/**
 * What dispensing posts.
 *
 * `saleId` is optional because a prescription can be dispensed against a sale rung
 * up afterwards, and mandatory in practice for anything the till sold: the link is
 * what lets a recall reach the patient. `lib/prescriptions.ts` says so on the form
 * rather than leaving it to the operator to work out why the field is there.
 */
export type DispensePrescriptionBody = {
  saleId?: string | null;
};

// ---------------------------------------------------------------------------
// Reminders and the bell
// ---------------------------------------------------------------------------

/**
 * One reminder, raised by the scheduler and deduplicated against its own history.
 *
 * `message` is the text the patient *would* be sent, stored when the reminder is
 * rather than composed when it is shown. That is what makes the unsent state
 * readable: the panel can put the exact sentence beside the reason it never went,
 * instead of a pharmacist wondering what a `not_sent` row was for.
 *
 * @mirrors backend/src/repositories/reminders.repository.ts ReminderRow
 */
export interface ReminderRow {
  id: string;
  pharmacyId: string;
  /** Not null in the schema: a reminder is always for somebody. */
  patientId: string;
  kind: ReminderKind;
  dueAt: string;
  /** The text the patient would be sent. */
  message: string;
  status: NotificationStatus;
  /**
   * Why nothing was sent. Guaranteed present whenever `status` is `not_sent` or
   * `failed`, by a check constraint in the schema rather than by the repository —
   * so this app never has to defend against an unexplained one, and never invents
   * a reason of its own.
   */
  notSentReason: string | null;
  /** The bell entry this reminder raised, once it raised one. */
  notificationId: string | null;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One bell entry.
 *
 * `readAt` is on the row and not in a per-user join table, so a broadcast has one
 * read state for the whole pharmacy: when anybody marks it read it is read for
 * everyone. That is a decision rather than an oversight — at a counter with three
 * people on a shift, per-member badges would give each of them a bell that stays
 * lit over an alert a colleague dealt with an hour ago. The UI has to say so, and
 * `userId` is how it can: null is a broadcast, a set value is aimed at one person.
 *
 * @mirrors backend/src/repositories/notifications.repository.ts NotificationRow
 */
export interface NotificationRow {
  id: string;
  pharmacyId: string;
  /** Null means every staff member sees it; a set value targets one user. */
  userId: string | null;
  type: NotificationType;
  status: NotificationStatus;
  title: string;
  body: string | null;
  relatedType: string | null;
  relatedId: string | null;
  dedupeKey: string;
  /** Present whenever nothing was attempted. Not an error field. */
  notSentReason: string | null;
  sentAt: string | null;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The name the API gives the row. An alias, untagged, for the reason
 * `ConsultationView` gives.
 */
export type NotificationView = NotificationRow;

/**
 * What one pass of the reminder scheduler did.
 *
 * `sent` is zero while no provider is configured, and `notSent` is where those
 * reminders go — with a reason beside each one. The four counts are reported
 * separately rather than summed, because "12 reminders, 0 sent" is the honest
 * headline for a pharmacy that has not connected an SMS provider and a UI that
 * showed only a total would be claiming work was done.
 *
 * @mirrors backend/src/services/reminders.service.ts RefreshSummary
 */
export interface RefreshSummary {
  /** The instant the batch reasoned about, echoed so a run can be identified. */
  now: string;
  /** Reminders selected as pending and due. */
  due: number;
  /** Reminders the provider accepted. Zero while no provider is configured. */
  sent: number;
  /** Reminders nothing was attempted for, each with a reason beside it. */
  notSent: number;
  /** Reminders a provider was reached about and did not complete. */
  failed: number;
  /** Reminders another run had already dealt with, so this one wrote nothing. */
  alreadyDealt: number;
}

/** @mirrors backend/src/services/notifications.service.ts NotificationPage */
export interface NotificationPage {
  notifications: NotificationView[];
  /**
   * Everything this member of staff can see that nobody has read, counted over the
   * whole table rather than over the page.
   */
  unread: number;
  limit: number;
  offset: number;
}

/** @mirrors backend/src/services/notifications.service.ts ReadAllResult */
export interface ReadAllResult {
  /**
   * How many rows this call read. Zero on a second click, because the update is
   * scoped to rows nobody has read — so the answer is "how many I just read" and
   * not "how many matched", and a bell cleared twice does not report the same
   * number twice.
   */
  read: number;
}

/** @mirrors backend/src/services/notifications.service.ts RefreshResult */
export interface RefreshResult {
  summary: RefreshSummary;
  /**
   * True when the batch came back full, so there may be more still pending.
   *
   * One pass rather than a drain, because this is an HTTP request and a request has
   * to return. Saying so is what stops a full batch reading as a finished one: the
   * button can be pressed again, and the quarter-hourly scheduler picks the
   * remainder up whatever anybody does.
   */
  moreDue: boolean;
}

/**
 * `GET /notifications` — the bell.
 *
 * `unread` travels with the rows rather than being a second endpoint, so the badge
 * and the list it counts cannot come from two different moments. A bell showing 3
 * above two rows is the disagreement that makes somebody stop trusting either
 * number.
 */
export type NotificationListResponse = NotificationPage & {
  types: NotificationType[];
};

/**
 * `GET /notifications/reminders`.
 *
 * `status` and `notSentReason` come back on every row rather than being summarised
 * here, because the acceptance criterion is that an unsent reminder is labelled as
 * unsent *and says why*. A panel that inferred "not delivered" from an empty
 * `sentAt` would be guessing at the one thing the row states.
 */
export type ReminderListResponse = {
  reminders: ReminderRow[];
  limit: number;
  offset: number;
  kinds: ReminderKind[];
};

/** `POST /notifications/read-all`. The result is the whole body. */
export type ReadAllResponse = ReadAllResult;

/** `POST /notifications/refresh`. The result is the whole body. */
export type RefreshResponse = RefreshResult;
