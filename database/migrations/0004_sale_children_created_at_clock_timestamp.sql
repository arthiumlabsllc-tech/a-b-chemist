-- 0004: sale_items, sale_item_batches and sale_payments default created_at to
--        clock_timestamp()
--
-- Why this exists: 0002 fixed this for stock_movements and stopped there, on the
-- reading that the ledger was the only table written several rows at a time
-- inside one transaction. It is not. The sale write path is one transaction and
-- writes one row per basket line, one row per lot each line drew from, and one
-- row per tender -- so a three-item basket paid cash-and-momo writes three
-- sale_items, four sale_item_batches and two sale_payments that all share the
-- transaction's start time.
--
-- `id` is a uuid, so every `order by created_at, id` in the sales repository
-- then tie-breaks on a random value:
--
--   list_sale_items            the receipt's lines print in arbitrary order
--   list_sale_item_batches     which lot a line drew from first is arbitrary
--   list_sale_payments         the tenders print in arbitrary order
--   list_sales' array_agg      the history list's payment_methods reads
--                              "momo,cash" or "cash,momo" run to run
--
-- None of these raise. A receipt whose lines are shuffled is a receipt a
-- pharmacist cannot check against the bag, and the fault looks like the till
-- rather than like the schema, which is why it is worth a migration rather than
-- a shrug.
--
-- Found by section 13c of database/tests/assertions.sql, which asserts the
-- tender sequence a split payment was written in. It passed once and failed six
-- times in eight runs against an unmodified schema -- the two passes being the
-- runs where the uuids happened to sort into insertion order.
--
-- `clock_timestamp()` advances during the transaction, which is what an ordered
-- child table needs. Each column keeps its type, its NOT NULL and its position;
-- only the default moves.
--
-- sale_item_batches is included even though nothing orders by it today. It is
-- the third table in the same transaction, and leaving one of the three on
-- transaction time is a trap for whoever next adds an ORDER BY to the recall
-- query that reads it.
--
-- Rows already written are left alone, for the reason 0002 gives: rewriting
-- history to make it sort is the wrong trade.
--
-- Idempotent: setting a default to the value it already has is a no-op.

alter table sale_items
  alter column created_at set default clock_timestamp();

alter table sale_item_batches
  alter column created_at set default clock_timestamp();

alter table sale_payments
  alter column created_at set default clock_timestamp();

comment on column sale_items.created_at is
  'Statement time, not transaction time: the lines of one basket get distinct timestamps, so a receipt reads back in the order it was written.';

comment on column sale_item_batches.created_at is
  'Statement time, not transaction time: nothing orders by this today, and it is set so that the day something does, it can.';

comment on column sale_payments.created_at is
  'Statement time, not transaction time: a split payment written in one transaction gets one timestamp per tender, so the receipt and the history list agree on which came first.';
