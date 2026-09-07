-- 0005: reminders carry the reason they were not sent
--
-- Why this exists: Phase 8's acceptance line is that every reminder which has not
-- been sent is labelled as not sent *and why*. `notifications` has had a
-- `not_sent_reason` column since init.sql, and a reminder that reaches the
-- scheduler raises one, so for that path the reason had a home. Two cases did not.
--
-- The first is the ordinary one for this deployment: there is no SMS provider
-- configured, so every reminder the scheduler picks up is written `not_sent`. The
-- notification it raises can say so, but the reminder list on the dashboard shows
-- reminders and not notifications, and without a column here that list can say
-- "not sent" and nothing else. A pharmacist reading it cannot tell "we have no way
-- to send this" from "we tried and it did not go", which are different sentences
-- requiring different responses — one is a setting somebody has to change and the
-- other is a phone number somebody has to check.
--
-- The second is the case that decides it. An appointment reminder is keyed to the
-- consultation *and its scheduled time*, so rescheduling raises a fresh reminder
-- for the new slot. The old one is still `pending`, still in
-- `reminders_pharmacy_due_idx`, and still due: left alone it fires for a meeting
-- that no longer exists, and the patient is told to come in on a day nobody is
-- expecting them. `reminders` has no `consultation_id` — it points at a
-- consultation only through text in `dedupe_key` — so superseding it means moving
-- it out of `pending`, and `notification_status` has no `cancelled` value. The
-- honest value available is `not_sent`: nothing was attempted, and that is true.
-- But it was not sent for a different reason than the provider being absent, and
-- with no column to hold the reason the two become the same row. This codebase
-- keeps `no_show` apart from `cancelled` and `undisclosed` apart from null for
-- exactly that kind of difference; this is the same argument on a third table.
--
-- So the column, and a check constraint that makes the acceptance line a fact
-- about the schema rather than a convention in the service. The constraint runs in
-- one direction only: a `not_sent` or `failed` reminder must give a reason. The
-- converse — a `pending` reminder carrying one — is deliberately permitted rather
-- than refused, because forbidding it would add a failure mode and remove nothing:
-- a row that has not been reached yet simply has no reason to record, and the
-- scheduler writes the status and the reason in one statement when it does.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and DROP CONSTRAINT IF NOT EXISTS before
-- the ADD. Adding a check constraint validates the rows already there, so if a
-- database holds a `not_sent` reminder with no reason this migration fails —
-- correctly, and loudly, because that row is the state this migration exists to
-- make impossible and shipping past it would leave the acceptance line untrue of
-- the data. A&B Chemist has no deployed reminders yet, so there is nothing to
-- repair; the sentence is here for the next database this runs against.

alter table reminders add column if not exists not_sent_reason text;

alter table reminders drop constraint if exists reminders_not_sent_has_reason;
alter table reminders add constraint reminders_not_sent_has_reason
  check (status not in ('not_sent', 'failed') or not_sent_reason is not null);

comment on column reminders.not_sent_reason is
  'Why nothing was sent. Required beside a status of not_sent or failed by reminders_not_sent_has_reason, because an unsent reminder with no reason cannot be told apart from one somebody forgot to look at. Two reasons occur in practice: no SMS provider is configured, which is every reminder this deployment sends, and the appointment was rescheduled, which supersedes a reminder that would otherwise still fire for a slot that no longer exists.';

comment on constraint reminders_not_sent_has_reason on reminders is
  'One direction only: not_sent and failed must give a reason. A pending reminder is permitted to carry one, since refusing that would add a failure mode and remove nothing.';
