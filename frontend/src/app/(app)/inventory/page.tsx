'use client';

/**
 * Stock. `/inventory`, gated by `inventory:read`.
 *
 * The product list the back office works from: every product, searchable by name,
 * code, generic name or barcode, filterable by category and by whether to include
 * inactive ones. Each row is a link to `/inventory/[id]`, which holds the lots, the
 * ledger and every stock write. This page reads and navigates; the one thing it
 * writes is a new product, because "add a product" belongs where the list is.
 *
 * The fetch is debounced for the reason `/sales` gives: the search box drives the
 * same effect as every other filter, and a request per keystroke would hammer a
 * route that shares its IP rate-limit bucket with the whole pharmacy behind one
 * NAT. An in-flight response is cancelled when the filters move again.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { ProductModal } from '@/components/inventory/product-modal';
import {
  EXPIRY_TONE,
  EXPIRY_WORD,
  STOCK_LEVEL_TONE,
  STOCK_LEVEL_WORD,
} from '@/components/inventory/inventory-words';
import { Button } from '@/components/ui/button';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  Money,
  PageHeader,
  Spinner,
  StatusNotice,
} from '@/components/ui/display';
import { Field, Input } from '@/components/ui/field';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api-error-message';
import type { ProductBody, ProductListResponse, ProductRow, ProductWriteResponse } from '@/lib/api-types';
import { todayIso } from '@/lib/dates';
import { formatDate } from '@/lib/format';
import {
  daysUntilExpiry,
  EMPTY_INVENTORY_FILTERS,
  expiryState,
  productFiltersActive,
  productQueryFrom,
  stockLevel,
  type InventoryFilters,
} from '@/lib/inventory';

/** The backend's own `DEFAULT_LIST_LIMIT`, so a page is one server page. */
const PAGE_SIZE = 50;

export default function InventoryPage() {
  const { api, can } = useAuth();

  const [filters, setFilters] = useState<InventoryFilters>(EMPTY_INVENTORY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  const filtersActive = productFiltersActive(filters);
  const today = todayIso();
  const canWrite = can('inventory:product:write');

  // Distinct categories from the page in hand, offered as suggestions. There is no
  // inventory-scoped categories endpoint, and the filter is an exact match, so the
  // datalist is autocomplete over real data rather than a guess at the full set.
  const categories = [
    ...new Set(products.map((product) => product.category).filter((c): c is string => c !== null)),
  ].sort();

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      void (async () => {
        setLoading(true);
        setLoadError(null);
        try {
          const result = await api.get<ProductListResponse>('/inventory', {
            query: productQueryFrom(filters, PAGE_SIZE, offset),
          });
          if (cancelled) return;
          setProducts(result.products);
          setHasMore(result.products.length === PAGE_SIZE);
        } catch (error) {
          if (!cancelled) {
            setLoadError(apiErrorMessage(error, 'Could not load the product list.'));
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [api, filters, offset, reloadToken]);

  function update(patch: Partial<InventoryFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
  }

  function clearFilters() {
    setFilters(EMPTY_INVENTORY_FILTERS);
    setOffset(0);
  }

  async function onCreate(body: ProductBody) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.post<ProductWriteResponse>('/inventory', body);
      setCreating(false);
      setNotice(`Added ${result.product.name}.`);
      reload();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'Could not add the product.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Stock"
        subtitle="Every product, its on-hand count and its nearest expiry"
        actions={
          canWrite ? (
            <Button
              variant="primary"
              onClick={() => {
                setNotice(null);
                setSubmitError(null);
                setCreating(true);
              }}
            >
              Add product
            </Button>
          ) : undefined
        }
      />

      <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
        {notice !== null && <StatusNotice>{notice}</StatusNotice>}

        <Card>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Search" htmlFor="inventory-search">
              <Input
                id="inventory-search"
                placeholder="Name, code, generic or barcode"
                autoComplete="off"
                maxLength={120}
                value={filters.search}
                onChange={(event) => update({ search: event.target.value })}
              />
            </Field>
            <Field label="Category" htmlFor="inventory-category">
              <Input
                id="inventory-category"
                placeholder="Exact category name"
                autoComplete="off"
                list="inventory-categories"
                value={filters.category}
                onChange={(event) => update({ category: event.target.value })}
              />
            </Field>
          </div>
          <datalist id="inventory-categories">
            {categories.map((category) => (
              <option key={category} value={category} />
            ))}
          </datalist>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <label htmlFor="inventory-include-inactive" className="flex items-center gap-2 text-sm">
              <input
                id="inventory-include-inactive"
                type="checkbox"
                className="h-4 w-4 accent-primary-500"
                checked={filters.includeInactive}
                onChange={(event) => update({ includeInactive: event.target.checked })}
              />
              <span className="text-neutral-700">Include inactive products</span>
            </label>
            {filtersActive && (
              <Button variant="ghost" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </div>
        </Card>

        {loadError !== null && (
          <div className="space-y-3">
            <ErrorNotice>{loadError}</ErrorNotice>
            <Button variant="secondary" onClick={reload}>
              Try again
            </Button>
          </div>
        )}

        {loading && loadError === null && (
          <div className="flex justify-center p-12">
            <Spinner label="Loading products…" />
          </div>
        )}

        {!loading && loadError === null && products.length === 0 && (
          <Card padded={false}>
            <EmptyState
              title="No products found"
              message={
                filtersActive
                  ? 'No product matches these filters.'
                  : 'Add a product to start tracking its stock.'
              }
              action={
                canWrite && !filtersActive ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    Add product
                  </Button>
                ) : undefined
              }
            />
          </Card>
        )}

        {!loading && loadError === null && products.length > 0 && (
          <div className="space-y-3">
            <ul className="space-y-2">
              {products.map((product) => {
                const level = stockLevel(product.quantity, product.reorderLevel);
                const expiry = expiryState(daysUntilExpiry(product.expiryDate, today));
                return (
                  <li key={product.id}>
                    <Link href={`/inventory/${product.id}`} className="block">
                      <Card className="transition hover:bg-surface-50">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-medium text-neutral-900">{product.name}</p>
                              <Badge tone={STOCK_LEVEL_TONE[level]}>{STOCK_LEVEL_WORD[level]}</Badge>
                              {product.expiryDate !== null && expiry !== 'none' && (
                                <Badge tone={EXPIRY_TONE[expiry]}>{EXPIRY_WORD[expiry]}</Badge>
                              )}
                              {!product.isActive && <Badge tone="neutral">Inactive</Badge>}
                            </div>
                            <p className="mt-0.5 text-2xs text-neutral-500">
                              {product.code}
                              {product.category !== null ? ` · ${product.category}` : ''}
                              {product.expiryDate !== null
                                ? ` · expires ${formatDate(product.expiryDate)}`
                                : ''}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="text-base font-semibold text-neutral-900">
                              {product.quantity} <span className="text-2xs font-normal">units</span>
                            </p>
                            <Money value={product.unitPrice} className="text-2xs text-neutral-500" />
                          </div>
                        </div>
                      </Card>
                    </Link>
                  </li>
                );
              })}
            </ul>

            <div className="flex items-center justify-between gap-3">
              <Button
                variant="secondary"
                onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
                disabled={offset === 0 || loading}
              >
                Previous
              </Button>
              <span className="text-2xs text-neutral-500">
                {offset + 1}–{offset + products.length}
              </span>
              <Button
                variant="secondary"
                onClick={() => setOffset((current) => current + PAGE_SIZE)}
                disabled={!hasMore || loading}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>

      {canWrite && (
        <ProductModal
          open={creating}
          mode="create"
          product={null}
          submitting={submitting}
          error={submitError}
          onClose={() => setCreating(false)}
          onSubmit={onCreate}
        />
      )}
    </div>
  );
}
