import { query } from 'express-validator';
import { requireAuth } from '../middleware/authenticate';
import type { Actor } from '../services/inventory.service';
import { toBoolean } from '../utils/coerce';
import { HttpError } from '../utils/http';

/**
 * The things every route file needs and none of them should own.
 *
 * These began as locals in `inventory.routes.ts`, which was the first router with
 * a paginated list and an `/:id` route. Copying them into `sales.routes.ts` would
 * have made two `pageOf`s and two `MAX_LIST_LIMIT`s, and the patients, reports and
 * notifications routers would each have made another. The copies do not look like
 * a problem while they agree, and the reason they stop agreeing is that the
 * comment explaining a subtlety is the first thing dropped from a copy — which is
 * why the comments came across with the code rather than being rewritten shorter.
 *
 * `pageOf` in particular carries a fact about Express 5 that is invisible in the
 * four lines of code, and a route file that re-derived it would get it right by
 * accident the first time and would not know it had been lucky. `enumListFilter`
 * arrived the same way, from `screenings.routes.ts` and
 * `consultations.routes.ts` needing one list filter each on the same day, and
 * `searchQuery` from three routers holding three private `MAX_SEARCH_LENGTH`s
 * that all said 120 and all justified it in different words.
 */

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

/**
 * The ceiling on a search box.
 *
 * 120 because every search in this build matches a name, a phone number or a
 * short reference, and the longest of those is a person's full name. It is not a
 * limit on what can be stored — `patients.full_name` and `products.name` each
 * have their own — but on what one keystroke-driven filter box is worth sending.
 */
export const MAX_SEARCH_LENGTH = 120;

/**
 * The `optional` setting every filter in a query string uses.
 *
 * One rule: an empty cell means "no filter". `?patientId=` and no `patientId` at
 * all are the same request, because an empty cell is what a browser sends when a
 * form field is cleared, and it is what every handler reading one already says it
 * wants.
 *
 * ## It was not one rule, and the disagreement could not be seen
 *
 * `optional()` skips only `undefined`, and `optional({ values: 'null' })` skips
 * `undefined` and `null`. Neither skips `''`; only `{ values: 'falsy' }` does. That
 * was checked against the installed express-validator rather than read off the
 * option's name, because "falsy" suggests a JavaScript truthiness test and a query
 * string value is always a string — the only falsy string is `''`, while `'0'` and
 * `'false'` are truthy and are still validated. That is what makes the setting safe
 * here: a skipped `?patientId=0` would reach a `::uuid` cast and answer 500, and it
 * is not skipped.
 *
 * So the chains built on `.isString().isLength()` happened to accept an empty cell
 * and the ones built on `.isUUID()`, `.isIn()` or `.isDate()` refused it — on the
 * same query string, in the same request. `?type=` asked for the whole pharmacy and
 * `?patientId=` was a 400.
 *
 * The refusal also contradicted the layer underneath it, which is the defect
 * `booleanQuery` records for a yes/no filter: `toDateOnlyOrNull('')` returns null,
 * and ten handlers spelled `raw.x === undefined || raw.x === ''` as their reading
 * of an absent filter. Those ten `=== ''` halves were dead code that read like a
 * decision, which is worse than no code — a reader who trusts one concludes that an
 * empty cell is handled, and it was handled only for some fields.
 *
 * ## What does not use it
 *
 * `pagination`, below. `limit` and `offset` are paging controls rather than
 * filters, no form clears them, and `pageOf` reads them with `??` rather than with
 * an `=== ''` branch — so there is no dead code to revive and no second answer to
 * reconcile. A required parameter does not use it either, and `GET
 * /screenings/latest`'s `patientId` is one: there, an empty cell is a request with
 * the patient missing, and refusing it is the answer.
 *
 * Nothing on a request **body** uses it, and that is a hazard rather than a
 * preference. Every value in a query string is a string, so `'falsy'` skips one
 * thing; a JSON body carries real types, so it would also skip `0`, `false` and
 * `NaN`. `services/screenings.service.ts` calls `.trim()` on whatever a cleared
 * `measuredAt` turns out to be, so a skipped `0` is a `TypeError` inside a
 * transaction and a 500 with no field name in it. In a body an empty cell is a
 * value a client sent; in a query string it is a spelling of absence. The two are
 * different facts and only the second one wants this setting.
 *
 * ## Every router that uses it has to prove it
 *
 * Not once, here, but once per suite. Breaking this constant back to
 * `{ values: 'null' }` failed a single test — the one in
 * `screenings.routes.test.ts` — and left the identical mistake live in five other
 * routers whose suites sent no empty cell at all. A shared constant guarded by one
 * caller is guarded for that caller. So each suite sends every filter its router
 * has as an empty cell and asserts the answer is the one an absent filter gets:
 * `screenings.routes.test.ts`, `sales.routes.test.ts` and `reports.routes.test.ts`
 * do, and a router added to this list inherits the obligation with the import.
 */
export const OPTIONAL_QUERY = { values: 'falsy' } as const;

/** `limit`/`offset` for a list endpoint, validated once and read the same way everywhere. */
export const pagination = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: MAX_LIST_LIMIT })
    .withMessage(`limit must be between 1 and ${MAX_LIST_LIMIT}`),
  query('offset').optional().isInt({ min: 0 }).withMessage('offset must be 0 or more'),
];

export function pageOf(raw: Record<string, unknown>): { limit: number; offset: number } {
  // Read from the raw query rather than trusting express-validator's mutation of
  // it. `.toInt()` rewrites `req.query` in place, which works on Express 4 and
  // stops working on Express 5 where `req.query` is a getter — parsing here is
  // correct on both and has already been validated by the chain above.
  const limit = Number.parseInt(String(raw.limit ?? DEFAULT_LIST_LIMIT), 10);
  const offset = Number.parseInt(String(raw.offset ?? 0), 10);
  return {
    limit: Number.isNaN(limit) ? DEFAULT_LIST_LIMIT : limit,
    offset: Number.isNaN(offset) ? 0 : offset,
  };
}

export function actorOf(req: Parameters<typeof requireAuth>[0]): Actor {
  const auth = requireAuth(req);
  return { userId: auth.userId, pharmacyId: auth.pharmacyId };
}

/**
 * The id from a matched `/:id` route.
 *
 * Typed `string | undefined` because `noUncheckedIndexedAccess` does not know
 * that a matched route always populates it. Answering 404 rather than asserting
 * keeps the impossible case from becoming a crash in front of a customer.
 */
export function idParam(value: string | undefined, what: string): string {
  if (value === undefined) {
    throw new HttpError(404, `No ${what} matches that id`, { code: 'not_found' });
  }
  return value;
}

/**
 * A repeated-or-single query filter, as one array.
 *
 * `?status=completed` arrives as a string and `?status=scheduled&status=completed`
 * as an array, and the two have to reach `toEnumMember` the same way or the
 * single-value case is a special case somebody eventually forgets to write.
 *
 * Empty means "no filter" and folds to an empty array here, which the repository
 * then folds on into "every row". That second fold is the important half: `status
 * = any('{}')` is valid SQL matching nothing, so a diary asked for no statuses at
 * all would show an empty page and read as a pharmacy with no appointments. The
 * trap is documented in `consultations.repository.ts` and
 * `screenings.repository.ts`, and it is handled at the layer that owns the SQL
 * rather than here — this function only guarantees that a filter nobody asked for
 * arrives as `[]` and never as `['']`.
 */
export function enumListFilter(raw: unknown): unknown[] {
  if (raw === undefined || raw === null || raw === '') return [];
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * A `?search` filter, validated the same way on every router that has one.
 *
 * One message for the whole chain rather than a `.withMessage` per validator,
 * which is the house shape `inventory.routes.ts` uses for its body fields: the
 * caller does not care whether the search was refused for not being text or for
 * being too long, and two sentences for one input is two things a form has to
 * choose between.
 *
 * The message is not optional and its absence was a defect rather than a style.
 * A chain with no message answers with express-validator's own `'Invalid value'`,
 * which `inventory.routes.test.ts` sweeps its bodies for and refuses to let
 * through — a 400 that does not say which field it meant leaves the pharmacist to
 * work it out from thirteen inputs. The same chains on query parameters had no
 * such sweep, which is how four of them came to be spelled without one.
 */
export function searchQuery() {
  return query('search', `Enter a search of ${MAX_SEARCH_LENGTH} characters or fewer`)
    .optional(OPTIONAL_QUERY)
    .isString()
    .trim()
    .isLength({ max: MAX_SEARCH_LENGTH });
}

/**
 * A yes/no filter in a query string, checked by running the coercer.
 *
 * `label` is the phrase the refusal is built from, and the handler has to pass the
 * same one to `toBoolean` when it reads the value — which is why both call sites in
 * a route file hold it in one local constant rather than spelling it twice. A
 * validator and a reader that word the same field differently is two messages for
 * one input, and which of them a caller sees depends on nothing they did.
 *
 * ## Why this runs `toBoolean` rather than `.isBoolean()`
 *
 * The reason is the one `inventory.routes.ts` gives for declining `isDecimal` on a
 * money field: `utils/coerce.ts` accepts the value and produces the message, so a
 * validator in front of it with a narrower vocabulary is a rule that refuses
 * something the layer underneath would have handled. `.isBoolean()` is exactly
 * that. It accepts `true`, `false`, `1` and `0`, and with `{ loose: true }` also
 * `yes`, `no` and `TRUE` — but not `on`, `off`, `y` or `n`, all four of which
 * `toBoolean` accepts. `on` is not a curiosity either: it is what an HTML checkbox
 * serialises to when nobody set a `value` on it, so the spelling most likely to
 * arrive from a form is among the ones a library validator allows least.
 *
 * `toBoolean` throws where a `.custom` has to answer, so the throw is caught and
 * the chain's own message carries the sentence. The two are worded identically on
 * purpose — the property `tax.routes.test.ts` praises about a rate that both the
 * route and the engine can refuse — so nobody reading the 400 has to work out
 * which layer produced it, and neither do they need to.
 */
export function booleanQuery(field: string, label: string) {
  return query(field, `Enter ${label} as yes or no`)
    .optional(OPTIONAL_QUERY)
    .custom((value: unknown) => {
      try {
        toBoolean(value, label);
        return true;
      } catch {
        return false;
      }
    });
}
