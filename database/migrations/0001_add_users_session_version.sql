-- 0001: users.session_version
--
-- Why this exists: deactivating a staff member must stop their till session
-- now, not when their access token happens to expire. A JWT is stateless, so
-- the only honest way to revoke one is a server-side number the token carries
-- and the server compares: bump the number and every outstanding token for
-- that user — access and refresh — fails its next check.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, so re-running this file is a no-op.

alter table users
  add column if not exists session_version integer not null default 0;

comment on column users.session_version is
  'Bumped on deactivation, password reset and logout; tokens carry the value they were signed with and fail once it moves.';
