-- Verification for 0001_add_users_session_version.
-- Asserts row-level outcomes, not merely that the migration completed.

do $$
declare
  col record;
  seeded integer;
  bumped integer;
begin
  select column_name, data_type, is_nullable, column_default
    into col
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'users'
     and column_name = 'session_version';

  if col.column_name is null then
    raise exception 'VERIFY 0001a: users.session_version does not exist';
  end if;
  if col.data_type <> 'integer' or col.is_nullable <> 'NO' then
    raise exception 'VERIFY 0001b: session_version is % %', col.data_type, col.is_nullable;
  end if;
  if col.column_default is distinct from '0' then
    raise exception 'VERIFY 0001c: session_version default is %', col.column_default;
  end if;

  -- Every existing row, including the seeded owner, must carry 0: a NULL or
  -- absent default would leave old rows unable to match any new token.
  select coalesce(min(session_version), -1) into seeded from users;
  if seeded <> 0 then
    raise exception 'VERIFY 0001d: existing rows do not all carry 0 (min %)', seeded;
  end if;

  -- The revocation mechanic itself: bumping the value must be an ordinary
  -- update, because that is what the deactivation path will do.
  update users
     set session_version = session_version + 1
   where id = 'a0000000-0000-4000-8000-000000000002';
  select session_version into bumped
    from users
   where id = 'a0000000-0000-4000-8000-000000000002';
  if bumped <> 1 then
    raise exception 'VERIFY 0001e: bumping session_version produced %', bumped;
  end if;
  update users
     set session_version = 0
   where id = 'a0000000-0000-4000-8000-000000000002';

  raise notice 'VERIFY 0001 passed: session_version exists, defaults to 0, and bumps';
end $$;
