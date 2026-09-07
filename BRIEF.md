# Build Brief: A&B Chemist Pharmacy Management Platform

This document is the source of truth for the build. Where a decision in code
and a decision here disagree, this document wins until it is deliberately
amended.

## 1. Role and mission

A production pharmacy management platform for a single, real client:
**A&B Chemist**, a community pharmacy in Ghana. Single-tenant — one pharmacy,
one database, one deployment. It is not a SaaS and carries no multi-tenant
machinery.

Real money moves through this system, real dispensing decisions depend on it,
and real patient health data is stored in it. Optimise for correctness and
honesty over features. A wrong stock figure, a fabricated tax split, or a UI
that claims a sale was saved when it was not are all worse than a missing
feature.

When something cannot be done — no network, no stock, no gateway, insufficient
permission — the system says so plainly and never implies success.

## 2. Business context

- The pharmacy dispenses medicines over the counter, sells OTC products, and
  serves both cash and mobile-money customers.
- Connectivity in Ghana is unreliable. The till must keep trading through an
  outage and reconcile afterwards.
- The pharmacy is small: an owner, pharmacists, and counter staff. The UI is
  used on a touchscreen at the counter and occasionally on a phone.
- Ghana tax law applies to every sale (section 6).
- Patient data is personal health data, protected under Ghana's Data Protection
  Act, 2012 (Act 843).

## 3. Hard constraints

1. **Single tenant.** Seed exactly one pharmacy. Keep a `pharmacy_id` column on
   every business table and scope every query by it — it is the security
   boundary and costs nothing — but build no UI for choosing, creating, or
   switching pharmacies.
2. **No NHIS. Not anywhere.** No claims module, no ClaimsIT integration, no
   `nhis_claims` table, no `claim_status` enum, no NHIS number on patient
   records, no NHIS references in code, schema, UI, receipts, reports, seeds,
   or tests. A case-insensitive search for the string must return zero matches.
3. **No public self-registration.** There is no `/register` route. Staff
   accounts are created by the owner from the Staff page. Anyone who finds the
   URL must not be able to create an account.
4. **No in-app subscription or billing.** The client pays the developer a
   contract fee directly. No plans page, no tier gating, no upgrade flow. Every
   feature is available.
5. **Money goes to the pharmacy, never to the developer.** Paystack is
   configured with A&B Chemist's own keys so customer payments settle into
   A&B's account directly. No split-payment, subaccount, settlement-ledger or
   payout logic — none is needed when the merchant is the pharmacy.
6. **Its own database and deployment.** Patient data must not be commingled
   with any other system.

## 4. Modules

### 4.1 Authentication and staff (RBAC)

- Roles: `pharmacy_owner`, `pharmacist`, `staff`. No `super_admin`.
- JWT access and refresh, bcrypt password hashing, session invalidation.
- Permissions enforced server-side on every route, not only in the UI. Hiding a
  button is not authorisation.
- Staff management: create, deactivate, change role. Deactivating must not
  delete — historical sales must still show who served them.
- Owner-only: voiding a sale, adjusting stock, writing off a batch, changing
  tax settings, managing staff.
- Every sale records `served_by`; every prescription sale records `approved_by`.

### 4.2 Inventory with batch and expiry control

- Products: name, code, generic name, category, manufacturer, pack size,
  default sell unit, shelf location, barcode, requires-prescription flag,
  reorder level, unit price, cost price, VAT treatment.
- **Batches are the source of truth for stock.** Each batch has a lot number,
  expiry date, quantity, cost price and `received_at`.
- **Four columns on the product row are derived and must never be written
  directly**: `quantity`, `batch_number`, `expiry_date`, `cost_price`. A
  database trigger recomputes them from the batches. An API that accepts them
  in a request body discards them and reports that it did so.
- FEFO (first-expiry-first-out) allocation on every sale, as a pure testable
  function. Tie-break on `received_at`, and reject a future `received_at` at
  the API — the tie-break reads it.
- **Expiry semantics, identical everywhere**: a batch is sellable ON its expiry
  date and not after it; a batch with no expiry date is always sellable. This
  rule appears in several queries and they must not disagree.
- Receive stock (creating or merging into a batch), adjust a batch, write off a
  batch. A note and a reason are mandatory on adjustments and write-offs.
- Every movement writes a `stock_movements` ledger row so the stock figure can
  always be re-derived and audited.
- Recall traceability: given a batch, list every sale that contained it and
  which customers to contact.
- Reorder and expiry alerts, persisted and deduplicated so an alert is not
  re-raised on every refresh. Expiry window: 90 days.
- Bulk upload from CSV, with an opening batch per row and savepoints so one bad
  row cannot abort the whole import.

### 4.3 Point of sale

- Touch-optimised: large targets, product grid, category filter chips, search,
  in-stock-only toggle, basket, discount with a reason.
- Selling units: one inventory record (a strip of 10) can be sold per tablet or
  per strip.
- Payment methods: `cash` and `momo` only. No card, no bank transfer, no
  credit. Section 10 records why, and how cheaply a third method can be added
  later if A&B ever needs one.
- Split payments across the two, with change computed only for a single cash
  tender. Mobile money cannot give change — the wallet is debited for exactly
  the amount it is told to — so on a part-cash part-momo sale the cash portion
  is entered as an exact figure and the till refuses to invent change.
- With no credit tender there is no debtor record and no "owe" list. A customer
  who cannot pay does not get a sale that quietly becomes a debt: the sale
  stays `pending`, with stock already drawn from the batches, until the payment
  is taken or the sale is voided. The pending banner says which of those two
  things is outstanding.
- Prescription items require an approver before the sale can complete.
- Sale lifecycle: `pending`, `completed`, `voided`, `refunded`,
  `partially_refunded`.
- **Voiding restores stock to the exact batches the sale drew from**, via the
  sale-item-to-batch junction rows — never back onto the product row, or the
  derived-stock trigger erases it and the product is credited for units that
  came out of a lot it never held.
- Receipt shows the tax actually recorded on the sale, never recomputed from
  today's rates.
- Sales history with date, status, method, staff and search filters.
- Reports: sales summary, daily breakdown, profitability, staff performance,
  and a VAT return.

### 4.4 Patients and engagement

- Patient records: demographics, allergies, conditions, medications, notes. No
  NHIS number field.
- Screenings: blood pressure, blood sugar, BMI, weight, temperature, heart
  rate, with a risk classification.
- Consultations: scheduled, in person / video / chat / phone. Build the data
  model and scheduling; treat video as a link-out rather than building media
  infrastructure.
- Refill and appointment reminders persisted to a notifications table,
  deduplicated against history, surfaced in a notification bell and on the
  dashboard. The bell reads persisted notifications; it does not re-derive them
  on every load.
- **Real SMS delivery is a separate later phase.** Build the reminders table,
  the scheduler hook and the notification record now. Until a provider is
  configured the UI shows reminders as "not sent — no SMS provider configured"
  rather than claiming they went out. Ghanaian providers to evaluate: Hubtel,
  Arkesel, mNotify.

### 4.5 Offline-first till

The hardest module and the most valuable.

- Cache the catalogue, tax settings and permissions in IndexedDB.
- The till keeps selling through an outage, pricing on-device with a pure
  pricing function whose output must match the server engine exactly. Verify
  with shared parity vectors, not by eye.
- Queue writes with an idempotency key and a client-generated sale id, so a
  response lost in flight cannot double-sell when replayed.
- A sync review page where a queued item can be retried or **explicitly
  discarded** — never silently dropped, never silently retried forever.
- A service worker that hands off to background sync and does not cache non-ok
  or redirected navigation responses.
- An honest offline indicator driven by real queue state.

**The honesty rules, which matter more than the mechanics:**

- Only a server that could not answer puts the till into offline mode. A 401, a
  403, a 409 and a 500 are all answers. A 500 must surface as an error — never
  as "you are offline, your sale is queued" when the queue is empty and nothing
  was written anywhere. Model "could not reach the server" as its own concept,
  distinct from "this request could plausibly be retried".
- An offline receipt is provisional and says so.
- **Never fabricate a tax split offline.** The on-device pricer produces a total
  and no VAT/NHIL/GETFund breakdown, because a displayed split that was not
  computed by the server engine is a false statement to a customer and to the
  revenue authority. Represent the absent split as null, not as zero.

## 5. Technology

- Frontend: Next.js (App Router) + React + TypeScript, Tailwind, Zustand with
  persist, deployed to Vercel as a PWA.
- Backend: Node + Express + TypeScript, deployed to Render.
- Database: Postgres (Supabase). Use the pooled/IPv4 connection string —
  Supabase's direct host is IPv6-only and will not connect from Render's free
  tier.
- Redis (Upstash) for rate limiting and caching.
- npm workspaces monorepo: `frontend`, `backend`, `database`.
- Testing: Jest on both sides. Migration correctness verified against a real
  Postgres 16 instance in Docker, not mocked.

## 6. Ghana tax engine (non-negotiable)

Under the Value Added Tax Act, 2025 (Act 1151):

- `standard`: 15% VAT + 2.5% NHIL + 2.5% GETFund levy, all on the same base.
- `exempt`: First Schedule supplies — no VAT, NHIL or GETFund levy.
- `zero_rated`: Second Schedule — taxable at 0%, input tax stays creditable.

Medicines in HS Chapter 30 are exempt, so `vat_treatment` defaults to `exempt`
— but the classification must be an explicit, editable field, because
toiletries, cosmetics and devices sold by the same pharmacy are standard-rated
and will otherwise be sold without VAT.

Support inclusive pricing mode (tax included in the shelf price). Basket-level
discounts are apportioned across lines in proportion to gross value so the
discount reduces each line's taxable base rather than being applied after tax,
with rounding drift pushed into the largest line so the shares sum exactly.

One implementation, used by both the server and the till's offline pricer. Two
implementations drift, and a displayed total that is not what gets charged is a
dispute waiting to happen. Write the tax tests against a worked example from
the GRA, not against our own arithmetic.

## 7. Data-model notes

Author the schema fresh. Do not create then remove.

- `sale_payment_method` is a Postgres enum with exactly two values: `cash` and
  `momo`. **Postgres cannot drop a value from an enum** — which is precisely why
  this build must not create an NHIS value and take it out later, and why the
  tender list is authored at its final size rather than padded with methods
  nobody has asked for. Growing it is one safe statement
  (`ALTER TYPE sale_payment_method ADD VALUE 'insurance'`, which cannot be run
  inside a transaction block); shrinking it means creating a new type and
  rewriting the column, and fails outright while any row still holds the value
  being removed.
- `sales` has no claim foreign key.
- `patients` has no NHIS number and no index on one.
- Every business table carries `pharmacy_id`, and every read is scoped by it.
- Notification and reminder tables need `updated_at` maintained by a trigger —
  written so it does not make the rows unupdatable, with an UPDATE asserted in
  the harness.

## 8. Landmines — each cost real time on a previous build

1. **Untyped enum parameters.** node-postgres sends every parameter untyped, so
   Postgres infers each parameter's type from all its uses. A parameter used
   both as the value of an enum column and in a text comparison —
   `VALUES (..., $19, ..., CASE WHEN $19 = 'completed' THEN ...)` — gets two
   incompatible deduced types and the statement is rejected at parse time with
   `inconsistent types deduced for parameter $19 / DETAIL: text versus
   sale_status`. Every sale fails, surfacing as a bare HTTP 500 that looks like
   a payment-gateway problem. **Always cast explicitly in the comparison**
   (`$19::sale_status`) and comment why, so nobody tidies it up. Note that
   `COALESCE($n, column)` supplies a genuine type context and is immune — do
   not "fix" statements that use it.
2. **`trust proxy` must be set.** Behind Render and any CDN, `req.ip` resolves
   to a proxy address, so an express-rate-limit limiter silently becomes one
   global bucket shared by every user.
3. **A 500 is not an offline signal.** See section 4.5.
4. **Never write the four derived stock columns.** See section 4.2.
5. **Void restores to batches, not to the product row.** See section 4.3.
6. **`PREPARE` fails at parse time**, which makes it a write-free way to
   validate parameterised SQL against a schema-only database. Use it in the
   migration harness.
7. Declare `@types/jest` in the frontend workspace, or the Vercel build fails
   with `Cannot use namespace 'jest' as a value`.
8. Migrations must be idempotent (`IF NOT EXISTS`, `DO $$ ... EXCEPTION WHEN
   duplicate_object`), and each must ship with a verification script that runs
   against real Postgres and asserts row-level outcomes.
9. Rate-limit and cache the login path, but do not get locked out of your own
   debugging: use write-free endpoints (`/quote`, list endpoints, config
   probes) to diagnose production.
10. Money columns are Postgres `NUMERIC` and arrive in JSON as strings. Coerce
    before arithmetic, and never compare a string to a number.

## 9. Definition of done

- TypeScript compiles clean on both sides with zero errors.
- All tests pass, and every test has been seen to fail when the behaviour it
  guards is broken. A test that has never been red proves nothing.
- Production build succeeds.
- Each migration verified against real Postgres 16 in Docker, with assertions
  on the resulting rows.
- The full sale write path executed end to end against the real trigger chain:
  sale, items, batch decrement, lot snapshot, movement ledger, payment,
  settlement — with stock confirmed to have moved through the trigger.
- A live cash sale and a live mobile-money sale both complete against the
  deployed environment.
- The till sells offline, queues and reconciles, with the queue count visible
  and matching reality.
- A case-insensitive search for `nhis` returns zero matches repo-wide.
- No route is reachable without authentication except login, the health check
  and the signed payment webhook.
- Webhook signatures are verified; a charge response is never trusted alone.

## 10. Decisions taken, and what remains open

Taken, and cheap to reverse before the relevant phase begins:

1. Payment methods are `cash` and `momo`. Card, bank transfer and credit (owe)
   are out, and so is the `insurance` tender previously proposed as a sixth
   method: the instruction to leave cash and mobile money settles what used to
   be open question 1, about whether A&B serves insured customers at all. The
   choice is deliberately asymmetric — adding a value later is one safe
   statement, removing one after rows exist means rewriting the column — so the
   enum starts small and grows only on evidence. Consequence for the gateway:
   Paystack is charged with `channels: ['mobile_money']`, so the payment modal
   collects a phone number and never asks for a card.
2. Screenings and consultations are included: full data model and scheduling,
   with video as a link-out rather than media infrastructure.
3. Refill reminders are built end to end except delivery. No SMS provider is
   wired; the UI shows "not sent — no SMS provider configured".
4. Paystack keys are empty env placeholders with the honest manual fallback
   active until A&B supply their own account keys.
5. CSV bulk import is built; no existing A&B data is assumed.
6. `pharmacy_id` is kept on every business table and every query is scoped by
   it. No `super_admin` role.
7. Identifier `a-and-b-chemist` for folder, package and project names; display
   name "A&B Chemist" in the UI, on receipts and in the database. The `&` and
   the space break npm package names, Vercel and Render project names, and
   shell commands.

Still to confirm with the client:

1. Whether A&B actually offers health screenings and consultations.
2. The SMS provider, who pays for messages, and whether patients consent to
   being texted.
3. Who owns the Paystack account, and who handles refunds and reversed or
   failed mobile money debits.
4. Whether existing stock and patient data needs importing, and in what format.
5. The domain name, and whether A&B or the developer owns the Vercel, Render
   and Supabase accounts.

## 11. Working agreements

- Never run a migration against a production database without explicit
  instruction. Produce the SQL and let the client apply it.
- Never commit or push without being asked.
- When a hypothesis about a bug is wrong, say so explicitly and say what
  disproved it. Do not quietly move on.
- Distinguish clearly between what was verified and what is inferred. Label
  unproven claims as unproven.
- Every comment explains why, not what. Where a line is load-bearing and looks
  removable, say so in the comment.
