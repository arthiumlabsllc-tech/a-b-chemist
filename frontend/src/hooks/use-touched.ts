import { useCallback, useState } from 'react';

/**
 * Field errors are earned, not announced.
 *
 * A dialog that opens with red "this is required" messages under controls nobody
 * has touched tells the operator they have already done something wrong, before
 * they have done anything. Validation still runs on every keystroke — it is what
 * disables the submit button — but a message only appears once the field itself
 * has been edited. So clearing a field you typed into says "this is now empty",
 * while a field you never touched says nothing at all.
 *
 * Keyed by field name rather than holding the values, because the draft already
 * lives in the dialog; this only records which controls have been visited.
 */
export function useTouchedFields(): {
  touched: Record<string, boolean>;
  touch: (key: string) => void;
  resetTouched: () => void;
} {
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const touch = useCallback((key: string) => {
    setTouched((current) => (current[key] === true ? current : { ...current, [key]: true }));
  }, []);

  const resetTouched = useCallback(() => {
    setTouched({});
  }, []);

  return { touched, touch, resetTouched };
}

/** The error to show for a field: the real one once touched, nothing before. */
export function shownError(
  touched: Record<string, boolean>,
  key: string,
  error: string | null | undefined
): string | undefined {
  if (touched[key] !== true) {
    return undefined;
  }
  return error ?? undefined;
}
