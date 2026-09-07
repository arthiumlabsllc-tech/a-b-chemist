'use client';

/**
 * The basket half of the till: the lines the operator has tapped, a discount, the
 * running totals, and the button that goes to the payment modal.
 *
 * ## The totals are a preview, and are labelled as one
 *
 * Everything here is priced on the device by `priceTillBasket`, which calls the
 * same shared engine the server calls. It is still not what the customer is
 * charged: pressing the button calls `POST /sales/quote`, and the payment modal
 * shows the *server's* total. The two agree unless a price or a rate moved since
 * the grid loaded, and when they do the server wins and the modal says so. That
 * is why this panel is comfortable showing a total that is, strictly, an estimate.
 *
 * ## Except offline, when the preview is the charge
 *
 * With `offline` set there is no quote coming to supersede this figure — it is the
 * amount the customer will be asked for, and the sale will be held on the device
 * against it. So the VAT/NHIL/GETFund line disappears and the total is labelled
 * provisional. That is BRIEF.md §4.5's "never fabricate a tax split offline"
 * applied where it is easiest to miss: the split this panel shows online is
 * harmless because a server figure replaces it seconds later, and the same numbers
 * shown with no replacement on the way are a tax statement to a customer that no
 * server engine ever made. The subtotal and the discount stay, because those are
 * facts about what was tapped and what was taken off rather than claims about tax.
 *
 * ## Why `priced` can be null
 *
 * Null means the till has no tax settings, so it never asked the engine anything.
 * That is not a `TillPriceFailure`: the type carries an engine code, and borrowing
 * `basket_has_no_value` to mean "the rates did not load" would put a lie in a
 * typed field for the sake of reusing a branch. It becomes reachable in Phase 9 —
 * a tablet booting offline with a cached catalogue but no cached rates — and the
 * two cases need different sentences because only one of them has a Reload button.
 *
 * ## The discount reason is enforced here as well as in the engine
 *
 * The shared engine refuses a discount with an *empty* reason. The API refuses one
 * with a reason shorter than `SALE_LIMITS.discountReason.min` — three characters —
 * and the engine does not know that number. So the panel checks the length itself
 * and holds the button, because the alternative is an operator pressing Charge,
 * waiting for the round trip, and being told the reason they can already see is
 * too short. A discount with no lines is meaningless, so the fields reset when the
 * basket empties, which is also how the parent's Clear and a completed sale wipe
 * them.
 */

import { useEffect, useId, useState } from 'react';
import type { Dispatch } from 'react';

import { Button } from '@/components/ui/button';
import { controlClass } from '@/components/ui/field';
import { ErrorNotice } from '@/components/ui/display';
import { basketIsEmpty, basketLineCount } from '@/lib/basket';
import type { BasketAction, BasketState } from '@/lib/basket';
import { cediText, lineUnitPrice, parseCediInput } from '@/lib/pricing';
import type { PricedTillBasket } from '@/lib/pricing';
import { SALE_LIMITS } from '@/lib/api-types';

export interface BasketPanelProps {
  basket: BasketState;
  dispatch: Dispatch<BasketAction>;
  /** Null when the till has no tax settings and so has priced nothing at all. */
  priced: PricedTillBasket | null;
  /** True when the server could not be reached, so this total is the charge. */
  offline: boolean;
  /** True while `POST /sales/quote` is in flight. */
  quoting: boolean;
  onCharge: () => void;
}

function StepperButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-md border border-surface-300 bg-white text-lg font-semibold text-neutral-700 hover:bg-surface-100 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label === 'Decrease quantity' ? '\u2212' : '+'}
    </button>
  );
}

export function BasketPanel({ basket, dispatch, priced, offline, quoting, onCharge }: BasketPanelProps) {
  const discountId = useId();
  const reasonId = useId();

  // The raw text of the two discount fields, held here rather than derived from
  // the basket so the operator can pass through '5.' and '' on the way to '5.50'.
  const [discountText, setDiscountText] = useState('');
  const [reasonText, setReasonText] = useState('');

  // A discount on an empty basket is meaningless, and emptying is how Clear and a
  // completed sale both arrive — so this is the one place the local text is reset
  // from outside itself.
  const lineCount = basketLineCount(basket);
  useEffect(() => {
    if (lineCount === 0) {
      setDiscountText('');
      setReasonText('');
    }
  }, [lineCount]);

  function onDiscountTextChange(text: string) {
    setDiscountText(text);
    dispatch({ type: 'set-discount', pesewas: parseCediInput(text) ?? 0, reason: reasonText });
  }

  function onReasonTextChange(text: string) {
    setReasonText(text);
    dispatch({ type: 'set-discount', pesewas: basket.discountPesewas, reason: text });
  }

  const reasonTooShort =
    basket.discountPesewas > 0 &&
    basket.discountReason.trim().length < SALE_LIMITS.discountReason.min;

  const empty = basketIsEmpty(basket);
  const total = priced?.ok === true ? priced.basket.total : 0;
  const canCharge = !empty && priced?.ok === true && !reasonTooShort && !quoting;

  return (
    <section
      className="flex min-h-0 w-full flex-col border-surface-200 bg-white lg:w-96 lg:shrink-0 lg:border-l"
      aria-label="Basket"
    >
      <div className="flex items-center justify-between gap-2 border-b border-surface-200 px-4 py-3">
        <h2 className="text-base font-semibold text-neutral-900">
          Basket
          <span className="ml-2 text-sm font-normal text-neutral-500">
            {lineCount} {lineCount === 1 ? 'item' : 'items'}
          </span>
        </h2>
        <Button
          variant="ghost"
          size="md"
          disabled={empty}
          onClick={() => dispatch({ type: 'clear' })}
        >
          Clear
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {empty ? (
          <p className="px-4 py-10 text-center text-sm text-neutral-500">
            Tap a product to start a sale.
          </p>
        ) : (
          <ul className="divide-y divide-surface-200">
            {basket.lines.map((line) => {
              const pricedLine = priced?.ok === true
                ? priced.basket.lines.find((candidate) => candidate.id === line.lineId)
                : undefined;
              const unit = lineUnitPrice(line);
              return (
                <li key={line.lineId} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-neutral-900">{line.name}</p>
                      <p className="mt-0.5 text-2xs text-neutral-500">
                        {unit === null ? 'No price' : `${cediText(unit)} per ${line.sellUnit}`}
                        {line.requiresPrescription && (
                          <span className="ml-1 font-semibold text-accent-800">· Rx</span>
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${line.name}`}
                      onClick={() => dispatch({ type: 'remove', lineId: line.lineId })}
                      className="-mr-1 inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-surface-100 hover:text-danger-600"
                    >
                      <span aria-hidden="true" className="text-xl leading-none">
                        {'\u00d7'}
                      </span>
                    </button>
                  </div>

                  <div className="mt-2 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1">
                      <StepperButton
                        label="Decrease quantity"
                        onClick={() =>
                          dispatch({
                            type: 'set-quantity',
                            lineId: line.lineId,
                            quantity: line.quantity - 1,
                          })
                        }
                      />
                      <span
                        aria-label={`Quantity ${line.quantity}`}
                        className="min-w-touch text-center text-base font-semibold tabular-nums text-neutral-900"
                      >
                        {line.quantity}
                      </span>
                      <StepperButton
                        label="Increase quantity"
                        onClick={() =>
                          dispatch({
                            type: 'set-quantity',
                            lineId: line.lineId,
                            quantity: line.quantity + 1,
                          })
                        }
                      />
                    </div>

                    {line.packSize > 1 && (
                      <div className="flex overflow-hidden rounded-md border border-surface-300">
                        {(['single', 'pack'] as const).map((sellUnit) => (
                          <button
                            key={sellUnit}
                            type="button"
                            onClick={() =>
                              dispatch({ type: 'set-sell-unit', lineId: line.lineId, sellUnit })
                            }
                            aria-pressed={line.sellUnit === sellUnit}
                            className={[
                              'min-h-touch px-2 text-2xs font-semibold capitalize',
                              line.sellUnit === sellUnit
                                ? 'bg-primary-500 text-white'
                                : 'bg-white text-neutral-600 hover:bg-surface-100',
                            ].join(' ')}
                          >
                            {sellUnit}
                          </button>
                        ))}
                      </div>
                    )}

                    <span className="money ml-auto text-sm font-semibold text-neutral-900">
                      {pricedLine === undefined ? '—' : cediText(pricedLine.lineTotal)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {!empty && (
        <div className="space-y-3 border-t border-surface-200 px-4 py-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-2xs font-medium text-neutral-600" htmlFor={discountId}>
                Discount (GHS)
              </label>
              <input
                id={discountId}
                type="text"
                inputMode="decimal"
                value={discountText}
                onChange={(event) => onDiscountTextChange(event.target.value)}
                placeholder="0.00"
                className={[controlClass, 'mt-1 min-h-touch text-sm'].join(' ')}
              />
            </div>
            <div>
              <label className="block text-2xs font-medium text-neutral-600" htmlFor={reasonId}>
                Reason
              </label>
              <input
                id={reasonId}
                type="text"
                value={reasonText}
                onChange={(event) => onReasonTextChange(event.target.value)}
                placeholder="Why"
                className={[controlClass, 'mt-1 min-h-touch text-sm'].join(' ')}
              />
            </div>
          </div>

          {reasonTooShort && (
            <p className="text-2xs text-danger-700">
              A discount needs a reason of at least {SALE_LIMITS.discountReason.min} characters.
            </p>
          )}

          {priced === null ? (
            <p className="text-2xs text-neutral-500">
              The tax settings are not loaded, so this basket cannot be priced yet.
            </p>
          ) : priced.ok ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between text-neutral-600">
                <dt>Subtotal</dt>
                <dd className="money">{cediText(priced.basket.subtotal)}</dd>
              </div>
              {priced.basket.discount > 0 && (
                <div className="flex justify-between text-neutral-600">
                  <dt>Discount</dt>
                  <dd className="money">&minus; {cediText(priced.basket.discount)}</dd>
                </div>
              )}
              <div className="flex justify-between border-t border-surface-200 pt-2 text-base font-semibold text-neutral-900">
                <dt>Total</dt>
                <dd className="money">{cediText(priced.basket.total)}</dd>
              </div>
              {offline ? (
                <div className="pt-1 text-2xs text-neutral-500">
                  Provisional — priced on this device. The VAT, NHIL and GETFund breakdown follows
                  once the server records the sale.
                </div>
              ) : (
                <div className="pt-1 text-2xs text-neutral-500">
                  {priced.basket.rates.taxInclusivePricing ? 'Includes' : 'Plus'} VAT{' '}
                  {cediText(priced.basket.vatAmount)} · NHIL {cediText(priced.basket.nhilAmount)} ·
                  GETFund {cediText(priced.basket.getfundAmount)}
                </div>
              )}
            </dl>
          ) : (
            <ErrorNotice>{priced.failure.message}</ErrorNotice>
          )}

          <Button
            variant="accent"
            size="lg"
            block
            loading={quoting}
            disabled={!canCharge}
            onClick={onCharge}
          >
            {quoting ? 'Checking…' : `Charge ${cediText(total)}`}
          </Button>
        </div>
      )}
    </section>
  );
}
