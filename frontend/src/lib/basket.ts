/**
 * The open basket at the till, as a pure reducer.
 *
 * ## Why a reducer in `lib` and not a store
 *
 * The basket lives and dies on `/pos`: nobody navigates away mid-sale expecting
 * it to survive, and Phase 9's offline queue persists a *submitted* sale, not an
 * in-progress one. So there is no reason to make it global state, and every
 * reason to make it a pure function — `useReducer` in the page, and a suite here
 * that drives every transition without rendering anything. That is the same
 * split the codebase already draws: the deciding is a pure function with a test
 * (`route-guard`, `pricing`), and the component that calls it is thin.
 *
 * ## Line identity
 *
 * A line is keyed `productId:sellUnit`, not by product. `pricing.ts` says why the
 * same product may legitimately occupy two lines — a strip sold per tablet and a
 * strip sold per box — and keying by product would collapse them into one the
 * drawer did not ring. Keying by product *and* unit also makes a second tap on a
 * tile do the obvious thing: increment the line already there rather than stack a
 * duplicate, while a deliberate "sell as pack" beside a "sell as single" stays
 * two lines.
 *
 * ## What this does not do
 *
 * It does not price. `pricing.ts` prices the lines this holds, on every render,
 * and the server prices them again at `/quote`. Nothing here touches money beyond
 * storing the discount the operator typed, as whole pesewas, which is the unit
 * `pricing.ts` and the shared engine both work in.
 */

import type { SellUnit } from 'a-and-b-chemist-shared';

import type { TillProduct } from './api-types';
import { basketLineFor, maxQuantityFor } from './pricing';
import type { BasketLine } from './pricing';

export interface BasketState {
  lines: BasketLine[];
  /** Whole pesewas. Zero means no discount; the reason is only sent with one. */
  discountPesewas: number;
  discountReason: string;
}

export type BasketAction =
  | { type: 'add'; product: TillProduct; sellUnit?: SellUnit }
  | { type: 'set-quantity'; lineId: string; quantity: number }
  | { type: 'set-sell-unit'; lineId: string; sellUnit: SellUnit }
  | { type: 'remove'; lineId: string }
  | { type: 'set-discount'; pesewas: number; reason: string }
  | { type: 'clear' };

export const EMPTY_BASKET: BasketState = {
  lines: [],
  discountPesewas: 0,
  discountReason: '',
};

/** The line key for a product sold in a unit. Stable, so a re-tap finds it. */
export function lineIdFor(productId: string, sellUnit: SellUnit): string {
  return `${productId}:${sellUnit}`;
}

export function basketLineCount(state: BasketState): number {
  return state.lines.reduce((total, line) => total + line.quantity, 0);
}

export function basketIsEmpty(state: BasketState): boolean {
  return state.lines.length === 0;
}

/**
 * Adds one selling unit of a product, incrementing the line if it is already
 * there.
 *
 * Capped at what the till says is available *when it can say it*. `maxQuantityFor`
 * returns null whenever the requested unit differs from the product's default,
 * because the available figure is floored to whole packs and converting it would
 * be a guess — and refusing a sale the server would accept is worse than an
 * unbounded stepper that `/quote` then reports a shortfall for. So the cap is
 * applied exactly when it is known to be correct, and otherwise the operator is
 * left to be told by the quote.
 */
function addLine(state: BasketState, product: TillProduct, sellUnit?: SellUnit): BasketState {
  const unit = sellUnit ?? product.defaultSellUnit;
  const lineId = lineIdFor(product.id, unit);
  const max = maxQuantityFor(product, unit);

  const existing = state.lines.find((line) => line.lineId === lineId);
  if (existing !== undefined) {
    const next = existing.quantity + 1;
    // At the ceiling already: nothing to add, and adding would be a quantity the
    // till itself said cannot be handed over.
    if (max !== null && next > max) {
      return state;
    }
    return {
      ...state,
      lines: state.lines.map((line) =>
        line.lineId === lineId ? { ...line, quantity: next } : line
      ),
    };
  }

  // A new line the till knows cannot be filled is not added at all: an
  // out-of-stock tile that rings up a line the quote then rejects is a sale that
  // stalls at the payment step in front of the customer.
  if (max !== null && max < 1) {
    return state;
  }
  return { ...state, lines: [...state.lines, basketLineFor(product, lineId, unit, 1)] };
}

/**
 * Changes a line's selling unit, which changes its key.
 *
 * When the unit it is changing to is already on another line, the two are merged
 * rather than left as a duplicate key: pack and single of the same product are
 * only separate lines while their units differ, and the moment an operator moves
 * one onto the other's unit they are the same line again.
 */
function setSellUnit(state: BasketState, lineId: string, sellUnit: SellUnit): BasketState {
  const target = state.lines.find((line) => line.lineId === lineId);
  if (target === undefined || target.sellUnit === sellUnit) {
    return state;
  }

  const newLineId = lineIdFor(target.productId, sellUnit);
  const collides = state.lines.some((line) => line.lineId === newLineId);

  if (collides) {
    return {
      ...state,
      lines: state.lines
        .filter((line) => line.lineId !== lineId)
        .map((line) =>
          line.lineId === newLineId
            ? { ...line, quantity: line.quantity + target.quantity }
            : line
        ),
    };
  }

  return {
    ...state,
    lines: state.lines.map((line) =>
      line.lineId === lineId ? { ...line, lineId: newLineId, sellUnit } : line
    ),
  };
}

export function basketReducer(state: BasketState, action: BasketAction): BasketState {
  switch (action.type) {
    case 'add':
      return addLine(state, action.product, action.sellUnit);

    case 'set-quantity': {
      // Below one is a removal, not a zero-quantity line: the engine prices a
      // quantity of zero as an empty basket and the receipt would show a line
      // that charged nothing and drew no stock.
      if (action.quantity < 1) {
        return { ...state, lines: state.lines.filter((line) => line.lineId !== action.lineId) };
      }
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.lineId === action.lineId ? { ...line, quantity: action.quantity } : line
        ),
      };
    }

    case 'set-sell-unit':
      return setSellUnit(state, action.lineId, action.sellUnit);

    case 'remove': {
      // Returning the same reference when the line is not there is not a
      // micro-optimisation: `useReducer` re-renders on a new state object, and a
      // remove dispatched for a line already gone (a double tap on the bin icon)
      // would otherwise repaint the whole till for nothing.
      const present = state.lines.some((line) => line.lineId === action.lineId);
      if (!present) {
        return state;
      }
      return { ...state, lines: state.lines.filter((line) => line.lineId !== action.lineId) };
    }

    case 'set-discount':
      // Clamped at zero. A negative discount is a surcharge, which this till does
      // not have a notion of and the engine would refuse; the field is money the
      // operator is taking off, and the smallest amount off is nothing.
      return {
        ...state,
        discountPesewas: Math.max(0, action.pesewas),
        discountReason: action.reason,
      };

    case 'clear':
      return EMPTY_BASKET;

    default:
      return state;
  }
}
