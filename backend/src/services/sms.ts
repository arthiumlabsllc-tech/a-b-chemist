import { config, type SmsConfig } from '../config';
import { scoped } from '../utils/logger';
import { normaliseGhanaPhone } from '../utils/phone';
import type { NotificationStatus } from '../utils/schema-enums';

const log = scoped('sms');

/**
 * Sending a reminder by SMS, and being honest when it cannot be sent.
 *
 * No provider is configured and no message has ever left this module. That is
 * the state the plan asks for — an interface, a scheduler hook, and every
 * unsent reminder labelled as unsent with the reason beside it — and this file
 * is where the honesty is concentrated so it cannot be spread thin across the
 * services that call it.
 *
 * ## Why the provider is not written
 *
 * `configuredSmsProvider` returns null, and it will keep returning null until
 * A&B chooses an aggregator and sets `SMS_API_URL` and `SMS_API_KEY`. Writing an
 * HTTP call now would mean guessing a vendor's request shape, authentication
 * header and success codes, and a guess is the worst thing this module could
 * contain: it would compile, it would pass a suite that mocks the fetch, and it
 * would fail on the first real message — which is the moment a patient's refill
 * reminder silently stops arriving, with the record still saying `sent`.
 *
 * When the provider is chosen, `httpProvider` is written against its
 * documentation and `configuredSmsProvider` returns it. Nothing else here
 * changes, and the delivery plumbing below is already covered by
 * `__tests__/sms.test.ts`, which injects a fake provider — that is the point of
 * `deliverSms` taking one as a parameter with a default. What no suite can cover
 * is whether a real vendor accepts the request, because that is a fact about the
 * vendor rather than about this module.
 *
 * ## Why each refusal has its own sentence
 *
 * `not_sent` is a single status covering several genuinely different situations,
 * and collapsing them would leave a pharmacist unable to tell which one they are
 * looking at or what to do about it. Four are exported constants, because they are
 * the ones a dashboard counts and searches for; three more are written inline, at
 * the branch that produces them, because each names a fact about the message or the
 * attempt rather than a state of this pharmacy.
 */

/**
 * Nothing was attempted because there is nowhere to send it.
 *
 * The same sentence stock alerts have carried since Phase 4, now with one home
 * rather than two: `services/alerts.service.ts` re-exports it as
 * `ALERT_NOT_SENT_REASON` so the panel and the bell cannot drift into calling
 * the same fact two different things.
 */
export const SMS_NOT_CONFIGURED_REASON =
  'Shown in the app only — no SMS provider is configured.';

/**
 * Nothing was attempted because the record has no destination.
 *
 * Actionable, and differently so from the one above: a pharmacist can fix this
 * by asking the patient for their number at the next visit, and until then the
 * reminder still appears in the bell where somebody can act on it by telephone.
 */
export const NO_PHONE_REASON = 'The patient record has no phone number.';

/**
 * Nothing was attempted because the number on the record is not one a provider
 * could be given. `utils/phone.ts` is what decides, and it refuses rather than
 * sending on a malformed destination — a provider will usually accept one, bill
 * for it, and report success, which would leave the record claiming a patient
 * was told something they were never told.
 */
export const UNSENDABLE_PHONE_REASON =
  'The phone number on the record is not a sendable Ghana number.';

/**
 * A provider is configured but nothing here knows how to speak to it.
 *
 * The fourth reason exists because the first would be a lie in this situation:
 * the pharmacy has set the variables and expects messages to go out. Reporting
 * `not_sent — no provider is configured` at an operator who has just configured
 * one sends them looking in the wrong place entirely.
 *
 * The endpoint is logged and not included. This sentence reaches
 * `notifications.not_sent_reason` and from there the bell, where counter staff
 * read it — and an internal URL is configuration detail that helps nobody there.
 * Whoever has to act on it has the log line.
 */
export const PROVIDER_NOT_WRITTEN_REASON =
  'An SMS provider is configured but this build has no integration for it yet.';

/** The longest body the reminder builder may compose. Two GSM segments. */
export const SMS_BODY_MAX_LENGTH = 320;

/**
 * The name a message signs itself with, as a patient would recognise it.
 *
 * Here rather than in either of the two services that build a reminder body,
 * because both of them need it and a copy in each is a copy that drifts: the day
 * the pharmacy trades under a second name, an appointment reminder and a
 * collection reminder would sign themselves differently and a patient would have
 * no way to tell which one was real.
 *
 * It is a constant and not the `pharmacies.name` column, and that is a decision
 * worth stating because the column exists. A message body is composed once and
 * persisted; a name read from the database at composition time would be the name
 * as of that instant, and re-reading it later — to resend, to show the bell what
 * was sent — would produce a different sentence from the one on the row. Signing
 * with a constant means the text a patient received is reproducible from the code
 * that was deployed when they received it.
 *
 * Every character here is in GSM 7-bit's default alphabet. `SMS_BODY_MAX_LENGTH`
 * is stated in those terms, and an ampersand is one of them; a curly apostrophe
 * in a trading name would not be, and would halve the length of every reminder
 * this pharmacy sends.
 */
export const PHARMACY_NAME = 'A&B Chemist';

export interface SmsMessage {
  /** The destination, already in the record's own spelling. Normalised here. */
  to: string | null;
  body: string;
}

/**
 * The two statuses an undelivered message can honestly carry.
 *
 * Derived from `notification_status` rather than spelled out, so growing the
 * enum is a compile error here instead of a second vocabulary that quietly stops
 * matching the column it is written to. `pending` and `sent` are excluded
 * because neither describes an attempt that has already finished.
 *
 * The distinction is the one `init.sql` makes and it is load-bearing: `not_sent`
 * means nothing was attempted and the reason is a fact about this pharmacy's
 * configuration or its records, while `failed` means a provider was reached and
 * said no — a different problem with a different owner, and one a pharmacist
 * cannot fix by asking the patient for their number again.
 */
export type UndeliveredStatus = Exclude<NotificationStatus, 'pending' | 'sent'>;

/**
 * What happened to one attempt.
 *
 * `delivered: true` carries the instant and whatever reference the provider
 * handed back, because a patient who says "I never got it" turns a dispute into
 * a lookup. `delivered: false` carries a status and a sentence rather than a
 * code: the sentence is written to `notifications.not_sent_reason`, which is
 * read by a pharmacist and not by a machine.
 */
export type SmsOutcome =
  | { delivered: true; sentAt: string; reference: string | null }
  | { delivered: false; status: UndeliveredStatus; reason: string };

export interface SmsProvider {
  /** What the log calls it. Never derived from a key and never a secret. */
  readonly name: string;
  /**
   * Sends one message. `to` arrives already normalised to `+233NNNNNNNNN`, so a
   * provider implementation does not have to repeat the numbering plan.
   *
   * Must not throw for an ordinary refusal — an unknown subscriber, an
   * unsubscribed handset, a provider-side quota — because those are answers and
   * belong in the outcome. It may throw for a transport failure, which
   * `deliverSms` catches and reports as not delivered.
   */
  send(message: { to: string; body: string }): Promise<SmsOutcome>;
}

/**
 * The configured provider, or null.
 *
 * Null today, always, because `config.sms.configured` is false until the
 * variables are set. See the header for why nothing is guessed ahead of that.
 */
export function configuredSmsProvider(sms: SmsConfig = config.sms): SmsProvider | null {
  if (!sms.configured) return null;
  return {
    name: 'unwritten',
    send: async () => {
      // Logged with the endpoint because this is the branch somebody will be
      // debugging from the log, and the reason string deliberately omits it.
      log.error('sms provider configured but not implemented', { apiUrl: sms.apiUrl });
      return { delivered: false, status: 'not_sent', reason: PROVIDER_NOT_WRITTEN_REASON };
    },
  };
}

/**
 * Hands a reminder to a provider, or explains why it could not.
 *
 * The provider is a parameter with a default rather than a module-level import
 * so the plumbing is testable without a vendor: the sequence of checks below,
 * the normalisation, and the mapping of a thrown transport error onto a reason
 * are all real behaviour, and all of it is covered by a suite that injects a
 * fake. What is not covered — because it cannot be — is whether a real provider
 * accepts the request, and that is a fact about a vendor rather than about this
 * module.
 *
 * Nothing here reads the clock. The instant a message went out is the
 * provider's to report and arrives as `sentAt` in its outcome; a timestamp
 * taken locally instead would claim to know when a handset received something
 * this process only handed over.
 */
export async function deliverSms(
  message: SmsMessage,
  provider: SmsProvider | null = configuredSmsProvider()
): Promise<SmsOutcome> {
  if (message.body.trim() === '') {
    // Refused rather than sent. An empty message is a builder bug, and a
    // provider would accept it, bill for it, and deliver a blank text to a
    // patient — who would then have no idea why their pharmacy texted them.
    return { delivered: false, status: 'not_sent', reason: 'The message has no text in it.' };
  }
  if (message.body.length > SMS_BODY_MAX_LENGTH) {
    // Also refused rather than truncated. Cutting a reminder mid-sentence to
    // fit a segment count is the kind of edit that turns "your blood pressure
    // reading was high" into something that says the opposite.
    return {
      delivered: false,
      status: 'not_sent',
      reason: `The message is ${message.body.length} characters and the limit is ${SMS_BODY_MAX_LENGTH}.`,
    };
  }
  if (message.to === null || message.to.trim() === '') {
    return { delivered: false, status: 'not_sent', reason: NO_PHONE_REASON };
  }

  const to = normaliseGhanaPhone(message.to);
  if (to === null) {
    return { delivered: false, status: 'not_sent', reason: UNSENDABLE_PHONE_REASON };
  }

  // Last of the refusals, and the ordering is the point rather than an accident of
  // how the branches were written. With no provider configured nothing can be sent at
  // all, so the tempting shape is to return early — ahead of the checks on the record
  // — which would report "no SMS provider is configured" for a patient whose number
  // is a typo. Both sentences are true; only one of them is something a pharmacist can
  // act on today, by asking that patient for their number again.
  if (provider === null) {
    return { delivered: false, status: 'not_sent', reason: SMS_NOT_CONFIGURED_REASON };
  }

  try {
    return await provider.send({ to, body: message.body });
  } catch (error) {
    // A transport failure is `failed`, not `not_sent`: something was attempted
    // and did not complete, which is the distinction the status enum exists to
    // carry. It is a reason rather than a 500 either way, because the reminder
    // still has to be written down as undelivered — a refresh that threw instead
    // would leave it `pending` forever, and `pending` reads as "on its way" when
    // nothing is. The provider's own message is logged and not surfaced: it can
    // name a vendor, an endpoint or an auth scheme, none of which is a fact for
    // the person at the counter.
    const detail = error instanceof Error ? error.message : String(error);
    log.error('sms delivery threw', { provider: provider.name, error: detail });
    return {
      delivered: false,
      status: 'failed',
      reason: 'The SMS provider could not be reached. The reminder is in the app instead.',
    };
  }
}
