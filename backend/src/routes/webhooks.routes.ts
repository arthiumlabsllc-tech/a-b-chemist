import { Router } from 'express';
import { handleChargeSuccess, webhookSignatureIsValid } from '../services/paystack.service';
import { asyncHandler } from '../utils/async-handler';
import { nowIso } from '../utils/clock';
import { HttpError, sendOk } from '../utils/http';
import { scoped } from '../utils/logger';

const log = scoped('webhook');

/**
 * The Paystack webhook, on its own.
 *
 * A separate file rather than a route at the bottom of `sales.routes.ts`, and the
 * reason is that this is the only router in the codebase with no `authenticate`
 * on it. A reader who opens this file sees one route and no token check, which is
 * the whole truth about it; the same route at the end of a file whose eleven
 * siblings all sit behind a mount-level `authenticate` is a route somebody will
 * one day "tidy" by moving the middleware to the mount — and the failure is not
 * an error, it is Paystack receiving 401s and retrying a paid charge until it
 * gives up, with the sale pending forever and nothing in the log to say why.
 *
 * ## What replaces the token
 *
 * An HMAC-SHA512 of the request body, keyed on the Paystack secret. That is
 * stronger than a bearer token in the one way that matters here: it also proves
 * the body was not edited in transit, so the amount in the event is the amount
 * Paystack signed. It is checked in `app.ts`'s `verify` hook against the raw
 * bytes and in `webhookSignatureIsValid`, and never against a re-serialised
 * object — see both for why.
 *
 * ## Every branch after the signature answers 200
 *
 * Because a retry cannot fix anything. An event for a reference this server never
 * issued will never become one; an amount that does not match the tender will
 * never match; a transfer event will never be a charge. Answering anything else
 * makes Paystack retry, and the retries bury the one log line that says a real
 * charge went unhandled. `WebhookResult.reason` exists so the difference between
 * "applied" and "acknowledged and dropped" is in the body and the log rather than
 * being flattened into a status code that has to stay 200.
 *
 * The signature failure is the one exception and answers **400**. That request is
 * not from Paystack, or is from Paystack with a secret this server does not have,
 * and both are things somebody needs to see: 400 shows up as a failed delivery in
 * Paystack's own dashboard, where a 200 would look like the endpoint working.
 */

/** The header Paystack signs with. Named once, so the route and the log agree. */
const SIGNATURE_HEADER = 'x-paystack-signature';

export const paystackWebhookRoutes = Router();

paystackWebhookRoutes.post(
  '/',
  asyncHandler(async (req, res) => {
    const header = req.headers[SIGNATURE_HEADER];
    // Express types that `string | string[] | undefined`, so it has to be
    // narrowed before `webhookSignatureIsValid` will take it. The array half is
    // not reachable on today's Node: duplicates of any header other than
    // `set-cookie` are joined with `', '` by the parser before middleware runs,
    // so a request carrying two signatures arrives as one 258-character string
    // and is refused by the length check in front of `timingSafeEqual`.
    // Narrowing to `undefined` rather than taking the first element is still the
    // right answer — first-wins is a rule an attacker gets to test against by
    // sending a valid signature second, and the join is Node's current behaviour
    // rather than a guarantee this route can rest a security property on.
    const signature = typeof header === 'string' ? header : undefined;

    if (req.rawBody === undefined) {
      // No buffer means the JSON parser never ran — an empty body, or a
      // content-type that is not `application/json`. Logged apart from a bad
      // signature because the two have different causes: this one is a request
      // that is not shaped like a webhook at all, and it is what a probe looks
      // like.
      log.warn('webhook arrived with no body to verify', {
        contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null,
      });
      throw new HttpError(400, 'That request carried no body this endpoint could verify.', {
        code: 'webhook_signature_invalid',
      });
    }

    if (!webhookSignatureIsValid(req.rawBody, signature)) {
      // Not logged with the body or the signature. The body of a signed webhook
      // carries a customer's payment details, and a signature is a credential
      // even when it is the wrong one — a log that collects near-misses is a log
      // that helps somebody build one.
      log.warn('webhook rejected: the signature did not match', {
        headerPresent: signature !== undefined,
        // Not reachable under the join described above, and kept anyway. The day
        // this is true is the day Node's header handling changed, and the
        // alternative to logging it is finding out from webhooks that stopped
        // verifying for a reason nothing on the screen mentions.
        headerRepeated: Array.isArray(header),
      });
      throw new HttpError(400, 'That request did not carry a signature Paystack would have given it.', {
        code: 'webhook_signature_invalid',
      });
    }

    const result = await handleChargeSuccess(req.body, nowIso());

    // One line per delivery, so "did the webhook arrive at all" is answerable
    // from the log without a database. `handleChargeSuccess` logs the branches
    // that need attention; this is the record that the endpoint is reachable.
    log.info('webhook handled', { reason: result.reason, handled: result.handled });

    sendOk(res, { received: true, reason: result.reason, handled: result.handled });
  })
);
