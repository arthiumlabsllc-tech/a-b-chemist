-- 0002: stock_movements.created_at defaults to clock_timestamp()
--
-- Why this exists: `now()` returns the transaction start time, not the time the
-- statement ran. Every movement written inside one transaction therefore shares
-- one timestamp, and `id` is a uuid — so the ledger's `order by created_at desc,
-- id desc` tie-break resolves on a random value. Two movements in the same sale
-- come back in an arbitrary order, and the running total reads backwards.
--
-- `clock_timestamp()` advances during the transaction, which is what a ledger
-- needs: the order rows were written in is the order they are read back in. The
-- column keeps its type, its NOT NULL and its position; only the default moves.
--
-- Rows already written are left alone. Their timestamps are what they are, and
-- rewriting history in an audit table to make it sort is the wrong trade.
--
-- Idempotent: setting a default to the value it already has is a no-op.

alter table stock_movements
  alter column created_at set default clock_timestamp();

comment on column stock_movements.created_at is
  'Statement time, not transaction time: two movements written in one transaction get two distinct timestamps, so the ledger reads back in the order it was written.';
