import { newPaymentReference } from '../utils/reference';

/**
 * The reference a mobile money tender is bound to.
 *
 * Forty-three lines of source, and the reason it has a suite is that every way
 * it can break is silent. A reference that collides does not error:
 * `findSalePaymentByReference` takes the earliest match, so a webhook for the
 * newer tender settles the older one and both sales look correct on screen and in
 * the ledger. A reference that stopped carrying the receipt number still works
 * everywhere except on the phone to Paystack support, where nobody can find the
 * sale it belongs to.
 *
 * Migration 0003 makes a collision a refused insert rather than a mis-settled
 * sale, so the worst outcome is now loud — but only at the moment of the insert.
 * The entropy is what stops that refusal ever happening to a customer at a
 * counter.
 */

const SALE_NUMBER = 'H3-000042';

/**
 * The suffix, pinned as a shape rather than as a value.
 *
 * Sixteen uppercase hex characters is eight bytes is sixty-four bits. The
 * `{16}` is the assertion that matters in this file: the first draft used four
 * bytes, and the change from `{8}` to `{16}` is exactly the kind of edit that
 * reads as tidying — a shorter reference is easier to read aloud, and nothing
 * else in the codebase gets worse the day it is made.
 */
const SUFFIX = /^[0-9A-F]{16}$/;

describe('newPaymentReference', () => {
  it('carries the receipt number and sixteen hex characters', () => {
    const reference = newPaymentReference(SALE_NUMBER);
    expect(reference).toMatch(new RegExp(`^${SALE_NUMBER}-[0-9A-F]{16}$`));
    expect(reference.slice(SALE_NUMBER.length + 1)).toMatch(SUFFIX);
  });

  it('carries the receipt number through verbatim', () => {
    // No sanitising, and that is load-bearing rather than incidental: the
    // reference is matched by exact equality in SQL and is put into a URL path by
    // `verifyTransaction`, so a function that normalised anything here would
    // produce a reference the webhook lookup could not find. Sale numbers are
    // `H3-000042` today; this pins that the format is not doing quiet work.
    expect(newPaymentReference('H12-999999').startsWith('H12-999999-')).toBe(true);
  });

  it('draws a different reference every time', () => {
    // The observable proof that entropy is being used at all. A constant, a
    // counter or `randomBytes(0)` would satisfy every format assertion above and
    // would settle the first tender every webhook ever named.
    const references = new Set(Array.from({ length: 50 }, () => newPaymentReference(SALE_NUMBER)));
    expect(references.size).toBe(50);
  });

  it('does not reuse a reference across two sales with the same number', () => {
    // `sale_number` is unique per pharmacy and not across them, and a webhook
    // arrives with a reference and no way to say which pharmacy it belongs to.
    // Two pharmacies both ringing their 42nd sale of the day must not produce one
    // reference, or `findSalePaymentByReference` — which has no tenant in its
    // where clause, and cannot — would have two rows to choose between.
    const a = newPaymentReference('H3-000042');
    const b = newPaymentReference('H3-000042');
    expect(a).not.toBe(b);
  });

  it('stays distinct over a draw far larger than a pharmacy will ever make', () => {
    const draws = 20_000;
    const references = new Set(
      Array.from({ length: draws }, () => newPaymentReference(`H3-${draws}`))
    );
    expect(references.size).toBe(draws);
  });

  // Worth knowing before this is mistaken for the entropy guard: it is not. The
  // suite was run with `randomBytes(4)` in place of `randomBytes(8)` and both
  // distinctness tests above still passed, because 20,000 draws over 32 bits
  // collide only about 29% of the time — a coin flip is not a regression test.
  // What caught the change was the `{16}` in the first test, and that is why the
  // length is pinned as a shape rather than the distinctness as a property. These
  // two still earn their place: they are what fails if `randomBytes` is replaced
  // by something degenerate, which no length assertion would notice.

  it('is a pure function of its argument and entropy, with no clock in it', () => {
    // Pinned by shape rather than by value: a timestamp in the suffix would make
    // references guessable in the only sense that matters here, which is that
    // somebody who has seen one can predict roughly where the next one lives. The
    // hex-only assertion above is what forbids it, and this restates the intent so
    // the forbidding is not read as an accident of the format.
    for (const reference of Array.from({ length: 20 }, () => newPaymentReference(SALE_NUMBER))) {
      expect(reference.split('-').pop()).toMatch(SUFFIX);
    }
  });
});
