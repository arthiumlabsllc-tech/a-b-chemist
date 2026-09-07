'use client';

/**
 * A modal dialog.
 *
 * ## Why there is no click-the-backdrop-to-close
 *
 * The obvious implementation puts an `onClick` on the dimmed backdrop div. Two
 * reasons not to, and the first is the one that would fail the build: a click
 * handler on a non-interactive element is exactly what the `jsx-a11y` rules in
 * `next/core-web-vitals` reject, and this project lints with `--max-warnings=0`.
 * The second is the product reason the lint rule is encoding — on a till, a
 * stray tap on the dim area while reaching for the card reader should not throw
 * away a half-entered payment. Escape and the visible close button are the two
 * deliberate ways out, and both are real, focusable, keyboard-reachable controls.
 *
 * ## Shape
 *
 * A bottom sheet below `sm` and a centred dialog from `sm` up. On a phone the
 * centred dialog floats with dead space above and below and the keyboard covers
 * the footer; a sheet anchored to the bottom keeps the action button reachable
 * with the thumb and lets the keyboard push it up.
 *
 * Focus is moved into the panel on open and returned to whatever held it on
 * close, and body scroll is locked so the page behind cannot be dragged while
 * the dialog is up. A full focus *trap* is deliberately not attempted here — it
 * needs a tested library or a lot of careful keydown handling, and the dialogs in
 * this app are short forms whose first control is focused by the caller.
 */

import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Rendered in a distinct footer bar. Omit for a dialog that is all body. */
  footer?: ReactNode;
  size?: 'md' | 'lg';
}

export function Modal({ open, title, onClose, children, footer, size = 'md' }: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div aria-hidden="true" className="absolute inset-0 bg-neutral-900/50" />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={[
          'relative flex max-h-[90vh] w-full animate-slide-up flex-col overflow-hidden rounded-t-lg bg-white shadow-xl outline-none sm:rounded-lg',
          size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md',
        ].join(' ')}
      >
        <div className="flex items-start justify-between gap-3 border-b border-surface-200 px-4 py-3">
          <h2 id={titleId} className="text-base font-semibold text-neutral-900">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 inline-flex min-h-touch min-w-touch items-center justify-center rounded-md text-neutral-500 hover:bg-surface-100 hover:text-neutral-800"
          >
            <span aria-hidden="true" className="text-xl leading-none">
              {'\u00d7'}
            </span>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>

        {footer !== undefined && (
          <div className="border-t border-surface-200 bg-surface-50 px-4 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
}
