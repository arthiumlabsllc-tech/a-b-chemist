-- A&B Chemist — initial schema.
--
-- Authored fresh against an EMPTY database. This file is not a migration and
-- is deliberately not idempotent: CREATE TYPE has no IF NOT EXISTS, and
-- pretending otherwise means wrapping every type in an exception-swallowing DO
-- block, which is how a failed apply gets reported as a success. Evolution
-- after this point lives in database/migrations/, where idempotency is
-- mandatory and each file ships its own verification.
--
-- Money is NUMERIC throughout. Quantities are integers in base units: a line
-- sold as a pack is converted at sale time using the product's pack_size, so
-- the batch ledger never holds two different units.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type user_role as enum ('pharmacy_owner', 'pharmacist', 'staff');

create type sale_status as enum (
  'pending', 'completed', 'voided', 'refunded', 'partially_refunded'
);

-- Exactly two tenders, on purpose. Postgres cannot drop a value from an enum:
-- growing this list later is one safe ALTER TYPE ... ADD VALUE, shrinking it
-- means a new type and a rewritten column, and fails while any row holds the
-- value being removed. So it starts at the size the client asked for.
create type sale_payment_method as enum ('cash', 'momo');

create type sale_payment_status as enum ('pending', 'succeeded', 'failed', 'reversed');

create type vat_treatment as enum ('standard', 'exempt', 'zero_rated');

create type prescription_status as enum ('pending', 'approved', 'rejected', 'dispensed');

create type consultation_type as enum ('in_person', 'video', 'chat', 'phone');

create type consultation_status as enum ('scheduled', 'completed', 'cancelled', 'no_show');

create type screening_type as enum (
  'blood_pressure', 'blood_sugar', 'bmi', 'weight', 'temperature', 'heart_rate'
);

create type risk_level as enum ('low', 'moderate', 'high');

create type notification_type as enum (
  'refill_reminder', 'appointment_reminder', 'stock_expiry', 'stock_reorder', 'product_recall'
);

-- 'not_sent' is a deliberate, honest state, distinct from 'failed': no SMS
-- provider is configured, so nothing was attempted and the UI must say so
-- rather than implying a message went out.
create type notification_status as enum ('pending', 'sent', 'not_sent', 'failed');

create type reminder_kind as enum ('refill', 'appointment');

create type stock_movement_type as enum (
  'opening', 'receive', 'adjust', 'write_off', 'sale', 'void_restore'
);

-- How a sale line counts units against a batch: 'pack' consumes pack_size
-- base units per unit sold.
create type sell_unit as enum ('single', 'pack');

create type gender as enum ('male', 'female', 'other', 'undisclosed');

-- ---------------------------------------------------------------------------
-- Shared trigger functions
-- ---------------------------------------------------------------------------

-- Maintains updated_at. Returns NEW, never NULL: a BEFORE trigger that returns
-- NULL silently skips the whole operation, which presents as "the row cannot
-- be updated" while every statement reports success.
create function set_updated_at() returns trigger
language plpgsql
as $$
begin
  -- clock_timestamp(), not now(): now() is frozen at transaction start, so an
  -- insert and an update in the same transaction would carry identical
  -- timestamps and within-transaction audit would be indistinguishable.
  new.updated_at = clock_timestamp();
  return new;
end;
$$;

-- Recomputes the four derived product columns from the batches. Runs on EVERY
-- update to inventory, which is what makes those columns unwritable: any value
-- supplied by a caller is overwritten here before the row is stored.
--
--   quantity     total base units on hand across batches holding stock,
--                including expired ones: physical stock and sellability are
--                different questions, and sellability is answered at query
--                time by the shared expiry rule (sellable ON the expiry date,
--                never after; undated always sellable).
--   batch_number lot of the batch that would be sold next (FEFO: earliest
--   expiry_date  expiry first, tie-break on received_at), so the product row
--                shows what the till is actually about to hand over.
--   cost_price   quantity-weighted average cost across batches holding stock:
--                a valuation figure. Cost of goods on a sale is snapshotted
--                per batch into sale_item_batches, never read from here.
create function recompute_inventory_from_batches() returns trigger
language plpgsql
as $$
declare
  leading_lot text;
  leading_expiry date;
  total_units integer;
  weighted_cost numeric;
begin
  select coalesce(sum(b.quantity), 0)
    into total_units
    from inventory_batches b
   where b.inventory_id = new.id and b.quantity > 0;

  select b.lot_number, b.expiry_date
    into leading_lot, leading_expiry
    from inventory_batches b
   where b.inventory_id = new.id and b.quantity > 0
   order by b.expiry_date nulls last, b.received_at, b.id
   limit 1;

  select coalesce(round(sum(b.quantity * b.cost_price) / nullif(sum(b.quantity), 0), 4), 0)
    into weighted_cost
    from inventory_batches b
   where b.inventory_id = new.id and b.quantity > 0;

  new.quantity = total_units;
  new.batch_number = leading_lot;
  new.expiry_date = leading_expiry;
  new.cost_price = weighted_cost;
  return new;
end;
$$;

-- The batch side of the derived-stock chain. This trigger does no arithmetic:
-- its UPDATE is the message. Touching inventory.updated_at fires the product's
-- BEFORE UPDATE triggers, and recompute_inventory_from_batches does the work.
-- Routing every batch change through one product-level recompute is what keeps
-- the four columns consistent no matter which statement moved the stock.
create function touch_inventory_after_batch_change() returns trigger
language plpgsql
as $$
declare
  target uuid;
begin
  target = coalesce(new.inventory_id, old.inventory_id);
  if target is not null then
    update inventory set updated_at = clock_timestamp() where id = target;
  end if;
  return null; -- AFTER trigger: the return value is ignored
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table pharmacies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  address text,
  -- Tax settings live here because they are per-pharmacy and owner-only to
  -- change; every sale snapshots them so a receipt shows the tax charged.
  tax_inclusive_pricing boolean not null default true,
  vat_rate numeric(5, 4) not null default 0.15,
  nhil_rate numeric(5, 4) not null default 0.025,
  getfund_rate numeric(5, 4) not null default 0.025,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger pharmacies_set_updated_at
  before update on pharmacies
  for each row execute function set_updated_at();

create table users (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies (id) on delete cascade,
  full_name text not null,
  email text not null,
  phone text,
  role user_role not null default 'staff',
  -- bcrypt output only. The seeded owner carries the literal 'UNSET', which is
  -- not a valid bcrypt string, so the account cannot authenticate until
  -- onboarding writes a real hash from an environment variable. A known
  -- password committed in a seed file is a password published to the repo.
  password_hash text not null,
  -- Deactivation, never deletion: historical sales must still show who served
  -- them, so a user row is forever.
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index users_email_key on users (lower(email));
create index users_pharmacy_idx on users (pharmacy_id);

create trigger users_set_updated_at
  before update on users
  for each row execute function set_updated_at();

create table patients (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies (id) on delete cascade,
  full_name text not null,
  phone text,
  date_of_birth date,
  gender gender,
  -- Arrays, not comma-joined text: allergies are queried, not displayed whole.
  allergies text[] not null default '{}',
  conditions text[] not null default '{}',
  medications text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index patients_pharmacy_idx on patients (pharmacy_id);
create index patients_pharmacy_phone_idx on patients (pharmacy_id, phone);

create trigger patients_set_updated_at
  before update on patients
  for each row execute function set_updated_at();

create table inventory (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies (id) on delete cascade,
  name text not null,
  code text not null,
  generic_name text,
  category text,
  manufacturer text,
  pack_size integer not null default 1 check (pack_size > 0),
  default_sell_unit sell_unit not null default 'single',
  shelf_location text,
  barcode text,
  requires_prescription boolean not null default false,
  reorder_level integer not null default 0 check (reorder_level >= 0),
  unit_price numeric(12, 2) not null default 0 check (unit_price >= 0),
  -- Medicines in HS Chapter 30 are exempt, so exempt is the default; but the
  -- classification stays an explicit editable column, because toiletries and
  -- devices sold by the same pharmacy are standard-rated and would otherwise
  -- be sold without VAT forever.
  vat_treatment vat_treatment not null default 'exempt',
  is_active boolean not null default true,

  -- DERIVED. Never write these: recompute_inventory_from_batches overwrites
  -- them on every update, so a supplied value is discarded, not stored.
  quantity integer not null default 0,
  batch_number text,
  expiry_date date,
  cost_price numeric(12, 4) not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pharmacy_id, code)
);

create index inventory_pharmacy_idx on inventory (pharmacy_id);
create index inventory_pharmacy_category_idx on inventory (pharmacy_id, category);

-- Named so it fires before ..._set_updated_at: triggers on the same event run
-- in name order, and the recompute must see the row before updated_at is
-- stamped (it does not read updated_at, but the ordering makes the chain
-- legible in \dy instead of accidental).
create trigger inventory_recompute_derived
  before update on inventory
  for each row execute function recompute_inventory_from_batches();

create trigger inventory_set_updated_at
  before update on inventory
  for each row execute function set_updated_at();

-- Batches are the source of truth for stock. The product row is a cache.
create table inventory_batches (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies (id) on delete cascade,
  inventory_id uuid not null references inventory (id) on delete cascade,
  lot_number text not null,
  -- NULL means undated, and undated stock is always sellable. The expiry rule
  -- is applied at query time, identically everywhere, never stored as a flag.
  expiry_date date,
  quantity integer not null default 0 check (quantity >= 0),
  cost_price numeric(12, 4) not null default 0 check (cost_price >= 0),
  -- FEFO tie-break. A future value is rejected at the API, not here, because
  -- the tie-break reads it and a clock-skewed receive must remain visible in
  -- the ledger rather than vanishing into a constraint violation.
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pharmacy_id, inventory_id, lot_number)
);

create index inventory_batches_inventory_idx on inventory_batches (inventory_id);
-- The FEFO read order, so allocation and the derived-column recompute are
-- index scans rather than sorts over every batch of every product.
create index inventory_batches_fefo_idx
  on inventory_batches (inventory_id, expiry_date nulls last, received_at);

create trigger inventory_batches_set_updated_at
  before update on inventory_batches
  for each row execute function set_updated_at();

create trigger inventory_batches_touch_inventory
  after insert or update or delete on inventory_batches
  for each row execute function touch_inventory_after_batch_change();

create table sales (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies (id) on delete cascade,
  sale_number text not null,
  status sale_status not null default 'pending',
  served_by uuid not null references users (id),
  -- Prescriptions need a second signature; NULL on everything else.
  approved_by uuid references users (id),
  patient_id uuid references patients (id),
  subtotal numeric(12, 2) not null default 0,
  discount numeric(12, 2) not null default 0 check (discount >= 0),
  -- Mandatory whenever a discount exists: an unexplained discount is the
  -- shape of a leak.
  discount_reason text,
  vat_amount numeric(12, 2) not null default 0,
  nhil_amount numeric(12, 2) not null default 0,
  getfund_amount numeric(12, 2) not null default 0,
  tax_total numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,
  amount_paid numeric(12, 2) not null default 0,
  -- Change exists only on a single cash tender. Mobile money cannot give
  -- change, so on any sale touching momo this stays zero by rule, enforced in
  -- the write path rather than by a constraint that cannot see the tenders.
  change_given numeric(12, 2) not null default 0,
  -- Tax snapshot: the receipt shows the tax actually charged, never a figure
  -- recomputed from whatever the rates happen to be today.
  vat_rate numeric(5, 4) not null,
  nhil_rate numeric(5, 4) not null,
  getfund_rate numeric(5, 4) not null,
  tax_inclusive_pricing boolean not null,
  -- Client-generated id so a response lost in flight cannot double-sell when
  -- the offline queue replays it.
  client_sale_id text,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pharmacy_id, sale_number)
);

create unique index sales_client_sale_id_key
  on sales (pharmacy_id, client_sale_id)
  where client_sale_id is not null;
create index sales_pharmacy_created_idx on sales (pharmacy_id, created_at desc);
create index sales_pharmacy_status_idx on sales (pharmacy_id, status);

create trigger sales_set_updated_at
  before update on sales
  for each row execute function set_updated_at();

create table sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales (id) on delete cascade,
  inventory_id uuid not null references inventory (id),
  -- Snapshot of the name at the moment of sale: renaming a product must not
  -- rewrite history on old receipts.
  description text not null,
  sell_unit sell_unit not null default 'single',
  quantity integer not null check (quantity > 0),
  unit_price numeric(12, 2) not null,
  line_gross numeric(12, 2) not null,
  line_discount numeric(12, 2) not null default 0,
  taxable_base numeric(12, 2) not null,
  vat_amount numeric(12, 2) not null default 0,
  nhil_amount numeric(12, 2) not null default 0,
  getfund_amount numeric(12, 2) not null default 0,
  line_total numeric(12, 2) not null,
  vat_treatment vat_treatment not null,
  created_at timestamptz not null default now()
);

create index sale_items_sale_idx on sale_items (sale_id);
create index sale_items_inventory_idx on sale_items (inventory_id);

-- The lot snapshot, and the reason voiding is safe. Each row records which
-- batch a sale line drew from and how much, so a void restores units to those
-- exact batches. Restoring onto the product row instead would be erased by
-- the derived-stock trigger and would credit a lot that never held the units.
create table sale_item_batches (
  id uuid primary key default gen_random_uuid(),
  sale_item_id uuid not null references sale_items (id) on delete cascade,
  batch_id uuid not null references inventory_batches (id),
  quantity integer not null check (quantity > 0),
  unit_cost numeric(12, 4) not null,
  created_at timestamptz not null default now()
);

create index sale_item_batches_sale_item_idx on sale_item_batches (sale_item_id);
-- Recall traceability: given a batch, every sale that contained it.
create index sale_item_batches_batch_idx on sale_item_batches (batch_id);

create table sale_payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales (id) on delete cascade,
  method sale_payment_method not null,
  status sale_payment_status not null default 'pending',
  amount numeric(12, 2) not null check (amount > 0),
  reference text,
  -- The gateway's own payload, kept verbatim so a dispute can be answered
  -- with evidence rather than with our recollection of it.
  gateway_response jsonb,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index sale_payments_sale_idx on sale_payments (sale_id);

create trigger sale_payments_set_updated_at
  before update on sale_payments
  for each row execute function set_updated_at();

-- Every movement, ever, signed. The stock figure must always be re-derivable
-- from this ledger alone; if it is not, something wrote stock without saying so.
create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies (id) on delete cascade,
  inventory_id uuid not null references inventory (id) on delete cascade,
  batch_id uuid references inventory_batches (id) on delete set null,
  sale_id uuid references sales (id) on delete set null,
  movement_type stock_movement_type not null,
  quantity_change integer not null check (quantity_change <> 0),
  quantity_after integer not null,
  -- Mandatory on adjust and write_off, enforced in the write path: the reason
  -- a constraint cannot express is that 'adjust' with no reason is indistinguishable
  -- from hiding something.
  reason text,
  note text,
  performed_by uuid not null references users (id),
  -- Superseded by migrations/0002: `now()` is transaction-start time, so every
  -- movement written in one transaction shares a timestamp and the ledger
  -- cannot be ordered. What ships is this file plus every migration.
  created_at timestamptz not null default now()
);

create index stock_movements_pharmacy_inventory_idx
  on stock_movements (pharmacy_id, inventory_id, created_at);
create index stock_movements_batch_idx on stock_movements (batch_id);

create table prescriptions (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies (id) on delete cascade,
  patient_id uuid references patients (id),
  sale_id uuid references sales (id) on delete set null,
  prescriber_name text,
  status prescription_status not null default 'pending',
  approved_by uuid references users (id),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index prescriptions_pharmacy_idx on prescriptions (pharmacy_id);
create index prescriptions_patient_idx on prescriptions (patient_id);

create trigger prescriptions_set_updated_at
  before update on prescriptions
  for each row execute function set_updated_at();

create table consultations (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies (id) on delete cascade,
  patient_id uuid not null references patients (id) on delete cascade,
  conducted_by uuid references users (id),
  type consultation_type not null,
  status consultation_status not null default 'scheduled',
  scheduled_at timestamptz not null,
  duration_minutes integer check (duration_minutes is null or duration_minutes >= 0),
  -- Video is a link-out. Building media infrastructure for a pharmacy that
  -- books a handful of consultations a month is spending the client's money on
  -- the wrong problem.
  video_url text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index consultations_pharmacy_scheduled_idx
  on consultations (pharmacy_id, scheduled_at);
create index consultations_patient_idx on consultations (patient_id);

create trigger consultations_set_updated_at
  before update on consultations
  for each row execute function set_updated_at();

create table screenings (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies (id) on delete cascade,
  patient_id uuid not null references patients (id) on delete cascade,
  recorded_by uuid not null references users (id),
  type screening_type not null,
  risk_level risk_level not null default 'low',
  -- Nullable measurements rather than a jsonb blob: each is queried, ranged
  -- and charted, and a screening records only what was actually measured.
  systolic_bp integer check (systolic_bp is null or systolic_bp > 0),
  diastolic_bp integer check (diastolic_bp is null or diastolic_bp > 0),
  blood_glucose_mmol numeric(5, 2),
  weight_kg numeric(5, 2),
  height_cm numeric(5, 1),
  bmi numeric(4, 1),
  temperature_c numeric(4, 1),
  heart_rate_bpm integer,
  measured_at timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now()
);

create index screenings_pharmacy_patient_idx on screenings (pharmacy_id, patient_id);
create index screenings_patient_measured_idx on screenings (patient_id, measured_at desc);

-- The bell reads this table; it does not re-derive reminders on every load.
create table notifications (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies (id) on delete cascade,
  -- NULL means every staff member sees it; a set value targets one user.
  user_id uuid references users (id) on delete cascade,
  type notification_type not null,
  status notification_status not null default 'pending',
  title text not null,
  body text,
  related_type text,
  related_id uuid,
  -- Deduplication against history: an alert that already exists under this
  -- key is not re-raised on the next refresh.
  dedupe_key text not null,
  not_sent_reason text,
  sent_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pharmacy_id, dedupe_key)
);

create index notifications_pharmacy_status_idx on notifications (pharmacy_id, status);
create index notifications_user_unread_idx
  on notifications (user_id, created_at desc)
  where read_at is null;

create trigger notifications_set_updated_at
  before update on notifications
  for each row execute function set_updated_at();

create table reminders (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies (id) on delete cascade,
  patient_id uuid not null references patients (id) on delete cascade,
  kind reminder_kind not null,
  due_at timestamptz not null,
  message text not null,
  status notification_status not null default 'pending',
  -- The notification row this reminder raised, once it raised one.
  notification_id uuid references notifications (id) on delete set null,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pharmacy_id, dedupe_key)
);

create index reminders_pharmacy_due_idx on reminders (pharmacy_id, due_at)
  where status = 'pending';

create trigger reminders_set_updated_at
  before update on reminders
  for each row execute function set_updated_at();

-- Replay protection for the offline queue and for any client that retries a
-- write: same pharmacy, same scope, same key returns the stored response
-- instead of performing the work twice.
create table idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies (id) on delete cascade,
  scope text not null,
  key text not null,
  request_hash text not null,
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (pharmacy_id, scope, key)
);

create index idempotency_keys_expires_idx on idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- Seed: exactly one pharmacy and its owner. Single tenant, no choosing UI.
-- ---------------------------------------------------------------------------

insert into pharmacies (
  id, name, phone, email, address
) values (
  'a0000000-0000-4000-8000-000000000001',
  'A&B Chemist',
  null,
  null,
  null
) on conflict (id) do nothing;

insert into users (
  id, pharmacy_id, full_name, email, role, password_hash
) values (
  'a0000000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000001',
  'Owner',
  'owner@localhost',
  'pharmacy_owner',
  'UNSET'
) on conflict (id) do nothing;
