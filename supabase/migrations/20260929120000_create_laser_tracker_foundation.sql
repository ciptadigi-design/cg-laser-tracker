-- CG Laser Tracker — Supabase foundation
-- Phase 3A: database/security foundation only. No application cutover,
-- no production data import happens in this migration.
--
-- Design notes / decisions are explained inline; the full rationale also
-- lives in docs/SUPABASE_MIGRATION.md.
--
-- Idempotency: every statement below is safe to re-run (IF NOT EXISTS /
-- OR REPLACE / DROP POLICY IF EXISTS guards throughout).

-- =====================================================================
-- 1. EXTENSIONS
-- =====================================================================
-- gen_random_uuid() has been part of Postgres core since v13; Supabase
-- runs newer versions, so no extension is strictly required. Kept here,
-- defensively, as a no-op if already satisfied by core.
create extension if not exists pgcrypto;

-- =====================================================================
-- 2. ROLE MODEL: public.profiles
-- =====================================================================
-- One row per Supabase Auth user, holding the app-level role.
-- Frontend button visibility is UX only — this table + the RLS policies
-- below are the real, server-enforced security boundary.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'operator' check (role in ('operator', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Users may read their own profile (e.g. to render admin-only UI).
-- Nobody can read/modify other profiles from the client; role changes are
-- an operator/admin bootstrap action performed via SQL (see docs), not via
-- the app, so there are intentionally no client-facing INSERT/UPDATE/DELETE
-- policies here.
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

-- Auto-provision a profile row (default role: operator) whenever a new
-- Supabase Auth user is created, so app code never has to manage this.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role)
  values (new.id, 'operator')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- Helper used by laser_jobs RLS policies. SECURITY DEFINER + owned by the
-- migration role (table owner) lets it read profiles without being blocked
-- by profiles' own RLS (table owners bypass RLS unless FORCE ROW LEVEL
-- SECURITY is set, which we deliberately do not set here).
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- =====================================================================
-- 3. TABLE: public.laser_jobs
-- =====================================================================
create table if not exists public.laser_jobs (
  id uuid primary key default gen_random_uuid(),

  -- Migration traceability/idempotency only. Nullable for ordinary,
  -- non-migrated application records; Postgres UNIQUE constraints treat
  -- multiple NULLs as distinct, so this is "unique whenever present" with
  -- no partial-index trickery required.
  legacy_firebase_id text unique,

  tanggal date not null,
  operator text not null check (btrim(operator) <> ''),
  invoice_code text,
  customer text,
  deskripsi text,

  jumlah_unit integer not null check (jumlah_unit > 0),
  harga_per_unit numeric(14, 2) not null check (harga_per_unit >= 0),
  durasi_menit integer not null check (durasi_menit >= 0),

  -- GENERATED column, not a CHECK constraint: see docs/SUPABASE_MIGRATION.md
  -- "Business integrity" section for the full rationale. Short version —
  -- a generated column makes an inconsistent total structurally
  -- impossible (the database computes it, the client cannot override it),
  -- which is strictly stronger than a CHECK that only rejects a
  -- client-supplied mismatch, and it sidesteps float/NUMERIC rounding
  -- edge cases a CHECK would otherwise need a tolerance band for.
  total_penghasilan numeric(16, 2) not null
    generated always as (jumlah_unit * harga_per_unit) stored,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.laser_jobs is
  'Laser production job log. Canonical target for Firebase laser_jobs CSV migration. total_penghasilan is DB-computed (see column comment); do not attempt to INSERT/UPDATE it directly.';
comment on column public.laser_jobs.legacy_firebase_id is
  'Original Firestore document ID, populated only for rows brought in via CSV migration. NULL for normal application-created rows.';
comment on column public.laser_jobs.total_penghasilan is
  'Generated column: jumlah_unit * harga_per_unit. Computed by Postgres; cannot drift from its inputs.';

-- =====================================================================
-- 4. updated_at MAINTENANCE
-- =====================================================================
-- Application code must never be responsible for setting updated_at.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists laser_jobs_set_updated_at on public.laser_jobs;
create trigger laser_jobs_set_updated_at
  before update on public.laser_jobs
  for each row
  execute function public.set_updated_at();

-- =====================================================================
-- 5. INDEXES
-- =====================================================================
-- tanggal: the dashboard/report view sorts and will eventually filter by
-- production date (already true in the current app's client-side sort);
-- this is the one genuinely hot access pattern for a table of this size.
create index if not exists idx_laser_jobs_tanggal on public.laser_jobs (tanggal desc);

-- legacy_firebase_id already has an implicit unique index from the UNIQUE
-- constraint above — no separate index needed.
--
-- invoice_code and created_at are deliberately NOT indexed: the app does
-- not currently filter/search by either, table volume is small (internal
-- single-shop job log), and an unjustified index only adds write overhead.
-- Revisit if/when invoice_code lookup or created_at-range reporting
-- becomes a real, frequent query pattern.

-- =====================================================================
-- 6. ROW LEVEL SECURITY
-- =====================================================================
alter table public.laser_jobs enable row level security;

-- SELECT: any authenticated user (operator or admin) can read the full
-- job history — matches current app behavior (all users see all jobs).
-- No anonymous/anon-key SELECT policy is created: see
-- "DECISION REQUIRED — public read access" in docs/SUPABASE_MIGRATION.md.
drop policy if exists "laser_jobs_select_authenticated" on public.laser_jobs;
create policy "laser_jobs_select_authenticated"
  on public.laser_jobs
  for select
  to authenticated
  using (true);

-- INSERT: authenticated users (any role) may create ordinary jobs
-- (legacy_firebase_id IS NULL). Only admin may insert a row carrying
-- legacy_firebase_id — i.e. only admin can run the CSV migration import.
-- There is intentionally NO policy for the `anon` role, so an
-- unauthenticated browser session cannot insert at all — see
-- "DECISION REQUIRED — operator login" in docs/SUPABASE_MIGRATION.md for
-- the product trade-off this implies versus the current no-login app.
drop policy if exists "laser_jobs_insert_operator_or_admin" on public.laser_jobs;
create policy "laser_jobs_insert_operator_or_admin"
  on public.laser_jobs
  for insert
  to authenticated
  with check (
    legacy_firebase_id is null
    or public.current_user_role() = 'admin'
  );

-- UPDATE: admin only. Normal operators cannot edit historical jobs.
drop policy if exists "laser_jobs_update_admin_only" on public.laser_jobs;
create policy "laser_jobs_update_admin_only"
  on public.laser_jobs
  for update
  to authenticated
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

-- DELETE: admin only.
drop policy if exists "laser_jobs_delete_admin_only" on public.laser_jobs;
create policy "laser_jobs_delete_admin_only"
  on public.laser_jobs
  for delete
  to authenticated
  using (public.current_user_role() = 'admin');

-- No production seed data is included in this migration.
