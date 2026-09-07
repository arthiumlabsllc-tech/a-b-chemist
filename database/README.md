# database/

The schema for A&B Chemist, authored fresh against an empty database.

## Layout

- `init.sql` — the whole initial schema: enums, tables, indexes, triggers and
  the seed for one pharmacy and its owner. Targets an **empty** database and is
  deliberately not idempotent; `CREATE TYPE` has no `IF NOT EXISTS`, and
  wrapping every statement in exception-swallowing blocks is how a failed
  apply gets reported as a success.
- `migrations/` — every change after the initial schema. Each file **must** be
  idempotent and ship with verification, see `migrations/README.md`.
- `tests/assertions.sql` — row-level and parse-time assertions run against the
  applied schema.
- `docker-compose.yml` — the harness: a throwaway Postgres 16 and a psql client
  that applies `init.sql` then runs the assertions.

## Running the harness

From the repository root:

```
npm run db:verify
```

It applies the schema to an in-memory Postgres 16, runs every assertion, and
exits non-zero on the first failure. Containers left behind after a failed run
can be removed with `npm run verify:down --workspace=database`.

## Rules this directory enforces

- Money is `NUMERIC`. Quantities are integers in base units.
- The four derived product columns (`quantity`, `batch_number`, `expiry_date`,
  `cost_price`) are recomputed by trigger and must never be written.
- `set_updated_at` returns `NEW`, never `NULL`, and stamps
  `clock_timestamp()` so two writes in one transaction remain distinguishable.
- Every business table carries `pharmacy_id`.
- Parameterised SQL that touches an enum column casts the parameter
  explicitly, with a comment saying the cast is load-bearing.
