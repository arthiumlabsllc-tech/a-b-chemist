'use client';

/**
 * The till. `/` redirects here, because this is what the person at the counter is
 * walking towards the tablet for.
 *
 * ## The shape of a sale, and why it is this order
 *
 *  1. **Load** the catalogue, the categories, the tax settings, the gateway config
 *     and the approvers. The tax settings are what let the basket be priced on the
 *     device at all; without them the till cannot show a total and Charge is held.
 *  2. **Tap** tiles into a basket held by a pure reducer (`lib/basket.ts`). The
 *     panel prices it locally on every change (`lib/pricing.ts`, the shared engine)
 *     so the operator sees the total move under their finger.
 *  3. **Charge** calls `POST /sales/quote` — the server's figure, and the check
 *     that the stock is actually there. If a line cannot be filled, the shortfall
 *     is named and the payment modal never opens.
 *  4. **Take payment** in the modal, on the quoted total. Change and refusals are
 *     previewed locally (`lib/tender.ts`) but the server decides.
 *  5. **Record** with `POST /sales`, carrying a `clientSaleId` minted once for this
 *     basket and reused on every retry — that is what makes a lost response a
 *     replay rather than a second sale.
 *  6. **Show the receipt** from the stored sale, clear the basket, and refresh the
 *     catalogue so the stock figures move.
 *
 * The local price and the quoted price can differ — a rate or a price changed since
 * the grid loaded — and when they do the quote is what the customer pays. That is
 * the whole reason the quote step exists between the basket and the money.
 *
 * ## Offline, which is a branch of steps 1, 3 and 5 rather than a separate mode
 *
 * The till never decides it is offline; it finds out. Charge always attempts
 * `POST /sales/quote`, and only a failure carrying `ApiError.isOffline` — a request
 * that never connected, never a 401, a 409 or a 500, which are answers — takes the
 * offline branch: price on the device from the cached rates, offer cash alone, and
 * hold the sale in the queue instead of recording it. Step 1 reads the catalogue and
 * the tax settings back out of the cache on the same signal, which is what makes the
 * grid and the total still work at all.
 *
 * Recording attempts `POST /sales` too, except for a basket whose quote has just
 * failed to connect — that write would fail identically, and skipping it costs one
 * doomed round trip at a counter with a customer standing at it.
 *
 * Attempting every time rather than trusting a remembered answer is deliberate. A
 * flag set once has to be cleared by something, and the only candidates are
 * `navigator.onLine` — a hint that stays true while a server is down and the network
 * is up — or a timer, which BRIEF.md §4.5 rules out and `offline-sync.tsx` already
 * refuses on the same grounds. An attempt is its own recovery probe: the first sale
 * after the connection returns is recorded rather than queued, with nothing needed
 * to notice the outage ended. `tillOffline` is therefore display state only. No
 * decision in this file reads it, so a stale flag can mislabel the totals but can
 * never queue a sale that was recordable or record one that was not.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { decimalStringFromPesewas } from 'a-and-b-chemist-shared';

import { BasketPanel } from '@/components/pos/basket-panel';
import { PaymentModal } from '@/components/pos/payment-modal';
import { ProductGrid } from '@/components/pos/product-grid';
import { ProvisionalReceipt } from '@/components/pos/provisional-receipt';
import { Receipt } from '@/components/pos/receipt';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { ErrorNotice, WarningNotice } from '@/components/ui/display';
import { useAuth } from '@/hooks/use-auth';
import { ApiError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/api-error-message';
import { EMPTY_BASKET, basketIsEmpty, basketReducer } from '@/lib/basket';
import {
  getOfflineCache,
  readCatalogue,
  readTaxSettings,
  rememberCatalogue,
  rememberTaxSettings,
} from '@/lib/offline/cache';
import { offlineTotalFromBasket } from '@/lib/offline/offline-pricing';
import { getSaleQueue } from '@/lib/offline/queue';
import { offlineSaleBlocker, queuedSaleDraft } from '@/lib/offline/till';
import {
  basketToRequest,
  newClientSaleId,
  priceTillBasket,
  taxSettingsFromView,
} from '@/lib/pricing';
import type { BasketLine, PricedTillBasket } from '@/lib/pricing';
import { changeDuePesewas, toCreateSalePayments } from '@/lib/tender';
import type { TenderDraft } from '@/lib/tender';
import type {
  Approver,
  ApproversResponse,
  CreateSaleBody,
  CreateSaleResult,
  PaymentConfig,
  PaymentConfigResponse,
  QuoteBody,
  QuoteResult,
  SaleDetail,
  TaxSettingsResponse,
  TaxSettingsView,
  TillCategoriesResponse,
  TillProduct,
  TillProductsResponse,
} from '@/lib/api-types';

const PRODUCT_PAGE_LIMIT = 200;
const SEARCH_DEBOUNCE_MS = 300;

/** A printer, for the receipt's Print button. */
function PrinterIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-4 w-4"
    >
      <path d="M7 8V3h10v5" />
      <rect x="4" y="8" width="16" height="8" rx="2" />
      <path d="M7 14h10v7H7z" />
    </svg>
  );
}

/**
 * What Charge arrived at: the total to take payment on, and who produced it.
 *
 * One state rather than a total with an `offline` boolean floating beside it, so
 * the payment modal cannot be opened on a figure whose provenance the page has
 * forgotten — which is the difference between a receipt that says "provisional"
 * and one that claims the server's authority for a number it never saw.
 */
interface ChargeState {
  /** False when the server could not be reached and this device priced the basket. */
  quoted: boolean;
  /**
   * A plain decimal string in cedis — `'25.00'`, with no thousands separator —
   * because it goes straight into the tender field the operator edits, and
   * `parseCediInput` refuses the comma that `moneyText` puts into a four-figure
   * amount.
   */
  totalText: string;
}

/** What the receipt modal shows: a sale the server recorded, or one this device holds. */
type ReceiptState =
  | { kind: 'recorded'; detail: SaleDetail; replayed: boolean }
  | {
      kind: 'held';
      /**
       * Copied out of the basket rather than read from it. The sale clears the
       * basket the moment it is held, and a receipt that read `basket.lines` would
       * render empty behind the modal the operator is still looking at.
       */
      lines: BasketLine[];
      totalPesewas: number;
      tenders: TenderDraft[];
      changePesewas: number;
    };

function shortfallMessage(quote: QuoteResult): string {
  const short = quote.lines.filter((line) => line.shortfall > 0);
  if (short.length === 0) {
    return 'This basket cannot be filled from the stock on hand.';
  }
  const parts = short.map(
    (line) => `${line.name} — ${line.shortfall} short, only ${line.available} available`
  );
  return `Not enough stock: ${parts.join('; ')}.`;
}

export default function PosPage() {
  const { api } = useAuth();
  const [basket, dispatch] = useReducer(basketReducer, EMPTY_BASKET);

  const [products, setProducts] = useState<TillProduct[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [category, setCategory] = useState('');
  const [onlyInStock, setOnlyInStock] = useState(false);

  const [categories, setCategories] = useState<string[]>([]);
  const [taxView, setTaxView] = useState<TaxSettingsView | null>(null);
  const [paymentConfig, setPaymentConfig] = useState<PaymentConfig | null>(null);
  const [approvers, setApprovers] = useState<Approver[]>([]);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [bootToken, setBootToken] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);

  const [charge, setCharge] = useState<ChargeState | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [chargeError, setChargeError] = useState<string | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReceiptState | null>(null);

  /**
   * Whether the last thing the till asked for could not be reached.
   *
   * Display state only — see the module docstring. Written from real answers and
   * from nothing else: never from `navigator.onLine`, which is a hint that stays
   * true while a server is down and the network is up.
   */
  const [tillOffline, setTillOffline] = useState(false);

  // Minted once per basket, before the first attempt, and reused on every retry.
  // See step 5 above — a fresh id per attempt is a duplicate sale, not a retry.
  const clientSaleIdRef = useRef<string | null>(null);

  // The settings the till cannot price without. Loaded once; a failure here is
  // shown and Charge is held rather than the till guessing at a rate.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setSettingsError(null);
      // Resolved inside the effect rather than in the render, because an effect only
      // ever runs on the client and `getOfflineCache()` memoises a singleton at
      // module scope — created during a server render it would belong to the process
      // rather than to the request, which is the hazard `getAuthSession()` refuses
      // outright.
      const cache = getOfflineCache();
      try {
        const [cats, tax, gateway, people] = await Promise.all([
          api.get<TillCategoriesResponse>('/sales/categories'),
          api.get<TaxSettingsResponse>('/tax/settings'),
          api.get<PaymentConfigResponse>('/sales/payment-config'),
          api.get<ApproversResponse>('/sales/approvers'),
        ]);
        if (cancelled) return;
        setCategories(cats.categories);
        setTaxView(tax.taxSettings);
        setPaymentConfig(gateway.paymentConfig);
        setApprovers(people.approvers);
        setTillOffline(false);
        // Cached on the way past, which is the half of §4.5 that makes the restore
        // below possible at all: a tablet that has never reached the server has
        // nothing to fall back to and cannot sell, and the only moment there is
        // anything worth keeping is the moment the server answers.
        void rememberTaxSettings(cache, tax.taxSettings).catch(() => {});
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.isOffline) {
          setTillOffline(true);
          const cachedTax = await readTaxSettings(cache).catch(() => null);
          if (cancelled) return;
          if (cachedTax === null) {
            // No rates, so no total, so no sale — and the till says that instead of
            // pricing at zero or inventing a rate. Charge stays held by `priced`
            // being null.
            setSettingsError(
              'Cannot reach the server, and this device has no tax settings stored, so the till cannot price a basket. Reload once the connection is back.'
            );
            return;
          }
          setTaxView(cachedTax.value);
          const cachedCatalogue = await readCatalogue(cache).catch(() => null);
          if (!cancelled && cachedCatalogue !== null) {
            setCategories(cachedCatalogue.value.categories);
          }
          return;
        }
        // A 500 lands here and not in the branch above: the server answered, so this
        // is a fault to surface and not an outage to trade through.
        setSettingsError(apiErrorMessage(error, 'Could not load the till settings.'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, bootToken]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      setProductsLoading(true);
      setProductsError(null);
      const cache = getOfflineCache();
      try {
        const result = await api.get<TillProductsResponse>('/sales/products', {
          query: {
            limit: PRODUCT_PAGE_LIMIT,
            ...(debouncedSearch === '' ? {} : { search: debouncedSearch }),
            ...(category === '' ? {} : { category }),
          },
          signal: controller.signal,
        });
        if (cancelled) return;
        setProducts(result.products);
        setTillOffline(false);
      } catch (error) {
        if (cancelled || (error instanceof ApiError && error.kind === 'aborted')) return;
        if (error instanceof ApiError && error.isOffline) {
          setTillOffline(true);
          const cached = await readCatalogue(cache).catch(() => null);
          if (cancelled) return;
          if (cached !== null) {
            // The figures in here are a photograph of the shelf from the last time
            // the server answered. They are the best the till has and they are not
            // current, which is why nothing offline treats them as a stock check.
            setProducts(cached.value.products);
            return;
          }
          setProductsError(
            'Cannot reach the server, and this device has no catalogue stored, so there is nothing to sell from. Reload once the connection is back.'
          );
          return;
        }
        setProductsError(apiErrorMessage(error, 'Could not load products.'));
      } finally {
        if (!cancelled) setProductsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, debouncedSearch, category, reloadToken]);

  /**
   * Stores the catalogue, but only the unfiltered listing.
   *
   * Caching a search result as "the catalogue" would be the quiet kind of failure:
   * the operator looks up one product, the connection drops, the tablet restarts,
   * and the till offers three tiles with nothing to say why. The unfiltered listing
   * is fetched on mount before any search narrows it, so the entry is written early
   * and a later search leaves it alone.
   *
   * Still bounded by `PRODUCT_PAGE_LIMIT`, so a pharmacy with more products than
   * that trades offline on the first page of them. That is the same limit the
   * online grid works under, and widening it for the cache alone would mean a
   * request the till does not otherwise make.
   */
  useEffect(() => {
    if (debouncedSearch !== '' || category !== '') return;
    if (products.length === 0 || categories.length === 0) return;
    void rememberCatalogue(getOfflineCache(), { products, categories }).catch(() => {});
  }, [debouncedSearch, category, products, categories]);

  const settings = useMemo(() => (taxView === null ? null : taxSettingsFromView(taxView)), [taxView]);

  const priced: PricedTillBasket | null = useMemo(() => {
    // Null, and not a failure with a borrowed engine code: the engine was never
    // asked, because there are no rates to ask it with. `BasketPanel` has a separate
    // sentence for this and the notice above has the Reload button that belongs to it.
    if (settings === null) return null;
    if (basketIsEmpty(basket)) {
      return { ok: false, failure: { code: 'basket_has_no_value', message: 'The basket is empty' } };
    }
    return priceTillBasket(basket.lines, settings, {
      discountPesewas: basket.discountPesewas,
      discountReason: basket.discountReason === '' ? null : basket.discountReason,
    });
  }, [settings, basket]);

  const requiresApproval = basket.lines.some((line) => line.requiresPrescription);

  // Memoised: `Modal` re-runs its focus effect on `[open, onClose]`, so a fresh
  // arrow here would pull focus back into the dialog on every render of the page
  // behind it — which is every keystroke of the next basket.
  const closeReceipt = useCallback(() => setReceipt(null), []);
  const closePayment = useCallback(() => setPaymentOpen(false), []);

  /** What every finished sale does, whether the server recorded it or this device holds it. */
  function finishSale(heldOffline: boolean): void {
    setPaymentOpen(false);
    setCharge(null);
    dispatch({ type: 'clear' });
    clientSaleIdRef.current = null;
    // Online, the stock moved and the grid has to be fetched again to show it.
    // Offline nothing moved on the server: a reload would re-read the same cached
    // figures and put a spinner over a grid that then looks as though it had lost
    // the sale. The staleness is stated instead, on the provisional receipt and in
    // the basket panel, and the real figures arrive with the next successful load.
    if (!heldOffline) {
      setReloadToken((token) => token + 1);
    }
  }

  /**
   * Opens the payment modal on a figure this device priced, because the server
   * could not be asked for one.
   *
   * The blocker is checked here rather than by the caller so that both routes into
   * the offline branch — a quote that could not connect and a write that could not
   * — refuse a prescription-only basket identically and say why in the same words.
   */
  function openOfflineCharge(): void {
    if (priced === null || priced.ok !== true) {
      // No rates, so no total. The panel already holds Charge in this state; this is
      // the second half of the same guard, because opening a payment modal on a
      // figure the till could not compute is asking a customer for an invented
      // amount.
      setChargeError('The till has no tax settings, so it cannot price this basket.');
      return;
    }
    const blocker = offlineSaleBlocker(basket.lines);
    if (blocker !== null) {
      setChargeError(blocker);
      return;
    }

    const provisional = offlineTotalFromBasket(priced.basket);
    setCharge({
      quoted: false,
      totalText: decimalStringFromPesewas(provisional.totalPesewas),
    });
    setPaymentOpen(true);
  }

  /**
   * Queues the sale and shows what the counter is entitled to claim about it: the
   * lines, the money taken, the change counted back, and the fact that the server
   * has recorded none of it.
   */
  function holdOnDevice(body: CreateSaleBody, tenders: TenderDraft[]): void {
    if (priced === null || priced.ok !== true) {
      setSubmitError('The till has no tax settings, so this sale cannot be held on the device.');
      return;
    }

    const provisional = offlineTotalFromBasket(priced.basket);
    const draft = queuedSaleDraft({ body, lines: basket.lines, provisional });
    if (draft === null) {
      // Unreachable — `onSubmitSale` returns before this when there is no
      // `clientSaleId`, and it always passes one to `basketToRequest`. Kept because
      // the alternative is a sale queued without an idempotency key, which replays
      // as a second sale, and the honest answer when that cannot be ruled out by the
      // type is to record nothing and say so.
      setSubmitError(
        'This sale has no retry key, so it has not been held on the device and nothing has been recorded. Take the payment back and press Charge again.'
      );
      return;
    }

    getSaleQueue().enqueue(draft);
    setReceipt({
      kind: 'held',
      lines: [...basket.lines],
      totalPesewas: provisional.totalPesewas,
      tenders: [...tenders],
      changePesewas: changeDuePesewas(tenders, provisional.totalPesewas),
    });
    finishSale(true);
  }

  async function onCharge() {
    if (settings === null || basketIsEmpty(basket)) return;
    setQuoting(true);
    setChargeError(null);
    setSubmitError(null);

    if (clientSaleIdRef.current === null) {
      clientSaleIdRef.current = newClientSaleId();
    }
    const request = basketToRequest(basket.lines, {
      clientSaleId: clientSaleIdRef.current,
      discountPesewas: basket.discountPesewas,
      discountReason: basket.discountReason === '' ? null : basket.discountReason,
    });
    const quoteBody: QuoteBody = {
      lines: request.lines,
      ...(request.discount === undefined
        ? {}
        : { discount: request.discount, discountReason: request.discountReason }),
    };

    try {
      const result = await api.post<QuoteResult>('/sales/quote', quoteBody);
      setTillOffline(false);
      if (!result.canFulfil) {
        setChargeError(shortfallMessage(result));
        return;
      }
      setCharge({ quoted: true, totalText: result.basket.total });
      setPaymentOpen(true);
    } catch (error) {
      if (error instanceof ApiError && error.isOffline) {
        setTillOffline(true);
        openOfflineCharge();
        return;
      }
      // Every other failure is an answer — a 409, a 500, a refusal about the basket
      // — and goes to the operator as an error. Queueing here would be the exact
      // dishonesty BRIEF.md's landmine 3 names: "your sale is queued" when nothing
      // was written anywhere.
      setChargeError(apiErrorMessage(error, 'Could not price this basket.'));
    } finally {
      setQuoting(false);
    }
  }

  async function onSubmitSale(tenders: TenderDraft[], approverId: string | null) {
    const clientSaleId = clientSaleIdRef.current;
    if (clientSaleId === null) return;
    setSubmitting(true);
    setSubmitError(null);

    const body = basketToRequest(basket.lines, {
      clientSaleId,
      discountPesewas: basket.discountPesewas,
      discountReason: basket.discountReason === '' ? null : basket.discountReason,
      payments: toCreateSalePayments(tenders),
      ...(approverId === null ? {} : { approvedBy: approverId }),
    });

    try {
      if (charge === null || charge.quoted) {
        const result = await api.post<CreateSaleResult>('/sales', body);
        setTillOffline(false);
        setReceipt({ kind: 'recorded', detail: result.detail, replayed: result.replayed });
        finishSale(false);
        return;
      }
      holdOnDevice(body, tenders);
    } catch (error) {
      if (error instanceof ApiError && error.isOffline) {
        // The connection went between Charge and Pay. Held rather than lost, and the
        // `clientSaleId` already on the body is what makes a response that was in
        // flight when it dropped come back as a replay.
        setTillOffline(true);
        holdOnDevice(body, tenders);
        return;
      }
      setSubmitError(apiErrorMessage(error, 'The sale could not be recorded.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-col lg:h-full lg:flex-row">
      <div className="flex min-h-0 flex-1 flex-col">
        {settingsError !== null && (
          <div className="space-y-2 border-b border-surface-200 bg-white p-3 sm:p-4">
            <ErrorNotice>{settingsError}</ErrorNotice>
            <Button variant="secondary" size="md" onClick={() => setBootToken((token) => token + 1)}>
              Reload settings
            </Button>
          </div>
        )}
        {tillOffline && (
          <div className="border-b border-surface-200 bg-white p-3 sm:p-4">
            <WarningNotice>
              The server cannot be reached. The till is selling from what this device stored the
              last time it connected, so the stock figures are out of date and are not a check on
              what can be handed over. A sale will be held here until the connection returns.
            </WarningNotice>
          </div>
        )}
        {chargeError !== null && (
          <div className="border-b border-surface-200 bg-white p-3 sm:p-4">
            <ErrorNotice>{chargeError}</ErrorNotice>
          </div>
        )}
        <ProductGrid
          products={products}
          loading={productsLoading}
          error={productsError}
          search={search}
          onSearchChange={setSearch}
          categories={categories}
          category={category}
          onCategoryChange={setCategory}
          onlyInStock={onlyInStock}
          onOnlyInStockChange={setOnlyInStock}
          onAdd={(product) => dispatch({ type: 'add', product })}
          onRetry={() => setReloadToken((token) => token + 1)}
        />
      </div>

      <BasketPanel
        basket={basket}
        dispatch={dispatch}
        priced={priced}
        offline={tillOffline}
        quoting={quoting}
        onCharge={() => void onCharge()}
      />

      {charge !== null && (
        <PaymentModal
          open={paymentOpen}
          totalText={charge.totalText}
          offline={!charge.quoted}
          paymentConfig={paymentConfig}
          approvers={approvers}
          requiresApproval={requiresApproval}
          submitting={submitting}
          error={submitError}
          onSubmit={(tenders, approverId) => void onSubmitSale(tenders, approverId)}
          onClose={closePayment}
        />
      )}

      <Modal
        open={receipt !== null}
        onClose={closeReceipt}
        title={receipt?.kind === 'held' ? 'Held on this device' : 'Sale recorded'}
        footer={
          <div className="flex items-center justify-between gap-3">
            <p className="text-2xs text-neutral-500">
              {receipt?.kind === 'recorded'
                ? `${receipt.detail.items.length} line item(s)`
                : receipt?.kind === 'held'
                  ? `${receipt.lines.length} line item(s)`
                  : ''}
            </p>
            <div className="flex items-center gap-2">
              {receipt?.kind === 'recorded' && (
                <Button variant="secondary" size="md" onClick={() => window.print()}>
                  <PrinterIcon />
                  Print
                </Button>
              )}
              <Button variant="primary" size="md" onClick={closeReceipt}>
                New sale
              </Button>
            </div>
          </div>
        }
      >
        {receipt?.kind === 'recorded' && (
          <div className="space-y-3">
            {receipt.replayed && (
              <WarningNotice>
                This sale had already been recorded — the till lost the response and has recovered
                it. Stock was not taken twice.
              </WarningNotice>
            )}
            <Receipt detail={receipt.detail} />
          </div>
        )}
        {receipt?.kind === 'held' && (
          <ProvisionalReceipt
            lines={receipt.lines}
            totalPesewas={receipt.totalPesewas}
            tenders={receipt.tenders}
            changePesewas={receipt.changePesewas}
          />
        )}
      </Modal>
    </div>
  );
}
