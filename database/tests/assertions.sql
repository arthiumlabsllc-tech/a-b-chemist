-- A&B Chemist — schema harness assertions.
--
-- Runs against a database that has just had init.sql and every migration
-- applied, inside a throwaway Postgres 16 container (see ../docker-compose.yml).
-- Every failure is a RAISE EXCEPTION, and psql is invoked with ON_ERROR_STOP=1,
-- so the first broken assertion ends the run with a non-zero exit and the verify
-- service fails the compose run.
--
-- Nothing here is mocked. The trigger chain, the enum contents and the
-- parse-time behaviour of parameterised SQL are all observed on a real
-- server, because those are exactly the things a mock would happily agree
-- with us about.

-- ---------------------------------------------------------------------------
-- 1. Enum contents are exactly what the brief commits to.
-- ---------------------------------------------------------------------------
do $$
begin
  if enum_range(null::sale_payment_method)::text[] <> array['cash', 'momo'] then
    raise exception 'ASSERT 1a: sale_payment_method is %', enum_range(null::sale_payment_method)::text;
  end if;
  if enum_range(null::user_role)::text[] <> array['pharmacy_owner', 'pharmacist', 'staff'] then
    raise exception 'ASSERT 1b: user_role is %', enum_range(null::user_role)::text;
  end if;
  if enum_range(null::sale_status)::text[] <>
     array['pending', 'completed', 'voided', 'refunded', 'partially_refunded'] then
    raise exception 'ASSERT 1c: sale_status is %', enum_range(null::sale_status)::text;
  end if;
  if enum_range(null::vat_treatment)::text[] <> array['standard', 'exempt', 'zero_rated'] then
    raise exception 'ASSERT 1d: vat_treatment is %', enum_range(null::vat_treatment)::text;
  end if;
  raise notice 'ASSERT 1 passed: enum contents exact';
end $$;

-- ---------------------------------------------------------------------------
-- 2. The derived-stock chain: batches in, product columns out.
-- ---------------------------------------------------------------------------
do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  prod uuid;
  batch_b uuid;
  q integer;
  lot text;
  exp date;
  cost numeric;
begin
  insert into inventory (pharmacy_id, name, code, pack_size, unit_price)
  values (pharmacy, 'Harness Product', 'HARNESS-1', 10, 5.00)
  returning id into prod;

  insert into inventory_batches
    (pharmacy_id, inventory_id, lot_number, expiry_date, quantity, cost_price, received_at)
  values
    (pharmacy, prod, 'LOT-A', date '2027-01-31', 10, 2.00, '2026-01-01T00:00:00Z');

  select quantity, batch_number, expiry_date, cost_price into q, lot, exp, cost
    from inventory where id = prod;
  if q <> 10 or lot <> 'LOT-A' or exp <> date '2027-01-31' or cost <> 2.00 then
    raise exception 'ASSERT 2a: after first batch expected 10/LOT-A/2027-01-31/2.00, got %/%/%/%', q, lot, exp, cost;
  end if;

  -- An earlier expiry arrives: the FEFO-leading batch, and therefore the
  -- product's visible lot and expiry, must switch to it.
  insert into inventory_batches
    (pharmacy_id, inventory_id, lot_number, expiry_date, quantity, cost_price, received_at)
  values
    (pharmacy, prod, 'LOT-B', date '2026-12-31', 5, 3.00, '2026-01-02T00:00:00Z')
  returning id into batch_b;

  select quantity, batch_number, expiry_date, cost_price into q, lot, exp, cost
    from inventory where id = prod;
  -- (10 * 2.00 + 5 * 3.00) / 15 = 2.3333 after the trigger's 4dp rounding.
  if q <> 15 or lot <> 'LOT-B' or exp <> date '2026-12-31' or cost <> 2.3333 then
    raise exception 'ASSERT 2b: after second batch expected 15/LOT-B/2026-12-31/2.3333, got %/%/%/%', q, lot, exp, cost;
  end if;

  -- 3. The four derived columns are unwritable, including from raw SQL: any
  --    supplied value is overwritten by the recompute trigger before storage.
  update inventory
     set quantity = 999, batch_number = 'HACK', expiry_date = date '1999-01-01', cost_price = 1
   where id = prod;

  select quantity, batch_number, expiry_date, cost_price into q, lot, exp, cost
    from inventory where id = prod;
  if q <> 15 or lot <> 'LOT-B' or exp <> date '2026-12-31' or cost <> 2.3333 then
    raise exception 'ASSERT 3: a direct write to the derived columns survived: %/%/%/%', q, lot, exp, cost;
  end if;

  -- 4. A batch decrement travels through the AFTER trigger to the product row.
  update inventory_batches set quantity = 4 where id = batch_b;

  select quantity into q from inventory where id = prod;
  if q <> 14 then
    raise exception 'ASSERT 4: product quantity did not follow the batch decrement, got %', q;
  end if;

  raise notice 'ASSERT 2-4 passed: derived stock recomputes from batches and refuses direct writes';
end $$;

-- ---------------------------------------------------------------------------
-- 5. set_updated_at stamps without swallowing the write.
--    A BEFORE trigger returning NULL would skip the operation entirely and
--    present as "rows cannot be updated" while every statement reports success.
-- ---------------------------------------------------------------------------
do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  n uuid;
  created timestamptz;
  stamped timestamptz;
  title text;
begin
  insert into notifications (pharmacy_id, type, title, dedupe_key)
  values (pharmacy, 'stock_reorder', 'before', 'harness-notify-1')
  returning id, created_at into n, created;

  update notifications set title = 'after' where id = n;

  -- Qualified, because the local variable `title` and the column `title`
  -- otherwise make this reference ambiguous and PL/pgSQL refuses to guess.
  select ntf.title, ntf.updated_at into title, stamped
    from notifications ntf
   where ntf.id = n;
  if title <> 'after' then
    raise exception 'ASSERT 5a: the notification row did not take the update (title is %)', title;
  end if;
  if stamped <= created then
    raise exception 'ASSERT 5b: updated_at did not advance (% -> %)', created, stamped;
  end if;

  raise notice 'ASSERT 5 passed: rows stay updatable and updated_at advances';
end $$;

-- ---------------------------------------------------------------------------
-- 6. PREPARE as a write-free oracle.
--    The explicit enum cast is load-bearing: node-postgres sends parameters
--    untyped, and a parameter used both as an enum column value and in a text
--    comparison is rejected at parse time. The good statement must parse; the
--    uncast one must not. PREPARE proves both without writing a row.
-- ---------------------------------------------------------------------------
prepare harness_sale_with_cast as
with flag as (
  -- Analyzed before the insert, so this is the use that first deduces the
  -- parameter's type. The cast is the fix: it names the one type the
  -- parameter may have, and the insert then agrees with it.
  select case when $3::sale_status = 'completed' then 1 else 0 end as is_completed
), ins as (
  insert into sales
    (pharmacy_id, sale_number, status, served_by, subtotal, total,
     vat_rate, nhil_rate, getfund_rate, tax_inclusive_pricing)
  values
    ($1, $2, $3, $4, $5, $5, 0.15, 0.025, 0.025, true)
  returning id
)
select flag.is_completed, ins.id from ins cross join flag;
deallocate harness_sale_with_cast;

do $$
declare
  parsed boolean := false;
  message text;
begin
  begin
    execute 'prepare harness_sale_without_cast as
      with flag as (
        -- Same statement, no cast. Two unknowns in an equality resolve to
        -- text, so this use deduces text while the insert deduces
        -- sale_status, and the statement is rejected at parse time.
        select case when $3 = ''completed'' then 1 else 0 end as is_completed
      ), ins as (
        insert into sales
          (pharmacy_id, sale_number, status, served_by, subtotal, total,
           vat_rate, nhil_rate, getfund_rate, tax_inclusive_pricing)
        values
          ($1, $2, $3, $4, $5, $5, 0.15, 0.025, 0.025, true)
        returning id
      )
      select flag.is_completed, ins.id from ins cross join flag';
    parsed := true;
  exception
    when others then
      message := sqlerrm;
  end;

  if parsed then
    raise exception 'ASSERT 6a: the uncast enum parameter parsed; the cast is no longer load-bearing and this harness has gone blind';
  end if;
  -- The exact wording depends on where in the statement the conflicting
  -- deduction lands: the production incident reported "inconsistent types
  -- deduced for parameter $n", while the same defect in other shapes reports
  -- the assignment mismatch or the missing operator. All three are parse-time
  -- rejections of the same untyped-parameter defect, and PREPARE executes
  -- nothing, so any of them proves the statement cannot reach a write.
  if message not like '%inconsistent types deduced%'
     and message not like '%is of type sale_status but expression is of type text%'
     and message not like '%operator does not exist: sale_status = text%' then
    raise exception 'ASSERT 6b: expected a parse-time rejection of the uncast parameter, got: %', message;
  end if;

  raise notice 'ASSERT 6 passed: cast statement parses, uncast statement is rejected at parse time';
end $$;

-- ---------------------------------------------------------------------------
-- 7. The scheme is absent at the schema level, not only in the source text.
--    The repo guard scans files; this scans the resulting database, so a
--    column or type that slipped in under a renamed file is still caught.
-- ---------------------------------------------------------------------------
do $$
declare
  -- Assembled from character codes because this directory must contain zero
  -- occurrences of the string it forbids: a search pattern written literally
  -- here would itself be a match, and an allowlist entry for the harness
  -- would weaken the rule the harness exists to enforce.
  forbidden constant text := '%' || chr(110) || chr(104) || chr(105) || chr(115) || '%';
  hits text;
begin
  select string_agg(name, ', ') into hits
    from (
      select table_name || '.' || column_name as name
        from information_schema.columns
       where table_schema = 'public'
         and (column_name ilike forbidden or column_name ilike '%claim%')
      union all
      select table_name
        from information_schema.tables
       where table_schema = 'public'
         and (table_name ilike forbidden or table_name ilike '%claim%')
      union all
      select typname
        from pg_type
       where typtype = 'e'
         and (typname ilike forbidden or typname ilike '%claim%')
    ) found;
  if hits is not null then
    raise exception 'ASSERT 7: the schema contains %', hits;
  end if;

  raise notice 'ASSERT 7 passed: no scheme column, table or type exists in the database';
end $$;

-- ---------------------------------------------------------------------------
-- 8. The seed is one pharmacy and one owner who cannot log in yet, and the
--    pharmacy it seeds charges the tax Act 1151 charges.
-- ---------------------------------------------------------------------------
do $$
declare
  pharmacies_found integer;
  owner_role user_role;
  owner_hash text;
  seeded_vat numeric;
  seeded_nhil numeric;
  seeded_getfund numeric;
  seeded_inclusive boolean;
  unguarded integer;
begin
  select count(*) into pharmacies_found from pharmacies;
  if pharmacies_found <> 1 then
    raise exception 'ASSERT 8a: expected exactly one pharmacy, found %', pharmacies_found;
  end if;

  select role, password_hash into owner_role, owner_hash
    from users
   where id = 'a0000000-0000-4000-8000-000000000002';
  if owner_role is null then
    raise exception 'ASSERT 8b: the seeded owner is missing';
  end if;
  if owner_role <> 'pharmacy_owner' then
    raise exception 'ASSERT 8c: seeded owner role is %', owner_role;
  end if;
  if owner_hash ~ '^\$2[aby]\$' then
    raise exception 'ASSERT 8d: the seed publishes a usable bcrypt hash; it must ship UNSET and be set at onboarding';
  end if;

  -- 8e. What A&B Chemist charges on the day it opens. The seed omits all four
  --     tax columns, so these values arrive from the column defaults on
  --     `pharmacies` -- this assertion is about the defaults, reached through
  --     the row they produce.
  --
  --     It is the only place in the build that ties a number in the database to
  --     the statute. Every jest test on either side reads the rates from the
  --     shared engine's fixture, so a default changed here and not there leaves
  --     600-odd tests green while the pharmacy quietly charges the wrong tax --
  --     and the receipt agrees with itself, because it prints the rate that was
  --     charged. Nothing an owner or a cashier can see would be out of place.
  select vat_rate, nhil_rate, getfund_rate, tax_inclusive_pricing
    into seeded_vat, seeded_nhil, seeded_getfund, seeded_inclusive
    from pharmacies
   where id = 'a0000000-0000-4000-8000-000000000001';
  if seeded_vat <> 0.15 or seeded_nhil <> 0.025 or seeded_getfund <> 0.025 then
    raise exception 'ASSERT 8e: the seeded pharmacy charges VAT % / NHIL % / GETFund %, expected 0.1500 / 0.0250 / 0.0250 per the Value Added Tax Act, 2025 (Act 1151)',
      seeded_vat, seeded_nhil, seeded_getfund;
  end if;
  -- Inclusive, and asserted with `is not true` so that a NULL is a failure
  -- rather than a third value that slips past a `<>` comparison.
  if seeded_inclusive is not true then
    raise exception 'ASSERT 8e: the seeded pharmacy has tax_inclusive_pricing = %, expected true; shelf prices at A&B Chemist are tax-inclusive', seeded_inclusive;
  end if;

  -- 8f. A sale cannot be recorded without the rates it charged. All four
  --     snapshot columns on `sales` are NOT NULL *and* carry no default, and it
  --     is the missing default that makes the snapshot mandatory rather than
  --     merely present: `default 0` would let a sale be written that never
  --     priced its tax, and the receipt would then show a VAT of zero that
  --     nobody decided on.
  --
  --     Checked in the catalog rather than by attempting an insert, and the
  --     distinction is the whole assertion. An insert omitting all four proves
  --     only that at least one of them refuses a NULL, so it would still pass
  --     with three of the four defaulted -- which is precisely the regression
  --     this exists to catch.
  select count(*) into unguarded
    from information_schema.columns
   where table_name = 'sales'
     and column_name in ('vat_rate', 'nhil_rate', 'getfund_rate', 'tax_inclusive_pricing')
     and (is_nullable <> 'NO' or column_default is not null);
  if unguarded <> 0 then
    raise exception 'ASSERT 8f: % of the four tax snapshot columns on sales are nullable or carry a default; all four must be NOT NULL with no default, so that a sale cannot be stored without the rates it charged', unguarded;
  end if;

  raise notice 'ASSERT 8 passed: one pharmacy, one owner, no published password, and the seeded rates are Act 1151''s';
end $$;

-- ---------------------------------------------------------------------------
-- 9. The users repository's statements, against the real schema.
--    Every suite in backend that touches staff management mocks the repository,
--    so backend/src/__tests__/users.repository.test.ts pins the SQL as text and
--    nothing there can tell whether that text is a statement Postgres accepts.
--    This section is the other half of that proof.
--
--    It is split the same way section 6 is, because the two halves fail for
--    different reasons. PREPARE exercises the parse with untyped parameters,
--    which is what node-postgres sends, and writes nothing; that is where an
--    enum parameter or an ISO timestamp string is accepted or rejected. The DO
--    block then performs the writes and checks the rows, which is where a bump
--    that silently does not bump is caught.
-- ---------------------------------------------------------------------------

-- 9a. Every statement the users repository emits parses against the migrated
--     schema. These are named `users_repo_*` rather than `harness_*`: section 6
--     also prepares statements, and backend's drift check matches on this prefix
--     to tell its own copies from somebody else's.
prepare users_repo_find_by_email as
select id, pharmacy_id, full_name, email, phone, role, password_hash,
       is_active, session_version, last_login_at
  from users where lower(email) = lower($1) limit 1;

prepare users_repo_find_by_id as
select id, pharmacy_id, full_name, email, phone, role, password_hash,
       is_active, session_version, last_login_at
  from users where id = $1;

prepare users_repo_list_staff as
select id, pharmacy_id, full_name, email, phone, role, password_hash,
       is_active, session_version, last_login_at
  from users where pharmacy_id = $1 order by full_name, email;

prepare users_repo_count_active_owners as
select count(*)::int as n from users
  where pharmacy_id = $1
    and role = 'pharmacy_owner'
    and is_active = true
    and ($2::uuid is null or id <> $2::uuid);

-- The role parameter lands in a user_role column and nowhere else, so it is
-- deduced rather than ambiguous. Section 6 exists because the sales statement
-- uses its enum parameter twice, in two different deductions; this one does not,
-- and preparing it is what proves that difference still holds.
prepare users_repo_create_staff as
insert into users (pharmacy_id, full_name, email, phone, role, password_hash)
values ($1, $2, $3, $4, $5, $6)
returning id, pharmacy_id, full_name, email, phone, role, password_hash,
          is_active, session_version, last_login_at;

-- $2 receives an ISO-8601 string from JavaScript and must deduce timestamptz.
prepare users_repo_update_role_bump as
update users set role = $1, session_version = session_version + 1, updated_at = $2
  where id = $3
  returning id, pharmacy_id, full_name, email, phone, role, password_hash,
            is_active, session_version, last_login_at;

prepare users_repo_update_name_only as
update users set full_name = $1, updated_at = $2
  where id = $3
  returning id, pharmacy_id, full_name, email, phone, role, password_hash,
            is_active, session_version, last_login_at;

-- The widest patch, which is the shape whose placeholder numbering is easiest to
-- get wrong: four columns, a bump that consumes no parameter, then updated_at,
-- then the id at $6.
prepare users_repo_update_all_bump as
update users set full_name = $1, phone = $2, role = $3, is_active = $4,
                 session_version = session_version + 1, updated_at = $5
  where id = $6
  returning id, pharmacy_id, full_name, email, phone, role, password_hash,
            is_active, session_version, last_login_at;

prepare users_repo_set_password as
update users
   set password_hash = $1, session_version = session_version + 1, updated_at = now()
 where id = $2;

prepare users_repo_bump_session_version as
update users set session_version = session_version + 1 where id = $1;

prepare users_repo_mark_login as
update users set last_login_at = now() where id = $1;

do $$
begin
  raise notice 'ASSERT 9a passed: every users-repository statement parses against the migrated schema';
end $$;

deallocate users_repo_find_by_email;
deallocate users_repo_find_by_id;
deallocate users_repo_list_staff;
deallocate users_repo_count_active_owners;
deallocate users_repo_create_staff;
deallocate users_repo_update_role_bump;
deallocate users_repo_update_name_only;
deallocate users_repo_update_all_bump;
deallocate users_repo_set_password;
deallocate users_repo_bump_session_version;
deallocate users_repo_mark_login;

-- 9b-9k. The same statements, executed, and the rows they must produce.
do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  seeded_owner constant uuid := 'a0000000-0000-4000-8000-000000000002';
  subject uuid;
  ver integer;
  r user_role;
  active boolean;
  hash text;
  owners integer;
  still_there integer;
  duplicate_caught boolean := false;
begin
  insert into users (pharmacy_id, full_name, email, phone, role, password_hash)
  values (pharmacy, 'Harness Staff', 'harness-staff@aandb.example', null, 'staff', 'UNSET')
  returning id, session_version into subject, ver;

  -- 9b: the INSERT does not name session_version, so a new account starts at
  --     the column default. Anything else would desynchronise the row from the
  --     first token issued for it, and that token would be refused on the very
  --     first request it was used for.
  if ver <> 0 then
    raise exception 'ASSERT 9b: a new user started at session_version %, expected the default 0', ver;
  end if;

  -- 9c: a role change bumps in the same write, so there is no instant in which
  --     the role has changed and the old token still works.
  update users
     set role = 'pharmacist', session_version = session_version + 1, updated_at = now()
   where id = subject
   returning session_version, role into ver, r;
  if r <> 'pharmacist' or ver <> 1 then
    raise exception 'ASSERT 9c: the role-change update produced role=% session_version=%, expected pharmacist/1', r, ver;
  end if;

  -- 9d: an edit that changes nothing a token asserts must leave the session
  --     alone, or renaming somebody signs them out mid-shift.
  update users
     set full_name = 'Harness Staff-Renamed', updated_at = now()
   where id = subject
   returning session_version into ver;
  if ver <> 1 then
    raise exception 'ASSERT 9d: a rename moved session_version to %; it must stay at 1', ver;
  end if;

  -- 9e: deactivation is an ordinary column write that also bumps.
  update users
     set is_active = false, session_version = session_version + 1, updated_at = now()
   where id = subject
   returning is_active, session_version into active, ver;
  if active or ver <> 2 then
    raise exception 'ASSERT 9e: deactivation produced is_active=% session_version=%, expected false/2', active, ver;
  end if;

  -- 9f: and the row survives it. This is the whole reason staff are deactivated
  --     rather than deleted: a sale keeps the name of whoever served it.
  select count(*) into still_there from users where id = subject;
  if still_there <> 1 then
    raise exception 'ASSERT 9f: deactivation removed the row; historical sales would lose their served_by name';
  end if;

  -- 9g: setPassword changes the hash and ends the session in one statement.
  update users
     set password_hash = '$2a$12$harnessreplacement',
         session_version = session_version + 1,
         updated_at = now()
   where id = subject;
  select password_hash, session_version into hash, ver from users where id = subject;
  if hash <> '$2a$12$harnessreplacement' or ver <> 3 then
    raise exception 'ASSERT 9g: setPassword produced hash=% session_version=%, expected the new hash and 3', hash, ver;
  end if;

  -- 9h: two bumps must both land. Incrementing in SQL rather than reading,
  --     adding and writing back is what makes concurrent revocations lose
  --     neither, and a lost bump is a session that outlives the sign-out.
  update users set session_version = session_version + 1 where id = subject;
  update users set session_version = session_version + 1 where id = subject;
  select session_version into ver from users where id = subject;
  if ver <> 5 then
    raise exception 'ASSERT 9h: two bumps produced %, expected 5 — neither may be lost', ver;
  end if;

  -- 9i: countActiveOwners excludes the user it is given, which is how an owner
  --     editing themselves is not counted as their own replacement.
  select count(*)::int into owners from users
   where pharmacy_id = pharmacy
     and role = 'pharmacy_owner'
     and is_active = true
     and (seeded_owner::uuid is null or id <> seeded_owner::uuid);
  if owners <> 0 then
    raise exception 'ASSERT 9i: with the only owner excluded, countActiveOwners returned %, expected 0', owners;
  end if;

  -- 9j: and with nobody excluded it finds the seeded owner, so the guard is
  --     excluding one row rather than matching none.
  select count(*)::int into owners from users
   where pharmacy_id = pharmacy
     and role = 'pharmacy_owner'
     and is_active = true
     and (null::uuid is null or id <> null::uuid);
  if owners <> 1 then
    raise exception 'ASSERT 9j: with nobody excluded, countActiveOwners returned %, expected the one seeded owner', owners;
  end if;

  -- 9k: the unique index is on lower(email), so a differently-cased duplicate
  --     raises a unique violation. createStaff translates 23505 into a 409 on
  --     the strength of that, and if the index were case-sensitive two owners
  --     could each create the same address with different capitalisation.
  begin
    insert into users (pharmacy_id, full_name, email, phone, role, password_hash)
    values (pharmacy, 'Harness Dupe', 'HARNESS-STAFF@AANDB.EXAMPLE', null, 'staff', 'UNSET');
  exception
    when unique_violation then
      duplicate_caught := true;
  end;
  if not duplicate_caught then
    raise exception 'ASSERT 9k: a differently-cased duplicate email was accepted; createStaff would answer 201 for an address that already exists';
  end if;

  raise notice 'ASSERT 9b-9k passed: staff writes bump, deactivate without deleting, and refuse a duplicate email';
end $$;

-- ---------------------------------------------------------------------------
-- 10. The inventory repository's statements, and the four behaviours Phase 4
--     commits to: FEFO read order, a merge's weighted-average cost, recall
--     traceability, and a void putting stock back into the exact batches it
--     came out of.
--
--     10a is the same PREPARE oracle section 9a is: every statement
--     backend/src/repositories/inventory.repository.ts can emit, parsed against
--     the real schema with untyped parameters, which is what node-postgres
--     sends. Nothing is written and nothing is executed.
--
--     backend/src/__tests__/inventory.repository.test.ts holds a copy of each
--     statement and matches it against the `inventory_repo_*` names below in
--     both directions, so neither half can drift without a failure that names
--     the statement that moved. That guard collapses whitespace before it
--     compares, which is what allows these to be wrapped for reading rather
--     than pasted as one long line each.
-- ---------------------------------------------------------------------------

-- 10a. Every inventory statement parses against the migrated schema.
prepare inventory_repo_list_products_plain as
select id, pharmacy_id, name, code, generic_name, category, manufacturer,
       pack_size, default_sell_unit, shelf_location, barcode, requires_prescription,
       reorder_level, unit_price, vat_treatment, is_active, quantity, batch_number,
       expiry_date, cost_price, created_at, updated_at
  from inventory
 where pharmacy_id = $1 and is_active = true
 order by name, code
 limit $2 offset $3;

-- The widest filter combination, and the one whose placeholder numbering is
-- easiest to get wrong: `includeInactive` removes a predicate without removing
-- a parameter, and the single search parameter is reused by four `ilike`s so it
-- is numbered once.
prepare inventory_repo_list_products_widest as
select id, pharmacy_id, name, code, generic_name, category, manufacturer,
       pack_size, default_sell_unit, shelf_location, barcode, requires_prescription,
       reorder_level, unit_price, vat_treatment, is_active, quantity, batch_number,
       expiry_date, cost_price, created_at, updated_at
  from inventory
 where pharmacy_id = $1 and category = $2
   and (name ilike $3 or code ilike $3 or generic_name ilike $3 or barcode ilike $3)
 order by name, code
 limit $4 offset $5;

prepare inventory_repo_list_products_search_only as
select id, pharmacy_id, name, code, generic_name, category, manufacturer,
       pack_size, default_sell_unit, shelf_location, barcode, requires_prescription,
       reorder_level, unit_price, vat_treatment, is_active, quantity, batch_number,
       expiry_date, cost_price, created_at, updated_at
  from inventory
 where pharmacy_id = $1 and is_active = true
   and (name ilike $2 or code ilike $2 or generic_name ilike $2 or barcode ilike $2)
 order by name, code
 limit $3 offset $4;

prepare inventory_repo_find_product_by_id as
select id, pharmacy_id, name, code, generic_name, category, manufacturer,
       pack_size, default_sell_unit, shelf_location, barcode, requires_prescription,
       reorder_level, unit_price, vat_treatment, is_active, quantity, batch_number,
       expiry_date, cost_price, created_at, updated_at
  from inventory where pharmacy_id = $1 and id = $2;

prepare inventory_repo_find_product_by_code as
select id, pharmacy_id, name, code, generic_name, category, manufacturer,
       pack_size, default_sell_unit, shelf_location, barcode, requires_prescription,
       reorder_level, unit_price, vat_treatment, is_active, quantity, batch_number,
       expiry_date, cost_price, created_at, updated_at
  from inventory where pharmacy_id = $1 and code = $2;

-- `for update` is what makes receive, adjust and write-off safe to run against
-- the same product concurrently, and it is part of the statement the repository
-- sends, so it is part of what has to parse.
prepare inventory_repo_lock_product as
select id, pharmacy_id, name, code, generic_name, category, manufacturer,
       pack_size, default_sell_unit, shelf_location, barcode, requires_prescription,
       reorder_level, unit_price, vat_treatment, is_active, quantity, batch_number,
       expiry_date, cost_price, created_at, updated_at
  from inventory where pharmacy_id = $1 and id = $2 for update;

-- None of the four derived columns appears in the column list. That omission is
-- the schema-level half of the guarantee the API-level half is proved by in
-- inventory.routes.test.ts.
prepare inventory_repo_create_product as
insert into inventory (pharmacy_id, name, code, generic_name, category, manufacturer,
                       pack_size, default_sell_unit, shelf_location, barcode,
                       requires_prescription, reorder_level, unit_price,
                       vat_treatment, is_active)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
returning id, pharmacy_id, name, code, generic_name, category, manufacturer,
          pack_size, default_sell_unit, shelf_location, barcode, requires_prescription,
          reorder_level, unit_price, vat_treatment, is_active, quantity, batch_number,
          expiry_date, cost_price, created_at, updated_at;

prepare inventory_repo_update_product_one as
update inventory set name = $1
  where pharmacy_id = $2 and id = $3
  returning id, pharmacy_id, name, code, generic_name, category, manufacturer,
            pack_size, default_sell_unit, shelf_location, barcode, requires_prescription,
            reorder_level, unit_price, vat_treatment, is_active, quantity, batch_number,
            expiry_date, cost_price, created_at, updated_at;

-- Thirteen editable columns then the two scope parameters at $14 and $15. No
-- `updated_at` in the SET list: the trigger stamps it with the database clock,
-- and a value supplied from the app server would be overwritten anyway.
prepare inventory_repo_update_product_all as
update inventory set name = $1, generic_name = $2, category = $3, manufacturer = $4,
                     pack_size = $5, default_sell_unit = $6, shelf_location = $7,
                     barcode = $8, requires_prescription = $9, reorder_level = $10,
                     unit_price = $11, vat_treatment = $12, is_active = $13
  where pharmacy_id = $14 and id = $15
  returning id, pharmacy_id, name, code, generic_name, category, manufacturer,
            pack_size, default_sell_unit, shelf_location, barcode, requires_prescription,
            reorder_level, unit_price, vat_treatment, is_active, quantity, batch_number,
            expiry_date, cost_price, created_at, updated_at;

prepare inventory_repo_list_batches_for_product as
select id, pharmacy_id, inventory_id, lot_number, expiry_date, quantity, cost_price,
       received_at, created_at, updated_at
  from inventory_batches
 where pharmacy_id = $1 and inventory_id = $2
 order by expiry_date nulls last, received_at, id;

prepare inventory_repo_list_batches_holding_stock as
select id, pharmacy_id, inventory_id, lot_number, expiry_date, quantity, cost_price,
       received_at, created_at, updated_at
  from inventory_batches
 where pharmacy_id = $1 and quantity > 0
 order by inventory_id, expiry_date nulls last, received_at, id;

prepare inventory_repo_list_active_products as
select id, pharmacy_id, name, code, generic_name, category, manufacturer,
       pack_size, default_sell_unit, shelf_location, barcode, requires_prescription,
       reorder_level, unit_price, vat_treatment, is_active, quantity, batch_number,
       expiry_date, cost_price, created_at, updated_at
  from inventory
 where pharmacy_id = $1 and is_active = true
 order by name, code;

prepare inventory_repo_find_batch as
select id, pharmacy_id, inventory_id, lot_number, expiry_date, quantity, cost_price,
       received_at, created_at, updated_at
  from inventory_batches where pharmacy_id = $1 and id = $2;

prepare inventory_repo_find_batch_by_lot as
select id, pharmacy_id, inventory_id, lot_number, expiry_date, quantity, cost_price,
       received_at, created_at, updated_at
  from inventory_batches
 where pharmacy_id = $1 and inventory_id = $2 and lot_number = $3;

prepare inventory_repo_insert_batch as
insert into inventory_batches (pharmacy_id, inventory_id, lot_number, expiry_date,
                               quantity, cost_price, received_at)
values ($1, $2, $3, $4, $5, $6, $7)
returning id, pharmacy_id, inventory_id, lot_number, expiry_date, quantity,
          cost_price, received_at, created_at, updated_at;

-- The merge. `$3::numeric` is load-bearing and 10b proves why: without the cast
-- an `integer * unknown` resolution can deduce integer and silently truncate
-- every cost price to whole cedis. Both SET expressions read the pre-update row,
-- which is Postgres's rule rather than an ordering accident, and 10b asserts the
-- figure that rule produces.
prepare inventory_repo_merge_into_batch as
update inventory_batches
   set quantity = quantity + $2,
       cost_price = round(((quantity * cost_price) + ($2 * $3::numeric)) / (quantity + $2), 4)
 where id = $1
 returning id, pharmacy_id, inventory_id, lot_number, expiry_date, quantity,
           cost_price, received_at, created_at, updated_at;

prepare inventory_repo_set_batch_quantity as
update inventory_batches set quantity = $2
  where id = $1
  returning id, pharmacy_id, inventory_id, lot_number, expiry_date, quantity,
            cost_price, received_at, created_at, updated_at;

-- `movement_type` is assigned to a stock_movement_type column and nowhere else,
-- so it needs no cast: the column forces the type. Section 6 exists because the
-- sales statement uses its enum parameter in two different deductions.
prepare inventory_repo_insert_movement as
insert into stock_movements (pharmacy_id, inventory_id, batch_id, sale_id,
                             movement_type, quantity_change, quantity_after,
                             reason, note, performed_by)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);

prepare inventory_repo_list_movements as
select m.id, m.pharmacy_id, m.inventory_id, m.batch_id, m.sale_id, m.movement_type,
       m.quantity_change, m.quantity_after, m.reason, m.note, m.performed_by,
       m.created_at, u.full_name as performed_by_name
  from stock_movements m
  join users u on u.id = m.performed_by
 where m.pharmacy_id = $1 and m.inventory_id = $2
 order by m.created_at desc, m.id desc
 limit $3;

-- The recall trace. Scoped through `sales.pharmacy_id` because
-- `sale_item_batches` has no pharmacy column of its own, and a batch id from
-- another pharmacy must not answer here.
prepare inventory_repo_recall_trace as
select s.id as sale_id, s.sale_number, s.status, s.created_at as sold_at,
       sib.quantity as units, sib.unit_cost, si.description, si.sell_unit,
       u.full_name as served_by, p.full_name as patient_name, p.phone as patient_phone
  from sale_item_batches sib
  join sale_items si on si.id = sib.sale_item_id
  join sales s on s.id = si.sale_id
  join users u on u.id = s.served_by
  left join patients p on p.id = s.patient_id
 where sib.batch_id = $1
   and s.pharmacy_id = $2
 order by s.created_at desc, s.id desc;

do $$
begin
  raise notice 'ASSERT 10a passed: every inventory-repository statement parses against the migrated schema';
end $$;

deallocate inventory_repo_list_products_plain;
deallocate inventory_repo_list_products_widest;
deallocate inventory_repo_list_products_search_only;
deallocate inventory_repo_find_product_by_id;
deallocate inventory_repo_find_product_by_code;
deallocate inventory_repo_lock_product;
deallocate inventory_repo_create_product;
deallocate inventory_repo_update_product_one;
deallocate inventory_repo_update_product_all;
deallocate inventory_repo_list_batches_for_product;
deallocate inventory_repo_list_batches_holding_stock;
deallocate inventory_repo_list_active_products;
deallocate inventory_repo_find_batch;
deallocate inventory_repo_find_batch_by_lot;
deallocate inventory_repo_insert_batch;
deallocate inventory_repo_merge_into_batch;
deallocate inventory_repo_set_batch_quantity;
deallocate inventory_repo_insert_movement;
deallocate inventory_repo_list_movements;
deallocate inventory_repo_recall_trace;

-- 10b-10g. The same statements executed, and the rows they must produce.
do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  seeded_owner constant uuid := 'a0000000-0000-4000-8000-000000000002';

  product uuid;
  lot_mid uuid;
  lot_later uuid;
  lot_sequence text;
  expected_sequence constant text :=
    'LOT-EXPIRED,LOT-SOON,LOT-MID,LOT-LATER,LOT-SAME-OLD,LOT-SAME-NEW,LOT-UNDATED';

  merged_qty integer;
  merged_cost numeric;

  patient uuid;
  sale uuid;
  item uuid;
  traced_rows integer;
  traced_units integer;
  traced_phone text;
  traced_status text;

  mid_before integer;
  later_before integer;
  mid_after integer;
  later_after integer;
  derived_qty integer;
  batch_sum integer;
begin
  insert into inventory (pharmacy_id, name, code, unit_price, vat_treatment)
  values (pharmacy, 'Harness Product', 'HARNESS-2', 10.00, 'exempt')
  returning id into product;

  -- 10b. The read order in SQL is the allocator's order.
  --
  --      `expiry_date nulls last, received_at, id` is utils/fefo.ts's
  --      compareFefo written as an ORDER BY, and the two must not drift: this
  --      order decides which lot the batch panel shows first, and the allocator
  --      decides which lot the till draws from. They disagree and the screen
  --      shows one lot while the sale takes another.
  --
  --      Seven batches, one per rule: an expired lot still sorts first because
  --      the order is about age and not about sellability; a same-expiry pair is
  --      separated by received_at; and the undated lot goes last, which is what
  --      makes "undated stock is always sellable" and "undated stock is never
  --      chosen first" both true at once.
  insert into inventory_batches
    (pharmacy_id, inventory_id, lot_number, expiry_date, quantity, cost_price, received_at)
  values
    (pharmacy, product, 'LOT-EXPIRED',   current_date - 10, 5,  1.0000, now() - interval '7 days'),
    (pharmacy, product, 'LOT-SOON',      current_date +  5, 10, 2.0000, now() - interval '6 days'),
    (pharmacy, product, 'LOT-MID',       current_date + 30, 20, 1.0000, now() - interval '5 days'),
    (pharmacy, product, 'LOT-LATER',     current_date + 90, 30, 1.0000, now() - interval '4 days'),
    (pharmacy, product, 'LOT-SAME-OLD',  current_date + 90, 8,  1.0000, now() - interval '3 days'),
    (pharmacy, product, 'LOT-SAME-NEW',  current_date + 90, 8,  1.0000, now() - interval '2 days'),
    (pharmacy, product, 'LOT-UNDATED',   null,              12, 1.0000, now() - interval '1 day');

  select id into lot_mid   from inventory_batches where inventory_id = product and lot_number = 'LOT-MID';
  select id into lot_later from inventory_batches where inventory_id = product and lot_number = 'LOT-LATER';

  select string_agg(lot_number, ',' order by expiry_date nulls last, received_at, id)
    into lot_sequence
    from inventory_batches
   where pharmacy_id = pharmacy and inventory_id = product;
  if lot_sequence is distinct from expected_sequence then
    raise exception 'ASSERT 10b: batches came back in the order %, expected %', lot_sequence, expected_sequence;
  end if;

  -- 10c. A merge re-prices the drawer at the quantity-weighted average.
  --
  --      Run against LOT-MID, which the fixture above created holding 20 units
  --      at 1.0000. Receiving 5 more at 3.0000 makes 25 units whose cost is
  --      (20*1 + 5*3)/25 = 1.4000. Keeping the old cost would overstate the
  --      margin on everything sold from the drawer afterwards; taking the new one
  --      would understate it. The repository's own doc comment works the same
  --      rule through 10 at 2.0000 plus 5 at 3.0000 giving 2.3333 — a different
  --      row, the same arithmetic, and `round(..., 4)` here is the same rounding
  --      to the same number of places that recompute_inventory_from_batches
  --      uses, so the batch figure and the product figure agree.
  update inventory_batches
     set quantity = quantity + 5,
         cost_price = round(((quantity * cost_price) + (5 * '3.0000'::numeric)) / (quantity + 5), 4)
   where id = lot_mid
   returning quantity, cost_price into merged_qty, merged_cost;

  if merged_qty <> 25 or merged_cost <> 1.4000 then
    raise exception 'ASSERT 10c: merging 5 at 3.0000 into 20 at 1.0000 produced %/%, expected 25/1.4000',
      merged_qty, merged_cost;
  end if;

  -- 10d. A sale draws from two batches, and the recall trace names both the
  --      units and the person to contact.
  insert into patients (pharmacy_id, full_name, phone)
  values (pharmacy, 'Harness Patient', '0244111222')
  returning id into patient;

  insert into sales (pharmacy_id, sale_number, status, served_by, patient_id,
                     subtotal, total, amount_paid,
                     vat_rate, nhil_rate, getfund_rate, tax_inclusive_pricing)
  values (pharmacy, 'HARNESS-SALE-1', 'completed', seeded_owner, patient,
          70.00, 70.00, 70.00,
          0.1250, 0.0250, 0.0250, false)
  returning id into sale;

  insert into sale_items (sale_id, inventory_id, description, sell_unit, quantity,
                          unit_price, line_gross, taxable_base, line_total, vat_treatment)
  values (sale, product, 'Harness Product', 'single', 7,
          10.00, 70.00, 70.00, 70.00, 'exempt')
  returning id into item;

  -- Three units out of LOT-MID and four out of LOT-LATER: one line, two lots,
  -- which is the ordinary case and the reason the junction table exists.
  insert into sale_item_batches (sale_item_id, batch_id, quantity, unit_cost)
  values (item, lot_mid, 3, 1.4000), (item, lot_later, 4, 1.0000);

  select quantity into mid_before   from inventory_batches where id = lot_mid;
  select quantity into later_before from inventory_batches where id = lot_later;
  update inventory_batches set quantity = quantity - 3 where id = lot_mid;
  update inventory_batches set quantity = quantity - 4 where id = lot_later;

  select count(*)::int, max(sib.quantity), max(p.phone), max(s.status)::text
    into traced_rows, traced_units, traced_phone, traced_status
    from sale_item_batches sib
    join sale_items si on si.id = sib.sale_item_id
    join sales s on s.id = si.sale_id
    join users u on u.id = s.served_by
    left join patients p on p.id = s.patient_id
   where sib.batch_id = lot_mid
     and s.pharmacy_id = pharmacy;

  if traced_rows <> 1 or traced_units <> 3 or traced_phone is distinct from '0244111222'
     or traced_status is distinct from 'completed' then
    raise exception 'ASSERT 10d: the recall trace returned % row(s), % unit(s), phone %, status %; expected 1/3/0244111222/completed',
      traced_rows, traced_units, traced_phone, traced_status;
  end if;

  -- 10e. Voiding puts each batch's own units back into that batch.
  --
  --      This is the mechanism Phase 6's void route uses, proved here because
  --      the plan's acceptance criterion is that void is verified against real
  --      Postgres. Restoring through the junction rows is the only version that
  --      works: restoring onto the product row would be erased by the
  --      derived-stock trigger (ASSERT 3), and crediting a single batch would
  --      give one lot stock it never held and leave the other short.
  update inventory_batches b
     set quantity = b.quantity + sib.quantity
    from sale_item_batches sib
    join sale_items si on si.id = sib.sale_item_id
   where sib.batch_id = b.id
     and si.sale_id = sale;

  select quantity into mid_after   from inventory_batches where id = lot_mid;
  select quantity into later_after from inventory_batches where id = lot_later;

  if mid_after <> mid_before or later_after <> later_before then
    raise exception 'ASSERT 10e: the void restored LOT-MID to % (was %) and LOT-LATER to % (was %); each batch must get back exactly its own units',
      mid_after, mid_before, later_after, later_before;
  end if;

  -- And the product figure followed, because it is derived and nothing writes it.
  select quantity into derived_qty from inventory where id = product;
  select coalesce(sum(quantity), 0)::int into batch_sum
    from inventory_batches where inventory_id = product;
  if derived_qty <> batch_sum then
    raise exception 'ASSERT 10e: the product quantity is % but its batches hold %; the derived column did not follow the restore',
      derived_qty, batch_sum;
  end if;

  update sales
     set status = 'voided', voided_at = now(), void_reason = 'Harness void'
   where id = sale;

  -- 10f. A voided sale is still in the recall trace, carrying its status.
  --
  --      A recall is a safety operation and quietly dropping records is the wrong
  --      default: a void usually means the goods came back, but "usually" is not
  --      something to act on when the question is who may have taken a recalled
  --      lot. The UI shows the status and a person decides.
  select count(*)::int, max(s.status)::text, max(p.phone)
    into traced_rows, traced_status, traced_phone
    from sale_item_batches sib
    join sale_items si on si.id = sib.sale_item_id
    join sales s on s.id = si.sale_id
    join users u on u.id = s.served_by
    left join patients p on p.id = s.patient_id
   where sib.batch_id = lot_later
     and s.pharmacy_id = pharmacy;
  if traced_rows <> 1 or traced_status is distinct from 'voided' then
    raise exception 'ASSERT 10f: after the void the trace returned % row(s) with status %; expected 1/voided, not a filtered-out sale',
      traced_rows, traced_status;
  end if;

  -- 10g. The ledger accepts a void_restore movement.
  --
  --      The value exists in the enum and has no code path until Phase 6. It is
  --      proved here so that the Phase 6 author finds it already wired rather
  --      than inventing a second word for putting stock back.
  insert into stock_movements
    (pharmacy_id, inventory_id, batch_id, sale_id, movement_type,
     quantity_change, quantity_after, reason, note, performed_by)
  values
    (pharmacy, product, lot_mid, sale, 'void_restore',
     3, mid_after, 'Sale voided', 'Harness', seeded_owner);

  raise notice 'ASSERT 10b-10g passed: FEFO order, merge cost, recall trace, void restore, and the void_restore ledger entry';
end $$;

-- ---------------------------------------------------------------------------
-- 11. The notifications repository's statements, and the behaviours that cannot
--     be checked anywhere else: that raising twice under one dedupe key stores
--     once, and that the nullable filters in the single list statement really do
--     mean "no filter" rather than "match nothing".
--
--     11a is the PREPARE oracle sections 9a and 10a are: the statements parse,
--     the enum casts resolve, and every parameter position is deducible from its
--     target column.
--
--     It deliberately does NOT claim to prove the `on conflict (pharmacy_id,
--     dedupe_key)` target. Checked rather than assumed: with the target reduced to
--     `(dedupe_key)`, which matches no unique index on this table, all the
--     PREPAREs below still succeeded and this harness still exited 0. Arbiter
--     index inference is resolved by the planner, so it is not exercised by a
--     parse. That is why 11h exists, and why the notice 11a prints is worded as
--     narrowly as it is.
--
--     A wrong target is not a cosmetic problem: Postgres refuses the statement on
--     every execution, so every alert scan would 500, and a panel showing no
--     alerts looks exactly like a panel on a day when the stock is fine.
--
--     Phase 4 wrote this section for two statements and called it the alerts
--     repository. Phase 8 collapsed the list into one statement with nullable
--     parameters -- so the placeholder count no longer depends on which filters a
--     caller supplied -- and added the three the bell needs. That collapse is what
--     11k is for: a filter parameter bound to NULL is the new version of the empty
--     array trap 11e proves, and it fails the same silent way.
--
--     backend/src/__tests__/notifications.repository.test.ts holds a copy of each
--     statement and matches it against the `notifications_repo_*` names below in
--     both directions. The chain that makes the conflict target verified is
--     therefore: that drift guard ties the repository's text to the PREPARE here,
--     11b-11d execute that shape and show it dedupes, and 11h shows a different
--     target is refused -- so the shape being executed is the shape the code emits.
-- ---------------------------------------------------------------------------

prepare notifications_repo_raise as
insert into notifications
   (pharmacy_id, user_id, type, status, title, body, related_type, related_id,
    dedupe_key, not_sent_reason, sent_at)
values ($1, $2, $3::notification_type, $4::notification_status, $5, $6, $7, $8,
        $9, $10, $11)
on conflict (pharmacy_id, dedupe_key) do nothing
returning id, pharmacy_id, user_id, type, status, title, body, related_type,
          related_id, dedupe_key, not_sent_reason, sent_at, read_at, created_at,
          updated_at;

-- One statement for every filter combination the repository can be asked for.
-- `$2` is the asking user (null means "show me everything"), `$3` the type list
-- (null means every type) and `$4` unread-only (null means read rows count too).
prepare notifications_repo_list as
select id, pharmacy_id, user_id, type, status, title, body, related_type,
       related_id, dedupe_key, not_sent_reason, sent_at, read_at, created_at,
       updated_at
  from notifications
 where pharmacy_id = $1
   and ($2::uuid is null or user_id is null or user_id = $2::uuid)
   and ($3::notification_type[] is null or type = any($3::notification_type[]))
   and (coalesce($4::boolean, false) = false or read_at is null)
 order by created_at desc, id desc
 limit $5 offset $6;

prepare notifications_repo_count_unread as
select count(*)::int as n from notifications
  where pharmacy_id = $1
    and read_at is null
    and ($2::uuid is null or user_id is null or user_id = $2::uuid);

-- `coalesce` keeps the first reader's timestamp: a broadcast has one read_at and
-- the useful fact is when somebody first saw it, not when the last person
-- clicked the same row again.
prepare notifications_repo_mark_read as
update notifications
    set read_at = coalesce(read_at, $4)
  where pharmacy_id = $1
    and id = $3
    and ($2::uuid is null or user_id is null or user_id = $2::uuid)
  returning id, pharmacy_id, user_id, type, status, title, body, related_type,
            related_id, dedupe_key, not_sent_reason, sent_at, read_at,
            created_at, updated_at;

prepare notifications_repo_mark_all_read as
update notifications
    set read_at = $3
  where pharmacy_id = $1
    and read_at is null
    and ($2::uuid is null or user_id is null or user_id = $2::uuid)
  returning id;

do $$
begin
  raise notice 'ASSERT 11a passed: every notifications-repository statement parses against the migrated schema';
end $$;

deallocate notifications_repo_raise;
deallocate notifications_repo_list;
deallocate notifications_repo_count_unread;
deallocate notifications_repo_mark_read;
deallocate notifications_repo_mark_all_read;

-- 11b-11m. The same statements, executed.
do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  seeded_owner constant uuid := 'a0000000-0000-4000-8000-000000000002';
  stamp constant timestamptz := '2026-03-15T09:00:00Z';
  second_stamp constant timestamptz := '2026-03-15T10:30:00Z';
  raised_id uuid;
  stored integer;
  empty_match integer;
  typed_match integer;
  a_id uuid;
  b_id uuid;
  first_title text;
  wrong_target_error text;
  other_user uuid;
  broadcast_id uuid;
  targeted_id uuid;
  scratch_id uuid;
  visible_to_owner integer;
  visible_to_other integer;
  unread_owner integer;
  unread_other integer;
  listed_unfiltered integer;
  listed_unread_only integer;
  read_first timestamptz;
  read_second timestamptz;
  marked_all integer;
begin
  -- 11b. The first raise inserts, and RETURNING hands the row back.
  insert into notifications
    (pharmacy_id, user_id, type, status, title, body, related_type, related_id,
     dedupe_key, not_sent_reason)
  values
    (pharmacy, null, 'stock_reorder', 'not_sent', 'Harness reorder', 'Harness body',
     'inventory', null, 'HARNESS-ALERT-REORDER', 'Harness reason')
  on conflict (pharmacy_id, dedupe_key) do nothing
  returning id into raised_id;

  if raised_id is null then
    raise exception 'ASSERT 11b: the first raise of a new dedupe_key returned no row; ON CONFLICT would be swallowing inserts that should land';
  end if;

  -- 11c. The second raise of the same key returns nothing, and that is the whole
  --      mechanism. The repository reads `rows[0] === undefined` as "somebody
  --      already raised this", with no error and no second query. Deciding in the
  --      application instead — select, then insert if absent — is a race whose
  --      window is exactly the two round trips between the read and the write.
  raised_id := null;
  insert into notifications
    (pharmacy_id, user_id, type, status, title, body, related_type, related_id,
     dedupe_key, not_sent_reason)
  values
    (pharmacy, null, 'stock_reorder', 'not_sent', 'Harness reorder again', null,
     'inventory', null, 'HARNESS-ALERT-REORDER', null)
  on conflict (pharmacy_id, dedupe_key) do nothing
  returning id into raised_id;

  if raised_id is not null then
    raise exception 'ASSERT 11c: the second raise of the same key returned a row; the scan would add an alert on every refresh until the panel is unreadable';
  end if;

  -- 11d. Exactly one row survived the two attempts, and it is the first one.
  --      `do nothing` must decline the insert rather than update the row already
  --      there, or a later scan would overwrite the wording of an alert somebody
  --      has not read yet.
  select count(*)::int, max(title) into stored, first_title
    from notifications
   where pharmacy_id = pharmacy and dedupe_key = 'HARNESS-ALERT-REORDER';
  if stored <> 1 then
    raise exception 'ASSERT 11d: two raises of one key left % rows, expected 1', stored;
  end if;
  if first_title <> 'Harness reorder' then
    raise exception 'ASSERT 11d: the surviving row is titled %, expected the first raise to be the one kept', first_title;
  end if;

  -- 11e. `= any` of an empty array matches nothing. This is why listNotifications
  --      guards on `types.length > 0` instead of pushing the array unconditionally:
  --      an empty selection would render an empty panel with no error anywhere,
  --      which is indistinguishable from a quiet day in the pharmacy.
  select count(*)::int into empty_match
    from notifications
   where pharmacy_id = pharmacy
     and dedupe_key = 'HARNESS-ALERT-REORDER'
     and type = any(array[]::notification_type[]);
  if empty_match <> 0 then
    raise exception 'ASSERT 11e: an empty notification_type array matched % row(s), expected 0', empty_match;
  end if;

  -- 11f. And a populated array matches, the cast turning one bound parameter into
  --      a set without any value reaching the statement as SQL text.
  select count(*)::int into typed_match
    from notifications
   where pharmacy_id = pharmacy
     and dedupe_key = 'HARNESS-ALERT-REORDER'
     and type = any(array['stock_reorder', 'stock_expiry']::notification_type[]);
  if typed_match <> 1 then
    raise exception 'ASSERT 11f: a populated notification_type array matched % row(s), expected 1', typed_match;
  end if;

  -- 11g. Two alerts raised in the same scan share a created_at, so `id desc` is
  --      what makes the panel's order stable between two refreshes of the same
  --      data. Without it the list can reorder while nothing has changed, which
  --      reads as an alert disappearing.
  insert into notifications
    (pharmacy_id, type, status, title, dedupe_key, created_at)
  values
    (pharmacy, 'stock_expiry', 'not_sent', 'Harness expiry A', 'HARNESS-ALERT-A', stamp),
    (pharmacy, 'stock_expiry', 'not_sent', 'Harness expiry B', 'HARNESS-ALERT-B', stamp);

  select id into a_id from notifications where dedupe_key = 'HARNESS-ALERT-A';
  select id into b_id from notifications where dedupe_key = 'HARNESS-ALERT-B';
  select title into first_title
    from notifications
   where pharmacy_id = pharmacy and created_at = stamp
   order by created_at desc, id desc
   limit 1;

  -- Whichever uuid happens to be greater must be the one that sorts first. Both
  -- rows share created_at, so this is decided by the tie-break alone.
  if (first_title = 'Harness expiry A') <> (a_id > b_id) then
    raise exception 'ASSERT 11g: with two rows sharing created_at the tie-break put % first; `id desc` should always put the greater id first', first_title;
  end if;

  -- 11h. Everything above only means something if a target that matches no unique
  --      index is actually refused. It is, and at execution rather than at parse:
  --      this is the assertion 11a cannot make, verified instead of assumed after
  --      reducing the PREPARE above to `(dedupe_key)` and watching all three
  --      PREPAREs succeed anyway.
  --
  --      Without this, 11b-11d would show only that an insert carrying a conflict
  --      clause works, and the composite target -- the part the whole dedupe
  --      depends on -- would be untested.
  begin
    insert into notifications
      (pharmacy_id, type, status, title, dedupe_key)
    values
      (pharmacy, 'stock_reorder', 'not_sent', 'Harness wrong target', 'HARNESS-ALERT-WRONG')
    on conflict (dedupe_key) do nothing;
    wrong_target_error := null;
  exception
    when others then
      wrong_target_error := sqlstate;
  end;

  if wrong_target_error is null then
    raise exception 'ASSERT 11h: `on conflict (dedupe_key)` was accepted although no unique index on notifications matches it; 11b-11d would then be proving nothing about the target the repository uses';
  end if;
  -- 42P10 is invalid_on_clause_specification: "there is no unique or exclusion
  -- constraint matching the ON CONFLICT specification". Caught with `when others`
  -- and then compared, rather than caught by name, so that a future schema which
  -- grows a matching index fails here reporting the state it produced instead of
  -- failing on an exception nobody expected.
  if wrong_target_error <> '42P10' then
    raise exception 'ASSERT 11h: a non-matching ON CONFLICT target failed with SQLSTATE %, expected 42P10', wrong_target_error;
  end if;

  -- 11i. The visibility clause. A broadcast reaches everybody and a targeted row
  --      reaches one person, through the same three-valued disjunction the list,
  --      the count and both updates all use.
  --
  --      `TRUE OR NULL` is TRUE, and that is what makes the leading `$2::uuid is
  --      null` branch load-bearing rather than decorative: without it an
  --      unfiltered call would evaluate `user_id = NULL`, which is NULL and not
  --      false, and the bell would render empty for the alerts panel that asks
  --      for everything.
  insert into users (pharmacy_id, full_name, email, role, password_hash)
  values (pharmacy, 'Harness Other', 'harness-notifications-other@aandb.example',
          'staff', 'UNSET')
  returning id into other_user;

  insert into notifications (pharmacy_id, user_id, type, status, title, dedupe_key)
  values (pharmacy, null, 'refill_reminder', 'not_sent', 'Harness broadcast',
          'HARNESS-NOTIF-BROADCAST')
  returning id into broadcast_id;

  insert into notifications (pharmacy_id, user_id, type, status, title, dedupe_key)
  values (pharmacy, seeded_owner, 'appointment_reminder', 'not_sent', 'Harness targeted',
          'HARNESS-NOTIF-TARGETED')
  returning id into targeted_id;

  select count(*)::int into visible_to_owner
    from notifications
   where pharmacy_id = pharmacy
     and dedupe_key like 'HARNESS-NOTIF-%'
     and (seeded_owner is null or user_id is null or user_id = seeded_owner);
  if visible_to_owner <> 2 then
    raise exception 'ASSERT 11i: the targeted user sees % of the two harness notifications, expected 2 -- one broadcast and one aimed at them', visible_to_owner;
  end if;

  select count(*)::int into visible_to_other
    from notifications
   where pharmacy_id = pharmacy
     and dedupe_key like 'HARNESS-NOTIF-%'
     and (other_user is null or user_id is null or user_id = other_user);
  if visible_to_other <> 1 then
    raise exception 'ASSERT 11i: a second user sees % of the two harness notifications, expected 1 -- a reminder aimed at one pharmacist is not another''s to read', visible_to_other;
  end if;

  -- 11j. `coalesce(read_at, $4)` keeps the first reader's instant. Without it a
  --      second click on the same broadcast would move read_at forward, and the
  --      record would claim a reminder was seen at a time nobody can account for.
  update notifications
     set read_at = coalesce(read_at, stamp)
   where pharmacy_id = pharmacy and id = broadcast_id
     and (seeded_owner is null or user_id is null or user_id = seeded_owner);

  select read_at into read_first from notifications where id = broadcast_id;
  if read_first is distinct from stamp then
    raise exception 'ASSERT 11j: the first mark read wrote %, expected %', read_first, stamp;
  end if;

  update notifications
     set read_at = coalesce(read_at, second_stamp)
   where pharmacy_id = pharmacy and id = broadcast_id
     and (other_user is null or user_id is null or user_id = other_user);

  select read_at into read_second from notifications where id = broadcast_id;
  if read_second is distinct from stamp then
    raise exception 'ASSERT 11j: a second mark read moved read_at to %, expected it to stay at % -- coalesce is what keeps the first reader''s timestamp', read_second, stamp;
  end if;

  -- 11k. NULL in a filter parameter means "no filter", not "match nothing". This
  --      is the Phase 8 version of the empty-array trap 11e proves, and it is the
  --      reason the list is one statement rather than a builder: with a builder,
  --      a filter combination nobody exercised in a test was a statement nobody
  --      had ever parsed against the schema.
  --
  --      One of the two harness rows is read (11j) and one is not, so the
  --      unfiltered count must be the larger and the difference must be exactly
  --      the row that was marked.
  select count(*)::int into listed_unfiltered
    from notifications
   where pharmacy_id = pharmacy
     and (null::uuid is null or user_id is null or user_id = null::uuid)
     and (null::notification_type[] is null or type = any(null::notification_type[]))
     and (coalesce(null::boolean, false) = false or read_at is null)
     and dedupe_key like 'HARNESS-NOTIF-%';
  if listed_unfiltered <> 2 then
    raise exception 'ASSERT 11k: three NULL filter parameters matched % rows, expected 2 -- a filter nobody applied is filtering', listed_unfiltered;
  end if;

  select count(*)::int into listed_unread_only
    from notifications
   where pharmacy_id = pharmacy
     and (null::uuid is null or user_id is null or user_id = null::uuid)
     and (null::notification_type[] is null or type = any(null::notification_type[]))
     and (coalesce(true::boolean, false) = false or read_at is null)
     and dedupe_key like 'HARNESS-NOTIF-%';
  if listed_unread_only <> 1 then
    raise exception 'ASSERT 11k: unread-only matched % rows, expected 1 -- the broadcast was marked read in 11j', listed_unread_only;
  end if;

  -- The badge, asserted as a difference rather than as two absolute counts. The
  -- repository's own statement has no dedupe_key predicate, so an absolute count
  -- here would depend on every row earlier sections have written; the difference
  -- depends only on the one row that is aimed at somebody.
  select count(*)::int into unread_owner
    from notifications
   where pharmacy_id = pharmacy and read_at is null
     and (seeded_owner is null or user_id is null or user_id = seeded_owner);
  select count(*)::int into unread_other
    from notifications
   where pharmacy_id = pharmacy and read_at is null
     and (other_user is null or user_id is null or user_id = other_user);
  if unread_owner - unread_other <> 1 then
    raise exception 'ASSERT 11k: the unread counts differ by % between the targeted user and another, expected exactly 1 -- the badge would be showing a reminder to somebody it was not aimed at', unread_owner - unread_other;
  end if;

  -- 11l. Mark-all-read is scoped to `read_at is null`, so the row count it
  --      returns is "how many I just read" rather than "how many rows matched",
  --      and clearing the bell twice in a row reports zero the second time
  --      instead of re-touching rows nobody has opened since.
  --
  --      The dedupe_key predicate is not in the repository's statement. It is
  --      here so the assertion counts only the rows this section wrote; the
  --      semantics under test -- that an already-read row is not touched again --
  --      are unaffected by narrowing the scope.
  update notifications set read_at = second_stamp
   where pharmacy_id = pharmacy and read_at is null
     and (seeded_owner is null or user_id is null or user_id = seeded_owner)
     and dedupe_key like 'HARNESS-NOTIF-%';
  get diagnostics marked_all = row_count;
  if marked_all <> 1 then
    raise exception 'ASSERT 11l: mark-all-read touched % rows, expected 1 -- the broadcast was already read in 11j and must not be touched again', marked_all;
  end if;

  update notifications set read_at = second_stamp
   where pharmacy_id = pharmacy and read_at is null
     and (seeded_owner is null or user_id is null or user_id = seeded_owner)
     and dedupe_key like 'HARNESS-NOTIF-%';
  get diagnostics marked_all = row_count;
  if marked_all <> 0 then
    raise exception 'ASSERT 11l: a second mark-all-read touched % rows, expected 0', marked_all;
  end if;

  -- 11m. The visibility clause is on the UPDATE as well as the SELECT. A write
  --      path that forgot it would let any member of staff clear somebody else's
  --      reminders, and the result reads identically to "the reminder was never
  --      raised" -- the quietest failure in this section.
  scratch_id := null;
  update notifications
     set read_at = coalesce(read_at, second_stamp)
   where pharmacy_id = pharmacy and id = targeted_id
     and (other_user is null or user_id is null or user_id = other_user)
   returning id into scratch_id;
  if scratch_id is not null then
    raise exception 'ASSERT 11m: a user the reminder was not aimed at was able to mark it read';
  end if;

  raise notice 'ASSERT 11b-11m passed: one dedupe key stores one alert, an empty type array matches nothing, a created_at tie breaks on id, a non-matching conflict target is refused, NULL filters mean no filter, a broadcast keeps its first read_at, and a targeted reminder is neither counted for nor clearable by anybody else';
end $$;

-- ---------------------------------------------------------------------------
-- 12. A savepoint is what lets one bad row of an import fail alone.
-- ---------------------------------------------------------------------------
-- Raw SQL, not a `do` block, and that is not a stylistic choice. A PL/pgSQL
-- block with an exception handler *is* a savepoint: catching an error inside one
-- rolls back to an implicit subtransaction, so from inside a `do` block an
-- explicit SAVEPOINT and no savepoint at all are indistinguishable. The two
-- transactions below are the sequence `withSavepoint` in
-- backend/src/database/pool.ts sends, statement for statement, including the
-- `release` after the `rollback to`.
--
-- ON_ERROR_STOP is off for those two transactions only, because both contain a
-- statement that is meant to fail. It is back on before anything is asserted,
-- and every assertion is a positive count of what committed -- so a statement
-- failing unexpectedly shows up here as a missing row, not as a skipped check.

\set ON_ERROR_STOP off

-- 12a. The control. Three rows, the second a duplicate of the first, and no
--      savepoint anywhere.
begin;
insert into inventory (pharmacy_id, name, code, pack_size, unit_price)
values ('a0000000-0000-4000-8000-000000000001', 'Harness Control Before', 'HARNESS-SP-CTRL-1', 10, 5.00);
insert into inventory (pharmacy_id, name, code, pack_size, unit_price)
values ('a0000000-0000-4000-8000-000000000001', 'Harness Control Before', 'HARNESS-SP-CTRL-1', 10, 5.00);
insert into inventory (pharmacy_id, name, code, pack_size, unit_price)
values ('a0000000-0000-4000-8000-000000000001', 'Harness Control After', 'HARNESS-SP-CTRL-2', 10, 5.00);
commit;

-- 12b. The same shape with a savepoint around the row that fails.
begin;
insert into inventory (pharmacy_id, name, code, pack_size, unit_price)
values ('a0000000-0000-4000-8000-000000000001', 'Harness Savepoint Before', 'HARNESS-SP-OK-1', 10, 5.00);
savepoint csv_row_2;
insert into inventory (pharmacy_id, name, code, pack_size, unit_price)
values ('a0000000-0000-4000-8000-000000000001', 'Harness Savepoint Before', 'HARNESS-SP-OK-1', 10, 5.00);
rollback to savepoint csv_row_2;
release savepoint csv_row_2;
insert into inventory (pharmacy_id, name, code, pack_size, unit_price)
values ('a0000000-0000-4000-8000-000000000001', 'Harness Savepoint After', 'HARNESS-SP-OK-2', 10, 5.00);
commit;

\set ON_ERROR_STOP on

-- 12c. The control's third row again, in a transaction of its own. It has to be
--      insertable, or its absence from 12a would prove nothing about the
--      aborted transaction and everything about the row. `on conflict do
--      nothing` rather than a plain insert so that this statement cannot itself
--      fail: were 12a's transaction ever to commit, a plain insert would abort
--      the run here with a duplicate-key error and ASSERT 12d would never be
--      reached to report what actually went wrong.
insert into inventory (pharmacy_id, name, code, pack_size, unit_price)
values ('a0000000-0000-4000-8000-000000000001', 'Harness Control After', 'HARNESS-SP-CTRL-2', 10, 5.00)
on conflict (pharmacy_id, code) do nothing;

do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  ctrl_before integer;
  ctrl_after integer;
  survived integer;
begin
  select count(*) into ctrl_before from inventory
   where pharmacy_id = pharmacy and code = 'HARNESS-SP-CTRL-1';
  select count(*) into ctrl_after from inventory
   where pharmacy_id = pharmacy and code = 'HARNESS-SP-CTRL-2';
  select count(*) into survived from inventory
   where pharmacy_id = pharmacy and code like 'HARNESS-SP-OK-%';

  -- 12d. The duplicate aborted the transaction, so the `commit` became a
  --      rollback and took the first row with it -- a row that was valid and
  --      had already succeeded. This is the cost the importer must not pay:
  --      one bad line of a four-hundred-line file losing the whole upload.
  if ctrl_before <> 0 then
    raise exception 'ASSERT 12d: % row(s) committed from the aborted control transaction, expected 0; a commit on an aborted transaction must roll back', ctrl_before;
  end if;

  -- 12e. Proves 12d is about the transaction and not about the rows: the same
  --      statement, run outside an aborted transaction, lands.
  if ctrl_after <> 1 then
    raise exception 'ASSERT 12e: the control''s third row was inserted on its own and % row(s) are present, expected 1; 12d would then be proving nothing', ctrl_after;
  end if;

  -- 12f. Both good rows survived and the duplicate is absent. This is also the
  --      assertion that `release savepoint` is legal immediately after
  --      `rollback to savepoint` on Postgres 16, which pool.ts does on every
  --      failing row: had it raised, the transaction would have been aborted
  --      again and this count would be 0 rather than 2.
  if survived <> 2 then
    raise exception 'ASSERT 12f: % of the 2 good rows survived the savepoint, expected 2', survived;
  end if;

  raise notice 'ASSERT 12 passed: a duplicate loses the whole transaction without a savepoint and only its own row with one, and release after rollback to is accepted';
end $$;

-- ---------------------------------------------------------------------------
-- 13. The sales repository's statements, and Phase 6's acceptance line: the
--     seven-step write path executed end to end against the real trigger chain,
--     with stock confirmed to have moved through the trigger, and void proven
--     to restore to the exact batches the units came out of.
--
--     13a is the PREPARE oracle sections 9a, 10a and 11a are: every statement
--     backend/src/repositories/sales.repository.ts can emit, parsed against the
--     real schema with untyped parameters, which is what node-postgres sends.
--     This is the half that catches BRIEF.md's landmine 1, and PREPARE catches
--     it faithfully because a PREPARE with no parameter type list forces exactly
--     the deduction the driver forces: every type has to come from context.
--
--     backend/src/__tests__/sales.repository.test.ts holds a copy of each
--     statement and matches it against the `sales_repo_*` names below in both
--     directions, so neither half can drift without a failure naming the
--     statement that moved. That guard collapses whitespace before comparing,
--     which is what allows these to be wrapped for reading.
--
--     13b and 13c differ from 10b in one way that matters. Section 10a
--     deallocates before 10b runs, so 10b executes hand-written equivalents of
--     the inventory statements; here the prepares are kept and executed, so
--     there is no third copy of the sales SQL anywhere in the repository. The
--     statements 13b runs are the statements 13a parsed are the statements
--     Jest proved the repository builds. `harness_repo_sql` below is how: it
--     reads the text back out of pg_prepared_statements, which holds what
--     PREPARE was given, and strips the `prepare <name> as` prefix Postgres
--     records along with it.
--
--     The stock side of the path is written as plain SQL and that is deliberate.
--     Those statements belong to the inventory repository: 10a proves they parse
--     and 10b/10e prove they behave, and re-proving them here would only add a
--     second copy to drift. What this section owns is the sales half.
-- ---------------------------------------------------------------------------

-- 13a. Every sales statement parses against the migrated schema.
prepare sales_repo_advisory_lock as
select pg_advisory_xact_lock(hashtextextended($1, 0));

-- The receipt-number read. `$2` carries the capture pattern rather than having
-- it spliced into the text, so the `S-` prefix stays in one TypeScript constant
-- and no part of a statement is built by concatenation.
prepare sales_repo_next_sale_number as
select coalesce(max(substring(sale_number from $2)::bigint), 0) as last_number
  from sales
 where pharmacy_id = $1;

-- Twenty-one parameters in column order, `$3` cast to sale_status. The cast is
-- not load-bearing today -- an assignment deduces from the column -- and section
-- 6 is the experiment that shows what it is there for.
prepare sales_repo_insert_sale as
insert into sales
   (pharmacy_id, sale_number, status, served_by, approved_by, patient_id,
    subtotal, discount, discount_reason, vat_amount, nhil_amount, getfund_amount,
    tax_total, total, amount_paid, change_given, vat_rate, nhil_rate, getfund_rate,
    tax_inclusive_pricing, client_sale_id)
 values ($1, $2, $3::sale_status, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21)
 returning id, pharmacy_id, sale_number, status, served_by, approved_by, patient_id,
          subtotal, discount, discount_reason, vat_amount, nhil_amount, getfund_amount,
          tax_total, total, amount_paid, change_given, vat_rate, nhil_rate, getfund_rate,
          tax_inclusive_pricing, client_sale_id, voided_at, void_reason, created_at,
          updated_at;

prepare sales_repo_insert_sale_item as
insert into sale_items
   (sale_id, inventory_id, description, sell_unit, quantity, unit_price, line_gross,
    line_discount, taxable_base, vat_amount, nhil_amount, getfund_amount, line_total,
    vat_treatment)
 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
 returning id, sale_id, inventory_id, description, sell_unit, quantity,
          unit_price, line_gross, line_discount, taxable_base, vat_amount, nhil_amount,
          getfund_amount, line_total, vat_treatment, created_at;

prepare sales_repo_insert_sale_item_batch as
insert into sale_item_batches (sale_item_id, batch_id, quantity, unit_cost)
 values ($1, $2, $3, $4);

prepare sales_repo_insert_sale_payment as
insert into sale_payments (sale_id, method, status, amount, reference, gateway_response, paid_at)
 values ($1, $2, $3, $4, $5, $6, $7)
 returning id, sale_id, method, status, amount, reference,
          gateway_response, paid_at, created_at, updated_at;

prepare sales_repo_find_sale_by_id as
select id, pharmacy_id, sale_number, status, served_by, approved_by, patient_id,
       subtotal, discount, discount_reason, vat_amount, nhil_amount, getfund_amount,
       tax_total, total, amount_paid, change_given, vat_rate, nhil_rate, getfund_rate,
       tax_inclusive_pricing, client_sale_id, voided_at, void_reason, created_at,
       updated_at
  from sales where pharmacy_id = $1 and id = $2;

prepare sales_repo_find_sale_by_client_sale_id as
select id, pharmacy_id, sale_number, status, served_by, approved_by, patient_id,
       subtotal, discount, discount_reason, vat_amount, nhil_amount, getfund_amount,
       tax_total, total, amount_paid, change_given, vat_rate, nhil_rate, getfund_rate,
       tax_inclusive_pricing, client_sale_id, voided_at, void_reason, created_at,
       updated_at
  from sales where pharmacy_id = $1 and client_sale_id = $2;

prepare sales_repo_patient_exists as
select 1 from patients where pharmacy_id = $1 and id = $2;

-- Identical to the read above except for the lock, and 13b asserts that: a lock
-- on a *different* select would satisfy a regex while locking a row the write
-- path never compared against.
prepare sales_repo_lock_sale as
select id, pharmacy_id, sale_number, status, served_by, approved_by, patient_id,
       subtotal, discount, discount_reason, vat_amount, nhil_amount, getfund_amount,
       tax_total, total, amount_paid, change_given, vat_rate, nhil_rate, getfund_rate,
       tax_inclusive_pricing, client_sale_id, voided_at, void_reason, created_at,
       updated_at
  from sales where pharmacy_id = $1 and id = $2 for update;

prepare sales_repo_list_sale_items as
select id, sale_id, inventory_id, description, sell_unit, quantity,
       unit_price, line_gross, line_discount, taxable_base, vat_amount, nhil_amount,
       getfund_amount, line_total, vat_treatment, created_at
  from sale_items where sale_id = $1 order by created_at, id;

prepare sales_repo_list_sale_item_batches as
select sib.id, sib.sale_item_id, sib.batch_id, sib.quantity, sib.unit_cost,
       b.lot_number, si.inventory_id
  from sale_item_batches sib
  join sale_items si on si.id = sib.sale_item_id
  join inventory_batches b on b.id = sib.batch_id
 where si.sale_id = $1
 order by si.created_at, si.id, sib.id;

prepare sales_repo_list_sale_payments as
select id, sale_id, method, status, amount, reference,
       gateway_response, paid_at, created_at, updated_at
  from sale_payments where sale_id = $1 order by created_at, id;

-- The three filter shapes, because each one renumbers every placeholder after
-- it. `$2::sale_status` in the second and third is load-bearing: the parameter
-- is also used in `is null` by way of the filter being absent, and the edit that
-- lets the till send one value meaning "no filter" -- `or $2 = 'all'` -- gives it
-- a second, incompatible deduction.
prepare sales_repo_list_sales_plain as
select s.id, s.sale_number, s.status, s.created_at, s.total, s.amount_paid,
            s.change_given, s.patient_id,
            u.full_name as served_by_name,
            p.full_name as patient_name,
            (select count(*) from sale_items si where si.sale_id = s.id) as item_count,
            coalesce(
              (select array_agg(sp.method order by sp.created_at, sp.id)
                 from sale_payments sp
                where sp.sale_id = s.id),
              '{}'
            ) as payment_methods
       from sales s
       join users u on u.id = s.served_by
       left join patients p on p.id = s.patient_id
      where s.pharmacy_id = $1
      order by s.created_at desc, s.id desc
      limit $2 offset $3;

prepare sales_repo_list_sales_status as
select s.id, s.sale_number, s.status, s.created_at, s.total, s.amount_paid,
            s.change_given, s.patient_id,
            u.full_name as served_by_name,
            p.full_name as patient_name,
            (select count(*) from sale_items si where si.sale_id = s.id) as item_count,
            coalesce(
              (select array_agg(sp.method order by sp.created_at, sp.id)
                 from sale_payments sp
                where sp.sale_id = s.id),
              '{}'
            ) as payment_methods
       from sales s
       join users u on u.id = s.served_by
       left join patients p on p.id = s.patient_id
      where s.pharmacy_id = $1 and s.status = $2::sale_status
      order by s.created_at desc, s.id desc
      limit $3 offset $4;

prepare sales_repo_list_sales_all as
select s.id, s.sale_number, s.status, s.created_at, s.total, s.amount_paid,
            s.change_given, s.patient_id,
            u.full_name as served_by_name,
            p.full_name as patient_name,
            (select count(*) from sale_items si where si.sale_id = s.id) as item_count,
            coalesce(
              (select array_agg(sp.method order by sp.created_at, sp.id)
                 from sale_payments sp
                where sp.sale_id = s.id),
              '{}'
            ) as payment_methods
       from sales s
       join users u on u.id = s.served_by
       left join patients p on p.id = s.patient_id
      where s.pharmacy_id = $1 and s.status = $2::sale_status and s.served_by = $3
        and s.created_at >= $4::timestamptz
        and s.created_at < ($5::date + interval '1 day')
        and s.sale_number ilike $6
      order by s.created_at desc, s.id desc
      limit $7 offset $8;

prepare sales_repo_update_sale_settlement as
update sales
   set amount_paid = $2,
       change_given = $3,
       status = $4
 where id = $1
   and status <> 'voided'::sale_status
 returning id, pharmacy_id, sale_number, status, served_by, approved_by, patient_id,
          subtotal, discount, discount_reason, vat_amount, nhil_amount, getfund_amount,
          tax_total, total, amount_paid, change_given, vat_rate, nhil_rate, getfund_rate,
          tax_inclusive_pricing, client_sale_id, voided_at, void_reason, created_at,
          updated_at;

prepare sales_repo_mark_sale_voided as
update sales
   set status = 'voided'::sale_status,
       void_reason = $2,
       voided_at = $3,
       amount_paid = 0,
       change_given = 0
 where id = $1
   and status <> 'voided'::sale_status
 returning id, pharmacy_id, sale_number, status, served_by, approved_by, patient_id,
          subtotal, discount, discount_reason, vat_amount, nhil_amount, getfund_amount,
          tax_total, total, amount_paid, change_given, vat_rate, nhil_rate, getfund_rate,
          tax_inclusive_pricing, client_sale_id, voided_at, void_reason, created_at,
          updated_at;

prepare sales_repo_find_sale_payment as
select sp.id, sp.sale_id, sp.method, sp.status, sp.amount, sp.reference,
       sp.gateway_response, sp.paid_at, sp.created_at, sp.updated_at,
       s.pharmacy_id, s.status as sale_status
  from sale_payments sp
  join sales s on s.id = sp.sale_id
 where s.pharmacy_id = $1 and sp.id = $2;

-- The one lookup in the file with no pharmacy scope, because a webhook arrives
-- from Paystack, which knows the merchant account and has never heard of a
-- tenant. Restricted to momo: on a cash tender `reference` holds the operator's
-- free-text note, and matching that against a gateway reference would settle a
-- cash sale with money that never arrived.
prepare sales_repo_find_sale_payment_by_reference as
select sp.id, sp.sale_id, sp.method, sp.status, sp.amount, sp.reference,
       sp.gateway_response, sp.paid_at, sp.created_at, sp.updated_at,
       s.pharmacy_id, s.status as sale_status
  from sale_payments sp
  join sales s on s.id = sp.sale_id
 where sp.reference = $1
   and sp.method = 'momo'
 order by sp.created_at, sp.id
 limit 1;

-- The four shapes of the status update. The guard placeholder is pushed last,
-- after the SET list is assembled, so its number moves with whichever optionals
-- the caller supplied -- which is why all four are prepared rather than one.
prepare sales_repo_update_payment_status_only as
update sale_payments
   set status = $2::sale_payment_status
 where id = $1
   and status = any($3::sale_payment_status[])
 returning id, sale_id, method, status, amount, reference,
          gateway_response, paid_at, created_at, updated_at;

prepare sales_repo_update_payment_status_gateway as
update sale_payments
   set status = $2::sale_payment_status, gateway_response = $3::jsonb
 where id = $1
   and status = any($4::sale_payment_status[])
 returning id, sale_id, method, status, amount, reference,
          gateway_response, paid_at, created_at, updated_at;

prepare sales_repo_update_payment_status_paid_at as
update sale_payments
   set status = $2::sale_payment_status, paid_at = $3
 where id = $1
   and status = any($4::sale_payment_status[])
 returning id, sale_id, method, status, amount, reference,
          gateway_response, paid_at, created_at, updated_at;

prepare sales_repo_update_payment_status_both as
update sale_payments
   set status = $2::sale_payment_status, gateway_response = $3::jsonb, paid_at = $4
 where id = $1
   and status = any($5::sale_payment_status[])
 returning id, sale_id, method, status, amount, reference,
          gateway_response, paid_at, created_at, updated_at;

do $$
declare
  prepared integer;
begin
  select count(*)::int into prepared from pg_prepared_statements
   where name like 'sales_repo_%';

  -- Guarding the guard. Were a prepare above ever renamed or dropped, the
  -- executions in 13b and 13c would fail one at a time with a confusing error
  -- about a missing statement, and the drift check in backend would fail for a
  -- reason that looked like the repository's. This names the real fault first.
  if prepared <> 24 then
    raise exception 'ASSERT 13a: % sales_repo_* statements are prepared, expected 24; one was renamed, dropped, or added without the other two being updated', prepared;
  end if;

  raise notice 'ASSERT 13a passed: all 24 sales-repository statements parse against the migrated schema';
end $$;

-- How 13b and 13c execute those statements rather than copies of them.
--
-- pg_prepared_statements.statement holds the whole `prepare <name> as <text>`,
-- not just <text>, so running it as-is prepares the statement a second time and
-- fails with "already exists". Stripping the prefix leaves the statement the
-- repository emits, which plpgsql can then run with EXECUTE ... USING: real
-- bound parameters, no text built by concatenation, and nothing here to drift
-- from the code that ships.
create function harness_repo_sql(prepared_name text) returns text
  language sql stable
  as $$
    select regexp_replace(statement, '^prepare\s+\S+\s+as\s+', '')
      from pg_prepared_statements
     where name = prepared_name;
  $$;

-- 13b. The seven-step write path, end to end, in one atomic block.
--
--      A `do` block is one statement, so it is all-or-nothing in the way
--      withTransaction is: the advisory lock taken in the first step is held for
--      the whole of it and released when it ends, which is exactly the property
--      the receipt numbering depends on and exactly the property it loses when
--      called on the pool instead of a client.
--
--      The basket is two packs of ten out of a product holding five units in an
--      early lot and twenty in a later one, so the path has to split the line
--      across two batches and empty one of them. That is the ordinary case, not
--      an edge: it is what makes the junction two rows, the ledger two entries,
--      and the void a restore to two different lots.
do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  seeded_owner constant uuid := 'a0000000-0000-4000-8000-000000000002';
  client_sale_id constant text := 'harness-s13-client-1';

  product uuid;
  lot_early uuid;
  lot_late uuid;
  sale uuid;
  item uuid;
  cash_tender uuid;
  failed_tender uuid;
  momo_tender uuid;
  sale_number text;
  first_reference text;
  second_reference text;

  last_number bigint;
  n integer;
  rec record;
  listed integer;
  methods sale_payment_method[];
  derived integer;
  batch_sum integer;
  early_qty integer;
  late_qty integer;
  junction_rows integer;
  junction_units integer;
  found integer;
begin
  insert into inventory (pharmacy_id, name, code, pack_size, unit_price, vat_treatment)
  values (pharmacy, 'Harness S13 Product', 'HARNESS-S13', 10, 10.00, 'standard')
  returning id into product;

  insert into inventory_batches
    (pharmacy_id, inventory_id, lot_number, expiry_date, quantity, cost_price, received_at)
  values
    (pharmacy, product, 'LOT-S13-EARLY', current_date + 30,  5, 1.0000, now() - interval '2 days'),
    (pharmacy, product, 'LOT-S13-LATE',  current_date + 90, 20, 2.0000, now() - interval '1 day');

  select id into lot_early from inventory_batches
   where inventory_id = product and lot_number = 'LOT-S13-EARLY';
  select id into lot_late from inventory_batches
   where inventory_id = product and lot_number = 'LOT-S13-LATE';

  select quantity into derived from inventory where id = product;
  if derived <> 25 then
    raise exception 'ASSERT 13b: the fixture started with a derived quantity of %, expected 25 from its two batches; the write path below would be measuring the wrong thing', derived;
  end if;

  -- Step 0, the receipt number. The lock first, then the read of the highest
  -- number this pharmacy has issued.
  execute harness_repo_sql('sales_repo_advisory_lock')
    using 'a-and-b-chemist:sale_number:' || pharmacy::text
    into rec;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 13b: the advisory lock returned % row(s), expected 1', n;
  end if;

  execute harness_repo_sql('sales_repo_next_sale_number')
    using pharmacy, '^S-([0-9]+)$'
    into rec;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 13b: the receipt-number read returned % row(s), expected 1; coalesce over max() always answers', n;
  end if;
  last_number := rec.last_number;

  -- The padding is TypeScript's and not SQL's, so this line is a copy of a
  -- formatting rule rather than of a statement; backend's repository suite pins
  -- the same rule from '41' to 'S-000042'.
  sale_number := 'S-' || lpad((last_number + 1)::text, 6, '0');
  if sale_number !~ '^S-[0-9]{6}$' then
    raise exception 'ASSERT 13b: the receipt number came out as %, which is not a shape a pharmacist can read aloud and write into a paper book', sale_number;
  end if;
  -- And it is S-000001 rather than S-000002, because section 10 left a sale in
  -- this table numbered HARNESS-SALE-1. Numbering from count(*) would have
  -- counted that row; numbering from the highest number matching the pattern
  -- skips it, which is what keeps the harness's own rows from causing a
  -- duplicate receipt the day it runs.
  if sale_number <> 'S-000001' then
    raise exception 'ASSERT 13b: the first receipt of a fresh database numbered %, expected S-000001; a row whose number does not match the pattern has been counted', sale_number;
  end if;

  -- The write path asks before it stores a patient id, because a missing one
  -- arrives as 23503 and a foreign-key violation is a bare 500 that names no
  -- field. Zero rows is the answer and not an error.
  execute harness_repo_sql('sales_repo_patient_exists')
    using pharmacy, 'a0000000-0000-4000-8000-000000000060'::uuid
    into rec;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'ASSERT 13b: patient_exists found % row(s) for a uuid nobody inserted, expected 0', n;
  end if;

  -- Step 1, the sale row. Twenty-one parameters, and this is the statement
  -- section 6 exists for.
  execute harness_repo_sql('sales_repo_insert_sale')
    using pharmacy,
          sale_number,
          'pending'::sale_status,
          seeded_owner,
          null::uuid,
          null::uuid,
          200.00::numeric,
          0.00::numeric,
          null::text,
          30.00::numeric,
          5.00::numeric,
          5.00::numeric,
          40.00::numeric,
          240.00::numeric,
          0.00::numeric,
          0.00::numeric,
          0.1500::numeric,
          0.0250::numeric,
          0.0250::numeric,
          false,
          client_sale_id
    into rec;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 13b: insert into sales returned % row(s), expected 1', n;
  end if;
  sale := rec.id;

  -- The idempotency read, which is what makes a response lost in flight unable
  -- to double-sell: the offline queue replays this client id and finds the sale
  -- it already wrote.
  execute harness_repo_sql('sales_repo_find_sale_by_client_sale_id')
    using pharmacy, client_sale_id
    into rec;
  get diagnostics n = row_count;
  if n <> 1 or rec.id <> sale then
    raise exception 'ASSERT 13b: the idempotency read returned % row(s) for the client id just written, expected the sale it wrote', n;
  end if;

  execute harness_repo_sql('sales_repo_lock_sale') using pharmacy, sale into rec;
  get diagnostics n = row_count;
  if n <> 1 or rec.status::text <> 'pending' then
    raise exception 'ASSERT 13b: the lock read % row(s) with status %, expected one pending sale', n, rec.status;
  end if;

  -- Step 2, the line. Two selling units of a pack of ten, priced per selling
  -- unit at 100.00 while inventory.unit_price stays 10.00 per tablet.
  execute harness_repo_sql('sales_repo_insert_sale_item')
    using sale,
          product,
          'Harness S13 Product',
          'pack'::sell_unit,
          2,
          100.00::numeric,
          200.00::numeric,
          0.00::numeric,
          200.00::numeric,
          30.00::numeric,
          5.00::numeric,
          5.00::numeric,
          240.00::numeric,
          'standard'::vat_treatment
    into rec;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 13b: insert into sale_items returned % row(s), expected 1', n;
  end if;
  item := rec.id;

  -- Step 3, the batch decrement, and step 4, the lot snapshot. Twenty base
  -- units: five from the lot that expires first, which empties it, and fifteen
  -- from the next one.
  execute harness_repo_sql('sales_repo_insert_sale_item_batch')
    using item, lot_early, 5, 1.0000::numeric;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 13b: the junction took % row(s) for the early lot, expected 1', n;
  end if;
  execute harness_repo_sql('sales_repo_insert_sale_item_batch')
    using item, lot_late, 15, 2.0000::numeric;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 13b: the junction took % row(s) for the later lot, expected 1', n;
  end if;

  update inventory_batches set quantity = 0 where id = lot_early;
  update inventory_batches set quantity = 5 where id = lot_late;

  -- Step 5, the ledger. One entry per draw, signed, and tied to the sale so
  -- "what did this receipt do to the shelf" has an answer without anybody
  -- matching timestamps.
  insert into stock_movements
    (pharmacy_id, inventory_id, batch_id, sale_id, movement_type,
     quantity_change, quantity_after, reason, note, performed_by)
  values
    (pharmacy, product, lot_early, sale, 'sale', -5,  0, null, 'Harness 13b', seeded_owner),
    (pharmacy, product, lot_late,  sale, 'sale', -15, 5, null, 'Harness 13b', seeded_owner);

  -- Stock moved through the trigger, which is the acceptance line and the part
  -- no mocked suite can witness. `inventory.quantity` is derived and recomputed
  -- from `inventory_batches` by touch_inventory_after_batch_change, so nothing
  -- in the write path sets it and nothing has to: a sale that wrote it directly
  -- would be silently overwritten and the drawer and the shelf would disagree
  -- with no error raised anywhere.
  select quantity into derived from inventory where id = product;
  select coalesce(sum(quantity), 0)::int into batch_sum
    from inventory_batches where inventory_id = product;
  if derived <> 5 or batch_sum <> 5 then
    raise exception 'ASSERT 13b: after a sale of 20 base units the product shows % and its batches hold %, expected 5 and 5', derived, batch_sum;
  end if;
  select quantity into early_qty from inventory_batches where id = lot_early;
  select quantity into late_qty from inventory_batches where id = lot_late;
  if early_qty <> 0 or late_qty <> 5 then
    raise exception 'ASSERT 13b: FEFO drew to %/%, expected 0/5; the earlier lot must be emptied before the later one is touched', early_qty, late_qty;
  end if;

  -- Read back with the repository's own statement, because the junction is what
  -- makes a void safe and a recall answerable.
  junction_rows := 0;
  junction_units := 0;
  for rec in execute harness_repo_sql('sales_repo_list_sale_item_batches') using sale loop
    junction_rows := junction_rows + 1;
    junction_units := junction_units + rec.quantity;
  end loop;
  -- Two selling units on the line and twenty base units in the junction. Both
  -- figures are correct and they are not the same unit: the receipt says two
  -- packs, the drawer lost twenty tablets. Mixing them is a stock error nobody
  -- can see, because each number looks plausible on its own.
  if junction_rows <> 2 or junction_units <> 20 then
    raise exception 'ASSERT 13b: the lot junction held % row(s) totalling % base unit(s), expected 2 rows and 20 units for a line of 2 packs of ten', junction_rows, junction_units;
  end if;

  -- Steps 6 and 7, the tenders and the settlement. A split payment: cash at the
  -- drawer for part, and a mobile money charge for the rest that the gateway
  -- first declines and then accepts on a second reference.
  --
  -- `clock_timestamp()` and not `now()`, for the reason migration 0002 exists:
  -- `now()` is transaction-start time, and this whole block is one transaction,
  -- so every tender would carry an identical paid_at and `order by created_at`
  -- in list_sale_payments would have nothing to order by. The tenders below are
  -- written in a sequence that matters -- cash, declined, retried, settled --
  -- and 13c asserts that sequence by position.
  execute harness_repo_sql('sales_repo_insert_sale_payment')
    using sale, 'cash'::sale_payment_method, 'succeeded'::sale_payment_status,
          40.00::numeric, 'Drawer note 12', null::jsonb, clock_timestamp()::timestamptz
    into rec;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 13b: the cash tender wrote % row(s), expected 1', n;
  end if;
  cash_tender := rec.id;

  first_reference := sale_number || '-5A13B7C9D0E2F4A6';
  execute harness_repo_sql('sales_repo_insert_sale_payment')
    using sale, 'momo'::sale_payment_method, 'pending'::sale_payment_status,
          200.00::numeric, first_reference, null::jsonb, null::timestamptz
    into rec;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 13b: the first mobile money tender wrote % row(s), expected 1', n;
  end if;
  failed_tender := rec.id;

  -- The gateway declines, and `paid_at` is cleared rather than left holding a
  -- time at which no money arrived.
  execute harness_repo_sql('sales_repo_update_payment_status_paid_at')
    using failed_tender, 'failed'::sale_payment_status, null::timestamptz,
          array['pending']::sale_payment_status[]
    into rec;
  get diagnostics n = row_count;
  if n <> 1 or rec.status::text <> 'failed' then
    raise exception 'ASSERT 13b: declining the charge moved % row(s) to status %, expected 1 row to failed', n, rec.status;
  end if;

  second_reference := sale_number || '-7C25E9A1B3D4F608';
  execute harness_repo_sql('sales_repo_insert_sale_payment')
    using sale, 'momo'::sale_payment_method, 'pending'::sale_payment_status,
          200.00::numeric, second_reference, null::jsonb, null::timestamptz
    into rec;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 13b: the retried tender wrote % row(s), expected 1', n;
  end if;
  momo_tender := rec.id;

  -- The webhook that settles it, carrying the gateway's own payload into the
  -- jsonb column that exists to hold it verbatim.
  execute harness_repo_sql('sales_repo_update_payment_status_both')
    using momo_tender,
          'succeeded'::sale_payment_status,
          '{"status":"success","data":{"reference":"HARNESS-CHARGE-1"}}'::jsonb,
          clock_timestamp()::timestamptz,
          array['pending']::sale_payment_status[]
    into rec;
  get diagnostics n = row_count;
  if n <> 1 or rec.status::text <> 'succeeded' then
    raise exception 'ASSERT 13b: the first webhook moved % row(s) to status %, expected 1 row to succeeded', n, rec.status;
  end if;

  -- The same webhook delivered again, which Paystack does routinely. Zero rows
  -- is the answer and not an error: a tender that succeeded and is re-marked
  -- pending by a delayed retry would undo a settlement the drawer has felt.
  execute harness_repo_sql('sales_repo_update_payment_status_gateway')
    using momo_tender, 'pending'::sale_payment_status, null::jsonb,
          array['pending']::sale_payment_status[]
    into rec;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'ASSERT 13b: a repeated webhook moved % row(s), expected 0; the status guard in the WHERE clause has no teeth', n;
  end if;

  -- The tender the webhook was about, read by the reference it arrived with.
  execute harness_repo_sql('sales_repo_find_sale_payment_by_reference')
    using second_reference into rec;
  get diagnostics n = row_count;
  if n <> 1 or rec.id <> momo_tender then
    raise exception 'ASSERT 13b: the reference lookup returned % row(s), expected the tender that was just settled', n;
  end if;
  if rec.pharmacy_id <> pharmacy or rec.sale_status::text <> 'pending' then
    raise exception 'ASSERT 13b: the unscoped lookup did not bring the pharmacy and the sale status back with the row';
  end if;

  execute harness_repo_sql('sales_repo_find_sale_payment')
    using pharmacy, cash_tender into rec;
  get diagnostics n = row_count;
  if n <> 1 or rec.method::text <> 'cash' then
    raise exception 'ASSERT 13b: the scoped tender read returned % row(s) for method %, expected the cash tender', n, rec.method;
  end if;

  -- Step 7, the settlement: what has been paid and what the sale now is, in one
  -- statement, because they are one fact.
  execute harness_repo_sql('sales_repo_update_sale_settlement')
    using sale, 240.00::numeric, 0.00::numeric, 'completed'::sale_status
    into rec;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 13b: the settlement moved % row(s), expected 1', n;
  end if;
  if rec.status::text <> 'completed' or rec.amount_paid <> 240.00 then
    raise exception 'ASSERT 13b: the settled sale reads % paid of %, expected completed at 240.00', rec.status, rec.amount_paid;
  end if;
  -- The rates travelled with the sale, which is the whole of the snapshot: the
  -- receipt shows the tax that was charged and not whatever the rates are on
  -- the day somebody reprints it.
  if rec.vat_rate <> 0.1500 or rec.nhil_rate <> 0.0250 or rec.getfund_rate <> 0.0250 then
    raise exception 'ASSERT 13b: the stored rates read %/%/%, expected 0.1500/0.0250/0.0250', rec.vat_rate, rec.nhil_rate, rec.getfund_rate;
  end if;

  execute harness_repo_sql('sales_repo_find_sale_by_id') using pharmacy, sale into rec;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 13b: find_sale_by_id returned % row(s) for a sale seven statements had just written, expected 1', n;
  end if;

  listed := 0;
  for rec in execute harness_repo_sql('sales_repo_list_sale_items') using sale loop
    listed := listed + 1;
    if rec.quantity <> 2 or rec.unit_price <> 100.00 then
      raise exception 'ASSERT 13b: the line read back as % unit(s) at %, expected 2 packs at 100.00', rec.quantity, rec.unit_price;
    end if;
  end loop;
  if listed <> 1 then
    raise exception 'ASSERT 13b: list_sale_items returned % row(s) for a one-line sale', listed;
  end if;

  listed := 0;
  for rec in execute harness_repo_sql('sales_repo_list_sale_payments') using sale loop
    listed := listed + 1;
    if rec.id = momo_tender and rec.gateway_response is null then
      raise exception 'ASSERT 13b: the gateway payload was not stored; a dispute would be answered from memory rather than from evidence';
    end if;
  end loop;
  if listed <> 3 then
    raise exception 'ASSERT 13b: list_sale_payments returned % tender(s), expected the 3 written', listed;
  end if;

  -- The history list, both shapes. One row for a sale with three tenders, which
  -- is the property the aggregation exists for: a join would have produced three
  -- rows and `limit` would then cut through the middle of one sale's payments.
  -- The aggregate counts every tender written including the declined one, which
  -- is part of the sale's history even though it is not part of its money.
  found := 0;
  for rec in execute harness_repo_sql('sales_repo_list_sales_status')
       using pharmacy, 'completed'::sale_status, 50, 0 loop
    if rec.id = sale then
      found := 1;
      listed := rec.item_count;
      methods := rec.payment_methods;
    end if;
  end loop;
  if found <> 1 then
    raise exception 'ASSERT 13b: the sale did not appear in the history list filtered to completed';
  end if;
  if listed <> 1 then
    raise exception 'ASSERT 13b: the history list reported % line(s) for a one-line sale', listed;
  end if;
  if methods is null or array_length(methods, 1) <> 3 then
    raise exception 'ASSERT 13b: the history list reported % as the tenders, expected the 3 written for one sale on one row', methods;
  end if;

  found := 0;
  for rec in execute harness_repo_sql('sales_repo_list_sales_plain')
       using pharmacy, 50, 0 loop
    if rec.id = sale then found := 1; end if;
  end loop;
  if found <> 1 then
    raise exception 'ASSERT 13b: the unfiltered history list did not contain the sale';
  end if;

  -- The widest shape, run and not merely parsed, because only running it proves
  -- the date arithmetic. A range closing today has to include a sale made
  -- today: `created_at <= '2026-09-04'` is midnight at the start of the day and
  -- would drop every sale in it, which reads as a slow day rather than as a bug.
  found := 0;
  for rec in execute harness_repo_sql('sales_repo_list_sales_all')
       using pharmacy, 'completed'::sale_status, seeded_owner,
             current_date::text, current_date::text,
             '%' || sale_number || '%', 50, 0 loop
    if rec.id = sale then found := 1; end if;
  end loop;
  if found <> 1 then
    raise exception 'ASSERT 13b: a sale made today was not found by a date range closing today; the closing bound is not widened to the whole day';
  end if;

  raise notice 'ASSERT 13b passed: receipt numbering, the seven-step write path, FEFO across two lots, stock moved through the trigger, a split payment with a declined charge, and the settlement';
end $$;

-- 13c. The void, which is the other half of the acceptance line and the reason
--      sale_item_batches exists at all.
--
--      It re-finds the sale by its client id rather than carrying 13b's
--      variables across, for the same reason 13b numbered the receipt from the
--      table instead of from a counter: a block that only passes because the
--      block before it left a variable set is not testing the schema. What this
--      one needs, it reads.
--
--      Four things are being proved here and they are different things:
--
--      1. stock goes back to the batches it came out of, one row per draw, and
--         not onto the product row or onto whichever batch is first;
--      2. the void is idempotent at the statement level, so a double-click on
--         the till cannot restore the same twenty tablets twice;
--      3. the two guarded statements are mutually exclusive -- a settlement
--         cannot land on a sale that has been voided, which is the property that
--         makes "the drawer and the shelf disagree" unreachable rather than
--         merely unlikely;
--      4. a tender that already succeeded is reversed and one that never
--         succeeded is left alone.
do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  seeded_owner constant uuid := 'a0000000-0000-4000-8000-000000000002';
  client_sale_id constant text := 'harness-s13-client-1';

  sale uuid;
  sale_number text;
  product uuid;
  lot_early uuid;
  lot_late uuid;

  n integer;
  rec record;
  i integer;
  restored_qty integer;
  derived integer;
  early_qty integer;
  late_qty integer;
  net_movement integer;

  batch_ids uuid[];
  batch_units integer[];
  batch_products uuid[];
  tender_ids uuid[];
  tender_statuses text[];
  reversals integer;
  reversed_seen integer;
  failed_seen integer;
begin
  execute harness_repo_sql('sales_repo_find_sale_by_client_sale_id')
    using pharmacy, client_sale_id
    into rec;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 13c: the sale 13b wrote could not be found by its client id, so there is nothing to void';
  end if;
  sale := rec.id;
  sale_number := rec.sale_number;
  if rec.status::text <> 'completed' or rec.amount_paid <> 240.00 then
    raise exception 'ASSERT 13c: the sale to void reads % with % paid, expected the completed sale 13b settled', rec.status, rec.amount_paid;
  end if;

  -- The junction, read before anything is written back. This is the whole of
  -- the mechanism: two rows saying five units came out of one lot and fifteen
  -- out of the other. Without it the only available answer is "put twenty back
  -- somewhere", and putting twenty into the first lot would give it a stock it
  -- never held and leave the second one short by fifteen.
  for rec in execute harness_repo_sql('sales_repo_list_sale_item_batches') using sale loop
    batch_ids := array_append(batch_ids, rec.batch_id);
    batch_units := array_append(batch_units, rec.quantity);
    batch_products := array_append(batch_products, rec.inventory_id);
    if rec.lot_number = 'LOT-S13-EARLY' then
      lot_early := rec.batch_id;
    elsif rec.lot_number = 'LOT-S13-LATE' then
      lot_late := rec.batch_id;
    end if;
  end loop;
  if array_length(batch_ids, 1) <> 2 or lot_early is null or lot_late is null then
    raise exception 'ASSERT 13c: the junction yielded % row(s) across % distinct lot(s), expected the two lots 13b drew from', coalesce(array_length(batch_ids, 1), 0), (select count(distinct b) from unnest(batch_ids) as b);
  end if;
  product := batch_products[1];

  -- The void itself.
  execute harness_repo_sql('sales_repo_mark_sale_voided')
    using sale, 'Customer walked out before collection', clock_timestamp()::timestamptz
    into rec;
  get diagnostics n = row_count;
  if n <> 1 or rec.status::text <> 'voided' then
    raise exception 'ASSERT 13c: the void moved % row(s) to status %, expected 1 row to voided', n, rec.status;
  end if;
  -- amount_paid and change_given are zeroed in the same statement, and that is
  -- a takings rule rather than a tidiness one: a day's takings is
  -- sum(amount_paid) over sales, and a voided sale left holding 240.00 would be
  -- counted in it. The report would balance against nothing and nobody would
  -- notice until the drawer was short.
  if rec.amount_paid <> 0 or rec.change_given <> 0 then
    raise exception 'ASSERT 13c: the voided sale still reads % paid and % in change; a takings report would count money that was given back', rec.amount_paid, rec.change_given;
  end if;
  if rec.voided_at is null or rec.void_reason is null then
    raise exception 'ASSERT 13c: the void did not record when or why, which is the part an inspector asks for';
  end if;

  -- A second press of the same button. Zero rows is the answer, and it is the
  -- answer that makes the restore loop below safe to run exactly once: the
  -- service restores stock only when this statement moved a row.
  execute harness_repo_sql('sales_repo_mark_sale_voided')
    using sale, 'Pressed twice', clock_timestamp()::timestamptz
    into rec;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'ASSERT 13c: a second void moved % row(s), expected 0; the guard has no teeth and a double-click would restore the same units twice', n;
  end if;

  -- And the converse: a settlement cannot land on a sale that has been voided.
  -- Both statements carry `status <> 'voided'` and this is the assertion that
  -- they are the same guard seen from two directions, so there is no ordering of
  -- the two calls that ends with a voided sale marked paid.
  execute harness_repo_sql('sales_repo_update_sale_settlement')
    using sale, 240.00::numeric, 0.00::numeric, 'completed'::sale_status
    into rec;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'ASSERT 13c: a settlement moved % row(s) against a voided sale, expected 0; a late webhook would un-void the money', n;
  end if;

  -- Step 3 reversed: one write and one ledger entry per junction row, in the
  -- order the junction gave them. `quantity + n` and not `quantity = n`, because
  -- the batch may have been restocked since the sale and an assignment would
  -- quietly delete that delivery.
  for i in 1 .. array_length(batch_ids, 1) loop
    update inventory_batches
       set quantity = quantity + batch_units[i]
     where id = batch_ids[i]
    returning quantity into restored_qty;
    get diagnostics n = row_count;
    if n <> 1 then
      raise exception 'ASSERT 13c: restoring lot % of % moved % row(s), expected 1', i, array_length(batch_ids, 1), n;
    end if;

    insert into stock_movements
      (pharmacy_id, inventory_id, batch_id, sale_id, movement_type,
       quantity_change, quantity_after, reason, note, performed_by)
    values
      (pharmacy, batch_products[i], batch_ids[i], sale, 'void_restore',
       batch_units[i], restored_qty, 'Sale voided', 'Harness 13c', seeded_owner);
  end loop;

  -- The assertion is on the two lots separately and not on their sum. Crediting
  -- the early lot with all twenty would leave the total at 25 -- correct -- and
  -- the lots at 25/0 rather than 5/20, which is a recall answer that names the
  -- wrong batch and a cost of goods that is wrong by fifteen units at a different
  -- price. Both errors are invisible in the product total, which is exactly why
  -- the total is asserted too and asserted second.
  select quantity into early_qty from inventory_batches where id = lot_early;
  select quantity into late_qty from inventory_batches where id = lot_late;
  if early_qty <> 5 or late_qty <> 20 then
    raise exception 'ASSERT 13c: the void restored to %/%, expected 5/20 -- each lot back to what it held before the sale', early_qty, late_qty;
  end if;

  select quantity into derived from inventory where id = product;
  if derived <> 25 then
    raise exception 'ASSERT 13c: the derived product quantity reads % after the void, expected 25; nothing in this block wrote it, so the trigger either did not fire or fired on the wrong row', derived;
  end if;

  -- The ledger nets to zero for this sale, which is the property section 10
  -- claims and cannot test: stock re-derivable from movements alone. Zero rather
  -- than twenty-five, because the fixture's opening batches were inserted
  -- directly -- receiving is section 10's subject -- so the only movements here
  -- are the four this sale and its void made.
  select coalesce(sum(quantity_change), 0)::int into net_movement
    from stock_movements where inventory_id = product;
  if net_movement <> 0 then
    raise exception 'ASSERT 13c: the ledger nets to % for a product whose sale was voided, expected 0; a movement was written without its restore, or restored without its movement', net_movement;
  end if;

  -- A webhook arriving after the void still has to resolve. The charge went out
  -- and the customer's phone was debited; if the reference lookup stopped
  -- matching voided sales, that money would arrive with nowhere to land and the
  -- only evidence would be a gateway dashboard nobody at the counter can open.
  execute harness_repo_sql('sales_repo_find_sale_payment_by_reference')
    using sale_number || '-7C25E9A1B3D4F608'
    into rec;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 13c: the reference lookup returned % row(s) after the void, expected the tender that was still in flight', n;
  end if;
  if rec.pharmacy_id <> pharmacy then
    raise exception 'ASSERT 13c: the unscoped lookup did not bring a pharmacy back with the row, so the caller cannot tell whose sale it just found';
  end if;
  if rec.sale_status::text <> 'voided' then
    raise exception 'ASSERT 13c: the lookup reported the sale as %, expected voided; the webhook handler has to be able to see that and refund rather than settle', rec.sale_status;
  end if;

  -- Reverse what succeeded and only what succeeded. The filter is the statement's
  -- own guard and not an `if` around it: the same call is made against all three
  -- tenders and the count that comes back is the assertion.
  for rec in execute harness_repo_sql('sales_repo_list_sale_payments') using sale loop
    tender_ids := array_append(tender_ids, rec.id);
    tender_statuses := array_append(tender_statuses, rec.status::text);
  end loop;
  if array_length(tender_ids, 1) <> 3 then
    raise exception 'ASSERT 13c: the voided sale has % tender(s), expected the 3 13b wrote', coalesce(array_length(tender_ids, 1), 0);
  end if;
  -- Named before it is changed, so the count below is a statement about the
  -- fixture and not about whatever 13b happened to leave. In created_at order:
  -- the cash tender at the drawer, the charge the gateway declined, and the
  -- retry that settled.
  if tender_statuses <> array['succeeded', 'failed', 'succeeded'] then
    raise exception 'ASSERT 13c: the tenders before reversal read %, expected {succeeded,failed,succeeded}', tender_statuses;
  end if;

  reversals := 0;
  for i in 1 .. array_length(tender_ids, 1) loop
    execute harness_repo_sql('sales_repo_update_payment_status_only')
      using tender_ids[i], 'reversed'::sale_payment_status,
            array['succeeded']::sale_payment_status[]
      into rec;
    get diagnostics n = row_count;
    reversals := reversals + n;
  end loop;
  -- Two of the three: the cash tender and the mobile money charge that settled.
  -- Reversing the declined one as well would say money went back that never
  -- arrived, and a refund against a failed charge is a real movement of real
  -- money out of the pharmacy's account.
  if reversals <> 2 then
    raise exception 'ASSERT 13c: the void reversed % tender(s), expected exactly the 2 that succeeded', reversals;
  end if;

  -- Read back, because a count of rows moved is not the same fact as a count of
  -- tenders in the right state: the same call made twice against one tender
  -- would move one row the first time and none the second, and only this read
  -- distinguishes that from two tenders reversing.
  reversed_seen := 0;
  failed_seen := 0;
  for rec in execute harness_repo_sql('sales_repo_list_sale_payments') using sale loop
    if rec.status::text = 'reversed' then
      reversed_seen := reversed_seen + 1;
    elsif rec.status::text = 'failed' then
      failed_seen := failed_seen + 1;
    else
      raise exception 'ASSERT 13c: a tender reads % after the void, expected reversed if it succeeded and failed if it never did', rec.status;
    end if;
  end loop;
  if reversed_seen <> 2 or failed_seen <> 1 then
    raise exception 'ASSERT 13c: after the void the tenders read % reversed and % still failed, expected 2 and 1', reversed_seen, failed_seen;
  end if;

  raise notice 'ASSERT 13c passed: the void restored % unit(s) to the % batches they came out of, the trigger re-derived the product total, a second void and a late settlement both moved nothing, and % of 3 tenders were reversed',
    (select sum(u) from unnest(batch_units) as u), array_length(batch_ids, 1), reversals;
end $$;

-- 13a's statements, released. Section 13b and 13c executed them rather than
-- copies of them, so the prepares outlived the parse check that section 10a's
-- did not; they are dropped here instead, at the end, for the reason the whole
-- harness is throwaway: a session that carries a statement it no longer needs
-- is a session that can be compared against the wrong one.
deallocate sales_repo_advisory_lock;
deallocate sales_repo_next_sale_number;
deallocate sales_repo_insert_sale;
deallocate sales_repo_insert_sale_item;
deallocate sales_repo_insert_sale_item_batch;
deallocate sales_repo_insert_sale_payment;
deallocate sales_repo_find_sale_by_id;
deallocate sales_repo_find_sale_by_client_sale_id;
deallocate sales_repo_patient_exists;
deallocate sales_repo_lock_sale;
deallocate sales_repo_list_sale_items;
deallocate sales_repo_list_sale_item_batches;
deallocate sales_repo_list_sale_payments;
deallocate sales_repo_list_sales_plain;
deallocate sales_repo_list_sales_status;
deallocate sales_repo_list_sales_all;
deallocate sales_repo_update_sale_settlement;
deallocate sales_repo_mark_sale_voided;
deallocate sales_repo_find_sale_payment;
deallocate sales_repo_find_sale_payment_by_reference;
deallocate sales_repo_update_payment_status_only;
deallocate sales_repo_update_payment_status_gateway;
deallocate sales_repo_update_payment_status_paid_at;
deallocate sales_repo_update_payment_status_both;

-- ---------------------------------------------------------------------------
-- 14. The patients repository's statements, and the five behaviours that decide
--     whether a patient record can be trusted:
--
--       14d  the same number written two ways is one search, and the list and
--            the count agree about how many rows that was;
--       14e  a name search with no digits in it returns the names that matched
--            and not every patient in the book;
--       14f  an edit leaves alone every column it was not asked about, and can
--            still clear one when clearing is what was asked;
--       14g  LIKE's escape character is the backslash `likePattern` assumes;
--       14h  a patient who has ever had a prescription cannot be deleted, while
--            one who has not takes their screening history with them.
--
--     14g is the assertion that was missing from section 10a. `likePattern` in
--     backend/src/repositories/inventory.repository.ts escapes `\`, `%` and `_`
--     with a backslash, and every product and sale search in the application
--     depends on that being LIKE's default escape on this server. Nothing had
--     ever executed it: Jest pins the function's output, which is a string, and
--     a string is only an escape if the engine reading it agrees.
--
--     14h is evidence rather than coverage. It is what the patients repository's
--     header cites when it says there is no delete: the two halves of the same
--     operation behave differently depending on history, and an endpoint whose
--     outcome nobody can predict from the request is not one to expose.
--
--     The prepares are kept and executed through `harness_repo_sql`, as 13b
--     does, so the statements these assertions run are the statements 14a
--     parsed and not hand-written copies of them.
-- ---------------------------------------------------------------------------

prepare patients_repo_insert as
insert into patients
   (pharmacy_id, full_name, phone, date_of_birth, gender, allergies, conditions,
    medications, notes)
values ($1, $2, $3, $4::date, $5::gender, $6::text[], $7::text[], $8::text[],
        $9)
returning id, pharmacy_id, full_name, phone, date_of_birth, gender, allergies,
          conditions, medications, notes, created_at, updated_at;

prepare patients_repo_find_by_id as
select id, pharmacy_id, full_name, phone, date_of_birth, gender, allergies,
       conditions, medications, notes, created_at, updated_at
  from patients
 where pharmacy_id = $1 and id = $2;

prepare patients_repo_list as
select id, pharmacy_id, full_name, phone, date_of_birth, gender, allergies,
       conditions, medications, notes, created_at, updated_at
  from patients
 where pharmacy_id = $1
   and ($2::text is null
        or full_name ilike $2
        or regexp_replace(coalesce(phone, ''), '[^0-9+]', '', 'g') like $3)
 order by full_name, id
 limit $4 offset $5;

prepare patients_repo_count as
select count(*)::int as n from patients
  where pharmacy_id = $1
   and ($2::text is null
        or full_name ilike $2
        or regexp_replace(coalesce(phone, ''), '[^0-9+]', '', 'g') like $3);

prepare patients_repo_update as
update patients
    set full_name = coalesce($3::text, full_name),
        allergies = coalesce($4::text[], allergies),
        conditions = coalesce($5::text[], conditions),
        medications = coalesce($6::text[], medications),
        phone = case when $7::boolean then $8::text else phone end,
        date_of_birth = case when $9::boolean then $10::date
                             else date_of_birth end,
        gender = case when $11::boolean then $12::gender else gender end,
        notes = case when $13::boolean then $14::text else notes end
  where pharmacy_id = $1 and id = $2
  returning id, pharmacy_id, full_name, phone, date_of_birth, gender, allergies,
            conditions, medications, notes, created_at, updated_at;

do $$
begin
  raise notice 'ASSERT 14a passed: every patients-repository statement parses against the migrated schema, the fourteen-parameter preserving update among them';
end $$;

do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  owner constant uuid := 'a0000000-0000-4000-8000-000000000002';
  rec record;
  n integer;
  matched integer;
  seen_a boolean;
  seen_b boolean;
  seen_c boolean;
  a_id uuid;
  b_id uuid;
  c_id uuid;
  d_id uuid;
  e_id uuid;
  inserted_updated_at timestamptz;
  prescription_id uuid;
  delete_error text;
  screenings_left integer;
begin
  -- 14b. The insert, through the repository's own statement. Three facts are
  --      being checked at once, because all three are things a cast could get
  --      wrong in a way that only shows up as a wrong value rather than an
  --      error: that the date stored is the date supplied, that an empty array
  --      is stored empty rather than null, and that the two enum-shaped casts
  --      resolve on a real write.
  execute harness_repo_sql('patients_repo_insert')
    using pharmacy,
          'Harness Amabel Osei',
          '024 123-4567',
          '1988-03-15'::date,
          'female'::gender,
          array['aspirin']::text[],
          '{}'::text[],
          array['metformin 500mg']::text[],
          'Harness note A'
    into rec;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 14b: the insert returned % row(s), expected 1', n;
  end if;
  if rec.date_of_birth::text <> '1988-03-15' then
    raise exception 'ASSERT 14b: date_of_birth stored as %, expected 1988-03-15; a date that moves a day on the way in moves it back out again, and the record then says the patient was born on a day they were not', rec.date_of_birth;
  end if;
  -- Empty, not null. `array_length('{}', 1)` is null, so the two checks below
  -- are one assertion written the only way three-valued logic allows: an empty
  -- array passes both, a null fails the first and a populated one the second.
  if rec.conditions is null then
    raise exception 'ASSERT 14b: an empty array came back as null; the column is not null, so this is the difference between no conditions recorded and no conditions known';
  end if;
  if array_length(rec.conditions, 1) is not null then
    raise exception 'ASSERT 14b: conditions came back holding % element(s), expected none', array_length(rec.conditions, 1);
  end if;
  if rec.allergies <> array['aspirin']::text[] then
    raise exception 'ASSERT 14b: allergies came back as %, expected one entry', rec.allergies;
  end if;
  a_id := rec.id;
  inserted_updated_at := rec.updated_at;

  -- 14c. The same handset written down the other way, plus three patients who
  --      must not match anything below: one with no phone at all, and two whose
  --      names differ by exactly the character 14g is about.
  execute harness_repo_sql('patients_repo_insert')
    using pharmacy,
          'Harness Kwabena Osei',
          '+233 24 123 4567',
          null::date,
          null::gender,
          '{}'::text[],
          '{}'::text[],
          '{}'::text[],
          null::text
    into rec;
  b_id := rec.id;

  execute harness_repo_sql('patients_repo_insert')
    using pharmacy,
          'Harness Silent',
          null::text,
          null::date,
          'undisclosed'::gender,
          '{}'::text[],
          '{}'::text[],
          '{}'::text[],
          null::text
    into rec;
  c_id := rec.id;

  execute harness_repo_sql('patients_repo_insert')
    using pharmacy, 'Harness A_B', null::text, null::date, null::gender,
          '{}'::text[], '{}'::text[], '{}'::text[], null::text
    into rec;
  d_id := rec.id;

  execute harness_repo_sql('patients_repo_insert')
    using pharmacy, 'Harness AXB', null::text, null::date, null::gender,
          '{}'::text[], '{}'::text[], '{}'::text[], null::text
    into rec;
  e_id := rec.id;

  -- 14d. Two patients, one number, five ways of writing it between them. The
  --      patterns are what `searchPatterns` in the repository produces for the
  --      term '+233241234567': the raw term for the name branch and the nine
  --      national digits for the phone branch. Without the regexp_replace the
  --      first patient is stored as '024 123-4567' and only the second matches,
  --      which is a search that finds a customer depending on who happened to
  --      be at the counter when their number was typed in.
  matched := 0;
  seen_a := false;
  seen_b := false;
  seen_c := false;
  for rec in execute harness_repo_sql('patients_repo_list')
    using pharmacy, '%+233241234567%', '%241234567%', 50, 0
  loop
    matched := matched + 1;
    seen_a := seen_a or rec.id = a_id;
    seen_b := seen_b or rec.id = b_id;
    seen_c := seen_c or rec.id = c_id;
  end loop;
  if matched <> 2 or not seen_a or not seen_b or seen_c then
    raise exception 'ASSERT 14d: the phone search returned % row(s), first-patient=% second-patient=% no-phone-patient=%, expected exactly the two who hold that number written two ways', matched, seen_a, seen_b, seen_c;
  end if;

  -- And the count has to say the same number. The pager reads one and the list
  -- reads the other, so a search that disagreed with itself would offer a next
  -- page and then return nothing on it.
  execute harness_repo_sql('patients_repo_count')
    using pharmacy, '%+233241234567%', '%241234567%'
    into rec;
  if rec.n <> matched then
    raise exception 'ASSERT 14d: the count said % patient(s) matched while the list returned %; the two statements share their predicate in the repository, so this is the harness saying the shared text is not shared behaviour', rec.n, matched;
  end if;

  -- 14e. A name search holds no digits, so the repository sends a null phone
  --      pattern. The assertion is that the name branch still decides the row
  --      on its own: one patient, the one whose name matched. A predicate
  --      written as `like coalesce($3, '%')` -- the obvious way to make a null
  --      pattern harmless -- returns every patient in the book here, including
  --      the one with no phone at all, because an empty string matches '%'.
  matched := 0;
  seen_a := false;
  for rec in execute harness_repo_sql('patients_repo_list')
    using pharmacy, '%Amabel%', null::text, 50, 0
  loop
    matched := matched + 1;
    seen_a := seen_a or rec.id = a_id;
  end loop;
  if matched <> 1 or not seen_a then
    raise exception 'ASSERT 14e: a name search returned % row(s) and found the named patient=%, expected exactly that one patient; a null phone pattern has to mean "no phone match", not "every phone matches"', matched, seen_a;
  end if;

  -- 14f. The preserving update. Only `notes` is supplied: the first four
  --      parameters are null and the four flags are false, so every other
  --      column has to come back as it went in. The phone flag is false while
  --      its value is a real number, which is the case that separates a flag
  --      from a coalesce -- a statement reading the value would have written it.
  execute harness_repo_sql('patients_repo_update')
    using pharmacy, a_id,
          null::text,
          null::text[],
          null::text[],
          null::text[],
          false, '020 999 8888',
          false, null::date,
          false, null::gender,
          true, 'Harness note A, edited'
    into rec;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 14f: the notes-only update returned % row(s), expected 1', n;
  end if;
  if rec.notes <> 'Harness note A, edited' then
    raise exception 'ASSERT 14f: notes came back as %, expected the edited text', rec.notes;
  end if;
  if rec.phone <> '024 123-4567' then
    raise exception 'ASSERT 14f: a notes-only edit changed the phone to %; the flag was false and the value beside it was never meant to be read', rec.phone;
  end if;
  if rec.full_name <> 'Harness Amabel Osei' then
    raise exception 'ASSERT 14f: a notes-only edit changed the name to %', rec.full_name;
  end if;
  if rec.allergies <> array['aspirin']::text[] then
    raise exception 'ASSERT 14f: a notes-only edit changed the allergies to %; this is the lost update the fourteen parameters exist to prevent', rec.allergies;
  end if;
  if rec.date_of_birth::text <> '1988-03-15' then
    raise exception 'ASSERT 14f: a notes-only edit changed the date of birth to %', rec.date_of_birth;
  end if;
  if rec.updated_at <= inserted_updated_at then
    raise exception 'ASSERT 14f: updated_at did not move (% then %), and the statement does not set it; patients_set_updated_at is what stamps it, and section 5 is the only other place that is proven', inserted_updated_at, rec.updated_at;
  end if;

  -- The other half, and the reason a flag rather than a coalesce: clearing a
  -- nullable column is a thing a form does, and coalesce cannot tell it from
  -- "not supplied".
  execute harness_repo_sql('patients_repo_update')
    using pharmacy, a_id,
          null::text, null::text[], null::text[], null::text[],
          true, null::text,
          false, null::date,
          false, null::gender,
          false, null::text
    into rec;
  if rec.phone is not null then
    raise exception 'ASSERT 14f: clearing the phone left %; a patch that cannot remove a wrong number cannot correct one', rec.phone;
  end if;
  if rec.notes <> 'Harness note A, edited' then
    raise exception 'ASSERT 14f: clearing the phone also cleared the notes to %', rec.notes;
  end if;

  -- 14g. LIKE's escape character, executed. `likePattern` writes `\_` for an
  --      underscore and every search in the application trusts that this server
  --      reads the backslash as an escape rather than as a character. It matches
  --      the patient named with a real underscore and not the one with an X
  --      where the underscore is, which is the two outcomes that separate an
  --      escape from a literal.
  matched := 0;
  seen_a := false;
  seen_b := false;
  for rec in execute harness_repo_sql('patients_repo_list')
    using pharmacy, '%A\_B%', null::text, 50, 0
  loop
    matched := matched + 1;
    seen_a := seen_a or rec.id = d_id;
    seen_b := seen_b or rec.id = e_id;
  end loop;
  if matched <> 1 or not seen_a or seen_b then
    raise exception 'ASSERT 14g: an escaped underscore matched % row(s), the literal-underscore patient=% and the lookalike=%; expected one and one. If this fails, likePattern is writing an escape this server does not honour and every search in the application is wider than it looks', matched, seen_a, seen_b;
  end if;

  -- 14h. The two halves of a delete, and why the repository offers neither.
  insert into prescriptions (pharmacy_id, patient_id, prescriber_name)
  values (pharmacy, a_id, 'Harness Prescriber')
  returning id into prescription_id;

  delete_error := null;
  begin
    delete from patients where id = a_id;
  exception
    when others then
      delete_error := sqlstate;
  end;
  -- `is distinct from` and not `<>`: a delete that succeeded leaves the
  -- variable null, and `null <> '23503'` is null, which an `if` reads as false
  -- and the assertion would pass on exactly the outcome it exists to refuse.
  if delete_error is distinct from '23503' then
    raise exception 'ASSERT 14h: deleting a patient who has a prescription raised %, expected 23503; prescriptions.patient_id carries no on delete clause, so this is the schema refusing rather than the application deciding', coalesce(delete_error, 'nothing at all');
  end if;

  execute harness_repo_sql('patients_repo_find_by_id') using pharmacy, a_id into rec;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 14h: the refused delete left % row(s) behind, expected the patient still there; the nested block above is an implicit savepoint, so the failure has to undo only itself', n;
  end if;

  insert into screenings (pharmacy_id, patient_id, recorded_by, type, heart_rate_bpm)
  values (pharmacy, c_id, owner, 'heart_rate', 72);

  delete from patients where id = c_id;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'ASSERT 14h: deleting a patient with no prescription moved % row(s), expected 1', n;
  end if;
  select count(*)::int into screenings_left from screenings where patient_id = c_id;
  if screenings_left <> 0 then
    raise exception 'ASSERT 14h: % screening(s) survived the patient they belong to; screenings.patient_id is on delete cascade, so this is the other half of the asymmetry', screenings_left;
  end if;

  raise notice 'ASSERT 14b-14h passed: two writings of one number were one search, the list and the count agreed, a name search returned only the name that matched, a notes-only edit moved nothing else and a flagged null cleared the phone, an escaped underscore matched literally, and a delete was refused with 23503 for the patient who had a prescription and cascaded for the one who did not';
end $$;

deallocate patients_repo_insert;
deallocate patients_repo_find_by_id;
deallocate patients_repo_list;
deallocate patients_repo_count;
deallocate patients_repo_update;

-- ---------------------------------------------------------------------------
-- 15. The screenings repository's statements, and the four facts about the table
--     that the repository's shape depends on:
--
--       15b  there is no `updated_at` column at all, which is why the module
--            offers no update and is the only table in the schema with neither;
--       15c  the check constraints refuse a reading of zero, so the schema and
--            `utils/screening.ts` say the same thing about a measurement of a
--            living person;
--       15d  a closing date bound widened by one day includes the readings taken
--            during that day, and the one after it excludes them;
--       15e  an empty type array matches no row, which is why the repository
--            folds "no types" into a null parameter rather than sending `'{}`.
--
--     15d is the assertion that would be missed. `measured_at <= $5::date` parses
--     and returns rows and looks correct in every test that uses a midnight
--     timestamp, and it silently drops every reading taken during the closing day
--     of the range -- so a chart asked for March ends on the 1st. Nothing about
--     the statement is wrong; only its meaning is.
--
--     The prepares are kept and executed through `harness_repo_sql`, as 13b and
--     14 do, so the statements these assertions run are the statements 15a parsed.
-- ---------------------------------------------------------------------------

prepare screenings_repo_insert as
insert into screenings
   (pharmacy_id, patient_id, recorded_by, type, risk_level, systolic_bp,
    diastolic_bp, blood_glucose_mmol, weight_kg, height_cm, bmi, temperature_c,
    heart_rate_bpm, measured_at, notes)
values ($1, $2, $3, $4::screening_type, $5::risk_level, $6, $7, $8, $9, $10,
        $11, $12, $13, $14::timestamptz, $15)
returning id, pharmacy_id, patient_id, recorded_by, type, risk_level, systolic_bp,
          diastolic_bp, blood_glucose_mmol, weight_kg, height_cm, bmi,
          temperature_c, heart_rate_bpm, measured_at, notes, created_at;

prepare screenings_repo_list as
select id, pharmacy_id, patient_id, recorded_by, type, risk_level, systolic_bp,
       diastolic_bp, blood_glucose_mmol, weight_kg, height_cm, bmi,
       temperature_c, heart_rate_bpm, measured_at, notes, created_at
  from screenings
 where pharmacy_id = $1
   and ($2::uuid is null or patient_id = $2::uuid)
   and ($3::screening_type[] is null or type = any($3::screening_type[]))
   and ($4::date is null or measured_at >= $4::date)
   and ($5::date is null or measured_at < $5::date + interval '1 day')
 order by measured_at desc, id desc
 limit $6 offset $7;

prepare screenings_repo_latest_by_type as
select id, pharmacy_id, patient_id, recorded_by, type, risk_level, systolic_bp,
       diastolic_bp, blood_glucose_mmol, weight_kg, height_cm, bmi,
       temperature_c, heart_rate_bpm, measured_at, notes, created_at
  from screenings
 where pharmacy_id = $1
   and patient_id = $2
   and type = $3::screening_type
 order by measured_at desc, id desc
 limit 1;

do $$
begin
  raise notice 'ASSERT 15a passed: every screenings-repository statement parses against the migrated schema';
end $$;

do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  owner constant uuid := 'a0000000-0000-4000-8000-000000000002';
  rec record;
  n integer;
  matched integer;
  seen_march integer;
  patient_one uuid;
  patient_two uuid;
  late_glucose uuid;
  next_day_pulse uuid;
  constraint_error text;
  first_order uuid;
  second_order uuid;
begin
  insert into patients (pharmacy_id, full_name)
  values (pharmacy, 'Harness Screening One') returning id into patient_one;
  insert into patients (pharmacy_id, full_name)
  values (pharmacy, 'Harness Screening Two') returning id into patient_two;

  -- 15b. The column is absent, not merely unset. This is the evidence behind the
  --      screenings repository having no update function: a measurement is a fact
  --      about a moment, and a table that cannot stamp a revision cannot be
  --      revised honestly. Asserted against information_schema rather than
  --      assumed from reading init.sql, because the two are exactly the things
  --      that drift.
  select count(*)::int into n
    from information_schema.columns
   where table_name = 'screenings' and column_name = 'updated_at';
  if n <> 0 then
    raise exception 'ASSERT 15b: screenings has an updated_at column; if it was added, the set_updated_at trigger has to come with it and the repository has to stop pretending a reading cannot be edited';
  end if;
  select count(*)::int into n
    from information_schema.columns
   where table_name = 'screenings' and column_name = 'created_at';
  if n <> 1 then
    raise exception 'ASSERT 15b: screenings has % created_at column(s), expected 1; a row with no record of when it was written cannot be ordered against the readings beside it', n;
  end if;

  -- 15c. The schema's own opinion about a reading of zero. `utils/screening.ts`
  --      refuses `<= 0` in the application so the answer is a sentence about a
  --      field rather than a database error, and this is the other half: if the
  --      application ever stopped refusing, the column would. Two guards on one
  --      rule is not redundancy when the rule is about a person's body.
  constraint_error := null;
  begin
    execute harness_repo_sql('screenings_repo_insert')
      using pharmacy, patient_one, owner,
            'blood_pressure'::screening_type, 'high'::risk_level,
            0, 90,
            null::numeric, null::numeric, null::numeric, null::numeric,
            null::numeric, null::integer,
            '2026-03-01T08:00:00Z'::timestamptz, null::text;
  exception
    when others then
      constraint_error := sqlstate;
  end;
  -- `is distinct from` and not `<>`: an insert that succeeded leaves the variable
  -- null, and `null <> '23514'` is null, which an `if` reads as false and the
  -- assertion would pass on exactly the outcome it exists to refuse.
  if constraint_error is distinct from '23514' then
    raise exception 'ASSERT 15c: a systolic of zero was accepted with %, expected 23514 from the check constraint; the schema and the classifier would then disagree about what a measurement is', coalesce(constraint_error, 'no error at all');
  end if;

  -- The fixture the rest of the section reads. Four rows for patient one and one
  -- for patient two, with the timestamps chosen to sit either side of a day
  -- boundary: the late glucose is inside 2026-03-15 at 23:00 and the next day's
  -- pulse is outside it at 00:30 on the 16th.
  execute harness_repo_sql('screenings_repo_insert')
    using pharmacy, patient_one, owner,
          'blood_pressure'::screening_type, 'high'::risk_level,
          148, 92,
          null::numeric, null::numeric, null::numeric, null::numeric,
          null::numeric, null::integer,
          '2026-03-01T08:00:00Z'::timestamptz, 'Harness first reading'
    into rec;
  if rec.risk_level::text <> 'high' then
    raise exception 'ASSERT 15c: a derived risk level of high stored as %', rec.risk_level;
  end if;

  execute harness_repo_sql('screenings_repo_insert')
    using pharmacy, patient_one, owner,
          'blood_pressure'::screening_type, 'moderate'::risk_level,
          128, 82,
          null::numeric, null::numeric, null::numeric, null::numeric,
          null::numeric, null::integer,
          '2026-02-01T08:00:00Z'::timestamptz, null::text
    into rec;

  execute harness_repo_sql('screenings_repo_insert')
    using pharmacy, patient_one, owner,
          'blood_sugar'::screening_type, 'moderate'::risk_level,
          null::integer, null::integer,
          7.80::numeric, null::numeric, null::numeric, null::numeric,
          null::numeric, null::integer,
          '2026-03-15T23:00:00Z'::timestamptz, null::text
    into rec;
  late_glucose := rec.id;
  -- `numeric(5, 2)` keeps both places, which is the reason the driver hands the
  -- column back as text and the reason `toNumberOrNull` has to accept a string.
  if rec.blood_glucose_mmol::text <> '7.80' then
    raise exception 'ASSERT 15c: blood_glucose_mmol stored as %, expected 7.80 with both decimal places', rec.blood_glucose_mmol;
  end if;

  execute harness_repo_sql('screenings_repo_insert')
    using pharmacy, patient_one, owner,
          'heart_rate'::screening_type, 'low'::risk_level,
          null::integer, null::integer,
          null::numeric, null::numeric, null::numeric, null::numeric,
          null::numeric, 72,
          '2026-03-16T00:30:00Z'::timestamptz, null::text
    into rec;
  next_day_pulse := rec.id;

  execute harness_repo_sql('screenings_repo_insert')
    using pharmacy, patient_two, owner,
          'blood_pressure'::screening_type, 'low'::risk_level,
          118, 76,
          null::numeric, null::numeric, null::numeric, null::numeric,
          null::numeric, null::integer,
          '2026-03-10T08:00:00Z'::timestamptz, null::text
    into rec;

  -- 15d. Every filter parameter bound to null means "no filter", and the
  --      count is taken rather than assumed: patient one has four rows and
  --      patient two has one, so an unfiltered read of the whole pharmacy has to
  --      find at least those five. Section 11k makes the same point about the
  --      notifications list; this is the same trap in a different statement.
  matched := 0;
  for rec in execute harness_repo_sql('screenings_repo_list')
    using pharmacy, null::uuid, null::screening_type[], null::date, null::date, 50, 0
  loop
    matched := matched + 1;
  end loop;
  if matched < 5 then
    raise exception 'ASSERT 15d: an unfiltered list returned % row(s), expected at least the five just written; a null filter parameter has to mean no filter, not match nothing', matched;
  end if;

  -- The day-widening, and the assertion that gives it teeth. A closing bound of
  -- `<= $5::date` would include the 23:00 glucose only by accident and would
  -- exclude every other reading taken during the 15th, so the range is asked for
  -- with the 15th as its last day and both sides of the boundary are checked.
  matched := 0;
  seen_march := 0;
  for rec in execute harness_repo_sql('screenings_repo_list')
    using pharmacy, patient_one, null::screening_type[],
          '2026-03-01'::date, '2026-03-15'::date, 50, 0
  loop
    matched := matched + 1;
    if rec.id = late_glucose then seen_march := seen_march + 1; end if;
    if rec.id = next_day_pulse then
      raise exception 'ASSERT 15d: a reading taken at 00:30 on the day after the range closed was included; the upper bound is comparing with the wrong operator or the wrong day';
    end if;
  end loop;
  -- Two rows: the blood pressure taken at 08:00 on the opening day, and the
  -- glucose taken at 23:00 on the closing one. The February reading is before the
  -- range and the 16th's pulse is after it.
  if matched <> 2 or seen_march <> 1 then
    raise exception 'ASSERT 15d: a range closing on 2026-03-15 returned % row(s) of which % was the reading taken at 23:00 that day, expected 2 and 1; a closing bound that means midnight at the start of the day drops everything measured during it', matched, seen_march;
  end if;

  -- 15e. The empty array, executed rather than reasoned about. `type = any('{}')`
  --      is valid SQL that matches no row, so a caller who passed an empty list
  --      straight through would draw an empty chart for a patient with a full
  --      history -- and an empty chart is indistinguishable from a patient who
  --      has never been screened. This is why `listScreenings` folds an empty
  --      array into a null parameter.
  matched := 0;
  for rec in execute harness_repo_sql('screenings_repo_list')
    using pharmacy, patient_one, '{}'::screening_type[], null::date, null::date, 50, 0
  loop
    matched := matched + 1;
  end loop;
  if matched <> 0 then
    raise exception 'ASSERT 15e: an empty type array matched % row(s), expected none; the repository relies on this to justify turning an empty list into a null', matched;
  end if;
  -- And one type in the array is a filter rather than an absence of one.
  matched := 0;
  for rec in execute harness_repo_sql('screenings_repo_list')
    using pharmacy, patient_one, array['blood_pressure'::screening_type],
          null::date, null::date, 50, 0
  loop
    matched := matched + 1;
    if rec.type::text <> 'blood_pressure' then
      raise exception 'ASSERT 15e: a single-type filter returned a row of type %', rec.type;
    end if;
  end loop;
  if matched <> 2 then
    raise exception 'ASSERT 15e: a blood_pressure filter returned % row(s), expected the two written for this patient', matched;
  end if;

  -- The newest reading of one type, ignoring the others. Patient one has two
  -- blood pressures and one glucose; the blood pressure asked for is the March
  -- one, and the glucose is not returned even though it is more recent than the
  -- February blood pressure.
  execute harness_repo_sql('screenings_repo_latest_by_type')
    using pharmacy, patient_one, 'blood_pressure'::screening_type
    into rec;
  get diagnostics n = row_count;
  if n <> 1 or rec.measured_at <> '2026-03-01T08:00:00Z'::timestamptz then
    raise exception 'ASSERT 15e: the latest blood pressure returned % row(s) measured at %, expected the one taken on 2026-03-01; this is the reading a trend is drawn against', n, rec.measured_at;
  end if;
  if rec.systolic_bp <> 148 or rec.diastolic_bp <> 92 then
    raise exception 'ASSERT 15e: the latest blood pressure came back as %/%, expected 148/92', rec.systolic_bp, rec.diastolic_bp;
  end if;

  execute harness_repo_sql('screenings_repo_latest_by_type')
    using pharmacy, patient_two, 'blood_sugar'::screening_type
    into rec;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'ASSERT 15e: a patient with no glucose reading returned % row(s), expected none; a null here is what lets the UI say "no previous reading" instead of showing a blank', n;
  end if;

  -- Two readings of one type at one instant, so the `id desc` tie-break is the
  -- only thing deciding their order. Read twice, and required to answer the same
  -- way both times: a list that reorders itself between two loads of the same
  -- page is a list nobody can read carefully, and a chart whose points swap
  -- places is a trend that is not there.
  insert into screenings (pharmacy_id, patient_id, recorded_by, type, risk_level,
                          weight_kg, measured_at)
  values (pharmacy, patient_one, owner, 'weight', 'low', 68.50, '2026-03-20T09:00:00Z');
  insert into screenings (pharmacy_id, patient_id, recorded_by, type, risk_level,
                          weight_kg, measured_at)
  values (pharmacy, patient_one, owner, 'weight', 'low', 68.20, '2026-03-20T09:00:00Z');

  first_order := null;
  second_order := null;
  for rec in execute harness_repo_sql('screenings_repo_list')
    using pharmacy, patient_one, array['weight'::screening_type],
          null::date, null::date, 50, 0
  loop
    if first_order is null then first_order := rec.id; end if;
  end loop;
  for rec in execute harness_repo_sql('screenings_repo_list')
    using pharmacy, patient_one, array['weight'::screening_type],
          null::date, null::date, 50, 0
  loop
    if second_order is null then second_order := rec.id; end if;
  end loop;
  if first_order is null or first_order <> second_order then
    raise exception 'ASSERT 15e: two readings sharing a timestamp came back in a different order on two reads (% then %); the id tie-break is what makes the order total', first_order, second_order;
  end if;

  raise notice 'ASSERT 15b-15e passed: screenings has no updated_at to stamp, a systolic of zero was refused with 23514, a range closing on a day included the reading taken at 23:00 that day and excluded the one taken at 00:30 the next, an empty type array matched no row while a one-type array matched two, and the newest reading of a type ignored the readings of every other type';
end $$;

deallocate screenings_repo_insert;
deallocate screenings_repo_list;
deallocate screenings_repo_latest_by_type;

-- ---------------------------------------------------------------------------
-- 16. The consultations repository's statements, executed rather than copied.
--
-- `harness_repo_sql` reads each statement back out of pg_prepared_statements, so
-- 16b-16g run the shapes 16a parsed rather than hand-written copies of them.
--
-- What this section exists to prove is the four things a booking diary gets wrong
-- quietly: that a new consultation is `scheduled` because the *column* says so and
-- not because the code says so, since the repository's insert does not name the
-- column at all; that a guarded update which matched no row left `updated_at`
-- alone, so a refused change cannot read as a revision nobody made; that an
-- omitted nullable field means "leave it" while a supplied null means "clear it",
-- which is the distinction `coalesce` cannot make and the fourteen parameters
-- exist for; and that `conducted_by` restricts, which is one of the two reasons
-- this module offers no delete.
-- ---------------------------------------------------------------------------
prepare consultations_repo_insert as
insert into consultations
   (pharmacy_id, patient_id, conducted_by, type, scheduled_at, duration_minutes,
    video_url, notes)
values ($1, $2, $3, $4::consultation_type, $5::timestamptz, $6::integer, $7, $8)
returning id, pharmacy_id, patient_id, conducted_by, type, status, scheduled_at,
          duration_minutes, video_url, notes, created_at, updated_at;

prepare consultations_repo_find_by_id as
select id, pharmacy_id, patient_id, conducted_by, type, status, scheduled_at,
       duration_minutes, video_url, notes, created_at, updated_at
  from consultations
 where pharmacy_id = $1 and id = $2;

prepare consultations_repo_list_upcoming as
select id, pharmacy_id, patient_id, conducted_by, type, status, scheduled_at,
       duration_minutes, video_url, notes, created_at, updated_at
  from consultations
 where pharmacy_id = $1
   and ($2::uuid is null or patient_id = $2::uuid)
   and ($3::consultation_status[] is null or status = any($3::consultation_status[]))
   and ($4::uuid is null or conducted_by = $4::uuid)
   and ($5::date is null or scheduled_at >= $5::date)
   and ($6::date is null or scheduled_at < $6::date + interval '1 day')
 order by scheduled_at asc, id asc
 limit $7 offset $8;

prepare consultations_repo_list_recent as
select id, pharmacy_id, patient_id, conducted_by, type, status, scheduled_at,
       duration_minutes, video_url, notes, created_at, updated_at
  from consultations
 where pharmacy_id = $1
   and ($2::uuid is null or patient_id = $2::uuid)
   and ($3::consultation_status[] is null or status = any($3::consultation_status[]))
   and ($4::uuid is null or conducted_by = $4::uuid)
   and ($5::date is null or scheduled_at >= $5::date)
   and ($6::date is null or scheduled_at < $6::date + interval '1 day')
 order by scheduled_at desc, id desc
 limit $7 offset $8;

prepare consultations_repo_update as
update consultations
   set type = coalesce($3::consultation_type, type),
       status = coalesce($4::consultation_status, status),
       scheduled_at = coalesce($5::timestamptz, scheduled_at),
       duration_minutes = case when $6::boolean then $7::integer
                               else duration_minutes end,
       conducted_by = case when $8::boolean then $9::uuid
                           else conducted_by end,
       video_url = case when $10::boolean then $11::text
                        else video_url end,
       notes = case when $12::boolean then $13::text else notes end
 where pharmacy_id = $1
   and id = $2
   and status = any($14::consultation_status[])
returning id, pharmacy_id, patient_id, conducted_by, type, status, scheduled_at,
          duration_minutes, video_url, notes, created_at, updated_at;

do $$
begin
  raise notice 'ASSERT 16a passed: every consultations-repository statement parses against the migrated schema';
end $$;

do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  rec record;
  n integer;
  patient uuid;
  conductor uuid;
  booked uuid;
  late_evening uuid;
  next_morning uuid;
  constraint_error text;
  stamp_before timestamptz;
  stamp_after timestamptz;
  seen_late boolean;
  first_upcoming uuid;
  first_recent uuid;
begin
  -- A conductor of this section's own rather than the staff user section 9
  -- creates. 16g needs a 23503 that is attributable to `consultations`, and the
  -- section 9 user is also referenced by other tables whose foreign keys restrict
  -- just as hard -- a refusal naming `prescriptions` would prove nothing here.
  insert into users (pharmacy_id, full_name, email, phone, role, password_hash)
  values (pharmacy, 'Harness Conductor', 'harness-conductor@aandb.example', null,
          'staff', 'UNSET')
  returning id into conductor;

  insert into patients (pharmacy_id, full_name)
  values (pharmacy, 'Harness Consultation') returning id into patient;

  -- 16b. The repository's insert names eight columns and `status` is not one of
  --      them, so a booking takes the column default and a consultation cannot be
  --      created already finished. Proven rather than assumed: were the default to
  --      change, every consultation would arrive in whatever state the schema then
  --      favoured, and the guard in updateConsultation would refuse to move them.
  execute harness_repo_sql('consultations_repo_insert')
    using pharmacy, patient, conductor, 'video'::consultation_type,
          '2026-04-02T09:30:00Z'::timestamptz, 30,
          'https://meet.example/a-and-b/harness'::text, 'Harness video consultation'
    into rec;
  booked := rec.id;
  if rec.status::text <> 'scheduled' then
    raise exception 'ASSERT 16b: a consultation booked without naming a status came back %, expected the column default scheduled; the repository relies on that default and has no parameter a finished booking could arrive through', rec.status;
  end if;
  if rec.conducted_by <> conductor then
    raise exception 'ASSERT 16b: conducted_by came back %, expected the pharmacist it was booked with', rec.conducted_by;
  end if;
  if rec.duration_minutes <> 30 then
    raise exception 'ASSERT 16b: duration_minutes came back %, expected 30', rec.duration_minutes;
  end if;
  if rec.scheduled_at <> '2026-04-02T09:30:00Z'::timestamptz then
    raise exception 'ASSERT 16b: scheduled_at came back %, expected the instant it was booked for', rec.scheduled_at;
  end if;
  -- A row that has never been updated carries the same value in both stamps,
  -- because both default to now() and now() is transaction-start time. That is the
  -- baseline 16d and 16f compare against, and it is only a usable baseline because
  -- set_updated_at uses clock_timestamp() instead.
  if rec.created_at <> rec.updated_at then
    raise exception 'ASSERT 16b: a freshly inserted consultation had created_at % and updated_at %; the two diverge only when set_updated_at fires, and 16d depends on that', rec.created_at, rec.updated_at;
  end if;
  stamp_before := rec.updated_at;

  -- 16c. The schema's own opinion about a length that cannot be a length. Null is
  --      accepted and is not the same as zero: a consultation with no length given
  --      is not one that takes no time, and integerOrNull keeps the two apart in
  --      the mapper for the same reason.
  constraint_error := null;
  begin
    execute harness_repo_sql('consultations_repo_insert')
      using pharmacy, patient, null::uuid, 'phone'::consultation_type,
            '2026-04-03T09:30:00Z'::timestamptz, -5, null::text, null::text;
  exception
    when others then
      constraint_error := sqlstate;
  end;
  -- `is distinct from` and not `<>`: a statement that succeeded leaves the variable
  -- null, and `null <> '23514'` is null, which an `if` reads as false and the
  -- assertion would pass on exactly the outcome it exists to refuse.
  if constraint_error is distinct from '23514' then
    raise exception 'ASSERT 16c: a duration of -5 minutes was accepted with %, expected 23514 from the check constraint; a negative length would put an appointment before the one beside it in the diary', coalesce(constraint_error, 'no error at all');
  end if;

  execute harness_repo_sql('consultations_repo_insert')
    using pharmacy, patient, null::uuid, 'phone'::consultation_type,
          '2026-04-03T09:30:00Z'::timestamptz, null::integer, null::text, null::text
    into rec;
  if rec.duration_minutes is not null then
    raise exception 'ASSERT 16c: a consultation booked with no length came back with %, expected null; zero would say the appointment takes no time at all', rec.duration_minutes;
  end if;

  -- 16d. The guard, in both directions. First a transition it allows, which has to
  --      stamp a revision; then the same guard against a state it no longer
  --      allows, which has to change nothing at all -- including updated_at.
  execute harness_repo_sql('consultations_repo_update')
    using pharmacy, booked,
          null::consultation_type, 'completed'::consultation_status,
          null::timestamptz,
          false, null::integer, false, null::uuid, false, null::text, false, null::text,
          array['scheduled'::consultation_status]
    into rec;
  if rec.status::text <> 'completed' then
    raise exception 'ASSERT 16d: the transition from scheduled came back %, expected completed', rec.status;
  end if;
  stamp_after := rec.updated_at;
  if stamp_after = stamp_before then
    raise exception 'ASSERT 16d: a completed transition left updated_at at %; set_updated_at uses clock_timestamp() so it has to move inside one transaction, and a record that changed without saying when cannot be audited', stamp_after;
  end if;

  -- Counted with a loop rather than `into rec`, because EXECUTE ... INTO on a
  -- statement that returns no rows leaves the record null and a null field is not
  -- distinguishable from a field that was null in the row.
  n := 0;
  for rec in execute harness_repo_sql('consultations_repo_update')
    using pharmacy, booked,
          null::consultation_type, 'scheduled'::consultation_status,
          '2026-05-01T09:30:00Z'::timestamptz,
          false, null::integer, false, null::uuid, false, null::text, false, null::text,
          array['scheduled'::consultation_status]
  loop
    n := n + 1;
  end loop;
  if n <> 0 then
    raise exception 'ASSERT 16d: a reschedule guarded on status = scheduled matched % row(s) against a consultation that had already been completed; the guard reads the pre-update status, which is the only thing stopping a finished appointment from being moved to next month', n;
  end if;

  execute harness_repo_sql('consultations_repo_find_by_id')
    using pharmacy, booked
    into rec;
  if rec.id is null then
    raise exception 'ASSERT 16d: find_by_id did not return the consultation it had just updated';
  end if;
  if rec.status::text <> 'completed' then
    raise exception 'ASSERT 16d: a reschedule the guard refused still moved the status to %', rec.status;
  end if;
  if rec.scheduled_at <> '2026-04-02T09:30:00Z'::timestamptz then
    raise exception 'ASSERT 16d: a reschedule the guard refused still moved scheduled_at to %', rec.scheduled_at;
  end if;
  if rec.updated_at <> stamp_after then
    raise exception 'ASSERT 16d: an update that matched no row still stamped updated_at, from % to %; a refused change would then read as a revision somebody made', stamp_after, rec.updated_at;
  end if;

  -- 16e. Two appointments either side of a day boundary, and the filters around
  --      them. 15d proved the same widening fragment for screenings; this is the
  --      consultations copy, which is a separate string in a separate file and can
  --      drift on its own.
  execute harness_repo_sql('consultations_repo_insert')
    using pharmacy, patient, null::uuid, 'in_person'::consultation_type,
          '2026-04-10T23:00:00Z'::timestamptz, null::integer, null::text, null::text
    into rec;
  late_evening := rec.id;
  execute harness_repo_sql('consultations_repo_insert')
    using pharmacy, patient, null::uuid, 'in_person'::consultation_type,
          '2026-04-11T00:30:00Z'::timestamptz, null::integer, null::text, null::text
    into rec;
  next_morning := rec.id;

  n := 0;
  seen_late := false;
  for rec in execute harness_repo_sql('consultations_repo_list_upcoming')
    using pharmacy, patient, null::consultation_status[], null::uuid,
          null::date, '2026-04-10'::date, 50, 0
  loop
    n := n + 1;
    if rec.id = late_evening then seen_late := true; end if;
    if rec.id = next_morning then
      raise exception 'ASSERT 16e: a diary closing on 2026-04-10 included an appointment at %; the closing bound has to be widened to the whole day with < and one day rather than <=', rec.scheduled_at;
    end if;
  end loop;
  if not seen_late then
    raise exception 'ASSERT 16e: a diary closing on 2026-04-10 dropped the appointment at 23:00 that day, returning % row(s); a closing bound of <= would mean midnight at the start of the day, so a diary asked for a week would silently lose its last day', n;
  end if;

  -- `= any('{}')` is valid SQL matching no row, so an empty status list sent
  -- straight through would show an empty diary rather than every appointment.
  n := 0;
  for rec in execute harness_repo_sql('consultations_repo_list_upcoming')
    using pharmacy, patient, '{}'::consultation_status[], null::uuid,
          null::date, null::date, 50, 0
  loop
    n := n + 1;
  end loop;
  if n <> 0 then
    raise exception 'ASSERT 16e: an empty status array matched % row(s), expected none; that is the trap the repository avoids by folding an empty list into null instead of sending it', n;
  end if;

  n := 0;
  for rec in execute harness_repo_sql('consultations_repo_list_upcoming')
    using pharmacy, patient, array['scheduled'::consultation_status], null::uuid,
          null::date, null::date, 50, 0
  loop
    n := n + 1;
  end loop;
  if n <> 3 then
    raise exception 'ASSERT 16e: a diary restricted to scheduled returned % row(s), expected the three still booked and not the one 16d completed', n;
  end if;

  -- The conducted_by filter has to be able to return nothing, or it is not a
  -- filter. One consultation in this section has a conductor and three do not.
  n := 0;
  for rec in execute harness_repo_sql('consultations_repo_list_upcoming')
    using pharmacy, null::uuid, null::consultation_status[], conductor,
          null::date, null::date, 50, 0
  loop
    n := n + 1;
  end loop;
  if n <> 1 then
    raise exception 'ASSERT 16e: one pharmacist''s diary returned % row(s), expected the single consultation booked with them', n;
  end if;

  -- Upcoming is soonest first and recent is the reverse. Two whole orderings
  -- rather than one reversed, because with limit and offset reversing a page is
  -- not reversing an ordering -- it returns the same rows in the other sequence,
  -- which for a diary is the wrong set entirely.
  first_upcoming := null;
  first_recent := null;
  for rec in execute harness_repo_sql('consultations_repo_list_upcoming')
    using pharmacy, patient, null::consultation_status[], null::uuid,
          null::date, null::date, 50, 0
  loop
    if first_upcoming is null then first_upcoming := rec.id; end if;
  end loop;
  for rec in execute harness_repo_sql('consultations_repo_list_recent')
    using pharmacy, patient, null::consultation_status[], null::uuid,
          null::date, null::date, 50, 0
  loop
    if first_recent is null then first_recent := rec.id; end if;
  end loop;
  if first_upcoming is distinct from booked then
    raise exception 'ASSERT 16e: the diary started with %, expected the soonest appointment; upcoming has to be scheduled_at asc, because a diary read from the bottom is a diary nobody checks', first_upcoming;
  end if;
  if first_recent is distinct from next_morning then
    raise exception 'ASSERT 16e: the history started with %, expected the latest appointment; recent has to be scheduled_at desc', first_recent;
  end if;

  -- 16f. The distinction the fourteen parameters exist for. A notes-only edit has
  --      to move nothing else, clearing the video link has to be possible, and
  --      omitting it has to leave it alone.
  execute harness_repo_sql('consultations_repo_find_by_id')
    using pharmacy, late_evening
    into rec;
  stamp_before := rec.updated_at;

  execute harness_repo_sql('consultations_repo_update')
    using pharmacy, late_evening,
          null::consultation_type, null::consultation_status, null::timestamptz,
          false, null::integer, false, null::uuid, false, null::text,
          true, 'Harness note added afterwards'::text,
          array['scheduled'::consultation_status]
    into rec;
  if rec.notes <> 'Harness note added afterwards' then
    raise exception 'ASSERT 16f: a notes edit came back as %', rec.notes;
  end if;
  if rec.scheduled_at <> '2026-04-10T23:00:00Z'::timestamptz then
    raise exception 'ASSERT 16f: a notes-only edit moved scheduled_at to %; the preserving update is what stops a read-modify-write from losing a colleague''s reschedule made between the read and the write', rec.scheduled_at;
  end if;
  if rec.status::text <> 'scheduled' then
    raise exception 'ASSERT 16f: a notes-only edit moved the status to %', rec.status;
  end if;
  if rec.updated_at = stamp_before then
    raise exception 'ASSERT 16f: a notes edit left updated_at at %', stamp_before;
  end if;

  -- The consultation 16d completed, moved in person with its link cleared in one
  -- write. `coalesce` could not do this half: it cannot tell "not supplied" from
  -- "set to null", so a video consultation moved across a counter would keep
  -- handing out an address for a meeting that is no longer happening online.
  execute harness_repo_sql('consultations_repo_update')
    using pharmacy, booked,
          'in_person'::consultation_type, null::consultation_status, null::timestamptz,
          false, null::integer, false, null::uuid,
          true, null::text,
          false, null::text,
          array['completed'::consultation_status]
    into rec;
  if rec.video_url is not null then
    raise exception 'ASSERT 16f: a consultation moved in person kept the video link %', rec.video_url;
  end if;
  if rec.type::text <> 'in_person' then
    raise exception 'ASSERT 16f: the type came back %, expected in_person', rec.type;
  end if;

  -- And the other half, which is the one a flagged `case` could break while
  -- fixing the first: an omitted field has to mean "leave it".
  execute harness_repo_sql('consultations_repo_update')
    using pharmacy, next_morning,
          null::consultation_type, null::consultation_status, null::timestamptz,
          false, null::integer, false, null::uuid,
          true, 'https://meet.example/a-and-b/harness-two'::text,
          false, null::text,
          array['scheduled'::consultation_status]
    into rec;
  execute harness_repo_sql('consultations_repo_update')
    using pharmacy, next_morning,
          null::consultation_type, null::consultation_status, null::timestamptz,
          false, null::integer, false, null::uuid,
          false, null::text,
          true, 'Harness link kept'::text,
          array['scheduled'::consultation_status]
    into rec;
  if rec.video_url is distinct from 'https://meet.example/a-and-b/harness-two' then
    raise exception 'ASSERT 16f: a notes edit cleared the video link to %, expected it kept; an omitted field means leave it, and losing that would strip a link from every appointment anybody added a note to', coalesce(rec.video_url, 'null');
  end if;

  -- 16g. Why this module offers no delete, executed rather than read off the
  --      schema. `conducted_by` carries no on delete clause, so it restricts: a
  --      consultation cannot be removed by removing the pharmacist who held it.
  constraint_error := null;
  begin
    delete from users where id = conductor;
  exception
    when others then
      constraint_error := sqlstate;
  end;
  if constraint_error is distinct from '23503' then
    raise exception 'ASSERT 16g: deleting the pharmacist who conducted a consultation was refused with %, expected 23503; if that ever becomes a cascade a diary loses its appointments when a staff member leaves, and this module would have to grow a delete for records that should only ever be cancelled', coalesce(constraint_error, 'no error at all');
  end if;

  raise notice 'ASSERT 16b-16g passed: a booking with no status named came back scheduled, a duration of -5 was refused with 23514 while null was accepted, a guard that matched no row changed nothing and stamped nothing, a diary closing on a day included the 23:00 appointment and excluded the 00:30 one, an empty status array matched no row, a notes-only edit moved nothing else while a supplied null cleared the video link and an omitted one kept it, and deleting the conducting pharmacist was refused with 23503';
end $$;

deallocate consultations_repo_insert;
deallocate consultations_repo_find_by_id;
deallocate consultations_repo_list_upcoming;
deallocate consultations_repo_list_recent;
deallocate consultations_repo_update;

-- ---------------------------------------------------------------------------
-- 17. The prescriptions repository's statements, executed rather than copied.
--
-- What this section exists to prove is the four things a prescription record gets
-- wrong invisibly: that a new prescription is `pending` because the *column* says
-- so, since the repository's insert does not name the column and there is therefore
-- no parameter a dispensed prescription could arrive through; that a prescription
-- survives the sale it was dispensed against, because the record that medicine left
-- the shelf cannot depend on a receipt still existing; that `dispensed` is really
-- terminal and a guard that matched no row stamps nothing; and that a prescription
-- attached to the wrong patient can be detached, which is a clinical correction and
-- not an edit.
-- ---------------------------------------------------------------------------
prepare prescriptions_repo_insert as
insert into prescriptions
   (pharmacy_id, patient_id, sale_id, prescriber_name, approved_by, notes)
values ($1, $2, $3, $4, $5, $6)
returning id, pharmacy_id, patient_id, sale_id, prescriber_name, status,
          approved_by, notes, created_at, updated_at;

prepare prescriptions_repo_find_by_id as
select id, pharmacy_id, patient_id, sale_id, prescriber_name, status, approved_by,
       notes, created_at, updated_at
  from prescriptions
 where pharmacy_id = $1 and id = $2;

prepare prescriptions_repo_list_newest as
select id, pharmacy_id, patient_id, sale_id, prescriber_name, status, approved_by,
       notes, created_at, updated_at
  from prescriptions
 where pharmacy_id = $1
   and ($2::uuid is null or patient_id = $2::uuid)
   and ($3::prescription_status[] is null or status = any($3::prescription_status[]))
   and ($4::date is null or created_at >= $4::date)
   and ($5::date is null or created_at < $5::date + interval '1 day')
 order by created_at desc, id desc
 limit $6 offset $7;

prepare prescriptions_repo_list_oldest as
select id, pharmacy_id, patient_id, sale_id, prescriber_name, status, approved_by,
       notes, created_at, updated_at
  from prescriptions
 where pharmacy_id = $1
   and ($2::uuid is null or patient_id = $2::uuid)
   and ($3::prescription_status[] is null or status = any($3::prescription_status[]))
   and ($4::date is null or created_at >= $4::date)
   and ($5::date is null or created_at < $5::date + interval '1 day')
 order by created_at asc, id asc
 limit $6 offset $7;

prepare prescriptions_repo_count as
select count(*)::int as total from prescriptions
 where pharmacy_id = $1
   and ($2::uuid is null or patient_id = $2::uuid)
   and ($3::prescription_status[] is null or status = any($3::prescription_status[]))
   and ($4::date is null or created_at >= $4::date)
   and ($5::date is null or created_at < $5::date + interval '1 day');

prepare prescriptions_repo_update as
update prescriptions
   set status = coalesce($3::prescription_status, status),
       patient_id = case when $4::boolean then $5::uuid else patient_id end,
       sale_id = case when $6::boolean then $7::uuid else sale_id end,
       approved_by = case when $8::boolean then $9::uuid
                          else approved_by end,
       prescriber_name = case when $10::boolean then $11::text
                              else prescriber_name end,
       notes = case when $12::boolean then $13::text else notes end
 where pharmacy_id = $1
   and id = $2
   and status = any($14::prescription_status[])
returning id, pharmacy_id, patient_id, sale_id, prescriber_name, status,
          approved_by, notes, created_at, updated_at;

do $$
begin
  raise notice 'ASSERT 17a passed: every prescriptions-repository statement parses against the migrated schema';
end $$;

do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  owner constant uuid := 'a0000000-0000-4000-8000-000000000002';
  rec record;
  n integer;
  deltype text;
  patient uuid;
  patient_two uuid;
  sale uuid;
  rx_pending uuid;
  rx_sold uuid;
  rx_patched uuid;
  p_one uuid;
  p_two uuid;
  p_three uuid;
  stamp_before timestamptz;
  stamp_after timestamptz;
  first_newest uuid;
  first_oldest uuid;
begin
  -- 17b. The three foreign keys, read out of the catalog rather than out of
  --      init.sql. `a` is NO ACTION, which is what a bare `references` produces and
  --      is what refuses a delete; `n` is SET NULL. The two that restrict are why
  --      neither this module nor patients.repository.ts offers a delete, and the
  --      one that sets null is asserted behaviourally in 17d because its effect is
  --      the important part rather than its rule.
  select confdeltype::text into deltype
    from pg_constraint
   where conrelid = 'prescriptions'::regclass and contype = 'f'
     and confrelid = 'patients'::regclass;
  if deltype is distinct from 'a' then
    raise exception 'ASSERT 17b: prescriptions.patient_id has delete rule %, expected a (NO ACTION); a cascade would delete the authority behind a dispensing whenever a patient record went, and patients.repository.ts relies on this to refuse a delete', coalesce(deltype, 'no foreign key at all');
  end if;
  select confdeltype::text into deltype
    from pg_constraint
   where conrelid = 'prescriptions'::regclass and contype = 'f'
     and confrelid = 'users'::regclass;
  if deltype is distinct from 'a' then
    raise exception 'ASSERT 17b: prescriptions.approved_by has delete rule %, expected a (NO ACTION); a cascade would remove the record of who approved a dispensing when that pharmacist left', coalesce(deltype, 'no foreign key at all');
  end if;
  select confdeltype::text into deltype
    from pg_constraint
   where conrelid = 'prescriptions'::regclass and contype = 'f'
     and confrelid = 'sales'::regclass;
  if deltype is distinct from 'n' then
    raise exception 'ASSERT 17b: prescriptions.sale_id has delete rule %, expected n (SET NULL); a cascade would take the record that medicine left the shelf with the receipt', coalesce(deltype, 'no foreign key at all');
  end if;

  insert into patients (pharmacy_id, full_name)
  values (pharmacy, 'Harness Prescription') returning id into patient;
  insert into patients (pharmacy_id, full_name)
  values (pharmacy, 'Harness Prescription Two') returning id into patient_two;

  -- 17c. The repository's insert names six columns and `status` is not one of them,
  --      so a new prescription takes the column default and cannot arrive already
  --      dispensed. Proven rather than assumed: were the default to change, the one
  --      status that says medicine left the shelf would be the one every new
  --      prescription claimed.
  execute harness_repo_sql('prescriptions_repo_insert')
    using pharmacy, null::uuid, null::uuid, 'Harness Prescriber Two'::text,
          null::uuid, null::text
    into rec;
  rx_pending := rec.id;
  if rec.status::text <> 'pending' then
    raise exception 'ASSERT 17c: a prescription created without naming a status came back %, expected the column default pending; dispensed is the one status worth forging and the insert has no parameter for it', rec.status;
  end if;
  if rec.patient_id is not null or rec.sale_id is not null then
    raise exception 'ASSERT 17c: a prescription created with neither a patient nor a sale came back with % and %; both are nullable and a walk-in who is not on the books is a real prescription', rec.patient_id, rec.sale_id;
  end if;
  if rec.created_at <> rec.updated_at then
    raise exception 'ASSERT 17c: a freshly inserted prescription had created_at % and updated_at %; the two diverge only when set_updated_at fires, and 17e depends on that', rec.created_at, rec.updated_at;
  end if;

  -- 17d. The survival. A sale is created, a prescription is dispensed against it,
  --      and then the sale goes. The prescription has to still be there, with the
  --      link dropped and nothing else touched: the stock ledger shows a movement
  --      out, and this row is the only thing that says somebody authorised it.
  insert into sales (pharmacy_id, sale_number, status, served_by, patient_id,
                     subtotal, total, amount_paid,
                     vat_rate, nhil_rate, getfund_rate, tax_inclusive_pricing)
  values (pharmacy, 'HARNESS-SALE-RX', 'completed', owner, patient,
          70.00, 70.00, 70.00,
          0.1250, 0.0250, 0.0250, false)
  returning id into sale;

  execute harness_repo_sql('prescriptions_repo_insert')
    using pharmacy, patient, sale, 'Harness Prescriber Two'::text, owner,
          'Harness dispensed against a sale'::text
    into rec;
  rx_sold := rec.id;
  if rec.sale_id <> sale then
    raise exception 'ASSERT 17d: a prescription dispensed against a sale came back with sale_id %, expected %', rec.sale_id, sale;
  end if;

  delete from sales where id = sale;

  execute harness_repo_sql('prescriptions_repo_find_by_id')
    using pharmacy, rx_sold
    into rec;
  if rec.id is null then
    raise exception 'ASSERT 17d: deleting a sale took the prescription dispensed against it; the record that medicine left the shelf cannot depend on a receipt still existing';
  end if;
  if rec.sale_id is not null then
    raise exception 'ASSERT 17d: a prescription whose sale was deleted kept sale_id %, expected it set null', rec.sale_id;
  end if;
  if rec.patient_id <> patient then
    raise exception 'ASSERT 17d: deleting a sale moved patient_id to %; only the link to the sale is supposed to go', rec.patient_id;
  end if;
  if rec.notes <> 'Harness dispensed against a sale' then
    raise exception 'ASSERT 17d: deleting a sale changed the prescription notes to %', rec.notes;
  end if;
  -- Deliberately not asserted here: whether the foreign key's SET NULL stamps
  -- updated_at. PostgreSQL performs referential actions through SPI, which runs
  -- the modification through the ordinary executor, so a BEFORE UPDATE trigger on
  -- this table is a real possibility rather than a settled fact -- and nothing in
  -- the repository's design depends on which way it goes. An assertion guessing at
  -- it would be a claim the harness could not justify.

  -- 17e. One direction, with rejected as the only exit, and a refused transition
  --      changing nothing at all -- including updated_at.
  execute harness_repo_sql('prescriptions_repo_update')
    using pharmacy, rx_pending, 'approved'::prescription_status,
          false, null::uuid, false, null::uuid,
          true, owner, false, null::text, false, null::text,
          array['pending'::prescription_status]
    into rec;
  if rec.status::text <> 'approved' then
    raise exception 'ASSERT 17e: the transition from pending came back %, expected approved', rec.status;
  end if;
  if rec.approved_by <> owner then
    raise exception 'ASSERT 17e: approved_by came back %, expected the pharmacist who approved it', rec.approved_by;
  end if;
  stamp_after := rec.updated_at;
  -- 17c required the two stamps to arrive equal, so an approval has to have moved
  -- one of them. This is the baseline the refused transitions below are measured
  -- against: a change that stamps and a refusal that does not.
  if rec.updated_at = rec.created_at then
    raise exception 'ASSERT 17e: approving a prescription left updated_at at %, equal to created_at; set_updated_at uses clock_timestamp() so it has to move inside one transaction, and a record that changed without saying when cannot be audited', rec.updated_at;
  end if;

  n := 0;
  for rec in execute harness_repo_sql('prescriptions_repo_update')
    using pharmacy, rx_pending, 'pending'::prescription_status,
          false, null::uuid, false, null::uuid, false, null::uuid, false, null::text,
          false, null::text,
          array['dispensed'::prescription_status]
  loop
    n := n + 1;
  end loop;
  if n <> 0 then
    raise exception 'ASSERT 17e: a move back to pending matched % row(s) against a prescription that was only approved; the guard reads the pre-update status, which is the only thing keeping the flow one-directional', n;
  end if;

  execute harness_repo_sql('prescriptions_repo_find_by_id')
    using pharmacy, rx_pending
    into rec;
  if rec.status::text <> 'approved' then
    raise exception 'ASSERT 17e: a transition the guard refused still moved the status to %', rec.status;
  end if;
  if rec.updated_at <> stamp_after then
    raise exception 'ASSERT 17e: an update that matched no row still stamped updated_at, from % to %; a refused transition would then read as a revision somebody made', stamp_after, rec.updated_at;
  end if;

  execute harness_repo_sql('prescriptions_repo_update')
    using pharmacy, rx_pending, 'dispensed'::prescription_status,
          false, null::uuid, false, null::uuid, false, null::uuid, false, null::text,
          false, null::text,
          array['approved'::prescription_status]
    into rec;
  if rec.status::text <> 'dispensed' then
    raise exception 'ASSERT 17e: the transition from approved came back %, expected dispensed', rec.status;
  end if;

  -- Terminal. A dispensing that was wrong is corrected on the stock ledger with a
  -- write-off and on the sale with a refund, not by putting the prescription back
  -- and losing the record that it was ever supplied.
  n := 0;
  for rec in execute harness_repo_sql('prescriptions_repo_update')
    using pharmacy, rx_pending, 'rejected'::prescription_status,
          false, null::uuid, false, null::uuid, false, null::uuid, false, null::text,
          false, null::text,
          array['pending'::prescription_status, 'approved'::prescription_status]
  loop
    n := n + 1;
  end loop;
  if n <> 0 then
    raise exception 'ASSERT 17e: a dispensed prescription matched % row(s) against a guard of pending and approved; nothing may leave dispensed', n;
  end if;
  execute harness_repo_sql('prescriptions_repo_find_by_id')
    using pharmacy, rx_pending
    into rec;
  if rec.status::text <> 'dispensed' then
    raise exception 'ASSERT 17e: a dispensed prescription moved to %, which would lose the record that medicine was supplied', rec.status;
  end if;

  -- 17f. The fixtures for the filters and the orderings, on a patient of their own
  --      so the counts are exact. created_at is set directly because the
  --      repository's insert does not name it -- the fixture is not what is under
  --      test here, the list statement is.
  execute harness_repo_sql('prescriptions_repo_insert')
    using pharmacy, patient_two, null::uuid, 'Harness Prescriber Two'::text,
          null::uuid, null::text
    into rec;
  p_one := rec.id;
  execute harness_repo_sql('prescriptions_repo_insert')
    using pharmacy, patient_two, null::uuid, 'Harness Prescriber Two'::text,
          null::uuid, null::text
    into rec;
  p_two := rec.id;
  execute harness_repo_sql('prescriptions_repo_insert')
    using pharmacy, patient_two, null::uuid, 'Harness Prescriber Two'::text,
          null::uuid, null::text
    into rec;
  p_three := rec.id;

  update prescriptions set created_at = '2026-04-01T09:00:00Z'::timestamptz where id = p_one;
  update prescriptions set created_at = '2026-04-05T23:00:00Z'::timestamptz where id = p_two;
  update prescriptions set created_at = '2026-04-06T00:30:00Z'::timestamptz where id = p_three;

  -- `= any('{}')` is valid SQL matching no row, so an empty status list sent
  -- straight through would show an empty queue rather than every prescription.
  n := 0;
  for rec in execute harness_repo_sql('prescriptions_repo_list_newest')
    using pharmacy, patient_two, '{}'::prescription_status[], null::date, null::date,
          50, 0
  loop
    n := n + 1;
  end loop;
  if n <> 0 then
    raise exception 'ASSERT 17f: an empty status array matched % row(s), expected none; that is the trap the repository avoids by folding an empty list into null instead of sending it', n;
  end if;

  n := 0;
  for rec in execute harness_repo_sql('prescriptions_repo_list_newest')
    using pharmacy, patient_two, null::prescription_status[], null::date, null::date,
          50, 0
  loop
    n := n + 1;
  end loop;
  if n <> 3 then
    raise exception 'ASSERT 17f: an unfiltered history returned % row(s), expected the three written for this patient', n;
  end if;

  -- A range closing on 2026-04-05 has to include the prescription written at 23:00
  -- that day and exclude the one half an hour after midnight. 15d and 16e proved
  -- the same widening for two other tables; this is the third copy of the fragment,
  -- which is a separate string in a separate file and can drift on its own.
  n := 0;
  for rec in execute harness_repo_sql('prescriptions_repo_list_newest')
    using pharmacy, patient_two, null::prescription_status[], null::date,
          '2026-04-05'::date, 50, 0
  loop
    n := n + 1;
    if rec.id = p_three then
      raise exception 'ASSERT 17f: a history closing on 2026-04-05 included a prescription written at %; the closing bound has to be widened to the whole day with < and one day rather than <=', rec.created_at;
    end if;
  end loop;
  if n <> 2 then
    raise exception 'ASSERT 17f: a history closing on 2026-04-05 returned % row(s), expected the two written on or before that day including the one at 23:00', n;
  end if;

  -- The badge and the list have to agree, or the queue says three and shows two.
  execute harness_repo_sql('prescriptions_repo_count')
    using pharmacy, patient_two, null::prescription_status[], null::date,
          '2026-04-05'::date
    into rec;
  if rec.total <> 2 then
    raise exception 'ASSERT 17f: the count for the same filters returned %, expected the 2 the list returned', rec.total;
  end if;
  execute harness_repo_sql('prescriptions_repo_count')
    using pharmacy, patient_two, array['pending'::prescription_status], null::date,
          null::date
    into rec;
  if rec.total <> 3 then
    raise exception 'ASSERT 17f: the count of pending prescriptions returned %, expected 3', rec.total;
  end if;

  -- 17g. Newest first for a history and oldest first for an approval queue, which
  --      is the ordering in which a queue cannot quietly grow a backlog.
  first_newest := null;
  first_oldest := null;
  for rec in execute harness_repo_sql('prescriptions_repo_list_newest')
    using pharmacy, patient_two, null::prescription_status[], null::date, null::date,
          50, 0
  loop
    if first_newest is null then first_newest := rec.id; end if;
  end loop;
  for rec in execute harness_repo_sql('prescriptions_repo_list_oldest')
    using pharmacy, patient_two, null::prescription_status[], null::date, null::date,
          50, 0
  loop
    if first_oldest is null then first_oldest := rec.id; end if;
  end loop;
  if first_newest is distinct from p_three then
    raise exception 'ASSERT 17g: the history started with %, expected the prescription written last; newest has to be created_at desc', first_newest;
  end if;
  if first_oldest is distinct from p_one then
    raise exception 'ASSERT 17g: the queue started with %, expected the prescription that has been waiting longest; oldest has to be created_at asc, or the thing nobody dealt with is on the last page', first_oldest;
  end if;

  -- 17h. The distinction the fourteen parameters exist for, on the column where it
  --      is a clinical correction rather than a tidy one. The fixture is written
  --      with no patient on purpose: a walk-in prescription taken at the counter
  --      before anybody opened a record is the ordinary case here, and it is what
  --      lets the three edits below read as one sequence -- a note added without
  --      touching the attribution, then the record attached once it exists, then
  --      detached again because it was the wrong person. Created against the
  --      patient instead, the second edit would prove nothing and the first would
  --      be unsatisfiable.
  execute harness_repo_sql('prescriptions_repo_insert')
    using pharmacy, null::uuid, null::uuid, 'Harness Prescriber Two'::text,
          null::uuid, null::text
    into rec;
  rx_patched := rec.id;
  stamp_before := rec.updated_at;

  execute harness_repo_sql('prescriptions_repo_update')
    using pharmacy, rx_patched, null::prescription_status,
          false, null::uuid, false, null::uuid, false, null::uuid, false, null::text,
          true, 'Harness note added afterwards'::text,
          array['pending'::prescription_status]
    into rec;
  if rec.notes <> 'Harness note added afterwards' then
    raise exception 'ASSERT 17h: a notes edit came back as %', rec.notes;
  end if;
  if rec.status::text <> 'pending' then
    raise exception 'ASSERT 17h: a notes-only edit moved the status to %', rec.status;
  end if;
  if rec.patient_id is not null then
    raise exception 'ASSERT 17h: a notes-only edit attached the prescription to patient %', rec.patient_id;
  end if;
  if rec.updated_at = stamp_before then
    raise exception 'ASSERT 17h: a notes edit left updated_at at %', stamp_before;
  end if;

  execute harness_repo_sql('prescriptions_repo_update')
    using pharmacy, rx_patched, null::prescription_status,
          true, patient, false, null::uuid, false, null::uuid, false, null::text,
          false, null::text,
          array['pending'::prescription_status]
    into rec;
  if rec.patient_id is distinct from patient then
    raise exception 'ASSERT 17h: attaching a walk-in prescription to the record they later opened came back %, expected %', rec.patient_id, patient;
  end if;

  -- And the half that makes this a correction rather than an edit: a prescription
  -- attached to the wrong patient has to be detachable, because left attached it is
  -- a clinical error on somebody else's record saying they were supplied medicine
  -- they never received. `coalesce` could not do this at all.
  execute harness_repo_sql('prescriptions_repo_update')
    using pharmacy, rx_patched, null::prescription_status,
          true, null::uuid, false, null::uuid, false, null::uuid, false, null::text,
          false, null::text,
          array['pending'::prescription_status]
    into rec;
  if rec.patient_id is not null then
    raise exception 'ASSERT 17h: a supplied null did not clear patient_id, which came back %; a prescription that cannot be detached from the wrong patient is a clinical error that cannot be corrected', rec.patient_id;
  end if;
  if rec.notes <> 'Harness note added afterwards' then
    raise exception 'ASSERT 17h: clearing patient_id also cleared the notes to %; an omitted field has to mean leave it', coalesce(rec.notes, 'null');
  end if;

  raise notice 'ASSERT 17b-17h passed: patient_id and approved_by restrict while sale_id sets null, a prescription created without naming a status came back pending, deleting the sale left the prescription with its patient and its notes and dropped only the link without stamping a revision, approved could not go back to pending and dispensed could not leave at all and neither refusal stamped anything, an empty status array matched no row while a range closing on a day included the 23:00 prescription and the count agreed with the list, the queue came back oldest first and the history newest first, and a supplied null detached a prescription from the wrong patient while an omitted note was left alone';
end $$;

deallocate prescriptions_repo_insert;
deallocate prescriptions_repo_find_by_id;
deallocate prescriptions_repo_list_newest;
deallocate prescriptions_repo_list_oldest;
deallocate prescriptions_repo_count;
deallocate prescriptions_repo_update;

-- ---------------------------------------------------------------------------
-- 18. Reminders: the two things Phase 8 asks to see proven, plus the three that
--     make them work.
--
-- Deduplication first, because it is the acceptance line and because the
-- mechanism is the database's rather than the application's. A refresh that
-- selected and then inserted would have a race exactly as wide as the two round
-- trips between the read and the write, and its failure mode is a patient getting
-- the same text message twice. 18c runs the same key twice through the
-- repository's own statement and requires the second refresh to raise nothing, to
-- change nothing, and above all to stamp nothing: a swallowed conflict that moved
-- `updated_at` would be a revision nobody made.
--
-- The unsent state second. Migration 0005 added
-- `reminders_not_sent_has_reason` and its own verify file proves the constraint
-- against plain inserts. 18d proves it against the statement the scheduler
-- actually uses, which is the stronger claim: the repository cannot write
-- "not sent" with no reason beside it, either by supplying a null or by omitting
-- the field and leaving the null that is already there. Both paths are refused,
-- and the refusal is the acceptance line enforcing itself rather than a service
-- remembering to be honest.
--
-- Then the three that make those work. 18e is the guard that stops a reminder
-- being dealt with twice when two scheduler runs overlap, and the coalesce that
-- keeps a notification id once written. 18f is the queue, and specifically that
-- `status = 'pending'` is a literal: it is what lets the planner use the partial
-- index, and 18g reads that index's predicate out of the catalog so a change to
-- it cannot leave the literal quietly matching nothing. 18h is superseding by
-- prefix, the operation that stops a rescheduled appointment texting a patient
-- about a slot that no longer exists, and it is asserted against four reminders
-- that must survive it as well as the one that must not. 18j is superseding by
-- exact key, the operation that stops a collected prescription texting a patient
-- about medicine they are already holding, and it is asserted against three
-- survivors -- one of which is a key only a prefix match would reach, which is the
-- whole difference between the two statements.
--
-- The dedupe keys below are written out rather than generated, which is a second
-- spelling of the format `utils/reminder-keys.ts` owns. `reminders.repository.test.ts`
-- is what ties that module to the statement 18h executes, so the harness proves
-- the matching and the test proves the two spellings agree.
-- ---------------------------------------------------------------------------
prepare reminders_repo_insert as
insert into reminders
   (pharmacy_id, patient_id, kind, due_at, message, dedupe_key)
values ($1, $2, $3::reminder_kind, $4::timestamptz, $5, $6)
on conflict (pharmacy_id, dedupe_key) do nothing
returning id, pharmacy_id, patient_id, kind, due_at, message,
          status, not_sent_reason, notification_id, dedupe_key, created_at, updated_at;

prepare reminders_repo_find_by_id as
select id, pharmacy_id, patient_id, kind, due_at, message,
       status, not_sent_reason, notification_id, dedupe_key, created_at, updated_at
  from reminders
 where pharmacy_id = $1 and id = $2;

prepare reminders_repo_list_due as
select id, pharmacy_id, patient_id, kind, due_at, message,
       status, not_sent_reason, notification_id, dedupe_key, created_at, updated_at
  from reminders
 where pharmacy_id = $1
   and status = 'pending'
   and due_at <= $2::timestamptz
 order by due_at asc, id asc
 limit $3;

prepare reminders_repo_list_upcoming as
select id, pharmacy_id, patient_id, kind, due_at, message,
       status, not_sent_reason, notification_id, dedupe_key, created_at, updated_at
  from reminders
 where pharmacy_id = $1
   and ($2::uuid is null or patient_id = $2::uuid)
   and ($3::reminder_kind[] is null or kind = any($3::reminder_kind[]))
   and ($4::notification_status[] is null or status = any($4::notification_status[]))
   and ($5::date is null or due_at >= $5::date)
   and ($6::date is null or due_at < $6::date + interval '1 day')
 order by due_at asc, id asc
 limit $7 offset $8;

prepare reminders_repo_list_recent as
select id, pharmacy_id, patient_id, kind, due_at, message,
       status, not_sent_reason, notification_id, dedupe_key, created_at, updated_at
  from reminders
 where pharmacy_id = $1
   and ($2::uuid is null or patient_id = $2::uuid)
   and ($3::reminder_kind[] is null or kind = any($3::reminder_kind[]))
   and ($4::notification_status[] is null or status = any($4::notification_status[]))
   and ($5::date is null or due_at >= $5::date)
   and ($6::date is null or due_at < $6::date + interval '1 day')
 order by due_at desc, id desc
 limit $7 offset $8;

prepare reminders_repo_outcome as
update reminders
   set status = $3::notification_status,
       not_sent_reason = case when $4::boolean then $5::text
                              else not_sent_reason end,
       notification_id = coalesce($6::uuid, notification_id)
 where pharmacy_id = $1
   and id = $2
   and status = any($7::notification_status[])
 returning id, pharmacy_id, patient_id, kind, due_at, message,
           status, not_sent_reason, notification_id, dedupe_key, created_at, updated_at;

prepare reminders_repo_supersede as
update reminders
   set status = 'not_sent',
       not_sent_reason = $4::text
 where pharmacy_id = $1
   and kind = 'appointment'
   and status = 'pending'
   and dedupe_key like ($3::text || '%')
   and dedupe_key <> $2::text
 returning id;

prepare reminders_repo_supersede_refill as
update reminders
   set status = 'not_sent',
       not_sent_reason = $3::text
 where pharmacy_id = $1
   and kind = 'refill'
   and status = 'pending'
   and dedupe_key = $2::text
 returning id;

do $$
begin
  raise notice 'ASSERT 18a passed: every reminders-repository statement parses against the migrated schema';
end $$;

do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  rec record;
  n integer;
  patient uuid;
  first_reminder uuid;
  stamp_before timestamptz;
  constraint_error text;
begin
  insert into patients (pharmacy_id, full_name)
  values (pharmacy, 'Harness Reminder One') returning id into patient;

  -- 18b. Three columns the insert does not name, and all three defaults proved
  --      rather than read out of init.sql. `pending` is the one the whole queue
  --      depends on; a null reason is what makes an unexplained `not_sent` a
  --      schema violation rather than an ordinary row; and a null notification id
  --      is what makes 18e's coalesce meaningful, since there is nothing to keep
  --      yet. A fresh row also carries equal stamps, which is the baseline 18c and
  --      18e measure against.
  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'refill'::reminder_kind,
          '2026-04-20T09:00:00Z'::timestamptz,
          'Your blood pressure script is due for a refill.'::text,
          'refill:harness-rx-one'::text
    into rec;
  first_reminder := rec.id;
  stamp_before := rec.updated_at;
  if rec.status::text <> 'pending' then
    raise exception 'ASSERT 18b: a reminder created without naming a status came back %, expected the pending default the whole scheduler queue is selected on', rec.status;
  end if;
  if rec.not_sent_reason is not null then
    raise exception 'ASSERT 18b: a new pending reminder came back with the reason %, expected none; a queue that starts out labelled unsent is a dashboard that starts out apologising', rec.not_sent_reason;
  end if;
  if rec.notification_id is not null then
    raise exception 'ASSERT 18b: a reminder that has raised nothing came back attached to notification %, which would be a bell entry describing a reminder rather than the other way round', rec.notification_id;
  end if;
  if rec.created_at <> rec.updated_at then
    raise exception 'ASSERT 18b: a fresh reminder was created at % and updated at %, expected one instant; the column defaults both to now(), which is transaction-start time', rec.created_at, rec.updated_at;
  end if;
  if rec.kind::text <> 'refill' then
    raise exception 'ASSERT 18b: a refill reminder came back as kind %, so the cast in the statement is not binding against the column', rec.kind;
  end if;

  -- 18c. The acceptance line: a repeated refresh does not re-raise the same
  --      reminder. Driven through the repository's own statement, so what is
  --      proved is that `on conflict do nothing` really does nothing — not that a
  --      second insert was refused, which would be a different mechanism and would
  --      surface to the caller as an error to catch.
  --
  --      The loop rather than `into rec`, because an insert that conflicts returns
  --      no row and `EXECUTE ... INTO` on no rows leaves a null record whose fields
  --      are indistinguishable from a row that genuinely held nulls. Counting the
  --      rows is the only way to tell "raised nothing" from "raised a blank".
  n := 0;
  for rec in execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'refill'::reminder_kind,
          '2026-04-21T09:00:00Z'::timestamptz,
          'A different message and a different due date, neither of which may land.'::text,
          'refill:harness-rx-one'::text
  loop
    n := n + 1;
  end loop;
  if n <> 0 then
    raise exception 'ASSERT 18c: a second refresh of the same dedupe key raised % row(s), expected 0; the patient would be told twice about one prescription', n;
  end if;

  select count(*)::int into n
    from reminders
   where pharmacy_id = pharmacy and dedupe_key = 'refill:harness-rx-one';
  if n <> 1 then
    raise exception 'ASSERT 18c: % reminders hold the key after two refreshes, expected exactly 1', n;
  end if;

  -- And the surviving row is the first one, untouched. A conflict resolution that
  -- updated instead of doing nothing would return a row here too and pass the two
  -- assertions above, so this is the half that distinguishes them: the message and
  -- the due date are the ones from the first refresh, and `updated_at` has not
  -- moved, because a swallowed conflict is not a revision and must not look like
  -- one to anybody reading the history.
  execute harness_repo_sql('reminders_repo_find_by_id')
    using pharmacy, first_reminder into rec;
  if rec.message <> 'Your blood pressure script is due for a refill.' then
    raise exception 'ASSERT 18c: the surviving reminder reads %, so the second refresh overwrote the first instead of doing nothing', rec.message;
  end if;
  if rec.due_at <> '2026-04-20T09:00:00Z'::timestamptz then
    raise exception 'ASSERT 18c: the surviving reminder is due at %, expected the first refresh''s 2026-04-20T09:00:00Z; a reminder that moves when it is re-raised cannot be relied on to fire once', rec.due_at;
  end if;
  if rec.updated_at <> stamp_before then
    raise exception 'ASSERT 18c: a swallowed conflict moved updated_at from % to %, which is a revision nobody made', stamp_before, rec.updated_at;
  end if;

  -- 18d. The unsent state is honest, through the statement the scheduler uses.
  --
  --      A supplied null beside `not_sent`: the flagged case writes it, and
  --      migration 0005's constraint refuses the row. This is the path a caller
  --      would take by passing `notSentReason: null` explicitly.
  constraint_error := null;
  begin
    execute harness_repo_sql('reminders_repo_outcome')
      using pharmacy, first_reminder, 'not_sent'::notification_status,
            true, null::text, null::uuid,
            array['pending'::notification_status];
  exception
    when others then
      constraint_error := sqlstate;
  end;
  if constraint_error is distinct from '23514' then
    raise exception 'ASSERT 18d: writing not_sent with a supplied null reason was accepted with %, expected 23514 from reminders_not_sent_has_reason; the dashboard would then say "not sent" with nothing beside it', coalesce(constraint_error, 'no error at all');
  end if;

  --      And an omitted reason on a row that has none, which is the path a caller
  --      takes by not mentioning the field at all. The flag is false, so the case
  --      keeps the existing value -- and the existing value is null, so the
  --      constraint refuses this too. Proving both paths is the difference between
  --      "the reason is required" and "the reason is required unless you forget
  --      to supply one", which is the version that ships.
  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'refill'::reminder_kind,
          '2026-04-20T10:00:00Z'::timestamptz,
          'Your inhaler is due for a refill.'::text,
          'refill:harness-rx-two'::text
    into rec;
  constraint_error := null;
  begin
    execute harness_repo_sql('reminders_repo_outcome')
      using pharmacy, rec.id, 'not_sent'::notification_status,
            false, null::text, null::uuid,
            array['pending'::notification_status];
  exception
    when others then
      constraint_error := sqlstate;
  end;
  if constraint_error is distinct from '23514' then
    raise exception 'ASSERT 18d: writing not_sent with the reason omitted was accepted with %, expected 23514; omitting a field cannot be a way past the constraint that requires it', coalesce(constraint_error, 'no error at all');
  end if;

  --      And with a reason, it goes through: the constraint requires a reason, it
  --      does not forbid the status.
  execute harness_repo_sql('reminders_repo_outcome')
    using pharmacy, first_reminder, 'not_sent'::notification_status,
          true, 'no SMS provider is configured'::text, null::uuid,
          array['pending'::notification_status]
    into rec;
  if rec.status::text <> 'not_sent' then
    raise exception 'ASSERT 18d: an outcome with a reason came back as status %, expected not_sent', rec.status;
  end if;
  if rec.not_sent_reason <> 'no SMS provider is configured' then
    raise exception 'ASSERT 18d: an outcome written with a reason came back as %, so the flagged case is not binding the value', coalesce(rec.not_sent_reason, 'null');
  end if;

  raise notice 'ASSERT 18b-18d passed: a reminder created without naming a status came back pending with no reason and no notification and equal stamps, a second refresh of the same key raised nothing and changed nothing and stamped nothing, and not_sent was refused both with a supplied null reason and with the reason omitted while a real reason went straight through';
end $$;

do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  consultation constant uuid := 'c0000000-0000-4000-8000-000000000001';
  consultation_two constant uuid := 'c0000000-0000-4000-8000-000000000002';
  tick constant timestamptz := '2026-04-21T12:00:00Z';
  rec record;
  n integer;
  patient uuid;
  patient_two uuid;
  second_reminder uuid;
  stamp_before timestamptz;
  stamp_after timestamptz;
  notification uuid;
  queue_past uuid;
  queue_now uuid;
  dealt uuid;
  first_due uuid;
  second_due uuid;
  old_key text;
  new_key text;
  other_key text;
  done_key text;
  extra_key text;
  extra_slot uuid;
  old_slot uuid;
  new_slot uuid;
  other_slot uuid;
  refill_reminder uuid;
  done_slot uuid;
  done_stamp timestamptz;
  constraint_error text;
  index_found boolean;
  index_predicate text;
begin
  select id into patient from patients
   where pharmacy_id = pharmacy and full_name = 'Harness Reminder One';
  select id into second_reminder from reminders
   where pharmacy_id = pharmacy and dedupe_key = 'refill:harness-rx-two';

  -- 18e. Two scheduler runs overlapping both select the same pending row, and the
  --      guard is what makes the second one a no-op rather than a second message.
  --      This is a database-level answer to a concurrency question: not a lock held
  --      in the application, which would only be as reliable as the one process
  --      that remembers to take it.
  select updated_at into stamp_before from reminders where id = second_reminder;
  insert into notifications (pharmacy_id, type, status, title, dedupe_key,
                             not_sent_reason)
  values (pharmacy, 'refill_reminder', 'not_sent', 'Harness refill reminder',
          'HARNESS-NOTIF-R1', 'no SMS provider is configured')
  returning id into notification;

  execute harness_repo_sql('reminders_repo_outcome')
    using pharmacy, second_reminder, 'not_sent'::notification_status,
          true, 'no SMS provider is configured'::text, notification,
          array['pending'::notification_status]
    into rec;
  stamp_after := rec.updated_at;
  if rec.status::text <> 'not_sent' then
    raise exception 'ASSERT 18e: the first outcome came back as %, expected not_sent', rec.status;
  end if;
  if rec.notification_id is distinct from notification then
    raise exception 'ASSERT 18e: the outcome came back attached to notification %, expected %; the bell entry and the reminder that raised it have to point at each other', coalesce(rec.notification_id::text, 'null'), notification;
  end if;
  if rec.updated_at = stamp_before then
    raise exception 'ASSERT 18e: an outcome that changed the status left updated_at at %, so a dealt-with reminder looks like one nobody touched', stamp_before;
  end if;

  -- The second run, guarded on the same state. It matches nothing, because the row
  -- is no longer pending -- and matching nothing is the whole of the protection.
  n := 0;
  for rec in execute harness_repo_sql('reminders_repo_outcome')
    using pharmacy, second_reminder, 'sent'::notification_status,
          true, 'sent on a second run'::text, null::uuid,
          array['pending'::notification_status]
  loop
    n := n + 1;
  end loop;
  if n <> 0 then
    raise exception 'ASSERT 18e: a second scheduler run matched % row(s) guarded on pending, expected 0; the patient would be told twice about one refill', n;
  end if;

  execute harness_repo_sql('reminders_repo_find_by_id')
    using pharmacy, second_reminder into rec;
  if rec.status::text <> 'not_sent' then
    raise exception 'ASSERT 18e: the refused second run left the status as %, expected the not_sent the first run wrote', rec.status;
  end if;
  if rec.not_sent_reason <> 'no SMS provider is configured' then
    raise exception 'ASSERT 18e: the refused second run overwrote the reason with %', coalesce(rec.not_sent_reason, 'null');
  end if;
  if rec.updated_at <> stamp_after then
    raise exception 'ASSERT 18e: a refused outcome moved updated_at from % to %, which is a revision nobody made and the same claim 16d and 17e make about their guards', stamp_after, rec.updated_at;
  end if;

  -- `allowedFrom` is a parameter rather than a rule, proved by passing something
  -- other than pending. A backfill correcting a reason is entitled to a state the
  -- scheduler never is, and hardcoding the guard would leave that caller writing
  -- its own statement.
  execute harness_repo_sql('reminders_repo_outcome')
    using pharmacy, second_reminder, 'not_sent'::notification_status,
          false, null::text, null::uuid,
          array['not_sent'::notification_status]
    into rec;
  if rec.notification_id is distinct from notification then
    raise exception 'ASSERT 18e: an outcome that named no notification dropped the one already written, leaving %; notification_id is coalesced so a later outcome cannot un-attach the bell entry the reminder raised', coalesce(rec.notification_id::text, 'null');
  end if;

  -- And the flagged case clearing, which coalesce could not do: a retry that
  -- succeeds has to be able to take the reason off, or the row reads sent with
  -- "no SMS provider is configured" still beside it.
  execute harness_repo_sql('reminders_repo_outcome')
    using pharmacy, second_reminder, 'sent'::notification_status,
          true, null::text, null::uuid,
          array['not_sent'::notification_status]
    into rec;
  if rec.status::text <> 'sent' then
    raise exception 'ASSERT 18e: a retry guarded on not_sent came back as %, expected sent', rec.status;
  end if;
  if rec.not_sent_reason is not null then
    raise exception 'ASSERT 18e: a retry that succeeded left the reason % beside a status of sent; a row that says both is a contradiction the constraint permits and nobody should have to read', rec.not_sent_reason;
  end if;

  -- 18f. The queue: pending, due, soonest first. Four fixtures and only two of
  --      them eligible, so a predicate that is too wide or too narrow both show up
  --      as a count rather than as a plausible-looking list.
  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'refill'::reminder_kind,
          '2026-04-19T09:00:00Z'::timestamptz,
          'Overdue by two days.'::text, 'refill:harness-queue-past'::text
    into rec;
  queue_past := rec.id;
  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'refill'::reminder_kind,
          tick, 'Due at exactly the instant asked about.'::text,
          'refill:harness-queue-now'::text
    into rec;
  queue_now := rec.id;
  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'refill'::reminder_kind,
          '2026-04-30T09:00:00Z'::timestamptz,
          'Not due for nine more days.'::text, 'refill:harness-queue-future'::text
    into rec;
  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'refill'::reminder_kind,
          '2026-04-20T09:00:00Z'::timestamptz,
          'Due, but already dealt with.'::text, 'refill:harness-queue-dealt'::text
    into rec;
  dealt := rec.id;
  execute harness_repo_sql('reminders_repo_outcome')
    using pharmacy, dealt, 'not_sent'::notification_status,
          true, 'no SMS provider is configured'::text, null::uuid,
          array['pending'::notification_status]
    into rec;

  n := 0;
  first_due := null;
  second_due := null;
  for rec in execute harness_repo_sql('reminders_repo_list_due')
    using pharmacy, tick, 50
  loop
    n := n + 1;
    if n = 1 then
      first_due := rec.id;
    elsif n = 2 then
      second_due := rec.id;
    end if;
    if rec.status::text <> 'pending' then
      raise exception 'ASSERT 18f: the queue returned a reminder with status %, which is not pending and so is not the scheduler''s to send again', rec.status;
    end if;
    if rec.due_at > tick then
      raise exception 'ASSERT 18f: the queue returned a reminder due at %, after the % it was asked about', rec.due_at, tick;
    end if;
  end loop;
  if n <> 2 then
    raise exception 'ASSERT 18f: the queue held % reminders, expected exactly the two that are both pending and due', n;
  end if;
  if first_due is distinct from queue_past then
    raise exception 'ASSERT 18f: the queue put % first, expected the reminder due on the 19th; soonest first is what stops the oldest waiting reminder being pushed down by every new one', coalesce(first_due::text, 'nothing');
  end if;
  if second_due is distinct from queue_now then
    raise exception 'ASSERT 18f: the queue did not include the reminder due at exactly %, so the bound is exclusive and that reminder would be pushed to the next run of the scheduler and then the one after it', tick;
  end if;

  -- The limit binds, so a scheduler that takes ten at a time takes ten.
  n := 0;
  for rec in execute harness_repo_sql('reminders_repo_list_due')
    using pharmacy, tick, 1
  loop
    n := n + 1;
    if rec.id is distinct from queue_past then
      raise exception 'ASSERT 18f: a limit of one returned %, expected the soonest reminder', rec.id;
    end if;
  end loop;
  if n <> 1 then
    raise exception 'ASSERT 18f: a limit of one returned % rows', n;
  end if;

  -- 18g. Why `status = 'pending'` is a literal in that statement and not a
  --      parameter. The index is partial on exactly this predicate, and the planner
  --      will only use it when the query implies it; a bound value is unknown at
  --      plan time, so the queue would be a sequential scan of every reminder the
  --      pharmacy has ever written, on every tick, forever. Read from the catalog
  --      rather than from init.sql, because the two are what drift.
  select count(*) > 0, max(pg_get_expr(i.indpred, i.indrelid))
    into index_found, index_predicate
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
   where i.indrelid = 'public.reminders'::regclass
     and c.relname = 'reminders_pharmacy_due_idx';
  if not index_found then
    raise exception 'ASSERT 18g: reminders_pharmacy_due_idx does not exist, so the scheduler queue has no index to use at any predicate';
  end if;
  if index_predicate is null or position('pending' in index_predicate) = 0 then
    raise exception 'ASSERT 18g: the index predicate is %, expected it to name pending; listDueReminders writes the status as a literal precisely so the planner can match this predicate, and if the two ever disagree the queue stops using the index without erroring', coalesce(index_predicate, '(none)');
  end if;

  -- 18h. Superseding by prefix: the operation that stops a rescheduled appointment
  --      texting a patient about a slot that no longer exists. Five reminders, one
  --      of which may change, and the four that may not are the assertion -- each
  --      one is there because a predicate in the statement could plausibly be
  --      dropped and the failure would be silent.
  old_key := 'appointment:' || consultation::text || ':2026-04-20T09:30:00.000Z';
  new_key := 'appointment:' || consultation::text || ':2026-04-27T09:30:00.000Z';
  other_key := 'appointment:' || consultation_two::text || ':2026-04-20T09:30:00.000Z';
  done_key := 'appointment:' || consultation::text || ':2026-04-13T09:30:00.000Z';

  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'appointment'::reminder_kind,
          '2026-04-20T09:30:00Z'::timestamptz,
          'Your consultation is tomorrow at 9:30.'::text, old_key::text
    into rec;
  old_slot := rec.id;
  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'appointment'::reminder_kind,
          '2026-04-27T09:30:00Z'::timestamptz,
          'Your consultation is tomorrow at 9:30.'::text, new_key::text
    into rec;
  new_slot := rec.id;
  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'appointment'::reminder_kind,
          '2026-04-20T09:30:00Z'::timestamptz,
          'A different consultation, the same slot.'::text, other_key::text
    into rec;
  other_slot := rec.id;
  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'refill'::reminder_kind,
          '2026-04-20T09:30:00Z'::timestamptz,
          'A refill, which shares no prefix with an appointment.'::text,
          'refill:harness-supersede'::text
    into rec;
  refill_reminder := rec.id;
  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'appointment'::reminder_kind,
          '2026-04-13T09:30:00Z'::timestamptz,
          'A slot that was already superseded once.'::text, done_key::text
    into rec;
  done_slot := rec.id;
  execute harness_repo_sql('reminders_repo_outcome')
    using pharmacy, done_slot, 'not_sent'::notification_status,
          true, 'the appointment was rescheduled earlier'::text, null::uuid,
          array['pending'::notification_status]
    into rec;
  done_stamp := rec.updated_at;

  -- The prefix is built the way `utils/reminder-keys.ts` builds it, and the test
  -- beside this harness is what ties that module to the statement above.
  n := 0;
  for rec in execute harness_repo_sql('reminders_repo_supersede')
    using pharmacy, new_key::text,
          ('appointment:' || consultation::text || ':')::text,
          'the appointment was rescheduled'::text
  loop
    n := n + 1;
    if rec.id is distinct from old_slot then
      raise exception 'ASSERT 18h: superseding touched %, which is not the reminder for the slot that moved', rec.id;
    end if;
  end loop;
  if n <> 1 then
    raise exception 'ASSERT 18h: superseding one moved appointment changed % reminders, expected exactly 1', n;
  end if;

  execute harness_repo_sql('reminders_repo_find_by_id')
    using pharmacy, old_slot into rec;
  if rec.status::text <> 'not_sent' then
    raise exception 'ASSERT 18h: the superseded reminder is still %, so it is still in the partial index and will still fire for a slot nobody is expecting the patient at', rec.status;
  end if;
  if rec.not_sent_reason <> 'the appointment was rescheduled' then
    raise exception 'ASSERT 18h: the superseded reminder gives its reason as %, expected the one passed', coalesce(rec.not_sent_reason, 'null');
  end if;

  execute harness_repo_sql('reminders_repo_find_by_id')
    using pharmacy, new_slot into rec;
  if rec.status::text <> 'pending' then
    raise exception 'ASSERT 18h: the reminder for the slot that is still current came back %, expected pending; superseding without a key to keep would cancel the appointment the patient is actually due at, and then re-raising it would text them twice', rec.status;
  end if;

  execute harness_repo_sql('reminders_repo_find_by_id')
    using pharmacy, other_slot into rec;
  if rec.status::text <> 'pending' then
    raise exception 'ASSERT 18h: a reminder for a different consultation came back %, so the prefix match is wider than one consultation', rec.status;
  end if;

  execute harness_repo_sql('reminders_repo_find_by_id')
    using pharmacy, refill_reminder into rec;
  if rec.status::text <> 'pending' then
    raise exception 'ASSERT 18h: a refill reminder came back %, so the kind predicate is missing and a refill can be superseded by an appointment moving', rec.status;
  end if;

  execute harness_repo_sql('reminders_repo_find_by_id')
    using pharmacy, done_slot into rec;
  if rec.status::text <> 'not_sent' then
    raise exception 'ASSERT 18h: an already dealt-with reminder came back %', rec.status;
  end if;
  if rec.not_sent_reason <> 'the appointment was rescheduled earlier' then
    raise exception 'ASSERT 18h: an already dealt-with reminder had its reason rewritten to %, so the status predicate is missing and superseding rewrites history instead of only stopping what has not happened yet', rec.not_sent_reason;
  end if;
  if rec.updated_at <> done_stamp then
    raise exception 'ASSERT 18h: an already dealt-with reminder had updated_at moved from % to %, which is a revision nobody made', done_stamp, rec.updated_at;
  end if;

  -- And the reason is required here too, by the same constraint: `status =
  -- 'not_sent'` is a literal in this statement, so the only thing standing between
  -- it and an unexplained row is the schema.
  --
  -- Created after the supersede above rather than before it, and that ordering is
  -- load-bearing rather than incidental. A check constraint validates rows the
  -- statement actually writes, so against the fixtures as the previous call left
  -- them -- the moved slot already not_sent, the current one kept, the other
  -- consultation and the refill outside the predicate, the dealt-with one outside
  -- the status -- this update would match nothing at all and pass without the
  -- constraint ever firing. An assertion that cannot fail is worse than no
  -- assertion, because it reads like a guarantee.
  extra_key := 'appointment:' || consultation::text || ':2026-05-04T09:30:00.000Z';
  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'appointment'::reminder_kind,
          '2026-05-04T09:30:00Z'::timestamptz,
          'A second slot, raised so the refusal below has a row to refuse on.'::text,
          extra_key::text
    into rec;
  extra_slot := rec.id;

  constraint_error := null;
  begin
    execute harness_repo_sql('reminders_repo_supersede')
      using pharmacy, new_key::text,
            ('appointment:' || consultation::text || ':')::text,
            null::text;
  exception
    when others then
      constraint_error := sqlstate;
  end;
  if constraint_error is distinct from '23514' then
    raise exception 'ASSERT 18h: superseding with no reason was accepted with %, expected 23514 from reminders_not_sent_has_reason', coalesce(constraint_error, 'no error at all');
  end if;

  -- And the refused update wrote nothing. The subtransaction rolls back to the
  -- block, so the reminder is still pending and still unexplained -- which is the
  -- state it should be in, since the honest alternatives are a reason or nothing.
  execute harness_repo_sql('reminders_repo_find_by_id')
    using pharmacy, extra_slot into rec;
  if rec.status::text <> 'pending' then
    raise exception 'ASSERT 18h: a supersede refused for want of a reason left the reminder %, expected it still pending', rec.status;
  end if;
  if rec.not_sent_reason is not null then
    raise exception 'ASSERT 18h: a supersede refused for want of a reason left the reminder explaining itself as %, expected no reason at all', rec.not_sent_reason;
  end if;

  -- 18i. The cascade the module's lack of a delete leans on. A reminder should
  --      only ever disappear with the patient it was for, and it does so without
  --      the application: there is no delete function here to get wrong.
  insert into patients (pharmacy_id, full_name)
  values (pharmacy, 'Harness Reminder Two') returning id into patient_two;
  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient_two, 'refill'::reminder_kind,
          '2026-04-20T09:00:00Z'::timestamptz,
          'A reminder for a patient about to be erased.'::text,
          'refill:harness-cascade'::text
    into rec;
  delete from patients where id = patient_two;
  select count(*)::int into n from reminders where dedupe_key = 'refill:harness-cascade';
  if n <> 0 then
    raise exception 'ASSERT 18i: % reminder(s) outlived the patient they were for, expected 0; reminders.patient_id is on delete cascade and that is the only removal this module permits', n;
  end if;

  raise notice 'ASSERT 18e-18i passed: a second scheduler run guarded on pending matched nothing and stamped nothing, allowedFrom took a state other than pending, an omitted notification was coalesced and a supplied null cleared the reason, the queue held exactly the two pending reminders that were due with the one due at that instant included and the limit binding, the partial index really is predicated on pending, superseding one moved appointment changed one reminder and left the current slot and the other consultation and the refill and the already-dealt-with one exactly as they were and was refused with no reason at all and the refusal wrote nothing, and a reminder went with its patient';
end $$;

-- 18j. Superseding by exact key. 18h proved the appointment statement against four
--      survivors; this proves the refill one against three, and the third is what
--      makes this a separate assertion rather than a repeat.
--
--      Without this statement a prescription approved on Monday and collected on
--      Monday still sends its reminder on Tuesday: the row is pending, its due_at
--      arrives, and reminders_pharmacy_due_idx hands it to the scheduler. The
--      patient is told to come in for medicine they are holding. Keying the reminder
--      correctly -- which 18c proves -- stops a second one being raised and does
--      nothing at all about the row already sitting there.
--
--      The status predicate cannot be proved here the way 18h proves it, with a
--      second row sharing the key and a different status: the unique index on
--      (pharmacy_id, dedupe_key) forbids that row existing. So it is proved by
--      running the same supersede twice instead, which is the shape 18e uses and the
--      shape the scheduler really meets.
do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  script constant uuid := 'a0000000-0000-4000-8000-0000000000a1';
  other_script constant uuid := 'a0000000-0000-4000-8000-0000000000a2';
  rec record;
  n integer;
  patient uuid;
  collected uuid;
  beside uuid;
  elsewhere uuid;
  trailed uuid;
  collected_key text;
  beside_stamp timestamptz;
  elsewhere_stamp timestamptz;
  trailed_stamp timestamptz;
  collected_stamp timestamptz;
begin
  insert into patients (pharmacy_id, full_name)
  values (pharmacy, 'Harness Reminder Three') returning id into patient;

  -- Written out rather than generated, and the same spelling
  -- `reminders.repository.test.ts` asserts the repository binds.
  collected_key := 'refill:' || script::text;

  -- The one that must change: a refill for a prescription about to be collected.
  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'refill'::reminder_kind,
          '2026-04-20T09:00:00Z'::timestamptz,
          'Your prescription is ready to collect.'::text, collected_key::text
    into rec;
  collected := rec.id;

  -- Survivor one: an appointment for the same patient. There because `kind =
  -- 'refill'` could plausibly be dropped, and a refill key never equals an
  -- appointment key so nothing else would catch it.
  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'appointment'::reminder_kind,
          '2026-04-20T09:30:00Z'::timestamptz,
          'An appointment beside the refill being collected.'::text,
          ('appointment:' || script::text || ':2026-04-20T09:30:00.000Z')::text
    into rec;
  beside := rec.id;
  beside_stamp := rec.updated_at;

  -- Survivor two: a refill for a different prescription.
  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'refill'::reminder_kind,
          '2026-04-20T09:00:00Z'::timestamptz,
          'A refill for a different prescription.'::text,
          ('refill:' || other_script::text)::text
    into rec;
  elsewhere := rec.id;
  elsewhere_stamp := rec.updated_at;

  -- Survivor three, and the one that distinguishes this statement from 18h's: a
  -- key that starts with the key being superseded and carries a segment after it.
  -- No refill key the application builds ever looks like this, which is exactly why
  -- `=` is safe here -- and if somebody "made the two supersede statements
  -- consistent" by giving this one the appointment one's `like ($2::text || '%')`,
  -- this row is what would be silently cancelled beside the real one.
  execute harness_repo_sql('reminders_repo_insert')
    using pharmacy, patient, 'refill'::reminder_kind,
          '2026-04-20T09:00:00Z'::timestamptz,
          'A key only a prefix match would reach.'::text,
          (collected_key || ':2026-05-04T09:00:00.000Z')::text
    into rec;
  trailed := rec.id;
  trailed_stamp := rec.updated_at;

  n := 0;
  for rec in execute harness_repo_sql('reminders_repo_supersede_refill')
    using pharmacy, collected_key::text, 'the prescription was collected'::text
  loop
    n := n + 1;
    if rec.id is distinct from collected then
      raise exception 'ASSERT 18j: superseding touched %, which is not the reminder for the prescription being collected', rec.id;
    end if;
  end loop;
  if n <> 1 then
    raise exception 'ASSERT 18j: collecting one prescription changed % reminders, expected exactly 1', n;
  end if;

  execute harness_repo_sql('reminders_repo_find_by_id')
    using pharmacy, collected into rec;
  if rec.status::text <> 'not_sent' then
    raise exception 'ASSERT 18j: the collected prescription''s reminder is still %, so it is still in the partial index and the patient will be told to come in for medicine they are holding', rec.status;
  end if;
  if rec.not_sent_reason <> 'the prescription was collected' then
    raise exception 'ASSERT 18j: the superseded reminder gives its reason as %, expected the one passed; a not_sent with no reason beside it is refused by reminders_not_sent_has_reason, so what would replace it is a message the dashboard cannot show', coalesce(rec.not_sent_reason, 'null');
  end if;

  execute harness_repo_sql('reminders_repo_find_by_id')
    using pharmacy, beside into rec;
  if rec.status::text <> 'pending' then
    raise exception 'ASSERT 18j: an appointment reminder came back %, so the kind predicate is missing and collecting a prescription can cancel an appointment', rec.status;
  end if;
  if rec.updated_at <> beside_stamp then
    raise exception 'ASSERT 18j: an appointment reminder had updated_at moved from % to %, which is a revision nobody made', beside_stamp, rec.updated_at;
  end if;

  execute harness_repo_sql('reminders_repo_find_by_id')
    using pharmacy, elsewhere into rec;
  if rec.status::text <> 'pending' then
    raise exception 'ASSERT 18j: a refill for a different prescription came back %, so collecting one script cancels another', rec.status;
  end if;
  if rec.updated_at <> elsewhere_stamp then
    raise exception 'ASSERT 18j: a refill for a different prescription had updated_at moved from % to %, which is a revision nobody made', elsewhere_stamp, rec.updated_at;
  end if;

  execute harness_repo_sql('reminders_repo_find_by_id')
    using pharmacy, trailed into rec;
  if rec.status::text <> 'pending' then
    raise exception 'ASSERT 18j: a key that merely starts with the collected one came back %, so the statement matches by prefix where it should match exactly', rec.status;
  end if;
  if rec.updated_at <> trailed_stamp then
    raise exception 'ASSERT 18j: a key that merely starts with the collected one had updated_at moved from % to %, which is a revision nobody made', trailed_stamp, rec.updated_at;
  end if;

  -- The status predicate, proved by a second run rather than by a second row. The
  -- reminder is now not_sent, so the same statement with a different reason has to
  -- match nothing and rewrite nothing -- which is what stops a later collection, or
  -- two overlapping ones, from replacing the reason the first wrote.
  execute harness_repo_sql('reminders_repo_find_by_id')
    using pharmacy, collected into rec;
  collected_stamp := rec.updated_at;

  n := 0;
  for rec in execute harness_repo_sql('reminders_repo_supersede_refill')
    using pharmacy, collected_key::text, 'a reason nobody should ever read'::text
  loop
    n := n + 1;
  end loop;
  if n <> 0 then
    raise exception 'ASSERT 18j: a second supersede of the same prescription matched % row(s), expected 0; the status predicate is missing and superseding rewrites history instead of only stopping what has not happened yet', n;
  end if;

  execute harness_repo_sql('reminders_repo_find_by_id')
    using pharmacy, collected into rec;
  if rec.status::text <> 'not_sent' then
    raise exception 'ASSERT 18j: the refused second supersede left the status as %, expected the not_sent the first one wrote', rec.status;
  end if;
  if rec.not_sent_reason <> 'the prescription was collected' then
    raise exception 'ASSERT 18j: the refused second supersede overwrote the reason with %, so a reminder that was already dealt with has been re-explained by a run that matched nothing', coalesce(rec.not_sent_reason, 'null');
  end if;
  if rec.updated_at <> collected_stamp then
    raise exception 'ASSERT 18j: the refused second supersede moved updated_at from % to %, which is a revision nobody made and the same claim 18e and 18h make about their guards', collected_stamp, rec.updated_at;
  end if;

  raise notice 'ASSERT 18j passed: collecting a prescription superseded its one refill reminder and left an appointment beside it, a refill for a different script, and a key that merely starts with the collected one exactly as they were, and a second supersede matched nothing and rewrote nothing';
end $$;

deallocate reminders_repo_insert;
deallocate reminders_repo_find_by_id;
deallocate reminders_repo_list_due;
deallocate reminders_repo_list_upcoming;
deallocate reminders_repo_list_recent;
deallocate reminders_repo_outcome;
deallocate reminders_repo_supersede;
deallocate reminders_repo_supersede_refill;

-- ---------------------------------------------------------------------------
-- 19. The pharmacies repository: the read the reminder scheduler runs with
--     nobody signed in.
--
-- Section 8 proves the seed put exactly one pharmacy in the table. That is a fact
-- about the seed. This is the other half, and it is the half the scheduler
-- depends on: that asking the table for its ids finds that pharmacy.
--
-- `runReminders` takes its tenant from this query rather than from a PHARMACY_ID
-- variable, because a variable that is present and wrong fails silently -- the
-- run finds no due reminders for a pharmacy that has none, logs a clean summary
-- and exits zero while the real pharmacy's patients are never told anything. That
-- is the worst failure mode this system has, since what goes missing is what
-- nobody is looking at. A query cannot be wrong in that way, but only if it is
-- the query proved here.
--
-- 19a is the parse. 19b is the row, which is what turns "there is one pharmacy"
-- into "the scheduler will serve it".
-- ---------------------------------------------------------------------------
prepare pharmacies_repo_list_ids as
select id from pharmacies order by id;

do $$
begin
  raise notice 'ASSERT 19a passed: every pharmacies-repository statement parses against the migrated schema';
end $$;

do $$
declare
  seeded constant uuid := 'a0000000-0000-4000-8000-000000000001';
  rec record;
  n integer;
begin
  -- 19b. Counted in a loop rather than read with `into rec`, because `EXECUTE ...
  --      INTO` on no rows leaves a null record whose fields are indistinguishable
  --      from a row that genuinely held nulls -- the trap 18c documents. An empty
  --      result is not merely awkward here, it is the failure being guarded
  --      against: it is what makes `runReminders` refuse rather than report
  --      success against a database `db:apply` never reached.
  n := 0;
  for rec in execute harness_repo_sql('pharmacies_repo_list_ids')
  loop
    n := n + 1;
    if rec.id <> seeded then
      raise exception 'ASSERT 19b: the scheduler read found pharmacy %, expected the seeded %; a tenant the seed does not know about is a tenant whose reminders nobody has checked', rec.id, seeded;
    end if;
  end loop;
  if n <> 1 then
    raise exception 'ASSERT 19b: the scheduler read found % pharmacies, expected exactly 1; zero would make every run refuse, and two would mean 8a has stopped being true', n;
  end if;

  raise notice 'ASSERT 19b passed: the read the scheduler takes its tenant from finds the one seeded pharmacy';
end $$;

deallocate pharmacies_repo_list_ids;

drop function harness_repo_sql(text);

-- ---------------------------------------------------------------------------
-- Tidy up the harness's own rows. The container is throwaway, but leaving
-- test stock in a schema dump would put it in someone's production restore.
-- ---------------------------------------------------------------------------
delete from sale_item_batches
 where sale_item_id in (
   select si.id from sale_items si
     join sales s on s.id = si.sale_id
    where s.sale_number like 'HARNESS-SALE-%'
 );
delete from sale_items
 where sale_id in (select id from sales where sale_number like 'HARNESS-SALE-%');
-- Only this line carries the second predicate, and the two above it need no
-- change: sale_items, sale_item_batches and sale_payments all reference sales
-- with `on delete cascade`, read from init.sql rather than assumed. What does
-- not cascade is stock_movements.sale_id, which is `on delete set null`, so the
-- ledger survives its sale -- as it must, since a movement that disappeared with
-- the receipt would leave the stock figure un-derivable. Those rows go with the
-- product, four lines down, which cascades.
delete from sales
 where sale_number like 'HARNESS-SALE-%'
    or client_sale_id like 'harness-s13-%';
delete from inventory_batches
 where inventory_id in (select id from inventory where code like 'HARNESS-%');
delete from inventory where code like 'HARNESS-%';
delete from notifications where dedupe_key = 'harness-notify-1';
delete from notifications where dedupe_key like 'HARNESS-ALERT-%';
delete from notifications where dedupe_key like 'HARNESS-NOTIF-%';
-- Prescriptions before patients, and in that order for the reason 14h executes:
-- prescriptions.patient_id carries no on delete clause, so deleting the patient
-- first would be refused and leave both rows behind. What does cascade is
-- screenings, consultations and reminders, so those need no line of their own.
-- The predicate covers both halves of section 17's fixtures: the prescriptions
-- written against a harness patient, and the one 17c writes with no patient at all
-- but a harness prescriber name.
delete from prescriptions
 where patient_id in (select id from patients where full_name like 'Harness %')
    or prescriber_name like 'Harness %';
delete from patients where full_name like 'Harness %';
-- The conductor after the patients, because 16g proves `consultations.conducted_by`
-- restricts: deleting this user first would be refused with 23503, which is the
-- assertion and not the tidy-up.
delete from users where email = 'harness-conductor@aandb.example';
delete from users where email = 'harness-staff@aandb.example';
delete from users where email = 'harness-notifications-other@aandb.example';

select 'SCHEMA HARNESS: all assertions passed' as result;
