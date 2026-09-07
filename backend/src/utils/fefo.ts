/**
 * FEFO: first expired, first out.
 *
 * A pure module. No database, no clock, no HTTP. Every function here takes the
 * batches and the date it is reasoning about as arguments and returns a value,
 * which is the only shape that can be tested against a date in the past, a date
 * in the future and the exact boundary between sellable and not — without the
 * test's answer changing depending on when it happens to run.
 *
 * `today` is always a parameter and never `new Date()` inside. A function that
 * reads the clock cannot be pinned to the expiry date itself, and "sellable ON
 * the expiry date, not after" is precisely the boundary a pharmacy needs proven.
 *
 * This is also the one shared place the expiry rule lives. The same three
 * questions — is this batch sellable, which batch goes out next, what is
 * expiring soon — are asked by the till, by the product listing, by the alerts
 * job and by the offline pricer in Phase 9. Answered in four places they drift;
 * answered here they cannot.
 */

/**
 * The window an expiry alert is raised inside. Ninety days, from the brief.
 * Exported rather than inlined so the alert copy in the UI and the query that
 * drives it cannot disagree about what "soon" means.
 */
export const EXPIRY_ALERT_WINDOW_DAYS = 90;

/**
 * Sorts `NULL` expiry last, matching `order by expiry_date nulls last` in SQL
 * and the index `inventory_batches_fefo_idx`.
 *
 * Undated stock is not "expiring soonest" and not "never expiring" in the sort:
 * it goes behind everything with a date, so a dated batch is always sold first.
 * That is the safe reading — undated usually means the date was not captured,
 * and selling the batch whose date is known protects the one that has a
 * deadline.
 */
const NULLS_LAST = '9999-12-31';

/** Milliseconds in a day, for the date arithmetic below. */
const MS_PER_DAY = 86_400_000;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A batch as the allocator sees it.
 *
 * Deliberately the smallest shape allocation needs, so the repository's fuller
 * row type satisfies it structurally and this module never has to know about
 * `pharmacy_id`, `created_at` or anything else that cannot affect the order.
 *
 * `quantity` is base units, not selling units. A product with `pack_size` 10
 * sold as one pack is 10 units here; the conversion belongs to the caller, so
 * the ledger only ever holds one unit and never has to be reconciled against
 * itself.
 *
 * `costPrice` is the decimal string Postgres returns for a `numeric`, not a JS
 * number. Nothing in this module does arithmetic on money — it copies the cost
 * of each batch into the allocation so the sale can snapshot it — so passing the
 * exact value through costs nothing and keeps a binary approximation out of the
 * cost of goods. Phase 5 decides how money is added up; a double that arrived
 * here would have decided it already, silently.
 */
export interface BatchStock {
  id: string;
  lotNumber: string;
  /** `'YYYY-MM-DD'`, or null for undated stock. */
  expiryDate: string | null;
  /** ISO-8601. The FEFO tie-break, and the only thing that orders two batches with the same expiry. */
  receivedAt: string;
  quantity: number;
  costPrice: string;
}

export interface Allocation {
  batchId: string;
  lotNumber: string;
  expiryDate: string | null;
  /** Base units taken from this batch. Always at least 1 and never more than the batch held. */
  quantity: number;
  /** This batch's cost, snapshotted at allocation. Never read back from the product row. */
  unitCost: string;
}

export interface AllocationResult {
  allocations: Allocation[];
  /** Sums to `requested - shortfall`. Integer, and always equals the sum of the allocations. */
  allocated: number;
  /** Units that could not be covered from sellable stock. Zero means the request was met in full. */
  shortfall: number;
}

/**
 * Days from the epoch for a `'YYYY-MM-DD'` string, or null when it is not one.
 *
 * The round-trip is the point. `Date.UTC` rolls an impossible date forward —
 * 2026-02-30 becomes 2 March — so a pattern match alone would accept an expiry
 * date that does not exist, and it would then sort and compare against a day
 * nobody meant. Formatting the result back and comparing it to the input
 * refuses that. It matters most on the CSV path, where the date was typed into a
 * spreadsheet and Postgres has not yet had the chance to reject it.
 *
 * Days rather than milliseconds is what every comparison below wants: integer
 * day arithmetic has no timezone in it, whereas subtracting two `Date`s depends
 * on whether each string carried a time and was parsed as local or as UTC.
 * Mixing those is how an expiry boundary moves by a day for part of the year.
 */
function parseDateOnly(dateOnly: string): number | null {
  const [, year, month, day] = DATE_ONLY.exec(dateOnly) ?? [];
  if (year === undefined || month === undefined || day === undefined) return null;

  const days = Date.UTC(Number(year), Number(month) - 1, Number(day)) / MS_PER_DAY;
  return new Date(days * MS_PER_DAY).toISOString().slice(0, 10) === dateOnly ? days : null;
}

/** Is this a real calendar date, in the only format this module accepts? */
export function isDateOnly(value: string): boolean {
  return parseDateOnly(value) !== null;
}

function daysSinceEpoch(dateOnly: string): number {
  const days = parseDateOnly(dateOnly);
  if (days === null) {
    throw new Error(`not a real date in YYYY-MM-DD form: ${JSON.stringify(dateOnly)}`);
  }
  return days;
}

function requireToday(today: string): number {
  const days = parseDateOnly(today);
  if (days === null) {
    throw new Error(
      `today must be a date in YYYY-MM-DD form, got ${JSON.stringify(today)}. ` +
        'A timestamp here would compare a date against a datetime and move the expiry boundary by a day.'
    );
  }
  return days;
}

/**
 * The shared expiry rule: sellable ON the expiry date, never after.
 *
 * `>=`, not `>`. The distinction is one day of stock a pharmacy either sells or
 * throws away, and it is the kind of off-by-one that only shows up on the
 * printed date itself — which is why the boundary is a named test rather than
 * something implied by a range query.
 *
 * Undated stock is always sellable. That is not leniency: an undated batch has
 * no date to be past, and refusing to sell it would strand stock nobody can
 * prove is out of date.
 */
export function isSellable(expiryDate: string | null, today: string): boolean {
  const now = requireToday(today);
  if (expiryDate === null) return true;
  return daysSinceEpoch(expiryDate) >= now;
}

/**
 * Whole days until this batch expires, or null when it is undated.
 *
 * Negative once the date has passed, which is what makes "expired 4 days ago"
 * distinguishable from "expires in 4 days" without a second flag. Zero on the
 * expiry date itself, matching `isSellable`.
 */
export function daysUntilExpiry(expiryDate: string | null, today: string): number | null {
  const now = requireToday(today);
  if (expiryDate === null) return null;
  return daysSinceEpoch(expiryDate) - now;
}

/**
 * Whole days from one date-only string to another: `to` minus `from`.
 *
 * Not an expiry rule, and it lives here anyway, because this module owns
 * `parseDateOnly` and the round-trip inside it. A report window needs the same
 * difference — "is this range at most a year" is a day count between two dates —
 * and a second copy of the arithmetic in a reports module is precisely the drift
 * the header of this file warns about: one derives days from the epoch and the
 * other from `Date` subtraction, and they disagree for part of every day.
 *
 * Both arguments are validated, so an impossible date is refused rather than
 * rolled forward. `2026-02-30` reaching a report range would otherwise become
 * 2 March and quietly widen the window by a day nobody asked for.
 */
export function daysBetween(from: string, to: string): number {
  return daysSinceEpoch(to) - daysSinceEpoch(from);
}

/**
 * The three-part FEFO comparison.
 *
 * `<` on strings, not `localeCompare`. Code-unit order is what SQL's C
 * collation does and is the same in every locale, while `localeCompare` follows
 * the host's collation rules and may sort punctuation and case differently —
 * which would put the derived `batch_number` on the product row at the mercy of
 * the server's LANG setting. Two servers disagreeing about which lot goes out
 * first is not a difference anybody would think to look for.
 *
 * Fields are compared one at a time rather than joined into a key string: the
 * join would need a separator guaranteed absent from all three values, and this
 * way there is nothing to guarantee.
 */
function compareFefo(left: BatchStock, right: BatchStock): number {
  const leftKey = left.expiryDate ?? NULLS_LAST;
  const rightKey = right.expiryDate ?? NULLS_LAST;
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  if (left.receivedAt !== right.receivedAt) return left.receivedAt < right.receivedAt ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

/**
 * The FEFO order: earliest expiry first, undated last, ties broken by earliest
 * receipt and then by id.
 *
 * The id tie-break is what makes the order total. Without it, two batches with
 * the same expiry and the same receipt timestamp — the same delivery, entered
 * twice — sort differently between runs depending on how the query planner
 * fetched them, and the derived `batch_number` on the product row flickers
 * between two lots while nothing has been sold.
 *
 * `receivedAt` is compared as a string. Both values are ISO-8601 from the same
 * column, so code-unit order is chronological order; parsing them into `Date`s
 * would add a timezone question where there is not one.
 *
 * Returns a new array. Sorting the caller's array in place would reorder the
 * repository's rows underneath whoever else is holding them.
 */
export function inFefoOrder<T extends BatchStock>(batches: readonly T[]): T[] {
  return [...batches].sort(compareFefo);
}

/**
 * The batch at the front of the shelf.
 *
 * Expiry-blind on purpose, and that is not the same rule `allocate` uses. This
 * answers "what is physically first", which is what the product row's
 * `batch_number` and `expiry_date` display, and it must show an expired lot
 * rather than look past it: skipping expired batches here would put a future
 * date on the product card while out-of-date stock sits in the drawer, and the
 * one thing the display must never do is hide that.
 *
 * `allocate` answers the different question "what would actually be handed
 * over", and skips what is not sellable. The two agreeing on the common case
 * and differing exactly on the expired case is the behaviour, and it is what
 * `recompute_inventory_from_batches` in init.sql does — same order, same
 * `quantity > 0` filter, same three-part key.
 *
 * Returns null when no batch holds stock, which is an empty product rather than
 * an error.
 */
export function leadingBatch<T extends BatchStock>(batches: readonly T[]): T | null {
  return inFefoOrder(batches).find((batch) => batch.quantity > 0) ?? null;
}

/**
 * Base units that may actually be sold today.
 *
 * Not `inventory.quantity`. That column is the physical count and includes
 * expired stock, because what is in the drawer and what may be handed over a
 * customer are different questions and the ledger has to answer the first one
 * honestly. The till sells against this figure.
 */
export function sellableUnits(batches: readonly BatchStock[], today: string): number {
  requireToday(today);
  let total = 0;
  for (const batch of batches) {
    if (batch.quantity <= 0) continue;
    if (!isSellable(batch.expiryDate, today)) continue;
    total += batch.quantity;
  }
  return total;
}

/**
 * Batches that will expire within `windowDays`, earliest first, undated never.
 *
 * Includes batches that have already expired. An expiry alert that stops firing
 * the day after the date passes is an alert that hides exactly the stock that
 * most needs pulling off the shelf, and "expiring soon" read as a future-only
 * window would do that.
 */
export function expiringWithin<T extends BatchStock>(
  batches: readonly T[],
  today: string,
  windowDays: number = EXPIRY_ALERT_WINDOW_DAYS
): T[] {
  requireToday(today);
  if (!Number.isInteger(windowDays) || windowDays < 0) {
    throw new Error(`windowDays must be a non-negative integer, got ${String(windowDays)}`);
  }
  return inFefoOrder(
    batches.filter((batch) => {
      if (batch.quantity <= 0) return false;
      const days = daysUntilExpiry(batch.expiryDate, today);
      // Undated: null, and never expiring, so never in an expiry window.
      return days !== null && days <= windowDays;
    })
  );
}

/**
 * Splits `requested` base units across batches in FEFO order.
 *
 * The allocator the sale write path in Phase 6 will call, and the reason
 * `sale_item_batches` exists: it returns which batch each unit came from and at
 * what cost, so a void can put the units back into the lots that actually held
 * them instead of onto a product total that the derived-stock trigger would
 * immediately overwrite.
 *
 * Pure in the strictest sense — the input batches are not modified and the
 * caller's array is not reordered, so the same list can be allocated against
 * twice and get the same answer both times.
 *
 * Never over-allocates a batch and never allocates from one that is expired or
 * empty. When sellable stock runs out it stops and reports the shortfall rather
 * than reaching past the deadline into an expired lot: selling out of date
 * medicine because a basket was two units short is not a substitution the code
 * gets to make quietly.
 */
export function allocate(
  batches: readonly BatchStock[],
  requested: number,
  today: string
): AllocationResult {
  requireToday(today);
  if (!Number.isInteger(requested) || requested <= 0) {
    // Thrown rather than answered with an empty result. A request for zero
    // units returning "allocated 0, shortfall 0" is indistinguishable from
    // success, and a negative one is a stock increase arriving through the
    // selling path — both are caller bugs and neither may pass silently.
    throw new Error(
      `allocate() needs a positive whole number of base units, got ${String(requested)}`
    );
  }

  const seen = new Set<string>();
  const allocations: Allocation[] = [];
  let allocated = 0;

  for (const batch of inFefoOrder(batches)) {
    if (allocated >= requested) break;
    if (batch.quantity <= 0) continue;
    if (!isSellable(batch.expiryDate, today)) continue;
    // Guarded because the same batch id appearing twice in the input would
    // otherwise be allocated against twice out of one physical drawer.
    if (seen.has(batch.id)) continue;
    seen.add(batch.id);

    const take = Math.min(batch.quantity, requested - allocated);
    if (take <= 0) continue;

    allocations.push({
      batchId: batch.id,
      lotNumber: batch.lotNumber,
      expiryDate: batch.expiryDate,
      quantity: take,
      unitCost: batch.costPrice,
    });
    allocated += take;
  }

  return { allocations, allocated, shortfall: requested - allocated };
}
