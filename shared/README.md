# shared/

The money, tax and pricing engine, as a workspace package with no runtime
dependencies.

## Why this is a package and not a folder in `backend/`

Because it has two consumers that must not disagree. The API prices a sale at the
counter, and the offline till prices the same sale with no server in reach — and
if the two compute VAT differently, the pharmacy has two answers for one basket
and no way to tell which one the receipt came from. A shared module makes that
disagreement a compile error rather than a reconciliation exercise.

It also means the arithmetic is testable on its own, with no database, no Express
and no clock.

## Two invariants

**Money is a whole number of pesewas.** Never a float, never a cedi decimal.
`0.1 + 0.2 !== 0.3` is not a curiosity in a till; it is a pesewa that does not
balance at the end of the day. Strings cross the boundary only at the edges —
`pesewasFromDecimalString` in, `decimalStringFromPesewas` out — because that is
the shape `pg` uses for `numeric`.

**Rates are whole ten-thousandths.** `0.15` is `1500`. This is not a scaling
convention chosen for convenience: it is exactly what `numeric(5, 4)` in
`database/init.sql` holds, so the integer in memory and the value in the column
are the same number with no conversion between them.

## Purity is enforced by the compiler, not by review

`tsconfig.build.json` sets `types: []` and `lib: ["ES2017"]`, with no DOM. So in
anything that reaches `dist`, naming `process`, `Buffer`, `require`, `console`,
`window` or `fetch` is a compile error — the declarations simply do not exist.
An engine that read the clock or the environment could not be replayed offline,
and a reviewer cannot be relied on to notice; the compiler can.

`lib: ES2017` is also why `flatMap`, `Object.fromEntries` and friends are
unavailable. That is a deliberate cost: the till runs in a browser on hardware
nobody controls, and the service worker has to keep working.

## The public surface

`src/index.ts` is the only door. Anything not re-exported there is internal, and
a consumer importing it by path will break when the file moves.

- **`money`** — rounding, the two parsers and the two formatters, the bounds and
  their assertions.
- **`tax`** — `taxSettings` (the one place rates are parsed), `taxOnLine`,
  `taxOnExclusiveBase`, `taxFromInclusiveGross`, and the VAT treatments.
- **`discount`** — `apportionDiscount`, which splits a basket discount across
  lines so that the shares sum exactly to the whole. Each line takes a floored
  proportional share and the remainder is then placed largest-line-first,
  earliest-first among equals, never giving a line more discount than it is
  worth. Which lines absorbed the remainder is reported, not hidden, because a
  receipt has to be reproducible rather than merely right.
- **`basket`** — `priceBasket`, the whole sale: lines, discount, the three
  charges, the total, and the four settings snapshotted beside it.
- **`errors`** — `TaxError`, `isTaxError`, and the stable `code` values, so a
  caller can branch without matching prose.
- **`fixtures/`** — GRA's published figures and the parity vectors, as data.

## Act 1151

VAT 15%, the National Health Insurance Levy 2.5% and the GETFund levy 2.5%, in
force from 1 January 2026 under the Value Added Tax Act, 2025 (Act 1151). **All
three are charged on the same base.** There is no cascade.

`src/fixtures/gra-worked-example.ts` transcribes GRA's own illustration — 1,000
exclusive becomes NHIL 25, GETFund 25, VAT 150, total 1,200 — along with its
source URL, the instrument and the retrieval date. The tests are written against
those five published numbers rather than against arithmetic this repository
computed, because an engine tested against its author's own figures is a test
that agrees with itself: write the same mistake twice and both are green.

The pre-reform figures are kept in the same file as numbers the engine must
**not** produce. The old law added the levies to the price and charged VAT on the
sum, which is 19 cedis wrong in every 1,000 and is what most existing Ghanaian
code in the wild still does. It is plausible-looking, which is why it is a test
and not a footnote.

GRA publishes no rounding rule, so half-up is ours and is documented as ours.

## Two formatters, because there are two readers

`rateLabel(1500)` returns `'15%'`. That is what a receipt names the rate as, and
GRA requires the receipt to name NHIL, GETFund and VAT separately.

`rateDecimalString(1500)` returns `'0.1500'`. That is what a form field shows and
what the column stores — four places, never trimmed. Trimming to `'0.15'` would
still parse and would change no tax figure anywhere; what it would produce is a
row that looks edited by an owner who only opened it.

## Two ceilings, deliberately different

`MAX_AMOUNT_PESEWAS` (90,000,000) bounds what may be **multiplied**: squaring it
has to stay inside the 2^53 that a JavaScript number can represent exactly.
`MAX_TOTAL_PESEWAS` (999,999,999,999) bounds what may be **stored**, and is
`numeric(12, 2)`. A summed basket figure is checked against the second, not the
first — using the multiplication bound on a total would refuse a legitimate
large sale.

## Testing

```bash
npm run test             # 5 suites, 172 tests
npm run test:mutations   # 29 deliberate defects; every one must be caught
```

A test that has never been seen to fail proves nothing, so
`scripts/mutation-test.cjs` breaks the engine on purpose — the pre-reform cascade
restored, the two pricing modes swapped, half-up rounding replaced with
half-to-even, an over-discount allowed through, every VAT treatment charged as
standard — and requires the suite to go red each time. One of the 29 changes no
tax figure anywhere and is visible only to the test that the stored spelling
round-trips; it is in there because a mutation harness that only contains obvious
defects proves less than it appears to.

Every mutation is anchored to a source span that must appear exactly once, so a
refactor that moves the code reports an unusable anchor rather than silently
testing nothing. The harness restores each file in a `finally` and byte-compares
afterwards, aborting if anything was left mutated.

## Consuming it

Build it first. `package.json` points `main` and `types` at `dist`, so a consumer
resolves the **built** package and never the source. Building a consumer against
a stale or absent `shared/dist` fails on an export that plainly exists in
`src/index.ts` — an error that reads like a typo and is actually a missing build
step.

The root scripts get this right (`build:backend`, `test:backend`, `dev:backend`
all run `build:shared` first), and so does `backend/Dockerfile`. Any new build
path has to as well.
