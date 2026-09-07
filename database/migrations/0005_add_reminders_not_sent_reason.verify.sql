-- Verification for 0005_add_reminders_not_sent_reason.
-- Asserts row-level outcomes, not merely that the migration completed.
--
-- Behaviour first and the catalog last, as in 0003: the two halves are
-- independent here too, and putting the inserts first means a database with no
-- constraint at all goes red on the unsent reminder that was accepted rather than
-- on a missing catalog entry. The accepted unsent reminder is the fault that
-- matters, because it is the one that leaves a dashboard saying "not sent" with
-- nothing beside it and no way to tell a missing provider from a missed attempt.
--
-- The two reasons the column exists for are both written below as real rows: the
-- absent SMS provider, which is every reminder this deployment sends, and the
-- rescheduled appointment, which supersedes a reminder that would otherwise still
-- fire for a slot nobody is expecting the patient at.

do $$
declare
  pharmacy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  due constant timestamptz := '2026-04-20T09:00:00Z';
  patient uuid;
  refused text;
  landed integer;
  absent integer;
  defaulted record;
  column_found boolean;
  column_nullable boolean;
  column_type text;
  constraint_found boolean;
  constraint_kind text;
  constraint_text text;
begin
  -- Left behind by a run of this file that failed before its own cleanup. Removed
  -- first so the file can be run twice against one database, which is how it gets
  -- run while it is being written.
  delete from reminders where dedupe_key like 'h5:%';
  delete from patients where full_name = 'Harness Migration 0005';

  insert into patients (pharmacy_id, full_name)
  values (pharmacy, 'Harness Migration 0005') returning id into patient;

  -- 0005a: the assertion the migration exists for. A reminder that was not sent
  --        has to say why, because the dashboard shows reminders rather than the
  --        notifications they raise and "not sent" on its own is two different
  --        facts wearing one label.
  refused := null;
  begin
    insert into reminders (pharmacy_id, patient_id, kind, due_at, message,
                           status, dedupe_key)
    values (pharmacy, patient, 'refill', due,
            'Your blood pressure script is due for a refill.',
            'not_sent', 'h5:unsent-no-reason');
  exception
    when others then
      refused := sqlstate;
  end;
  -- `is distinct from` and not `<>`: an insert that succeeded leaves the variable
  -- null, and `null <> '23514'` is null, which an `if` reads as false and the
  -- assertion would pass on exactly the outcome it exists to refuse.
  if refused is distinct from '23514' then
    raise exception 'VERIFY 0005a: a reminder written not_sent with no reason was accepted with %, expected 23514 from reminders_not_sent_has_reason', coalesce(refused, 'no error at all');
  end if;

  -- 0005b: and the same for `failed`, which the constraint names beside
  --        `not_sent`. A provider that was reached and refused is the one case
  --        where the reason is most worth having, since it is the only one where
  --        somebody can act on it by checking a phone number.
  refused := null;
  begin
    insert into reminders (pharmacy_id, patient_id, kind, due_at, message,
                           status, dedupe_key)
    values (pharmacy, patient, 'refill', due,
            'Your blood pressure script is due for a refill.',
            'failed', 'h5:failed-no-reason');
  exception
    when others then
      refused := sqlstate;
  end;
  if refused is distinct from '23514' then
    raise exception 'VERIFY 0005b: a reminder written failed with no reason was accepted with %, expected 23514', coalesce(refused, 'no error at all');
  end if;

  -- 0005c: the reason this deployment actually writes, on every reminder the
  --        scheduler picks up.
  insert into reminders (pharmacy_id, patient_id, kind, due_at, message,
                         status, not_sent_reason, dedupe_key)
  values (pharmacy, patient, 'refill', due,
          'Your blood pressure script is due for a refill.',
          'not_sent', 'no SMS provider is configured', 'h5:notsent-with-reason');

  -- 0005d: the second reason, and the case that decided the column had to exist.
  --        `notification_status` has no `cancelled` value and `reminders` has no
  --        `consultation_id`, so a reminder superseded by a reschedule leaves
  --        `pending` as `not_sent` — true, since nothing was attempted — and the
  --        reason is the only thing keeping it apart from 0005c.
  insert into reminders (pharmacy_id, patient_id, kind, due_at, message,
                         status, not_sent_reason, dedupe_key)
  values (pharmacy, patient, 'appointment', due,
          'Your consultation is tomorrow at 9am.',
          'not_sent', 'the appointment was rescheduled', 'h5:superseded');

  -- 0005e: the scheduler's queue still has to be writable. A constraint that made
  --        a reason mandatory everywhere would refuse the ordinary case, which is
  --        a reminder that has not been reached yet and has nothing to report.
  insert into reminders (pharmacy_id, patient_id, kind, due_at, message,
                         status, dedupe_key)
  values (pharmacy, patient, 'refill', due,
          'Your blood pressure script is due for a refill.',
          'pending', 'h5:pending-no-reason');

  -- 0005f: and `sent` needs no reason either, which is the other half of why the
  --        constraint runs in one direction only.
  insert into reminders (pharmacy_id, patient_id, kind, due_at, message,
                         status, dedupe_key)
  values (pharmacy, patient, 'appointment', due,
          'Your consultation is tomorrow at 9am.',
          'sent', 'h5:sent-no-reason');

  -- 0005g: the permitted converse, asserted rather than left to be discovered.
  --        A `pending` reminder carrying a reason is allowed on purpose; refusing
  --        it would add a failure mode and remove nothing.
  insert into reminders (pharmacy_id, patient_id, kind, due_at, message,
                         status, not_sent_reason, dedupe_key)
  values (pharmacy, patient, 'refill', due,
          'Your blood pressure script is due for a refill.',
          'pending', 'no SMS provider is configured', 'h5:pending-with-reason');

  -- 0005h: an ALTER TABLE that rebuilt the table would be a way to disturb the
  --        column default, and the repository's insert does not name `status` at
  --        all — it relies on the default the way consultations and prescriptions
  --        rely on theirs. Proved here rather than assumed from init.sql.
  insert into reminders (pharmacy_id, patient_id, kind, due_at, message, dedupe_key)
  values (pharmacy, patient, 'refill', due,
          'Your blood pressure script is due for a refill.', 'h5:default-status')
  returning status, not_sent_reason into defaulted;
  if defaulted.status::text <> 'pending' then
    raise exception 'VERIFY 0005h: a reminder created without naming a status came back %, expected the pending default', defaulted.status;
  end if;
  if defaulted.not_sent_reason is not null then
    raise exception 'VERIFY 0005h: a new pending reminder came back with the reason %, expected none; a queue that starts out labelled unsent is a dashboard that starts out apologising', defaulted.not_sent_reason;
  end if;

  -- 0005i: every row the six inserts above expected to land, landed, and neither
  --        refused row is secretly among them. Without the second half a
  --        constraint that fired on the wrong insert could still show a correct
  --        total by refusing one row and accepting another.
  select count(*)::int into landed from reminders where dedupe_key like 'h5:%';
  if landed <> 6 then
    raise exception 'VERIFY 0005i: % reminders landed, expected 6', landed;
  end if;
  select count(*)::int into absent
    from reminders
   where dedupe_key in ('h5:unsent-no-reason', 'h5:failed-no-reason');
  if absent <> 0 then
    raise exception 'VERIFY 0005i: % of the two refused reminders are in the table, expected 0; a check violation inside a begin/exception block rolls back to the block, so a row here means the constraint did not fire', absent;
  end if;

  -- 0005j..l: the catalog, so the shape the behaviour implies is also the shape
  --           that ships. Read with aggregates rather than `select ... into
  --           record`: a record target left unassigned by a query that returned no
  --           rows raises on field access, so the "does it exist" branch would
  --           report a PL/pgSQL error instead of its own message.
  select count(*) > 0,
         bool_or(c.is_nullable = 'YES'),
         max(c.data_type)
    into column_found, column_nullable, column_type
    from information_schema.columns c
   where c.table_name = 'reminders' and c.column_name = 'not_sent_reason';

  if not column_found then
    raise exception 'VERIFY 0005j: reminders.not_sent_reason does not exist';
  end if;
  if column_nullable is distinct from true then
    raise exception 'VERIFY 0005k: reminders.not_sent_reason exists but is not nullable, which would make a pending reminder unwritable';
  end if;
  if column_type is distinct from 'text' then
    raise exception 'VERIFY 0005k: reminders.not_sent_reason is %, expected text to match notifications.not_sent_reason beside it', coalesce(column_type, '(none)');
  end if;

  select count(*) > 0,
         max(con.contype::text),
         max(pg_get_constraintdef(con.oid))
    into constraint_found, constraint_kind, constraint_text
    from pg_constraint con
   where con.conrelid = 'public.reminders'::regclass
     and con.conname = 'reminders_not_sent_has_reason';

  if not constraint_found then
    raise exception 'VERIFY 0005l: constraint reminders_not_sent_has_reason does not exist, so the reason is a convention in the service rather than a fact about the schema';
  end if;
  if constraint_kind is distinct from 'c' then
    raise exception 'VERIFY 0005l: reminders_not_sent_has_reason is of kind %, expected c for a check constraint', coalesce(constraint_kind, '(none)');
  end if;
  -- Both statuses named, and the column they depend on. Asserted on the rendered
  -- definition rather than on the migration's text, because what the server stored
  -- is what the server enforces.
  if position('not_sent' in constraint_text) = 0
     or position('failed' in constraint_text) = 0
     or position('not_sent_reason' in constraint_text) = 0 then
    raise exception 'VERIFY 0005l: the constraint definition is %, expected it to name not_sent, failed and not_sent_reason', constraint_text;
  end if;

  delete from reminders where dedupe_key like 'h5:%';
  delete from patients where id = patient;

  raise notice 'VERIFY 0005 passed: an unsent reminder has to give a reason, a pending one does not, and the default status survived the column being added';
end $$;
