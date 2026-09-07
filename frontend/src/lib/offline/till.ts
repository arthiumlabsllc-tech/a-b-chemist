/**
 * What the till is allowed to do while the server cannot be reached.
 *
 * The page keeps the deciding and the rendering apart the way the rest of `lib`
 * does: every rule here is a pure function with a test beside it, and `/pos` calls
 * them. That matters more than usual, because each of these rules is a refusal —
 * and a refusal the till cannot explain is one the operator works around.
 *
 * ## Why a prescription-only basket cannot be sold offline
 *
 * Not a policy preference. The server refuses the sale either way:
 *
 * - `sales.service.ts` throws `prescription_needs_approver` when a line
 *   `requiresPrescription` and no approver was named, so the replay of an offline
 *   Rx sale with no approver is a guaranteed 400.
 * - Naming one does not help. The approvers list is server data and is not in the
 *   three things BRIEF.md §4.5 has the till cache, so offline there is nobody to
 *   name; and even a cached id would be checked at write time, because
 *   `sales.routes.test.ts` pins that "an approver who may not approve" is refused
 *   even when the id is a real person. Hiding the picker is not authorisation, and
 *   neither is caching it.
 *
 * So the choice is between refusing at the counter and refusing on `/sync`. The
 * second is worse by a wide margin: by the time the replay fails the customer has
 * walked away with a prescription-only medicine and the drawer has taken money for
 * a sale that now sits marked "Not recorded", waiting to be discarded. Refusing
 * here means the pharmacist standing at the counter hears it while they can still
 * do something about it.
 *
 * ## Why stock is not checked, and why that is not a hole
 *
 * The cached `available` figure is a photograph of the shelf from the last time
 * the server answered, and the till cannot know what has been sold since. So an
 * offline sale can oversell. It is not left there: the server checks stock when the
 * queued sale replays, and a refusal lands on the queue as `failed` — which is
 * precisely what that status exists for, and why `/sync` offers a decision rather
 * than a retry loop. The alternative, refusing to sell anything the cached figure
 * cannot cover, would close the till during an outage on the strength of a number
 * the till already knows is stale.
 *
 * ## Why the draft is built here and not in the page
 *
 * `queuedSaleDraft` is the only place a `QueuedSaleDraft` is assembled, so the
 * summary, the line count and the provisional total cannot disagree with the lines
 * they describe. It also refuses a body with no `clientSaleId`, which is the
 * structural half of the queue's safety argument: a sale without an idempotency key
 * replays as a second sale, so it must never enter the queue at all.
 */

import type { CreateSaleBody } from '../api-types';
import type { BasketLine } from '../pricing';
import type { OfflineTotal } from './offline-pricing';
import type { QueuedSaleDraft } from './queue';

/**
 * Why this basket cannot be charged offline, in words for the counter, or null
 * when it can.
 *
 * The names are in the message. "A prescription-only item" sends the operator
 * looking through the basket for the one they cannot see, and the whole point of
 * refusing at the counter rather than on replay is that there is still time to act
 * on it.
 */
export function offlineSaleBlocker(lines: readonly BasketLine[]): string | null {
  const named = lines.filter((line) => line.requiresPrescription).map((line) => line.name);
  if (named.length === 0) return null;

  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  return `${list} needs approval from a pharmacist or the owner, and only the server can record who gave it. Take it off this basket to sell the rest, or wait for the connection to come back.`;
}

/**
 * The label `/sync` shows for a queued sale: the first line, and how many more.
 *
 * One product name is enough to recognise a sale the operator is deciding about,
 * and a summary listing every line would push the two buttons — the point of the
 * row — off a tablet screen. `lineCount` beside it carries the rest of the shape.
 */
export function saleSummary(lines: readonly BasketLine[]): string {
  const [first] = lines;
  // Unreachable from the till, which will not charge an empty basket, but a pure
  // function still has to answer rather than render "undefined".
  if (first === undefined) return 'An empty basket';

  const head = `${first.name} \u00d7 ${first.quantity}`;
  const rest = lines.length - 1;
  if (rest === 0) return head;
  return `${head} + ${rest} more ${rest === 1 ? 'line' : 'lines'}`;
}

/** What the till has to hand at the moment it decides to hold a sale on device. */
export interface OfflineSaleInput {
  /** The body `POST /sales` will take, built by `basketToRequest`. */
  body: CreateSaleBody;
  /** The same lines, for the label — the body carries ids and quantities only. */
  lines: readonly BasketLine[];
  /** The offline money: a total, and no tax split. */
  provisional: OfflineTotal;
}

/**
 * Assembles the queue entry, or returns null when the sale cannot safely be queued.
 *
 * Null is the missing `clientSaleId`, and the caller must treat it as "this sale is
 * not held anywhere" rather than papering over it — a queued sale with no key is a
 * duplicate the moment it is replayed, which is the one failure the whole queue
 * design exists to prevent.
 */
export function queuedSaleDraft(input: OfflineSaleInput): QueuedSaleDraft | null {
  const clientSaleId = input.body.clientSaleId;
  if (clientSaleId === undefined) return null;

  return {
    // The spread narrows `CreateSaleBody` to `QueueableSale` by supplying the one
    // field the intersection requires. It is the same id `basketToRequest` already
    // put on the body, so the sale replays as itself.
    sale: { ...input.body, clientSaleId },
    provisional: input.provisional,
    lineCount: input.lines.length,
    summary: saleSummary(input.lines),
  };
}
