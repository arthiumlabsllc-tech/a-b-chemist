-- Verification for 0003_sale_payments_momo_reference_unique.
-- Asserts row-level outcomes, not merely that the migration completed.
--
-- Behaviour first and the catalog last, which is the reverse of 0002's order and
-- deliberate. There, the behavioural half measured a column default that the
-- catalog check had just confirmed, so a wrong catalog answer would have made
-- the behaviour below it meaningless. Here the two halves are independent: the
-- inserts either collide or they do not, whatever `pg_index` says about it.
-- Putting them first means a database with no index at all goes red on the
-- collision itself rather than on a missing catalog entry — and the collision is
-- the fault that matters, because it is the one that settles the wrong tender.

do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  owner    constant uuid := 'a0000000-0000-4000-8000-000000000002';
  sale_a uuid;
  sale_b uuid;
  collided boolean;
  landed integer;
  index_found boolean;
  index_unique boolean;
  index_predicate text;
begin
  -- Left behind by a run of this file that failed before its own cleanup.
  -- Removed first so the file can be run twice against one database, which is
  -- how it gets run while it is being written.
  delete from sale_payments
   where sale_id in (select id from sales
                      where pharmacy_id = pharmacy
                        and sale_number in ('H3-0001', 'H3-0002'));
  delete from sales
   where pharmacy_id = pharmacy and sale_number in ('H3-0001', 'H3-0002');

  -- Two sales rather than one, because the collision that matters is across
  -- sales: a webhook carries a reference and no tenant, so it cannot be told
  -- which of the two it means and takes the earliest row it finds.
  insert into sales (pharmacy_id, sale_number, served_by,
                     vat_rate, nhil_rate, getfund_rate, tax_inclusive_pricing)
  values (pharmacy, 'H3-0001', owner, 0.1500, 0.0250, 0.0250, false)
  returning id into sale_a;

  insert into sales (pharmacy_id, sale_number, served_by,
                     vat_rate, nhil_rate, getfund_rate, tax_inclusive_pricing)
  values (pharmacy, 'H3-0002', owner, 0.1500, 0.0250, 0.0250, false)
  returning id into sale_b;

  insert into sale_payments (sale_id, method, status, amount, reference)
  values (sale_a, 'momo', 'pending', 12.00, 'H3-0001-0000000000000001');

  -- 0003a: one gateway reference, one mobile money tender. This is the
  --        assertion the migration exists for.
  collided := false;
  begin
    insert into sale_payments (sale_id, method, status, amount, reference)
    values (sale_b, 'momo', 'pending', 12.00, 'H3-0001-0000000000000001');
  exception when unique_violation then
    collided := true;
  end;
  if not collided then
    raise exception 'VERIFY 0003a: two mobile money tenders on two different sales accepted the same reference';
  end if;

  -- 0003b: the same column on a cash tender holds a note the operator typed,
  --        and notes repeat. Refusing these is the failure mode that would make
  --        the index worse than nothing: a till that stops taking cash the
  --        second time somebody leaves the note blank.
  begin
    insert into sale_payments (sale_id, method, status, amount, reference)
    values (sale_a, 'cash', 'succeeded', 5.00, 'no note given');
    insert into sale_payments (sale_id, method, status, amount, reference)
    values (sale_b, 'cash', 'succeeded', 7.50, 'no note given');
  exception when unique_violation then
    raise exception 'VERIFY 0003b: a repeated note on two cash tenders was refused, so the index is not partial on method';
  end;

  -- 0003c: and NULLs stay distinct, which a unique index already guarantees and
  --        which is why the predicate does not need to say so.
  begin
    insert into sale_payments (sale_id, method, status, amount, reference)
    values (sale_a, 'momo', 'pending', 3.00, null);
    insert into sale_payments (sale_id, method, status, amount, reference)
    values (sale_b, 'momo', 'pending', 4.00, null);
  exception when unique_violation then
    raise exception 'VERIFY 0003c: two mobile money tenders with no reference were refused';
  end;

  -- 0003d: a split wallet payment. Two tenders on one sale, each bound to its
  --        own charge, is legal and must not be refused by a uniqueness rule
  --        written for the case of two charges sharing one binding.
  begin
    insert into sale_payments (sale_id, method, status, amount, reference)
    values (sale_a, 'momo', 'pending', 2.00, 'H3-0001-SPLIT00000001');
    insert into sale_payments (sale_id, method, status, amount, reference)
    values (sale_a, 'momo', 'pending', 2.00, 'H3-0001-SPLIT00000002');
  exception when unique_violation then
    raise exception 'VERIFY 0003d: two mobile money tenders with different references on one sale were refused';
  end;

  -- 0003e: every row the four checks above expected to land, landed. One momo
  --        tender on the first sale, two cash notes, two references-less momo
  --        tenders, two halves of a split — and not the refused duplicate.
  select count(*)::int into landed
    from sale_payments where sale_id in (sale_a, sale_b);
  if landed <> 7 then
    raise exception 'VERIFY 0003e: % tenders on the two harness sales, expected 7', landed;
  end if;

  -- 0003f..i: the catalog, so the shape the behaviour implies is also the shape
  --           that ships. Read with aggregates rather than `select ... into
  --           record`: a record target left unassigned by a query that returned
  --           no rows raises on field access, so the "does it exist" branch
  --           would report a PL/pgSQL error instead of its own message.
  select count(*) > 0,
         bool_or(i.indisunique),
         max(pg_get_expr(i.indpred, i.indrelid))
    into index_found, index_unique, index_predicate
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
   where i.indrelid = 'public.sale_payments'::regclass
     and c.relname = 'sale_payments_momo_reference_key';

  if not index_found then
    raise exception 'VERIFY 0003f: index sale_payments_momo_reference_key does not exist';
  end if;
  if index_unique is distinct from true then
    raise exception 'VERIFY 0003g: sale_payments_momo_reference_key exists but is not unique';
  end if;
  if index_predicate is null or position('momo' in index_predicate) = 0 then
    raise exception 'VERIFY 0003h: the index predicate is %, expected it to name the momo method',
      coalesce(index_predicate, '(none)');
  end if;
  if position('null' in lower(index_predicate)) > 0 then
    raise exception 'VERIFY 0003i: the index predicate is %; it must not mention nullness, because a unique index already permits any number of NULLs',
      index_predicate;
  end if;

  delete from sale_payments where sale_id in (sale_a, sale_b);
  delete from sales where id in (sale_a, sale_b);

  raise notice 'VERIFY 0003 passed: one gateway reference per mobile money tender, cash notes free to repeat';
end $$;
