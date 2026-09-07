-- Verification for 0004_sale_children_created_at_clock_timestamp.
-- Asserts row-level outcomes, not merely that the migration completed.
--
-- The whole behavioural half runs inside one `do` block, which is one
-- transaction. That is not incidental: the defect only exists when several child
-- rows are written in one transaction, which is what the sale write path does
-- and what a verify file running statement-per-transaction would never
-- reproduce.

do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  owner constant uuid := 'a0000000-0000-4000-8000-000000000002';

  prod uuid;
  batch uuid;
  sale uuid;
  item uuid;
  col record;

  distinct_items integer;
  distinct_junction integer;
  distinct_tenders integer;
  items_in_order integer;
  junction_in_order integer;
  tenders_in_order integer;
begin
  -- 0004a: the catalog says all three defaults moved. Checked first, because if
  --        this fails the behavioural half below is measuring `now()` and would
  --        report the fault in the wrong place.
  for col in
    select table_name, data_type, is_nullable, column_default
      from information_schema.columns
     where table_schema = 'public'
       and column_name = 'created_at'
       and table_name in ('sale_items', 'sale_item_batches', 'sale_payments')
     order by table_name
  loop
    if col.data_type <> 'timestamp with time zone' or col.is_nullable <> 'NO' then
      raise exception 'VERIFY 0004a: %.created_at became % %; the migration must move only the default',
        col.table_name, col.data_type, col.is_nullable;
    end if;
    if col.column_default is distinct from 'clock_timestamp()' then
      raise exception 'VERIFY 0004b: %.created_at default is %, expected clock_timestamp()',
        col.table_name, col.column_default;
    end if;
  end loop;

  -- Three tables named, three rows returned. Without this a table renamed in
  -- init.sql would drop out of the loop above silently and still pass it.
  select count(*)::int into distinct_items
    from information_schema.columns
   where table_schema = 'public'
     and column_name = 'created_at'
     and table_name in ('sale_items', 'sale_item_batches', 'sale_payments');
  if distinct_items <> 3 then
    raise exception 'VERIFY 0004c: % of the 3 sale child tables were found to check, expected 3', distinct_items;
  end if;

  insert into inventory (pharmacy_id, name, code, pack_size, unit_price)
  values (pharmacy, 'Harness Order Product', 'HARNESS-4', 1, 1.00)
  returning id into prod;

  insert into inventory_batches
    (pharmacy_id, inventory_id, lot_number, expiry_date, quantity, cost_price, received_at)
  values (pharmacy, prod, 'HARNESS-4-LOT', null, 50, 1.00, '2026-01-01T00:00:00Z')
  returning id into batch;

  insert into sales
    (pharmacy_id, sale_number, served_by, vat_rate, nhil_rate, getfund_rate,
     tax_inclusive_pricing)
  values (pharmacy, 'HARNESS-4-SALE', owner, 0.1500, 0.0250, 0.0250, false)
  returning id into sale;

  -- 0004d: three lines, three junction rows and three tenders, all in this one
  --        transaction, each carrying its insertion position in a column of its
  --        own -- `description`, `unit_cost` and `reference` respectively, since
  --        none of the three tables has a sequence column to write into.
  for i in 1..3 loop
    insert into sale_items
      (sale_id, inventory_id, description, quantity, unit_price, line_gross,
       taxable_base, line_total, vat_treatment)
    values
      (sale, prod, 'seq-' || i, 1, 10.00, 10.00, 10.00, 10.00, 'standard')
    returning id into item;

    insert into sale_item_batches (sale_item_id, batch_id, quantity, unit_cost)
    values (item, batch, 1, i::numeric);
  end loop;

  for i in 1..3 loop
    insert into sale_payments (sale_id, method, status, amount, reference)
    values (sale, 'cash', 'succeeded', 10.00, 'seq-' || i);
  end loop;

  select count(distinct created_at)::int into distinct_items
    from sale_items where sale_id = sale;
  select count(distinct sib.created_at)::int into distinct_junction
    from sale_item_batches sib join sale_items si on si.id = sib.sale_item_id
   where si.sale_id = sale;
  select count(distinct created_at)::int into distinct_tenders
    from sale_payments where sale_id = sale;

  if distinct_items <> 3 or distinct_junction <> 3 or distinct_tenders <> 3 then
    raise exception 'VERIFY 0004d: three rows each of items, junction and tenders in one transaction produced %/%/% distinct timestamps, expected 3/3/3',
      distinct_items, distinct_junction, distinct_tenders;
  end if;

  -- 0004e: and the order they sort into is the order they were written in.
  --        Distinct timestamps alone would still permit an arbitrary order;
  --        these three are the half that makes a receipt readable. Each uses the
  --        ORDER BY the repository itself uses, tie-break included, so what is
  --        proved is the order the API returns and not an order invented here.
  select count(*)::int into items_in_order
    from (select description,
                 row_number() over (order by created_at asc, id asc) as position
            from sale_items where sale_id = sale) ordered
   where ordered.description = 'seq-' || ordered.position;
  if items_in_order <> 3 then
    raise exception 'VERIFY 0004e: only % of 3 receipt lines sort into their insertion order', items_in_order;
  end if;

  select count(*)::int into junction_in_order
    from (select sib.unit_cost,
                 row_number() over (order by si.created_at asc, si.id asc, sib.id asc) as position
            from sale_item_batches sib
            join sale_items si on si.id = sib.sale_item_id
           where si.sale_id = sale) ordered
   where ordered.unit_cost = ordered.position::numeric;
  if junction_in_order <> 3 then
    raise exception 'VERIFY 0004f: only % of 3 lot draws sort into their insertion order', junction_in_order;
  end if;

  select count(*)::int into tenders_in_order
    from (select reference,
                 row_number() over (order by created_at asc, id asc) as position
            from sale_payments where sale_id = sale) ordered
   where ordered.reference = 'seq-' || ordered.position;
  if tenders_in_order <> 3 then
    raise exception 'VERIFY 0004g: only % of 3 tenders sort into their insertion order', tenders_in_order;
  end if;

  -- Deleting the sale cascades to its items, their junction rows and its
  -- tenders; the batches and the product go after, because nothing cascades
  -- into inventory.
  delete from sales where id = sale;
  delete from inventory_batches where id = batch;
  delete from inventory where id = prod;

  raise notice 'VERIFY 0004 passed: a receipt written in one transaction reads back in the order it was written';
end $$;
