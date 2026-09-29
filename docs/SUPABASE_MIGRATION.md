# Supabase Foundation — CG Laser Tracker

Phase 3A deliverable. This document covers the database/security foundation
established in `supabase/migrations/20260929120000_create_laser_tracker_foundation.sql`.
**No application cutover has happened.** `src/App.jsx` still reads/writes
Firebase Firestore exclusively; nothing here is wired into the running app yet.

## Schema

Single table, matching the existing Firestore `laser_jobs` collection plus
migration/audit fields:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()`. Firestore doc IDs are **not** reused as the new PK — see [CSV → Supabase mapping](#csv--supabase-mapping). |
| `legacy_firebase_id` | `text`, nullable, `UNIQUE` | Original Firestore doc ID. Only set on rows brought in via CSV migration. `NULL` for normal app-created rows. Postgres `UNIQUE` allows multiple `NULL`s, so "nullable" and "unique when present" fall out of the plain constraint with no partial-index trick needed. |
| `tanggal` | `date` NOT NULL | |
| `operator` | `text` NOT NULL, non-blank check | |
| `invoice_code` | `text`, nullable | |
| `customer` | `text`, nullable | |
| `deskripsi` | `text`, nullable | |
| `jumlah_unit` | `integer` NOT NULL, `CHECK > 0` | |
| `harga_per_unit` | `numeric(14,2)` NOT NULL, `CHECK >= 0` | |
| `durasi_menit` | `integer` NOT NULL, `CHECK >= 0` | |
| `total_penghasilan` | `numeric(16,2)` NOT NULL, **generated** | See [Business integrity](#business-integrity). |
| `created_at` | `timestamptz` NOT NULL, default `now()` | On migration import, this is set explicitly from the CSV value, not defaulted. |
| `updated_at` | `timestamptz` NOT NULL, default `now()`, trigger-maintained | App code never sets this. |

## Business integrity: `total_penghasilan`

**Chosen approach: generated stored column** — `GENERATED ALWAYS AS
(jumlah_unit * harga_per_unit) STORED`, not a `CHECK` constraint.

Why generated column over CHECK:

- A `CHECK (total_penghasilan = jumlah_unit * harga_per_unit)` only rejects
  a client-supplied mismatch at write time — it's still the client
  computing and sending the value, so a client bug, a stale cache, or a
  future code path that forgets to recompute it becomes a hard write
  failure instead of a class of bug that can't exist in the first place.
- `NUMERIC(14,2) * NUMERIC(14,2)` can produce more decimal places than the
  target `NUMERIC(16,2)`; a CHECK doing an exact equality comparison would
  need a tolerance band (as the app-level CSV validator already does, see
  `src/lib/csvMigration.js`), adding complexity the generated column avoids
  entirely — Postgres rounds/stores the computed value once, consistently.
- It is strictly less code: no separate constraint to keep in sync with
  the two source columns, and `total_penghasilan` literally cannot be
  inserted or updated directly (Postgres rejects any attempt to write to a
  generated column), so drift is structurally impossible rather than just
  checked-for.

Trade-off, noted for completeness: CSV migration rows carry a
`total_penghasilan` value from Firestore. That value is **not** written to
the column — Postgres computes its own. The CSV-level drift check (Section
6 of the CSV migration hardening, `src/lib/csvMigration.js` `validateRow`)
already rejects any row where the *stored* Firestore total disagrees with
`jumlah_unit * harga_per_unit` before the row is ever considered for
import, so by the time a row reaches Supabase, the generated value and the
original Firestore value are already known to agree.

## Indexes

| Index | Justification |
|---|---|
| `idx_laser_jobs_tanggal` (btree, `tanggal DESC`) | The report/dashboard view sorts by production date today (client-side) and will do so server-side post-migration; this is the one query pattern that is both hot and already proven by the existing app. |
| (implicit) unique index on `legacy_firebase_id` | Comes free with the `UNIQUE` constraint; not a separate index. |

**Not indexed, deliberately:** `invoice_code` (no current filter/search use
case) and `created_at` (no current range-query use case; `tanggal` already
covers date-based sorting). This is a small, single-shop operational table
— add these later only if a real, frequent query pattern needs them.

## Auth model

Supabase Auth (email/password, or magic link — either works with the
schema below; not prescribed here) + Postgres Row Level Security. Two
roles, tracked in `public.profiles`:

- **operator** — default role for any newly created Supabase Auth user
  (auto-provisioned via an `auth.users` trigger). Can view job history,
  create new jobs.
- **admin** — everything operator can do, plus update/delete any job and
  run the CSV migration import.

Role is read via `public.current_user_role()`, a `SECURITY DEFINER`
function so RLS policies on `laser_jobs` can consult `profiles` without
running into RLS recursion. Role is **never** read from `auth.users` email,
JWT claims set by the client, or any frontend-supplied value — it always
comes from the server-side `profiles` row for `auth.uid()`.

## RLS policy matrix

| Operation | `anon` (no session) | `authenticated` operator | `authenticated` admin |
|---|---|---|---|
| SELECT | ❌ denied | ✅ all rows | ✅ all rows |
| INSERT (ordinary job, no `legacy_firebase_id`) | ❌ denied | ✅ | ✅ |
| INSERT (migration row, `legacy_firebase_id` set) | ❌ denied | ❌ denied | ✅ |
| UPDATE | ❌ denied | ❌ denied | ✅ |
| DELETE | ❌ denied | ❌ denied | ✅ |

This satisfies every explicit requirement from Phase 3A: normal operators
cannot update/delete historical jobs, admins retain full CRUD, and CSV
migration (any insert carrying `legacy_firebase_id`) cannot be executed by
an anonymous or operator-level browser session. No `anon`-role policy
exists at all on `laser_jobs`, so the Supabase anon key alone — without a
logged-in session — grants zero access, sidestepping the "unrestricted
`anon INSERT WITH CHECK (true)`" risk flagged in the task explicitly.

### DECISION REQUIRED — public/anonymous read access

The current Firebase app lets anyone with the page open see the full job
history and dashboard totals, no login required. This design requires
authentication for `SELECT` too. If the business wants the dashboard/report
view to remain viewable without login (e.g. a shop-floor display screen
that nobody signs into), that needs a deliberate, separate `anon` SELECT
policy — a real product decision, not something to default silently. Not
implemented in this migration pending that decision.

### DECISION REQUIRED — operator login for ordinary job entry

Today, `ADMIN_PASSWORD` gates edit/delete only; **anyone** can create a new
job entry with zero authentication — that's the actual current production
workflow (shop floor operators just use the page). This design requires
every write, including ordinary job creation, to come from an
authenticated session, which is a genuine operational change: floor staff
would need to sign in (individually or via one shared "operator" account)
before logging a job.

This is the safest simple model available and is the one recommended by
the task brief ("prefer authenticated users if that preserves operational
usability"), but *how* operators authenticate — individual accounts vs. one
shared kiosk/operator login — is a product/ops call this document
deliberately does not make. Recommendation for evaluation: a single shared
"operator" Supabase Auth account (one login, used by whoever is at the
laser station) is a common low-friction middle ground for a shop-floor
kiosk of this size, but confirm with the product owner before bootstrapping
it.

## Environment contract

Future client env vars (not yet consumed by any code — `src/App.jsx` is
still 100% Firebase):

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
```

See `.env.example` (placeholders only). `.env`, `.env.local`, and
`.env.*.local` are gitignored. The anon key is safe for the browser bundle
*only because* RLS is enabled on every table above — never put a
`service_role` key in a `VITE_`-prefixed variable, since Vite inlines those
into client-shipped JavaScript.

## Admin / operator bootstrap

No passwords, tokens, or credentials are ever committed to this
repository. First-admin setup is a manual, one-time action against the
real Supabase project:

1. Create the Supabase project under the `ciptadigi-design` organization
   (not done in this phase — no project exists yet; see status below).
2. Apply this migration (`supabase db push`, or paste the SQL into the
   Supabase SQL Editor).
3. In the Supabase Dashboard → Authentication → Users, create (or invite)
   the first real user account for whoever will be the admin.
   `public.handle_new_user()` auto-creates their `profiles` row with
   `role = 'operator'`.
4. Promote that one user to admin with a one-time SQL statement run
   directly in the Supabase SQL Editor (not from the app, not committed
   anywhere):
   ```sql
   update public.profiles set role = 'admin' where id = '<their auth.users id>';
   ```
5. Any subsequent operator accounts (individual or shared, per the
   decision above) sign up/are invited the same way and stay at the
   default `operator` role unless explicitly promoted via the same
   one-time SQL step.

## Applying the migration

Once a Supabase project exists and the CLI is linked (`supabase link
--project-ref <ref>`):

```
supabase db push
```

Or paste the contents of
`supabase/migrations/20260929120000_create_laser_tracker_foundation.sql`
directly into the Supabase SQL Editor. The migration is idempotent
(`IF NOT EXISTS` / `OR REPLACE` / `DROP POLICY IF EXISTS` throughout) and
safe to re-run.

## CSV → Supabase mapping

| CSV canonical column | Supabase column | Transform |
|---|---|---|
| `legacy_firebase_id` | `legacy_firebase_id` | direct |
| `tanggal` | `tanggal` | CSV `YYYY-MM-DD` string → `date` (already validated strictly by `csvMigration.js`) |
| `operator` | `operator` | direct |
| `invoice_code` | `invoice_code` | direct (empty string → consider `NULL` at import time for cleanliness, not required) |
| `customer` | `customer` | direct |
| `deskripsi` | `deskripsi` | direct |
| `jumlah_unit` | `jumlah_unit` | direct (already validated as integer > 0) |
| `harga_per_unit` | `harga_per_unit` | direct (already validated as number >= 0) |
| `durasi_menit` | `durasi_menit` | direct (already validated as integer >= 0) |
| `total_penghasilan` | *(not inserted)* | **Not written.** Column is `GENERATED`; Postgres computes it from `jumlah_unit * harga_per_unit`. The CSV value is used only for the pre-import drift check in `csvMigration.js`, which already ran before any row reaches this stage. |
| `created_at` | `created_at` | direct — inserted explicitly, not left to the column default, to preserve original history |
| *(none)* | `updated_at` | left to its `now()` default at insert time |
| *(none)* | `id` | generated by Postgres (`gen_random_uuid()`); Firestore doc ID is preserved separately in `legacy_firebase_id`, never reused as the primary key |

## Reconciliation queries

See `supabase/reconciliation_queries.sql` — row count, Total Pemasukan,
Unit Terproduksi, Runtime Mesin Total, earliest/latest `tanggal`, duplicate
`legacy_firebase_id` detection, and a `total_penghasilan` integrity check.
Reference/validation tooling only; not run against production in this
phase.

## Rollback considerations

- This phase makes **zero** changes to Firebase or to the running
  application — there is nothing to roll back on the app side.
- On the Supabase side, the entire foundation is one migration file. If it
  needs to be undone before any real data is imported, drop the objects it
  created (table, functions, trigger, policies) — safe to do since no
  production data will exist in this table until a later phase explicitly
  imports it.
- Because CSV import is the primary migration transport (per the
  pre-migration audit) and Firebase remains untouched throughout, the
  legacy Firebase project continues to serve as the actual source of
  truth and rollback path until an explicit, later cutover decision is
  made.

## Supabase project status (as checked in this phase)

No Supabase project for CG Laser Tracker exists yet under the
`ciptadigi-design` organization (org id `hgeqrrppilyfgvqpwfzg` — confirmed
via `supabase orgs list`; `supabase projects list` returned zero projects).
This phase intentionally stops short of provisioning one — that is an
infrastructure/billing action outside "database foundation design," and is
called out as the next manual step rather than performed automatically.
