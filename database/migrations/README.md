# migrations/

Every schema change after `init.sql` lands here as one numbered file, applied
in order, each one idempotent and each one shipped with its own verification.

## Naming

`0001_short_description.sql`, `0002_...` — the number is the order and the
order is never rewritten. A migration that has been applied anywhere is never
edited; a correction is a new migration.

## Idempotency is mandatory

A migration may run twice: once in the harness, once against a database the
client applied it to by hand. Every statement must survive the second run.

- `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`
- `ADD COLUMN IF NOT EXISTS`
- New enum values: `ALTER TYPE ... ADD VALUE IF NOT EXISTS` (note: this
  statement cannot run inside a transaction block, so a migration containing
  one must not be wrapped in `BEGIN`/`COMMIT`)
- Anything else: `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;`

## Verification is mandatory

Each migration ships a `0001_short_description.verify.sql` that runs against
real Postgres and asserts **row-level outcomes**, not merely that the
statement completed. A migration whose verification has never been seen fail
is unverified: break the migration temporarily and confirm the verification
goes red before trusting it.

### A catalog check can make the behavioural half unbreakable

Verify files here check the catalog first (`information_schema`) and the
behaviour second, so that a fault is named where it is rather than reported as
a downstream symptom. That ordering has a cost worth knowing about before you
write 0005.

If the catalog check is a *complete precondition* for the behaviour, then no
database can pass the first and fail the second, and the behavioural assertions
can never be seen red through the real file. `0004` is exactly that shape:
three columns either default to `clock_timestamp()` or they do not, and if they
do, the ordering follows. Proving the behavioural half had teeth meant copying
it into a scratch file with the catalog check taken out and running that against
an unmigrated schema — where it reported `1/1/1` distinct timestamps instead of
`3/3/3`.

Do that, or write the behavioural assertion so it can fail on its own. What you
cannot do is claim a test has been seen red when the only reds it can produce
are the ones a different assertion in the same file fires first.

## What a migration must never do

- Drop a value from an enum. Postgres cannot: it means a new type and a
  rewritten column, and it fails outright while any row holds the value.
  Grow enums, never shrink them.
- Touch production. Migrations are produced as SQL for the client to apply.
