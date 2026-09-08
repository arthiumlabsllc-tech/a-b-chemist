'use client';

/**
 * The catalogue half of the till: a search box, a category filter, an in-stock
 * toggle, and a grid of tiles the operator taps to add to the basket.
 *
 * ## What is server-side and what is not
 *
 * Search and category go back to `GET /sales/products`, debounced by the page,
 * because the catalogue is larger than one page and filtering a page in the
 * browser would hide products that are on the next one. The in-stock toggle is a
 * filter on the rows already here: `available` is on every `TillProduct`, and
 * asking the server for "only what I can sell" is a round trip to remove rows the
 * browser can remove itself.
 *
 * ## The tile is a button
 *
 * A real `<button>`, not a `<div onClick>`. `next/core-web-vitals` runs
 * `jsx-a11y`, which rejects a click handler on a non-interactive element, and the
 * lint is encoding the product point: a tile is the one thing on this screen that
 * gets tapped four hundred times a day, so it has to be focusable, keyboard-
 * reachable and announced as a button. It is disabled when the drawer cannot
 * fill it, and a disabled tile still says why — "Out of stock" — rather than
 * looking tappable and then doing nothing.
 *
 * ## The price on the tile is a preview
 *
 * `unitPricePesewas` is the same shared arithmetic the basket and the server use,
 * but a tile price is not what the customer is charged: `/quote` before the
 * payment modal is. A product whose stored price cannot be parsed renders "No
 * price" and is disabled, which is the client half of the backend refusing an
 * unpriceable product — same shape of answer, because in both cases the person at
 * the counter cannot fix it and the owner can.
 */

import { useId } from 'react';

import { controlClass } from '@/components/ui/field';
import { EmptyState, ErrorNotice, Spinner } from '@/components/ui/display';
import { cediText, unitPricePesewas } from '@/lib/pricing';
import type { TillProduct } from '@/lib/api-types';

export interface ProductGridProps {
  products: readonly TillProduct[];
  loading: boolean;
  error: string | null;
  search: string;
  onSearchChange: (value: string) => void;
  categories: readonly string[];
  category: string;
  onCategoryChange: (value: string) => void;
  onlyInStock: boolean;
  onOnlyInStockChange: (value: boolean) => void;
  onAdd: (product: TillProduct) => void;
  onRetry: () => void;
}

function unitLabel(product: TillProduct): string {
  return product.defaultSellUnit === 'pack' ? 'pack' : 'each';
}

function ProductTile({
  product,
  onAdd,
}: {
  product: TillProduct;
  onAdd: (product: TillProduct) => void;
}) {
  const price = unitPricePesewas(product.baseUnitPrice, product.packSize, product.defaultSellUnit);
  const sellable = product.available > 0;
  const priceable = price !== null;
  const disabled = !sellable || !priceable;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onAdd(product)}
      className={[
        'flex min-h-touch-lg flex-col justify-between rounded-lg border p-3 text-left transition-colors',
        disabled
          ? 'cursor-not-allowed border-surface-200 bg-surface-50 opacity-70'
          : 'border-surface-200 bg-white hover:border-primary-400 hover:bg-primary-50 active:bg-primary-100',
      ].join(' ')}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-neutral-900">{product.name}</span>
        <span className="mt-0.5 block truncate text-2xs text-neutral-500">
          {product.genericName ?? product.code}
        </span>
      </span>

      <span className="mt-2 flex items-end justify-between gap-2">
        <span className="money text-sm font-semibold text-primary-700">
          {priceable ? cediText(price) : 'No price'}
          <span className="ml-1 font-sans text-2xs font-normal text-neutral-500">
            / {unitLabel(product)}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          {product.requiresPrescription && (
            <span className="rounded-full border border-accent-300 bg-accent-50 px-1.5 text-2xs font-semibold text-accent-900">
              Rx
            </span>
          )}
          <span
            className={[
              'text-2xs font-medium',
              sellable ? 'text-neutral-600' : 'text-danger-600',
            ].join(' ')}
          >
            {sellable ? `${product.available} in stock` : 'Out of stock'}
          </span>
        </span>
      </span>
    </button>
  );
}

export function ProductGrid({
  products,
  loading,
  error,
  search,
  onSearchChange,
  categories,
  category,
  onCategoryChange,
  onlyInStock,
  onOnlyInStockChange,
  onAdd,
  onRetry,
}: ProductGridProps) {
  const searchId = useId();
  const categoryId = useId();
  const inStockId = useId();

  const shown = onlyInStock ? products.filter((product) => product.available > 0) : products;

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Products">
      <div className="border-b border-surface-200 bg-white p-3 sm:p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex-1">
            <label className="sr-only" htmlFor={searchId}>
              Search products
            </label>
            <input
              id={searchId}
              type="search"
              value={search}
              // Debounced by the page: this only updates the input and the
              // effect that re-fetches waits for the operator to stop typing.
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search by name, code or barcode"
              autoComplete="off"
              className={controlClass}
            />
          </div>
          <div className="sm:w-52">
            <label className="sr-only" htmlFor={categoryId}>
              Category
            </label>
            <select
              id={categoryId}
              value={category}
              onChange={(event) => onCategoryChange(event.target.value)}
              className={controlClass}
            >
              <option value="">All categories</option>
              {categories.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <label
            htmlFor={inStockId}
            className="flex min-h-touch w-fit cursor-pointer items-center gap-2 text-sm text-neutral-700"
          >
            <input
              id={inStockId}
              type="checkbox"
              checked={onlyInStock}
              onChange={(event) => onOnlyInStockChange(event.target.checked)}
              className="h-4 w-4 rounded border-surface-300 text-primary-600 focus:ring-primary-200"
            />
            In stock only
          </label>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
        {error !== null ? (
          <div className="space-y-3">
            <ErrorNotice>{error}</ErrorNotice>
            <button
              type="button"
              onClick={onRetry}
              className="min-h-touch rounded-md border border-surface-300 bg-white px-3 text-sm font-medium text-neutral-800 hover:bg-surface-100"
            >
              Try again
            </button>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-3 py-16 text-sm text-neutral-600">
            <Spinner label="Loading products" className="h-6 w-6 border-2" />
            Loading products…
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            title={products.length === 0 ? 'No products yet' : 'Nothing matches that'}
            message={
              products.length === 0
                ? 'Add products under Inventory, or import a CSV, and they will appear here.'
                : 'Try a different search, clear the category filter, or turn off in-stock only.'
            }
          />
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {shown.map((product) => (
              <ProductTile key={product.id} product={product} onAdd={onAdd} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
