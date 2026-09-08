'use client';

/**
 * The product dialog `/inventory` opens to add a product and `/inventory/[id]`
 * opens to edit one.
 *
 * One component, two modes, because the fields are the same and only two rules
 * differ: `code` is required and editable on create and immutable on edit (it is
 * not in the backend's `ProductPatch`, so sending it changes nothing), and the
 * page decides POST from PATCH. The dialog builds a `ProductBody` and hands it up;
 * it never knows the verb or the id.
 *
 * Optional text is sent as `null` when empty rather than omitted, so editing is a
 * full replace of the editable fields: clearing the category really clears it.
 */

import { useEffect, useState } from 'react';

import { SELL_UNITS, VAT_TREATMENTS } from 'a-and-b-chemist-shared';

import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/display';
import { Field, Input, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { shownError, useTouchedFields } from '@/hooks/use-touched';
import { PRODUCT_LIMITS } from '@/lib/api-types';
import type { ProductBody, ProductRow, SellUnit, VatTreatment } from '@/lib/api-types';
import { moneyBody, optionalText, quantityBody, requiredText } from '@/lib/inventory';

import { SELL_UNIT_WORD, VAT_TREATMENT_WORD } from './inventory-words';

export interface ProductModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  /** The product being edited; null in create mode. */
  product: ProductRow | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: ProductBody) => void;
}

interface ProductDraft {
  name: string;
  code: string;
  genericName: string;
  category: string;
  manufacturer: string;
  shelfLocation: string;
  barcode: string;
  packSize: string;
  defaultSellUnit: SellUnit;
  requiresPrescription: boolean;
  reorderLevel: string;
  unitPrice: string;
  vatTreatment: VatTreatment;
  isActive: boolean;
}

function draftFrom(product: ProductRow | null): ProductDraft {
  if (product === null) {
    return {
      name: '',
      code: '',
      genericName: '',
      category: '',
      manufacturer: '',
      shelfLocation: '',
      barcode: '',
      packSize: '1',
      defaultSellUnit: 'single',
      requiresPrescription: false,
      reorderLevel: '0',
      unitPrice: '',
      vatTreatment: 'exempt',
      isActive: true,
    };
  }
  return {
    name: product.name,
    code: product.code,
    genericName: product.genericName ?? '',
    category: product.category ?? '',
    manufacturer: product.manufacturer ?? '',
    shelfLocation: product.shelfLocation ?? '',
    barcode: product.barcode ?? '',
    packSize: String(product.packSize),
    defaultSellUnit: product.defaultSellUnit,
    requiresPrescription: product.requiresPrescription,
    reorderLevel: String(product.reorderLevel),
    unitPrice: product.unitPrice,
    vatTreatment: product.vatTreatment,
    isActive: product.isActive,
  };
}

/** Empty becomes null, so an optional field the operator cleared really clears. */
function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function ProductModal({
  open,
  mode,
  product,
  submitting,
  error,
  onClose,
  onSubmit,
}: ProductModalProps) {
  const [draft, setDraft] = useState<ProductDraft>(() => draftFrom(product));
  const { touched, touch, resetTouched } = useTouchedFields();

  useEffect(() => {
    if (open) {
      setDraft(draftFrom(product));
      resetTouched();
    }
  }, [open, product, resetTouched]);

  function set<K extends keyof ProductDraft>(key: K, value: ProductDraft[K]): void {
    touch(key);
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const nameError = requiredText(draft.name, 'the product name', PRODUCT_LIMITS.name.max);
  const codeError =
    mode === 'create' ? requiredText(draft.code, 'a product code', PRODUCT_LIMITS.code.max) : null;
  const genericError = optionalText(draft.genericName, 'the generic name', PRODUCT_LIMITS.genericName.max);
  const categoryError = optionalText(draft.category, 'the category', PRODUCT_LIMITS.category.max);
  const manufacturerError = optionalText(
    draft.manufacturer,
    'the manufacturer',
    PRODUCT_LIMITS.manufacturer.max
  );
  const shelfError = optionalText(draft.shelfLocation, 'the shelf location', PRODUCT_LIMITS.shelfLocation.max);
  const barcodeError = optionalText(draft.barcode, 'the barcode', PRODUCT_LIMITS.barcode.max);
  const packSize = quantityBody(
    draft.packSize,
    'the pack size',
    PRODUCT_LIMITS.packSize.min,
    PRODUCT_LIMITS.packSize.max
  );
  const reorderLevel = quantityBody(
    draft.reorderLevel,
    'the reorder level',
    PRODUCT_LIMITS.reorderLevel.min,
    PRODUCT_LIMITS.reorderLevel.max
  );
  const unitPrice = moneyBody(draft.unitPrice, 'the unit price');

  const canSubmit =
    nameError === null &&
    codeError === null &&
    genericError === null &&
    categoryError === null &&
    manufacturerError === null &&
    shelfError === null &&
    barcodeError === null &&
    packSize.ok &&
    reorderLevel.ok &&
    unitPrice.ok &&
    !submitting;

  function submit() {
    // `canSubmit` already refused on any text error; the three value results are
    // re-checked so TypeScript narrows them to their `ok` branch.
    if (!canSubmit || !packSize.ok || !reorderLevel.ok || !unitPrice.ok) return;
    onSubmit({
      name: draft.name.trim(),
      ...(mode === 'create' ? { code: draft.code.trim() } : {}),
      genericName: textOrNull(draft.genericName),
      category: textOrNull(draft.category),
      manufacturer: textOrNull(draft.manufacturer),
      shelfLocation: textOrNull(draft.shelfLocation),
      barcode: textOrNull(draft.barcode),
      packSize: packSize.quantity,
      defaultSellUnit: draft.defaultSellUnit,
      requiresPrescription: draft.requiresPrescription,
      reorderLevel: reorderLevel.quantity,
      unitPrice: unitPrice.amount,
      vatTreatment: draft.vatTreatment,
      isActive: draft.isActive,
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={mode === 'create' ? 'Add a product' : `Edit ${product?.name ?? 'product'}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} disabled={!canSubmit} onClick={submit}>
            {mode === 'create' ? 'Add product' : 'Save changes'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error !== null && <ErrorNotice>{error}</ErrorNotice>}
        <Field
          label="Name"
          htmlFor="product-name"
          hint="As it appears on the box."
          error={shownError(touched, 'name', nameError)}
          required
        >
          <Input
            id="product-name"
            value={draft.name}
            autoComplete="off"
            onChange={(event) => set('name', event.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Code"
            htmlFor="product-code"
            hint={mode === 'edit' ? 'A product code cannot be changed after creation.' : 'Your own short code.'}
            error={shownError(touched, 'code', codeError)}
            required={mode === 'create'}
          >
            <Input
              id="product-code"
              value={draft.code}
              disabled={mode === 'edit'}
              autoComplete="off"
              onChange={(event) => set('code', event.target.value)}
            />
          </Field>
          <Field label="Category" htmlFor="product-category" error={categoryError ?? undefined}>
            <Input
              id="product-category"
              value={draft.category}
              autoComplete="off"
              onChange={(event) => set('category', event.target.value)}
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Generic name" htmlFor="product-generic" error={genericError ?? undefined}>
            <Input
              id="product-generic"
              value={draft.genericName}
              autoComplete="off"
              onChange={(event) => set('genericName', event.target.value)}
            />
          </Field>
          <Field label="Manufacturer" htmlFor="product-manufacturer" error={manufacturerError ?? undefined}>
            <Input
              id="product-manufacturer"
              value={draft.manufacturer}
              autoComplete="off"
              onChange={(event) => set('manufacturer', event.target.value)}
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Pack size"
            htmlFor="product-packsize"
            hint="Base units in one pack. 1 if it is only sold singly."
            error={shownError(touched, 'packSize', packSize.ok ? null : packSize.message)}
            required
          >
            <Input
              id="product-packsize"
              type="text"
              inputMode="numeric"
              value={draft.packSize}
              onChange={(event) => set('packSize', event.target.value)}
            />
          </Field>
          <Field label="Sells as" htmlFor="product-sellunit">
            <Select
              id="product-sellunit"
              value={draft.defaultSellUnit}
              onChange={(event) => set('defaultSellUnit', event.target.value as SellUnit)}
            >
              {SELL_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {SELL_UNIT_WORD[unit]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Unit price"
            htmlFor="product-price"
            hint="Per base unit, for example 0.85."
            error={shownError(touched, 'unitPrice', unitPrice.ok ? null : unitPrice.message)}
            required
          >
            <Input
              id="product-price"
              type="text"
              inputMode="decimal"
              value={draft.unitPrice}
              onChange={(event) => set('unitPrice', event.target.value)}
            />
          </Field>
          <Field label="VAT treatment" htmlFor="product-vat">
            <Select
              id="product-vat"
              value={draft.vatTreatment}
              onChange={(event) => set('vatTreatment', event.target.value as VatTreatment)}
            >
              {VAT_TREATMENTS.map((treatment) => (
                <option key={treatment} value={treatment}>
                  {VAT_TREATMENT_WORD[treatment]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Reorder level"
            htmlFor="product-reorder"
            hint="Flag the product as low at or under this many units. 0 for none."
            error={shownError(touched, 'reorderLevel', reorderLevel.ok ? null : reorderLevel.message)}
          >
            <Input
              id="product-reorder"
              type="text"
              inputMode="numeric"
              value={draft.reorderLevel}
              onChange={(event) => set('reorderLevel', event.target.value)}
            />
          </Field>
          <Field label="Shelf location" htmlFor="product-shelf" error={shelfError ?? undefined}>
            <Input
              id="product-shelf"
              value={draft.shelfLocation}
              autoComplete="off"
              onChange={(event) => set('shelfLocation', event.target.value)}
            />
          </Field>
        </div>
        <Field label="Barcode" htmlFor="product-barcode" error={barcodeError ?? undefined}>
          <Input
            id="product-barcode"
            value={draft.barcode}
            autoComplete="off"
            onChange={(event) => set('barcode', event.target.value)}
          />
        </Field>
        <label
          htmlFor="product-rx"
          className="flex items-start gap-3 rounded-md border border-surface-200 p-3"
        >
          <input
            id="product-rx"
            type="checkbox"
            className="mt-0.5 h-5 w-5 accent-primary-500"
            checked={draft.requiresPrescription}
            onChange={(event) => set('requiresPrescription', event.target.checked)}
          />
          <span className="text-sm">
            <span className="font-medium text-neutral-800">Needs a prescription</span>
            <span className="mt-0.5 block text-neutral-600">
              A pharmacist must approve the sale before it rings.
            </span>
          </span>
        </label>
        <label
          htmlFor="product-active"
          className="flex items-start gap-3 rounded-md border border-surface-200 p-3"
        >
          <input
            id="product-active"
            type="checkbox"
            className="mt-0.5 h-5 w-5 accent-primary-500"
            checked={draft.isActive}
            onChange={(event) => set('isActive', event.target.checked)}
          />
          <span className="text-sm">
            <span className="font-medium text-neutral-800">Active</span>
            <span className="mt-0.5 block text-neutral-600">
              Off hides it from the till and the default product list. Stock already on hand is
              kept.
            </span>
          </span>
        </label>
      </div>
    </Modal>
  );
}
