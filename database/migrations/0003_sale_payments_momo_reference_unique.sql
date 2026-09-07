-- 0003: sale_payments.reference is unique per mobile money tender
--
-- Why this exists: a Paystack webhook arrives carrying a reference and nothing
-- else. Paystack knows the merchant account and has never heard of a tenant, so
-- there is no pharmacy id, no sale id and no tender id in the payload — the
-- reference is the whole of what there is to go on, and
-- `findSalePaymentByReference` has to answer with exactly one row.
--
-- Until now uniqueness was an argument about how the reference is generated
-- rather than something the database checked: the receipt number plus random
-- bytes, minted server-side, with the odds of a collision computed and assumed
-- small. An argument in a comment cannot stop the cases that matter, which are
-- the ones that do not go through the generator — a hand-applied fix, a data
-- import, a future code path that trusts a client. And the failure is silent:
-- the lookup takes the earliest match, so a webhook for the newer tender settles
-- the older one and both rows look correct afterwards.
--
-- Now it is a constraint. The generator's entropy is what keeps this from ever
-- firing; the index is what makes a collision a refused insert rather than a
-- mis-settled sale.
--
-- Partial, and on `method = 'momo'` only. On a cash tender this same column
-- holds the note the operator typed, which is free text and repeats constantly —
-- "cash", a receipt number, nothing typed at all. A whole-table unique index
-- would refuse the second cash sale of the day that had no note to give, which
-- is a till that stops taking money because of a bookkeeping column.
--
-- The predicate names the method and deliberately does not add
-- `reference is not null`. A unique index already permits any number of NULLs,
-- so the clause would buy nothing; leaving it out keeps the predicate to the one
-- condition the webhook's own `where` clause states, which is what lets the
-- planner consider this index for that query instead of scanning the table.
--
-- Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS. If a database already holds two
-- mobile money tenders sharing a reference, this fails — correctly, and loudly,
-- because that is the state this migration exists to make impossible.

create unique index if not exists sale_payments_momo_reference_key
  on sale_payments (reference)
  where method = 'momo';

comment on index sale_payments_momo_reference_key is
  'One gateway reference, one mobile money tender. A Paystack webhook carries a reference and no tenant, so this is the column that has to resolve to exactly one row. Cash tenders are outside the predicate: on those the column holds an operator note, which repeats freely.';
