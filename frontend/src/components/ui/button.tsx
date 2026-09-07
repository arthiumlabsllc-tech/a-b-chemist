'use client';

/**
 * Buttons.
 *
 * One component rather than class strings copied into seven pages, for the same
 * reason `navigation.ts` exists: a till where "primary" is `bg-primary-500` on
 * one screen and `bg-primary-600` on the next is a till nobody can read at a
 * glance, and the drift is invisible until the screens are side by side.
 *
 * Every button is at least `min-h-touch` (44px) and `md` by default. The config
 * calls the touch target a product decision rather than taste and it is: this is
 * operated standing up, on a touchscreen, in a hurry, sometimes in gloves. A
 * mis-tap here is not an annoyance, it is a screen the cashier did not mean to
 * open in front of a queue.
 *
 * `type` defaults to `'button'`, not the HTML default `'submit'`. Most of these
 * sit inside a form (a payment modal, a stock adjust) where an accidental submit
 * posts half-entered data; the one place that wants a submit says so explicitly.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'accent' | 'danger' | 'secondary' | 'ghost';
export type ButtonSize = 'md' | 'lg';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-primary-500 text-white hover:bg-primary-600 active:bg-primary-700',
  accent: 'bg-accent-500 text-neutral-900 hover:bg-accent-600 active:bg-accent-700',
  danger: 'bg-danger-500 text-white hover:bg-danger-600 active:bg-danger-700',
  secondary:
    'border border-surface-300 bg-white text-neutral-800 hover:bg-surface-100 active:bg-surface-200',
  ghost: 'text-neutral-700 hover:bg-surface-100 active:bg-surface-200',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  md: 'min-h-touch px-3 text-sm',
  lg: 'min-h-touch-lg px-4 text-base',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full width, for the one action that owns the bottom of a modal or card. */
  block?: boolean;
  /** Shows a spinner and disables. The label stays so the button does not jump. */
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  block = false,
  loading = false,
  className,
  disabled,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled === true || loading;
  return (
    <button
      type={type}
      disabled={isDisabled}
      className={[
        'inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-60',
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        block ? 'w-full' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {loading && <ButtonSpinner />}
      {children}
    </button>
  );
}

function ButtonSpinner() {
  // `border-current` so the spinner takes the button's own text colour: white on
  // a filled button, dark on the accent gold. A hard-coded colour would vanish
  // against one of them.
  return (
    <span
      aria-hidden="true"
      className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}
