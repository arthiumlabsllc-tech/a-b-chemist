-- Verification for 0002_stock_movements_created_at_clock_timestamp.
-- Asserts row-level outcomes, not merely that the migration completed.

do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  owner constant uuid := 'a0000000-0000-4000-8000-000000000002';
  col record;
  prod uuid;
  batch uuid;
  distinct_stamps integer;
  rows_in_order integer;
  out_of_order integer;
begin
  -- 0002a: the catalog says the default moved. Checked first, because if this
  --        fails the behavioural half below is measuring `now()` and would
  --        report a fault in the wrong place.
  select column_name, data_type, is_nullable, column_default
    into col
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'stock_movements'
     and column_name = 'created_at';

  if col.column_name is null then
    raise exception 'VERIFY 0002a: stock_movements.created_at does not exist';
  end if;
  if col.data_type <> 'timestamp with time zone' or col.is_nullable <> 'NO' then
    raise exception 'VERIFY 0002b: created_at became % %; the migration must move only the default',
      col.data_type, col.is_nullable;
  end if;
  if col.column_default is distinct from 'clock_timestamp()' then
    raise exception 'VERIFY 0002c: created_at default is %, expected clock_timestamp()', col.column_default;
  end if;

  insert into inventory (pharmacy_id, name, code, pack_size, unit_price)
  values (pharmacy, 'Harness Ledger Product', 'HARNESS-2', 1, 1.00)
  returning id into prod;

  insert into inventory_batches
    (pharmacy_id, inventory_id, lot_number, expiry_date, quantity, cost_price, received_at)
  values (pharmacy, prod, 'HARNESS-2-LOT', null, 50, 1.00, '2026-01-01T00:00:00Z')
  returning id into batch;

  -- 0002d: five movements, one transaction, insertion order recorded in `note`.
  --        Under `now()` every one of these shares the transaction start time
  --        and the ledger cannot be ordered at all.
  for i in 1..5 loop
    insert into stock_movements
      (pharmacy_id, inventory_id, batch_id, movement_type, quantity_change,
       quantity_after, reason, note, performed_by)
    values
      (pharmacy, prod, batch, 'adjust', 1, 50, 'harness', 'seq-' || i, owner);
  end loop;

  select count(distinct created_at)::int into distinct_stamps
    from stock_movements where inventory_id = prod;
  if distinct_stamps <> 5 then
    raise exception 'VERIFY 0002d: five movements in one transaction produced % distinct timestamps, expected 5',
      distinct_stamps;
  end if;

  -- 0002e: and the order they sort into is the order they were written in.
  --        Distinct timestamps alone would still permit an arbitrary order;
  --        this is the half that makes the ledger readable.
  select count(*)::int into rows_in_order
    from (select note,
                 row_number() over (order by created_at asc, id asc) as position
            from stock_movements
           where inventory_id = prod) ordered
   where ordered.note = 'seq-' || ordered.position;
  if rows_in_order <> 5 then
    raise exception 'VERIFY 0002e: only % of 5 movements sort into their insertion order', rows_in_order;
  end if;

  -- 0002f: newest first, which is the direction the API reads the ledger in.
  select count(*)::int into out_of_order
    from (select note,
                 row_number() over (order by created_at desc, id desc) as position
            from stock_movements
           where inventory_id = prod) ordered
   where ordered.note <> 'seq-' || (6 - ordered.position);
  if out_of_order <> 0 then
    raise exception 'VERIFY 0002f: % of 5 movements are out of place when read newest-first', out_of_order;
  end if;

  delete from stock_movements where inventory_id = prod;
  delete from inventory_batches where id = batch;
  delete from inventory where id = prod;

  raise notice 'VERIFY 0002 passed: the ledger is orderable within a transaction';
end $$;
