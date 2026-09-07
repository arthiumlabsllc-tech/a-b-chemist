'use client';

/**
 * Form controls and the label/hint/error scaffolding around them.
 *
 * `controlClass` is exported on its own as well as being baked into `Input`,
 * `Select` and `Textarea`, because a page sometimes needs the exact control
 * styling on an element these three do not cover — a quantity stepper, a search
 * box with an icon inside it — and the point is that it looks like every other
 * control on the screen, not that it is one of these three components.
 *
 * Controls are `min-h-touch-lg` (48px) and `text-base`. The larger touch target
 * is the same counter argument as the button. `text-base` is not a rounding of
 * taste either: iOS Safari zooms the page on focus of any input below 16px, and
 * a till that zooms when the cashier taps the discount field loses the basket
 * off the top of the screen mid-sale.
 *
 * `Field` renders the label and wires `htmlFor` to the control's `id`. It is a
 * real `<label>`, so tapping the word focuses the control — worth something on a
 * touchscreen where the target is a small word rather than a 48px box.
 */

import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

/** The one control style. Focus ring matches the sign-in form exactly. */
export const controlClass = [
  'block min-h-touch-lg w-full rounded-md border border-surface-300 bg-white px-3',
  'text-base text-neutral-900 placeholder:text-neutral-400',
  'focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200',
  'disabled:bg-surface-100 disabled:text-neutral-500',
].join(' ');

function merge(base: string, className?: string): string {
  return [base, className ?? ''].filter(Boolean).join(' ');
}

export interface FieldProps {
  label: ReactNode;
  htmlFor: string;
  /** Short help under the control, shown only when there is no error. */
  hint?: ReactNode;
  /** Field-level error, replaces the hint and is coloured as a problem. */
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required = false,
  children,
  className,
}: FieldProps) {
  return (
    <div className={className}>
      <label className="block text-sm font-medium text-neutral-700" htmlFor={htmlFor}>
        {label}
        {required && (
          // The asterisk is decoration next to a required control that the
          // browser already marks; `aria-hidden` keeps a screen reader from
          // saying "star" after every mandatory field.
          <span aria-hidden="true" className="text-danger-600">
            {' *'}
          </span>
        )}
      </label>
      <div className="mt-1">{children}</div>
      {error !== undefined ? (
        <p className="mt-1 text-2xs text-danger-700">{error}</p>
      ) : hint !== undefined ? (
        <p className="mt-1 text-2xs text-neutral-500">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={merge(controlClass, className)} {...rest} />;
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={merge(controlClass, className)} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={merge(merge(controlClass, 'py-2'), className)} {...rest} />;
}
