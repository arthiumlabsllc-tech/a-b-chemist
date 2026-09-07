import { config, type SmsConfig } from '../config';
import { ALERT_NOT_SENT_REASON } from '../services/alerts.service';
import {
  NO_PHONE_REASON,
  PROVIDER_NOT_WRITTEN_REASON,
  SMS_BODY_MAX_LENGTH,
  SMS_NOT_CONFIGURED_REASON,
  UNSENDABLE_PHONE_REASON,
  configuredSmsProvider,
  deliverSms,
  type SmsOutcome,
  type SmsProvider,
} from '../services/sms';

/**
 * Being honest about a message that did not leave.
 *
 * `services/sms.ts` is where Phase 8's acceptance line is concentrated — "every
 * reminder that has not been sent is labelled as not sent and why" — and the
 * module's own header claims the delivery plumbing is covered by a suite that
 * injects a fake provider. This is that suite. Nothing in it reaches a vendor,
 * because nothing in the module does: `configuredSmsProvider` returns null until
 * A&B chooses an aggregator, and the branches below are all the behaviour that
 * exists.
 *
 * What is worth pinning, and why a suite is worth having for a module that sends
 * nothing:
 *
 *   - The *order* of the refusals. A record with no phone number in a pharmacy
 *     with no provider is two true facts, and which one is written down decides
 *     whether anybody can act on it. The specific one wins, deliberately.
 *   - `failed` versus `not_sent`. Collapsing them is the easiest edit in this file
 *     and it removes the difference between "nothing was attempted" and "a
 *     provider was reached and said no", which have different owners.
 *   - What is *not* in the reason. These sentences reach the bell, where counter
 *     staff read them, so an endpoint or a key in one is configuration detail in
 *     front of a pharmacist and a secret in an API response.
 *   - That the provider is handed the normalised destination and the body
 *     verbatim. Trimming or rewriting clinical text to fit a segment count is the
 *     kind of edit that changes what it says.
 */

const VALID_PHONE = '024 123 4567';
const NORMALISED = '+233241234567';
const BODY = 'Your blood pressure script is due for a refill.';

const UNCONFIGURED: SmsConfig = { apiUrl: '', apiKey: '', senderId: '', configured: false };

const CONFIGURED: SmsConfig = {
  apiUrl: 'https://sms.invalid.example/send',
  apiKey: 'sk-test-not-a-real-key',
  senderId: 'ABCHEM',
  configured: true,
};

interface FakeProvider extends SmsProvider {
  /** Everything `send` was actually given, in order — the call record. */
  sent: { to: string; body: string }[];
}

/**
 * A provider that answers with a fixed outcome and keeps a record of the attempt.
 *
 * The record is the point: half of what is asserted here is that a refusal
 * happens *before* the provider is reached, and a stub that only returned an
 * outcome could not distinguish that from a provider being called and refusing.
 */
function fakeProvider(outcome: SmsOutcome): FakeProvider {
  const sent: { to: string; body: string }[] = [];
  return {
    name: 'fake',
    sent,
    send: async (message) => {
      sent.push(message);
      return outcome;
    },
  };
}

function throwingProvider(error: Error): FakeProvider {
  const sent: { to: string; body: string }[] = [];
  return {
    name: 'throwing',
    sent,
    send: async (message) => {
      sent.push(message);
      throw error;
    },
  };
}

/**
 * The reason on an undelivered outcome.
 *
 * Throws rather than returning a placeholder, following `onlyCall` in the
 * reminders suite: an assertion about why nothing was sent that quietly received a
 * delivered outcome would pass by asserting on the empty string, which is the sort
 * of test that cannot fail and so proves nothing.
 */
function reasonOf(outcome: SmsOutcome): string {
  if (outcome.delivered) {
    throw new Error('expected an undelivered outcome');
  }
  return outcome.reason;
}

/** Narrows `configuredSmsProvider`'s answer, because `expect(…).not.toBe(null)` does not. */
function mustProvider(provider: SmsProvider | null): SmsProvider {
  if (provider === null) {
    throw new Error('expected a provider, got null');
  }
  return provider;
}

describe('the reasons', () => {
  it('are four distinct sentences, because collapsing any two leaves nobody able to say which problem this is', () => {
    // The module's header argues for four rather than one, and the argument is only
    // true while they stay distinguishable. Two of them becoming the same string is
    // an edit that reads as tidying — "these both mean it did not go" — and it would
    // leave a pharmacist unable to tell a configuration problem they cannot fix from
    // a missing phone number they can, by asking the patient at the next visit.
    const reasons = [
      SMS_NOT_CONFIGURED_REASON,
      NO_PHONE_REASON,
      UNSENDABLE_PHONE_REASON,
      PROVIDER_NOT_WRITTEN_REASON,
    ];
    expect(new Set(reasons).size).toBe(4);
  });

  it('are written for a person at a counter, and carry no configuration detail', () => {
    // These strings are persisted to `notifications.not_sent_reason` and
    // `reminders.not_sent_reason` and read back in the bell, so they end up in an
    // API response. An endpoint, a key or a header name in one is a secret in a
    // place nobody is looking for it, and it helps nobody there: whoever has to
    // debug the integration has the log line instead.
    for (const reason of [
      SMS_NOT_CONFIGURED_REASON,
      NO_PHONE_REASON,
      UNSENDABLE_PHONE_REASON,
      PROVIDER_NOT_WRITTEN_REASON,
    ]) {
      expect(reason.endsWith('.')).toBe(true);
      expect(reason.toLowerCase()).not.toContain('http');
      expect(reason).not.toContain(CONFIGURED.apiUrl);
      expect(reason).not.toContain(CONFIGURED.apiKey);
      expect(reason.toLowerCase()).not.toContain('api');
    }
  });

  it('are one home for the sentence a stock alert has carried since Phase 4', () => {
    // An assignment in source, so it cannot drift by accident — which is exactly why
    // it is worth a test. The regression is somebody replacing the re-export in
    // `alerts.service.ts` with its own copy of the literal, and from then on a stock
    // alert and a patient reminder that cannot be texted are two situations in the
    // bell when they are one fact about this pharmacy's configuration.
    expect(ALERT_NOT_SENT_REASON).toBe(SMS_NOT_CONFIGURED_REASON);
  });
});

describe('deliverSms', () => {
  it('hands the provider the normalised destination and the body exactly as composed', async () => {
    const provider = fakeProvider({
      delivered: true,
      sentAt: '2026-04-20T09:00:05.000Z',
      reference: 'V-1',
    });

    // The record holds `024 123 4567` because that is how it was typed, and the
    // provider is given `+233241234567` because that is the one shape it accepts.
    // The body is passed through untrimmed on purpose: it is clinical text, and a
    // module that tidied it would be editing what a patient is told about their own
    // medicine.
    await expect(
      deliverSms({ to: ` ${VALID_PHONE} `, body: ` ${BODY} ` }, provider)
    ).resolves.toEqual({
      delivered: true,
      sentAt: '2026-04-20T09:00:05.000Z',
      reference: 'V-1',
    });
    expect(provider.sent).toEqual([{ to: NORMALISED, body: ` ${BODY} ` }]);
  });

  it('refuses an empty body rather than sending a blank text, and never reaches the provider', async () => {
    const provider = fakeProvider({ delivered: true, sentAt: '2026-04-20T09:00:05.000Z', reference: 'V-1' });

    // A blank message is a builder bug, and a provider would accept it, bill for it
    // and deliver nothing — leaving a patient with a text from their pharmacy and no
    // idea why. The `sent` record being empty is the assertion that matters: a refusal
    // that still called the provider would be a refusal in name only.
    for (const body of ['', '   ', '\n\t ']) {
      const outcome = await deliverSms({ to: VALID_PHONE, body }, provider);
      expect({ body, outcome }).toEqual({
        body,
        outcome: {
          delivered: false,
          status: 'not_sent',
          reason: 'The message has no text in it.',
        },
      });
    }
    expect(provider.sent).toEqual([]);
  });

  it('is two GSM segments, and the limit is pinned as a number rather than inferred', () => {
    // 320 is 2 × 153 usable characters in a concatenated GSM-7 message. Pinned
    // because raising it is an edit that reads as generous — a longer reminder is a
    // more useful reminder — and the cost lands on the pharmacy's bill per message
    // and on a handset that renders four segments as four separate texts.
    expect(SMS_BODY_MAX_LENGTH).toBe(320);
  });

  it('refuses an over-long body rather than truncating it, on the length that would actually be sent', async () => {
    const provider = fakeProvider({ delivered: true, sentAt: '2026-04-20T09:00:05.000Z', reference: 'V-1' });

    const tooLong = 'a'.repeat(SMS_BODY_MAX_LENGTH + 1);
    const outcome = await deliverSms({ to: VALID_PHONE, body: tooLong }, provider);

    // Truncating is the tempting alternative and it is worse than refusing: cutting a
    // reminder mid-sentence to fit a segment count is the kind of edit that turns
    // "your blood pressure reading was high" into something saying the opposite.
    // Both numbers are in the reason so whoever composed it can see how far over it
    // went rather than having to count.
    expect(outcome).toEqual({
      delivered: false,
      status: 'not_sent',
      reason: `The message is ${SMS_BODY_MAX_LENGTH + 1} characters and the limit is ${SMS_BODY_MAX_LENGTH}.`,
    });
    expect(provider.sent).toEqual([]);

    // Exactly at the limit is accepted, so the bound is inclusive and the refusal is
    // about being over rather than about being long.
    const atLimit = fakeProvider({ delivered: true, sentAt: '2026-04-20T09:00:05.000Z', reference: 'V-2' });
    await expect(
      deliverSms({ to: VALID_PHONE, body: 'a'.repeat(SMS_BODY_MAX_LENGTH) }, atLimit)
    ).resolves.toEqual({ delivered: true, sentAt: '2026-04-20T09:00:05.000Z', reference: 'V-2' });
    expect(atLimit.sent).toHaveLength(1);

    // And the limit is measured on what would be sent, not on what it would say once
    // tidied: a body at the limit with a trailing space is over, because the space is
    // sent too.
    const padded = fakeProvider({ delivered: true, sentAt: '2026-04-20T09:00:05.000Z', reference: 'V-3' });
    await expect(
      deliverSms({ to: VALID_PHONE, body: `${'a'.repeat(SMS_BODY_MAX_LENGTH)} ` }, padded)
    ).resolves.toMatchObject({ delivered: false, status: 'not_sent' });
    expect(padded.sent).toEqual([]);
  });

  it('reports a missing phone number before it reports anything about the provider', async () => {
    const provider = fakeProvider({ delivered: true, sentAt: '2026-04-20T09:00:05.000Z', reference: 'V-1' });

    // Both facts are true here — the record has no number *and* a provider is
    // configured — and the record's is the one written down, because it is the one
    // somebody at the counter can act on. A provider that is configured but never
    // reached is not a reason to hide a gap in the patient's record behind it.
    for (const to of [null, '', '   ']) {
      const outcome = await deliverSms({ to, body: BODY }, provider);
      expect({ to, outcome }).toEqual({
        to,
        outcome: { delivered: false, status: 'not_sent', reason: NO_PHONE_REASON },
      });
    }
    expect(provider.sent).toEqual([]);
  });

  it('reports an unsendable number even when no provider is configured, because the record is the part the pharmacy can fix', async () => {
    // The precedence that is easiest to get backwards. With no provider, nothing will
    // ever be sent, so "no SMS provider is configured" is true — and useless, because
    // the pharmacy already knows it and cannot do anything about it today. "This
    // number is not a sendable Ghana number" is also true, and a pharmacist can fix it
    // by asking the patient at the next visit. The specific reason wins.
    const outcome = await deliverSms({ to: '024123456a', body: BODY }, null);
    expect(outcome).toEqual({
      delivered: false,
      status: 'not_sent',
      reason: UNSENDABLE_PHONE_REASON,
    });
    expect(outcome).not.toEqual({
      delivered: false,
      status: 'not_sent',
      reason: SMS_NOT_CONFIGURED_REASON,
    });
  });

  it('says not sent, with the reason stock alerts carry, when there is nowhere to send it', async () => {
    // The state the platform ships in, and the one the acceptance line is about: a
    // reminder that has not been sent is labelled as not sent, with the why beside it,
    // rather than left `pending` where it reads as "on its way".
    await expect(deliverSms({ to: VALID_PHONE, body: BODY }, null)).resolves.toEqual({
      delivered: false,
      status: 'not_sent',
      reason: SMS_NOT_CONFIGURED_REASON,
    });
  });

  it('uses the configured provider by default, which in this environment is none', async () => {
    // The default parameter is the production path, so it is pinned rather than left
    // to the explicit-provider tests. The precondition is asserted first: this test is
    // about the wiring, and if the test environment ever grows SMS variables the
    // honest outcome is a loud failure here rather than a quietly different assertion.
    expect(config.sms.configured).toBe(false);

    await expect(deliverSms({ to: VALID_PHONE, body: BODY })).resolves.toEqual({
      delivered: false,
      status: 'not_sent',
      reason: SMS_NOT_CONFIGURED_REASON,
    });
  });

  it('reports a transport failure as failed rather than not sent, because something was attempted', async () => {
    const provider = throwingProvider(new Error('ECONNREFUSED https://sms.invalid.example/send'));

    const outcome = await deliverSms({ to: VALID_PHONE, body: BODY }, provider);

    // The distinction the status enum exists to carry, and the edit that would remove
    // it is one word. `not_sent` means nothing was attempted and the reason is a fact
    // about this pharmacy's configuration or its records; `failed` means a provider was
    // reached and did not complete, which is a different problem with a different owner
    // and one no amount of asking patients for their numbers will fix.
    expect(outcome).toMatchObject({ delivered: false, status: 'failed' });

    // It is still a reason and not a thrown 500, because the reminder has to be written
    // down as undelivered either way — a refresh that threw instead would leave it
    // `pending` forever, and `pending` reads as "on its way" when nothing is.
    // And the provider's own message is logged rather than surfaced: it names an
    // endpoint and a scheme, neither of which is a fact for the person at the counter.
    expect(reasonOf(outcome)).not.toBe('');
    expect(reasonOf(outcome)).not.toContain('ECONNREFUSED');
    expect(reasonOf(outcome)).not.toContain(CONFIGURED.apiUrl);
    expect(provider.sent).toHaveLength(1);
  });

  it('passes a provider refusal through unchanged, because the provider is the one that knows why', async () => {
    const refusal: SmsOutcome = {
      delivered: false,
      status: 'failed',
      reason: 'The subscriber is not reachable on this network.',
    };
    const provider = fakeProvider(refusal);

    // Not remapped and not replaced with one of this module's four sentences. An
    // unknown subscriber, an unsubscribed handset and a provider-side quota are
    // answers rather than transport failures, and this module has nothing to add to
    // them: rewriting a vendor's explanation into a generic one is how a pharmacy
    // ends up unable to tell a patient who opted out from one with a dead SIM.
    await expect(deliverSms({ to: VALID_PHONE, body: BODY }, provider)).resolves.toBe(refusal);
  });

  it('passes a delivery through with the instant the provider reported, and never reads the clock', async () => {
    const delivered: SmsOutcome = {
      delivered: true,
      sentAt: '2026-04-20T09:00:05.000Z',
      reference: 'VENDOR-REFERENCE-9',
    };
    const provider = fakeProvider(delivered);

    // The instant a message went out is the provider's to report. Stamped locally
    // instead, the record would claim to know when a handset received something this
    // process only handed over — and the reference is what turns "I never got it"
    // from a dispute into a lookup, so it travels with the outcome rather than being
    // dropped on the way back.
    await expect(deliverSms({ to: VALID_PHONE, body: BODY }, provider)).resolves.toBe(delivered);
  });
});

describe('configuredSmsProvider', () => {
  it('answers null when the pharmacy has configured nothing', () => {
    expect(configuredSmsProvider(UNCONFIGURED)).toBe(null);
  });

  it('branches on the configured flag alone, so a half-set provider is refused rather than attempted', () => {
    // `config.sms.configured` is computed from both halves being present, and this
    // module reads that and nothing else. Re-deriving it here would be a second rule
    // that could disagree with the first; trusting it means a URL with no key is
    // "not configured" and is refused cleanly, instead of being attempted and failing
    // on the first message with an authentication error nobody can read.
    expect(
      configuredSmsProvider({ apiUrl: 'https://sms.invalid.example/send', apiKey: '', senderId: '', configured: false })
    ).toBe(null);

    // And the converse, which is the other half of "reads this and nothing else": with
    // the flag set, a provider is returned even though this module has not looked at
    // the URL. The flag is the contract.
    expect(
      configuredSmsProvider({ apiUrl: '', apiKey: '', senderId: '', configured: true })
    ).not.toBe(null);
  });

  it('answers a provider that refuses with its own reason, because the first reason would be a lie', async () => {
    const provider = mustProvider(configuredSmsProvider(CONFIGURED));

    // The fourth reason exists for this branch. Reporting "no SMS provider is
    // configured" at an operator who has just configured one sends them looking in the
    // wrong place entirely — they would go and check variables that are set correctly,
    // while the actual gap is that this build has no integration for the vendor they
    // chose.
    expect(provider.name).toBe('unwritten');
    await expect(provider.send({ to: NORMALISED, body: BODY })).resolves.toEqual({
      delivered: false,
      status: 'not_sent',
      reason: PROVIDER_NOT_WRITTEN_REASON,
    });
  });

  it('logs the endpoint and keeps it out of the reason that reaches the bell', async () => {
    const provider = mustProvider(configuredSmsProvider(CONFIGURED));
    const outcome = await provider.send({ to: NORMALISED, body: BODY });

    // The sentence is persisted and surfaced to counter staff; the endpoint is
    // configuration detail that helps nobody there and belongs in the log beside the
    // line whoever debugs the integration will be reading.
    expect(outcome).toMatchObject({ delivered: false, status: 'not_sent' });
    expect(reasonOf(outcome)).not.toContain(CONFIGURED.apiUrl);
    expect(reasonOf(outcome)).not.toContain('invalid.example');
  });
});
