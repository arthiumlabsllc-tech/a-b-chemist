# A&B Chemist — Pharmacy Management Platform

A single-tenant pharmacy management platform built for one client: **A&B
Chemist**, a community pharmacy in Ghana. One pharmacy, one database, one
deployment. It is not a SaaS and carries no multi-tenant machinery.

`BRIEF.md` is the source of truth for what this system must and must not do.
Where code and the brief disagree, the brief wins until it is deliberately
amended.

## What is deliberately absent

- **The national health insurance scheme the client excluded.** It appears
  nowhere: not as a payment method, not as a patient identifier, not as a
  claims module, not in the schema, not in the UI copy. `npm run guard:terms`
  enforces this on every content change and on every file and directory name.
  The reason it is enforced by a script rather than by care is that the failure
  is silent — a leftover enum value still compiles, still passes its own tests,
  and still ships.
- **Public self-registration.** Staff accounts are created by the owner. Login,
  the health check and the signed payment webhook are the only unauthenticated
  endpoints.
- **Subscription billing.** There is one client and no plan tiers, so there is
  nothing to invoice.
- **Split payments, subaccounts and settlement ledgers.** A&B supply their own
  Paystack keys, so a customer's mobile money payment settles into A&B's
  account directly. Money never passes through the developer.
- **Card, bank transfer and credit (owe) tenders.** The till takes `cash` and
  `momo` and nothing else. Paystack is therefore charged with the mobile money
  channel only, and there is no debtor ledger — a customer who cannot pay has
  an unfinished sale, not an account. Adding a method later is one safe
  `ALTER TYPE ... ADD VALUE`; removing one after rows exist means rewriting the
  column, so the enum is authored at its final size.

## Layout

```
a-and-b-chemist/
  BRIEF.md                 the build brief; source of truth
  package.json             npm workspaces root
  tsconfig.base.json       strict compiler options every package extends
  scripts/
    guard-banned-terms.js  fails the build if the excluded scheme appears
  shared/                  money, tax and pricing engine; no runtime dependencies
    src/                   pure — `types: []` in its build config makes `process`,
                           `Buffer` and `window` compile errors in what ships
    scripts/
      mutation-test.cjs    breaks the engine on purpose to prove its tests go red
  backend/                 Express + TypeScript API
  frontend/                Next.js App Router + TypeScript + Tailwind
  database/
    init.sql               the whole schema, authored fresh
    migrations/            anything added after the initial schema
    tests/                 harness run against real Postgres 16 in Docker
```

## Getting started

```bash
npm install
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local

npm run db:verify     # apply the schema to Postgres 16 in Docker and run the harness
npm run db:apply      # apply the schema to the database in DATABASE_URL
npm run dev           # API and web together
```

## Verification

Every one of these must pass before a deploy. Nothing is committed, pushed or
deployed without an explicit instruction to do so.

```bash
npm run typecheck      # shared, backend and frontend
npm run test           # jest: shared, then backend, then frontend
npm run test:mutations # breaks the tax engine 29 ways; every one must be caught
npm run build          # shared first, then next build, then the API
npm run lint           # eslint, all three workspaces
npm run guard:terms    # the excluded-scheme check
npm run db:verify      # the schema harness, against real Postgres 16
```

A test that has never been seen to fail proves nothing, so each guard in this
repo has been demonstrated to go red when the behaviour it protects is broken.

## Money and data

Real money moves through this system and real patient health data is stored in
it. Patient records fall under the Data Protection Act, 2012 (Act 843), which is
why A&B have their own database and their own deployment rather than sharing
infrastructure with anyone else.

Tax follows the Value Added Tax Act, **2025** (Act 1151), in force from 1 January
2026: VAT 15%, the NHIL 2.5% and the GETFund levy 2.5%, all three charged on the
same base — 20% in total, with no cascade. The law it replaced added the levies
to the price first and charged VAT on the sum, which is 19 cedis wrong in every
1,000 and is what most existing Ghanaian code still does; `shared` is tested
against GRA's own published illustration, and against the pre-reform figures as
numbers it must **not** produce.

Most pharmaceuticals are exempt under the First Schedule, so a zero tax figure on
a medicine is correct behaviour rather than a missing calculation. Non-drug lines
— toiletries, cosmetics, devices — must be classified `standard` explicitly or
they will be sold without VAT. See `BRIEF.md` section 6.

## Deployment

- Backend: Render, from `backend/Dockerfile`, built with the **repository root**
  as the context; `render.yaml` is a Blueprint and already says so. The
  Dockerfile builds `shared/` before `backend/` and copies both `dist`
  directories into the runtime image. Neither is optional: `backend`
  resolves the shared package through its built output, so a missing build fails
  on an export that plainly exists in the source, and a missing `COPY` produces a
  container that builds, starts, and then cannot price a basket.
- Frontend: Vercel, from `frontend/`. It does not depend on `shared/` yet. When
  the till and the offline pricer do, the Vercel build command must build
  `shared` first for exactly the reason above — a bare `next build` will not, and
  the failure surfaces as a missing export rather than as a missing build step.
- Database: Supabase Postgres, using the **pooled IPv4** connection string.
  Supabase's direct host is IPv6-only and will not connect from Render's free
  tier.

Environment variables are documented in `backend/.env.example` and
`frontend/.env.example`. Paystack keys are left empty until A&B supply their
own; the till reports the gateway as unconfigured and falls back to honest
manual recording rather than pretending a payment was taken.
