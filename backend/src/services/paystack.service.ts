import { createHmac, timingSafeEqual } from 'node:crypto';

import { pesewasFromDecimalString } from 'a-and-b-chemist-shared';
import { config } from '../config';
import { poolSql } from '../database/pool';
import { findSalePaymentByReference } from '../repositories/sales.repository';
import { HttpError } from '../utils/http';
import { scoped } from '../utils/logger';
import {
  applyPaymentOutcome,
  getPayment,
  type SaleDetail,
} from './sales.service';

const log = scoped('paystack');

/**
 * Talking to Paystack, and believing as little of it as possible.
 *
 * This is the only module in the backend that makes a network call to a third
 * party, and that is deliberate rather than incidental. `sales.service.ts` owns
 * the seven-step write path and has no `fetch` in it, which means the whole of
 * the sale can be tested against a mocked repository without also mocking a
 * gateway — and it means a gateway outage cannot reach into the transaction that
 * draws stock.
 *
 * ## The charge is the browser's, not ours
 *
 * The till initialises the charge itself, with the public key from
 * `/sales/payment-config`, through Paystack's own popup. That is why there is no
 * `initialiseCharge` here. Doing it server-side would mean supplying a customer
 * email address to Paystack from a counter that never asked for one, and the
 * alternative — inventing one — puts a made-up address on a real financial
 * record. The public key is public; the customer's details are theirs to type.
 *
 * What the backend does is two things: hand out a reference the charge is bound
 * to, and then confirm the charge afterwards. The reference is ours and is
 * written onto the tender before the till ever sees it, so a webhook coming back
 * can be matched to exactly one tender rather than to whichever one a caller
 * names.
 *
 * ## "Never trusted on its own"
 *
 * The plan's words, and they are load-bearing in three places below. A webhook
 * is believed only after its HMAC signature is checked against the exact bytes
 * that arrived. A `verify` answer is believed only after the amount it reports
 * is compared against the amount the tender was written for. And a status the
 * gateway reports that is not unambiguously paid or unpaid is left alone rather
 * than resolved in whichever direction is convenient — a tender stuck `pending`
 * is visible and fixable, and one wrongly marked `failed` is a customer's money
 * missing from the record with nothing on the screen to say so.
 */

/** Where the webhook is mounted. Also the path `app.ts` exempts from rate limiting. */
export const PAYSTACK_WEBHOOK_PATH = '/webhooks/paystack';

const API_ROOT = 'https://api.paystack.co';

/**
 * How long a gateway call may take.
 *
 * Fifteen seconds and not the default of none. A till operator waiting on a
 * spinner with no timeout is a queue at the counter, and `fetch` will otherwise
 * hold the request open until the platform's own limit kills it — which on
 * Render is long enough that the operator has already rung the next customer.
 */
const GATEWAY_TIMEOUT_MS = 15_000;

// The reference a mobile money tender is bound to is minted by the sale write
// path, in `utils/reference.ts`. It is not minted here, and the reason is given
// there: this module already imports from `sales.service.ts`, so minting it here
// would close a loop between the gateway and the write path.

/**
 * Whether a webhook body carries the signature Paystack would have given it.
 *
 * Computed over the **raw bytes**, because that is what Paystack signed.
 * `JSON.stringify(req.body)` will not reproduce them: key order survives a parse
 * and a stringify only by luck, whitespace never does, and a body containing a
 * non-ASCII character round-trips differently. Verifying a re-serialised body is
 * the classic way this check gets written and the classic way it starts failing
 * on one payload in a hundred, which is indistinguishable from an attack.
 *
 * That is why `app.ts` keeps the buffer aside in a `verify` hook on the JSON
 * parser rather than letting the parsed object be the only thing that survives.
 *
 * Compared with `timingSafeEqual`. A byte-at-a-time comparison leaks how much of
 * the signature a guess got right, which turns an unguessable HMAC into one that
 * can be built a character at a time. `timingSafeEqual` throws on differing
 * lengths, so the length is checked first — and a header of the wrong length is
 * exactly what a forger sends, which is why that case answers false rather than
 * throwing.
 */
export function webhookSignatureIsValid(rawBody: Buffer, header: string | undefined): boolean {
  if (!config.paystack.configured) return false;
  if (header === undefined || header.trim() === '') return false;

  const expected = createHmac('sha512', config.paystack.secretKey)
    .update(rawBody)
    .digest('hex');

  const given = Buffer.from(header.trim(), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * What the gateway said about a charge, reduced to what a tender can use.
 *
 * There is deliberately no `reference` here. The only reference worth carrying
 * back would be the one this server asked about, which the caller already has,
 * and a field echoing the caller's own argument is an invitation to write it
 * back onto the tender — which would replace the one value a later webhook has
 * to find that tender with. See `PaymentOutcome` in `sales.service.ts`.
 */
export interface ChargeVerdict {
  /**
   * `unsettled` is not a third outcome the caller has to handle — it is the
   * refusal to guess. A charge that is still pending, was abandoned, or came back
   * with a status this code does not recognise leaves the tender exactly as it
   * was.
   */
  status: 'succeeded' | 'failed' | 'unsettled';
  /** Pesewas, as Paystack reports the smallest unit. Null when it did not say. */
  amountPesewas: number | null;
  paidAt: string | null;
  /** The gateway's own payload, verbatim, for `sale_payments.gateway_response`. */
  gatewayResponse: unknown;
}

interface PaystackEnvelope {
  status?: unknown;
  message?: unknown;
  /** The webhook's event name. Absent on a `verify` answer. */
  event?: unknown;
  data?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * The gateway's own answer, unwrapped.
 *
 * A non-2xx and a 2xx carrying `status: false` are both refusals, and both are
 * reported with the gateway's message attached. That message is for an
 * authenticated member of staff about the pharmacy's own account — "Invalid key"
 * is the difference between a five-minute fix and an afternoon of guessing — and
 * withholding it would leave the operator with "the gateway said no".
 */
async function callGateway(path: string, init?: RequestInit): Promise<unknown> {
  if (!config.paystack.configured) {
    throw new HttpError(
      503,
      'Mobile money is not configured on this server. Take cash for this sale and tell the owner the Paystack keys need setting.',
      { code: 'gateway_unconfigured' }
    );
  }

  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.paystack.secretKey}`,
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout, a DNS failure and a refused connection all arrive here and all
    // mean the same thing to the person at the counter: we could not ask. The
    // underlying reason is logged and not shown, because "fetch failed" is not a
    // sentence anybody can act on.
    log.warn('gateway unreachable', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new HttpError(
      502,
      'Paystack did not answer. The sale is recorded and this payment is still pending — press verify once the connection is back, or take cash and void it.',
      { code: 'gateway_unreachable' }
    );
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      log.warn('gateway answered something that is not JSON', { path, status: response.status });
      throw new HttpError(502, 'Paystack answered with something this till could not read.', {
        code: 'gateway_bad_response',
      });
    }
  }

  const envelope = asRecord(payload) as PaystackEnvelope | null;
  const message = textOf(envelope?.message);

  if (!response.ok || envelope?.status === false) {
    log.warn('gateway refused', { path, status: response.status, message });
    throw new HttpError(
      502,
      message === null
        ? 'Paystack refused that request.'
        : `Paystack refused that request: ${message}`,
      { code: 'gateway_refused' }
    );
  }

  return payload;
}

/**
 * Asks Paystack about a charge, server to server.
 *
 * This is the "never trusted on its own" half of the pair: a webhook says the
 * money moved, and this is how the till finds out without waiting for one — and
 * how a webhook that never arrives is eventually reconciled.
 */
export async function verifyTransaction(reference: string): Promise<ChargeVerdict> {
  const payload = await callGateway(
    `/transaction/verify/${encodeURIComponent(reference)}`
  );
  const data = asRecord((asRecord(payload) as PaystackEnvelope | null)?.data);
  const status = textOf(data?.status);

  return {
    // Only `success` settles a tender. `failed` and `abandoned` are the two the
    // gateway uses for a charge that will not complete; anything else — pending,
    // queued, or a value added next year — is left alone.
    status:
      status === 'success' ? 'succeeded' : status === 'failed' || status === 'abandoned' ? 'failed' : 'unsettled',
    amountPesewas: typeof data?.amount === 'number' && Number.isInteger(data.amount) ? data.amount : null,
    paidAt: status === 'success' ? textOf(data?.paid_at) : null,
    gatewayResponse: payload,
  };
}

/**
 * The one webhook event that moves a tender, or null for anything else.
 *
 * Only `charge.success` is acted on. `charge.failed` is a real Paystack event
 * and is deliberately ignored: marking a tender failed from a webhook we cannot
 * interrogate further, when the operator can press verify and get an answer that
 * has been checked against the amount, trades a visible pending sale for an
 * invisible one. Every other event — transfers, subscriptions, the dozen things
 * an account we do not fully control can emit — is acknowledged and dropped,
 * because answering anything but 200 makes Paystack retry something we will
 * never handle.
 */
export function readChargeSuccess(body: unknown): {
  reference: string;
  amountPesewas: number | null;
  paidAt: string | null;
  gatewayResponse: unknown;
} | null {
  const envelope = asRecord(body) as PaystackEnvelope | null;
  if (textOf(envelope?.event) !== 'charge.success') return null;

  const data = asRecord(envelope?.data);
  const reference = textOf(data?.reference);
  if (reference === null) {
    log.warn('a charge.success webhook named no reference');
    return null;
  }

  return {
    reference,
    amountPesewas:
      typeof data?.amount === 'number' && Number.isInteger(data.amount) ? data.amount : null,
    paidAt: textOf(data?.paid_at),
    gatewayResponse: body,
  };
}

/**
 * What confirming a charge did.
 *
 * Its own type rather than `PaymentOutcomeResult` with a flag bolted on, because
 * the unsettled case has no sale detail to return: nothing was written, so there
 * is nothing that changed shape. Widening `detail` to nullable to cover it would
 * make every caller of `applyPaymentOutcome` handle a null that cannot occur
 * there.
 */
export interface ConfirmChargeResult {
  /** The sale as it now stands, or null when the gateway gave no usable verdict. */
  detail: SaleDetail | null;
  /** False when the tender was already terminal, or was left alone. */
  changed: boolean;
  arrivedAfterVoid: boolean;
  /** True when Paystack would not say either way, so the tender stayed pending. */
  unsettled: boolean;
}

/**
 * Confirms one tender against the gateway and records the answer.
 *
 * The composition lives here rather than in the route because the amount check
 * is not route plumbing — it is the reason a charge response is not trusted on
 * its own, and a route that forgot it would settle a sale on a charge for the
 * wrong figure with every other guard intact.
 */
export async function confirmCharge(
  pharmacyId: string,
  paymentId: string,
  now: string
): Promise<ConfirmChargeResult> {
  const payment = await getPayment(pharmacyId, paymentId);

  if (payment.method !== 'momo') {
    throw new HttpError(
      400,
      'A cash payment is recorded the moment it is taken — there is nothing to verify.',
      { code: 'payment_not_gateway' }
    );
  }
  if (payment.reference === null) {
    // Unreachable through this codebase: every mobile money tender is written
    // with a reference. Answered rather than thrown past, because the throw
    // would be a 500 for a state the operator can see and cannot fix.
    throw new HttpError(
      409,
      'That payment has no gateway reference, so there is nothing to ask Paystack about.',
      { code: 'payment_has_no_reference' }
    );
  }

  const verdict = await verifyTransaction(payment.reference);

  if (verdict.status === 'unsettled') {
    // Left exactly as it was, and said so. The till shows a pending payment and
    // the operator presses verify again or takes cash.
    return { detail: null, changed: false, arrivedAfterVoid: false, unsettled: true };
  }

  const expected = pesewasFromDecimalString(payment.amount, 'the amount on this tender');
  if (
    verdict.status === 'succeeded' &&
    verdict.amountPesewas !== null &&
    verdict.amountPesewas !== expected
  ) {
    // The charge that succeeded is not the charge this tender was written for.
    // Recording it would settle the sale on somebody else's money, and the two
    // figures would agree on the receipt while disagreeing in the account.
    log.error('gateway amount does not match the tender', {
      paymentId,
      expected,
      reported: verdict.amountPesewas,
      reference: payment.reference,
    });
    throw new HttpError(
      409,
      'Paystack reports a different amount from the one this payment was taken for. Do not complete this sale — tell the owner and check the Paystack dashboard.',
      {
        code: 'gateway_amount_mismatch',
        details: { expected, reported: verdict.amountPesewas },
      }
    );
  }

  const result = await applyPaymentOutcome(
    pharmacyId,
    paymentId,
    {
      status: verdict.status,
      gatewayResponse: verdict.gatewayResponse,
      paidAt: verdict.paidAt,
    },
    now
  );

  if (result.arrivedAfterVoid) {
    log.error('a charge succeeded against a voided sale — a refund is owed', {
      paymentId,
      saleId: result.detail.sale.id,
      reference: payment.reference,
    });
  }

  return { ...result, unsettled: false };
}

/**
 * What a webhook did, as far as the route and the log need to know.
 *
 * `reason` is there because every one of these answers 200 to Paystack and the
 * difference between them is invisible in the status code. A retry cannot fix a
 * reference this server never issued or an amount that does not match, so
 * refusing would only bury the log line under retries — and "answered 200" on
 * its own would make an unhandled charge look like a handled one.
 */
export interface WebhookResult {
  reason:
    | 'not_our_event'
    | 'unknown_reference'
    | 'amount_mismatch'
    | 'already_recorded'
    | 'applied';
  /** True only when a tender actually moved. */
  handled: boolean;
  /** Money arrived against a sale that was already cancelled. A refund is owed. */
  arrivedAfterVoid: boolean;
}

/**
 * Handles a verified webhook: finds the tender by the reference it was written
 * with, and records what the gateway said.
 *
 * Called only after `webhookSignatureIsValid` has returned true. The signature is
 * checked in the route, over the raw body, because by the time anything is in
 * this module the bytes are gone.
 */
export async function handleChargeSuccess(body: unknown, now: string): Promise<WebhookResult> {
  const event = readChargeSuccess(body);
  if (event === null) return { reason: 'not_our_event', handled: false, arrivedAfterVoid: false };

  // Looked up by reference and not by pharmacy, because a webhook carries no
  // pharmacy: Paystack knows the account, not the tenant. The reference is ours,
  // carries a random suffix, and the row it finds brings its own `pharmacy_id`
  // back with it, so everything downstream is scoped as usual.
  //
  // Read on the pool rather than inside a transaction, because this read only
  // routes: it finds which tender the event is about. The write happens in
  // `applyPaymentOutcome`, which re-reads the tender and locks the sale inside
  // its own transaction, so a webhook and a `verify` arriving together still
  // serialise on the row that matters. The amount compared below cannot move in
  // between — nothing in this codebase ever updates `sale_payments.amount`.
  const payment = await findSalePaymentByReference(poolSql, event.reference);
  if (payment === null) {
    // A signed webhook for a reference we never issued. Acknowledged rather than
    // refused: answering 404 makes Paystack retry, and a retry loop against a
    // reference that will never exist is noise that hides the real one. Logged
    // because it is also what a mis-pointed test account looks like.
    log.warn('a verified webhook named a reference this server has no payment for', {
      reference: event.reference,
    });
    return { reason: 'unknown_reference', handled: false, arrivedAfterVoid: false };
  }

  // The same check `confirmCharge` makes, and for the same reason: the signature
  // proves the body came from Paystack and was not edited, and nothing more. It
  // does not prove the charge it describes is the one this tender was written for.
  const expected = pesewasFromDecimalString(payment.amount, 'the amount on this tender');
  if (event.amountPesewas !== null && event.amountPesewas !== expected) {
    log.error('webhook amount does not match the tender', {
      paymentId: payment.id,
      expected,
      reported: event.amountPesewas,
      reference: event.reference,
    });
    return { reason: 'amount_mismatch', handled: false, arrivedAfterVoid: false };
  }

  const result = await applyPaymentOutcome(
    payment.pharmacyId,
    payment.id,
    {
      status: 'succeeded',
      gatewayResponse: event.gatewayResponse,
      paidAt: event.paidAt,
    },
    now
  );

  if (result.arrivedAfterVoid) {
    // Money in a wallet's account for a sale that was cancelled. There is no
    // refund flow in this build, so the only honest thing is to say so loudly
    // where somebody will see it.
    log.error('a charge succeeded against a voided sale — a refund is owed', {
      paymentId: payment.id,
      saleId: result.detail.sale.id,
      reference: event.reference,
    });
  }

  return {
    reason: result.changed ? 'applied' : 'already_recorded',
    handled: result.changed,
    arrivedAfterVoid: result.arrivedAfterVoid,
  };
}
