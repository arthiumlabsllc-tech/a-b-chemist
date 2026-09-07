import { HttpError } from './http';
import { isTaxError, type TaxErrorCode } from 'a-and-b-chemist-shared';

/**
 * The bridge between the tax engine's errors and the API's response envelope.
 *
 * The engine throws `TaxError` because it is pure and shared: it runs in the API
 * and in a service worker, so it cannot know about HTTP. The API speaks
 * `HttpError`. Something has to translate, and it has to be one thing, because
 * two translations of the same engine are two different 400 bodies for one
 * mistake.
 *
 * Every code the engine throws means "the caller asked for something
 * impossible", so every one of them is a 400 and none is a 500. That is worth
 * stating because it is the whole mapping: there is no branch on the code, so
 * there is no code that can fall through to a status nobody chose.
 *
 * Only the two functions a caller actually uses are here. `isTaxError` is
 * already exported by the shared package and needs no wrapper, and a translator
 * for a single thrown `TaxError` would be guessing at a field path the caller
 * knows and this file does not — Phase 6's point-of-sale routes should add one
 * when there is a call site to shape it against.
 */

/** One rejected field, in the shape a form can point at. */
export interface TaxFault {
  /** The request field path — `vatRate`, not `the VAT rate`. */
  field: string;
  /** Operator-facing, and the engine's own wording rather than ours. */
  message: string;
  /** The engine's stable label, so a caller can branch without matching text. */
  code: TaxErrorCode;
}

/**
 * The labels the engine puts in its own messages, by request field.
 *
 * `taxSettings()` calls `parseRate(input.vatRate, 'the VAT rate')`, so these are
 * not our choice of wording — they are the wording the engine already produces,
 * listed here so a fault can carry the *request* field path beside it. Passing
 * `'vatRate'` as the label instead would put camelCase into a sentence an owner
 * reads at the counter.
 */
export const TAX_RATE_FIELDS = [
  { key: 'vatRate', label: 'the VAT rate' },
  { key: 'nhilRate', label: 'the NHIL rate' },
  { key: 'getfundRate', label: 'the GETFund levy rate' },
] as const;

export type TaxRateFieldKey = (typeof TAX_RATE_FIELDS)[number]['key'];

/**
 * One envelope for every rejected input, matching `runValidation` exactly.
 *
 * Same status, same `code`, same `details` array of `{ field, message }` — with
 * the engine's code added beside each, which `runValidation` has no equivalent
 * of. A frontend that already renders express-validator's field errors renders
 * these without knowing there are two sources, and that is the point: the
 * till shows one kind of red.
 */
export function validationErrorFromFaults(faults: readonly TaxFault[]): HttpError {
  return new HttpError(400, 'Some details need correcting before this can be saved', {
    code: 'validation_failed',
    details: faults.map(({ field, message, code }) => ({ field, message, code })),
  });
}

/**
 * Runs something that may refuse, and reports what it refused with.
 *
 * Returns rather than throws, so a caller can validate all three rates and
 * report all three faults at once. A form that refuses the first wrong field,
 * saves, and then refuses the second teaches the owner to guess; `runValidation`
 * already collects for express-validator and this collects for the engine.
 *
 * A non-`TaxError` is rethrown, not reported: our own bug is not a validation
 * fault and must not be dressed up as one.
 */
export function faultFrom(run: () => unknown, field: string): TaxFault | null {
  try {
    run();
  } catch (error) {
    if (!isTaxError(error)) throw error;
    return { field, message: error.message, code: error.code };
  }
  return null;
}
