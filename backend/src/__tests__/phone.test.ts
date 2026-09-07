import { normaliseGhanaPhone } from '../utils/phone';

/**
 * Ghana's numbering plan, and the decision to refuse rather than send.
 *
 * This is a pure function of one argument with no I/O in it, and it has a suite
 * because both of its failure modes are silent and both land on a patient.
 *
 * Normalising too little hands a provider a destination it will usually accept,
 * bill for, and report success at the HTTP level — so `reminders.status` says
 * `sent` for a message that arrived at nobody, and the pharmacy has a record
 * that is wrong in the direction that cannot be discovered. Normalising too
 * much refuses a real customer's number, and the failure looks identical from
 * the counter to a genuine typo: `not_sent`, with a reason that says the number
 * is not a Ghana number.
 *
 * The module resolves that trade-off toward refusing too little — it checks
 * *shape* against nine national digits beginning 2, 3 or 5, and deliberately does
 * not hold a table of prefixes the National Communications Authority currently
 * allocates, because a stale table's worst case is the second failure and there
 * is no way to see it. What is pinned here is therefore the shape rule and its
 * edges, not a list of operators.
 */

/** The output contract: international form, one of the three valid first digits. */
const SHAPE = /^\+233[235]\d{8}$/;

const VALID_MOBILE = '+233241234567';

describe('normaliseGhanaPhone', () => {
  it('reads the five ways one handset gets written at a counter as one number', () => {
    // The whole reason the function exists, and the list is the one the module's
    // header names. Pinned as a set rather than one example because the branches
    // are separate: `+233…` and `00233…` are stripped as international prefixes,
    // `024…` as a trunk zero, and the bare nine digits and the spaced form reach
    // the length rule with nothing stripped at all. Collapsing any two of those
    // into one branch would still pass a single example.
    for (const written of [
      '024 123 4567',
      '0241234567',
      '+233241234567',
      '233241234567',
      '24 123 4567',
      '00233241234567',
      '241234567',
    ]) {
      expect({ written, normalised: normaliseGhanaPhone(written) }).toEqual({
        written,
        normalised: VALID_MOBILE,
      });
    }
  });

  it('removes grouping punctuation before it counts, so a space after the plus still works', () => {
    // Formatting is stripped ahead of the prefix test rather than after, which is
    // what makes `+ 233 …` work: were the `+` looked for first, the leading space
    // left behind by trimming would put it in the wrong place and the number would
    // be counted as twelve digits with a country code that is not one.
    expect(normaliseGhanaPhone(' + 233 24 123 4567 ')).toBe(VALID_MOBILE);
    expect(normaliseGhanaPhone('(024) 123-4567')).toBe(VALID_MOBILE);
    expect(normaliseGhanaPhone('024.123.4567')).toBe(VALID_MOBILE);
  });

  it('strips exactly the five grouping characters and nothing else that looks like punctuation', () => {
    // The class is `[\s\-().]` — space, hyphen, parentheses, dot — and its edges are
    // worth pinning because widening it reads as tidying. A slash, a comma or a colon
    // in a phone field is not grouping, it is a wrong value, and the same argument
    // the module makes about letters applies: dropping it would turn `024/123/4567`
    // into a destination that belongs to whoever answers it.
    for (const written of [
      '024/123/4567',
      '024,123,4567',
      '024:123:4567',
      "024'123'4567",
    ]) {
      expect({ written, normalised: normaliseGhanaPhone(written) }).toEqual({
        written,
        normalised: null,
      });
    }
  });

  it('accepts a fixed line, because a landline is a destination and not a wrong value', () => {
    // 3X is fixed-line in Ghana's plan. The check is on the first national digit
    // only, so a pharmacy that texts a patient's landline — a shop, a clinic, a
    // household sharing one handset — is not refused by this module. Whether the
    // handset can receive a message is the provider's answer and arrives as a
    // delivery failure, which is a different fact with a different reason beside it.
    expect(normaliseGhanaPhone('030 212 3456')).toBe('+233302123456');
    expect(normaliseGhanaPhone('0501234567')).toBe('+233501234567');
  });

  it('refuses a first national digit outside 2, 3 and 5', () => {
    // One rule rather than six, and it is the shape rule the header states. These
    // are the refusals that are *correct* — a number beginning 1, 4, 6, 7, 8 or 9
    // in the national position is not a Ghana number, and sending it would be the
    // billed-and-misreported case.
    for (const written of [
      '0112345678',
      '0412345678',
      '0612345678',
      '0712345678',
      '0812345678',
      '0912345678',
      '112345678',
      '412345678',
    ]) {
      expect({ written, normalised: normaliseGhanaPhone(written) }).toEqual({
        written,
        normalised: null,
      });
    }
  });

  it('refuses a wrong length rather than padding or truncating it into a plausible number', () => {
    // The tempting implementation is to take the last nine digits, which would make
    // every one of these "work" — and would send a reminder to a stranger. A
    // truncated or over-long number is a typo, and a typo is refused loudly.
    for (const written of [
      '024123456', // nine characters with the trunk zero on: eight national digits
      '02412345678', // eleven
      '+23324123456', // country code plus eight
      '+2332412345678', // country code plus ten
      '24123456', // eight
      '2412345678', // ten with no trunk zero
      '+233',
    ]) {
      expect({ written, normalised: normaliseGhanaPhone(written) }).toEqual({
        written,
        normalised: null,
      });
    }
  });

  it('refuses a letter instead of dropping it, because a letter is a wrong value and not formatting', () => {
    // The digit check runs after punctuation is removed and before any length
    // arithmetic, and the two orderings answer differently. Stripping the letter as
    // though it were formatting would turn `024123456a` into a valid nine-digit
    // national number — a plausible destination belonging to somebody else, billed
    // as a success. Refusing it leaves the typo visible to whoever typed it.
    expect(normaliseGhanaPhone('024123456a')).toBe(null);
    expect(normaliseGhanaPhone('024 123 456a')).toBe(null);
    expect(normaliseGhanaPhone('(024) 123-4567 ext')).toBe(null);
  });

  it('answers null to anything that is not a string, because its callers hold a JSON body and a nullable column', () => {
    // The signature takes `unknown` for exactly this reason: a request body can
    // carry a number where a string was meant, and the column can carry null. A
    // signature demanding `string` would push the same three checks into every
    // caller, and the caller that forgot one would throw on a patient record with
    // no phone number — which is the ordinary case, not an error.
    for (const value of [241234567, null, undefined, {}, [], true]) {
      expect(normaliseGhanaPhone(value)).toBe(null);
    }
  });

  it('answers null to nothing at all, and to punctuation alone', () => {
    expect(normaliseGhanaPhone('')).toBe(null);
    expect(normaliseGhanaPhone('   ')).toBe(null);
    expect(normaliseGhanaPhone('()')).toBe(null);
    expect(normaliseGhanaPhone('+')).toBe(null);
  });

  it('refuses a number from another country, and the refusal is honest rather than lossy', () => {
    // A customer visiting from Lomé has a real number on their record and it is
    // stored and displayed exactly as it was typed — `patients.repository.ts` pins
    // that separately, because a formatter built on this function would blank the
    // field on screen and lie by omission. What this function says is narrower and
    // true: it is not a destination this module can hand a Ghana-shaped send. The
    // reminder still reaches the bell, where somebody can telephone instead.
    expect(normaliseGhanaPhone('+228 90 12 34 56')).toBe(null);
    expect(normaliseGhanaPhone('0022890123456')).toBe(null);
    expect(normaliseGhanaPhone('+44 7700 900123')).toBe(null);
  });

  it('reads nine digits beginning 233 as a national number, not as a country code with digits missing', () => {
    // The one genuine ambiguity in the rule, pinned so the resolution is a decision
    // on the record rather than an accident of branch order. `233241234` could be
    // read as country code `233` plus six national digits — too short, so a refusal
    // — or as nine national digits that happen to begin `233`, which is shape-valid
    // because Ghana's plan allows a national number to start with 2. This takes the
    // second reading, consistently with refusing too little: the first would refuse
    // a customer whose number is complete and correct.
    expect(normaliseGhanaPhone('233241234')).toBe('+233233241234');
  });

  it('is idempotent, so a number normalised twice is not corrupted the second time', () => {
    // Load-bearing for the callers rather than a nicety: a record stores the number
    // as typed, and a reminder may be composed from the stored value by one path and
    // from an already-normalised one by another. Were the output rejected by the
    // input rule, the second path would refuse a destination the first had accepted
    // and the same patient would be sendable or not depending on which route ran.
    const once = normaliseGhanaPhone('024 123 4567');
    expect(once).toBe(VALID_MOBILE);
    expect(normaliseGhanaPhone(once)).toBe(VALID_MOBILE);
  });

  it('only ever returns the one output shape', () => {
    // Asserted across everything above rather than on one example, because this is
    // the contract a provider is written against: `+233` and nine national digits,
    // no spaces, no trunk zero, no punctuation. A future branch that returned the
    // national part alone would satisfy a caller comparing against a record and
    // would be rejected by the provider.
    const accepted = [
      '024 123 4567',
      '0241234567',
      '+233241234567',
      '233241234567',
      '24 123 4567',
      '00233241234567',
      '241234567',
      '030 212 3456',
      '0501234567',
      '233241234',
    ];
    for (const written of accepted) {
      expect({ written, normalised: normaliseGhanaPhone(written) }).toEqual({
        written,
        normalised: expect.stringMatching(SHAPE),
      });
    }
  });
});
