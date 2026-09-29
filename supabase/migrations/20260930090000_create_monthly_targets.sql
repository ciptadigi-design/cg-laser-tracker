-- CG Laser Tracker V2 — Phase 1: flexible monthly targets
--
-- One optional revenue target and/or one optional production unit target
-- per calendar month. No account/tenant model exists anywhere else in this
-- schema (see docs/SUPABASE_MIGRATION.md — single-shop app, role is
-- operator/admin only), so this table deliberately has no account_id /
-- tenant column either: it follows the same architecture as laser_jobs.
--
-- Idempotency: every statement below is safe to re-run (IF NOT EXISTS /
-- OR REPLACE / DROP POLICY IF EXISTS throughout), matching the convention
-- established in 20260929120000_create_laser_tracker_foundation.sql.

create table if not exists public.monthly_targets (
  id uuid primary key default gen_random_uuid(),

  year integer not null check (year between 2000 and 2100),
  month integer not null check (month between 1 and 12),

  -- Both optional: a valid row may set revenue only, units only, both, or
  -- (before either is filled in) neither.
  revenue_target numeric(16, 2) check (revenue_target >= 0),
  unit_target integer check (unit_target >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint monthly_targets_year_month_unique unique (year, month)
);

comment on table public.monthly_targets is
  'One optional revenue target and/or unit target per calendar month. No account/tenant scoping — matches laser_jobs, which has none either.';

drop trigger if exists monthly_targets_set_updated_at on public.monthly_targets;
create trigger monthly_targets_set_updated_at
  before update on public.monthly_targets
  for each row
  execute function public.set_updated_at();

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table public.monthly_targets enable row level security;

-- SELECT: any authenticated user (operator or admin) may read targets, so
-- KPI progress renders for every signed-in user — matches the
-- laser_jobs_select_authenticated policy. No anon policy: anonymous
-- sessions have zero access, same as laser_jobs.
drop policy if exists "monthly_targets_select_authenticated" on public.monthly_targets;
create policy "monthly_targets_select_authenticated"
  on public.monthly_targets
  for select
  to authenticated
  using (true);

-- INSERT/UPDATE: admin only, mirroring laser_jobs_update_admin_only. Only
-- an authenticated admin can set or change a monthly target; operators are
-- read-only here, same restriction the UI enforces for job edit/delete.
drop policy if exists "monthly_targets_insert_admin_only" on public.monthly_targets;
create policy "monthly_targets_insert_admin_only"
  on public.monthly_targets
  for insert
  to authenticated
  with check (public.current_user_role() = 'admin');

drop policy if exists "monthly_targets_update_admin_only" on public.monthly_targets;
create policy "monthly_targets_update_admin_only"
  on public.monthly_targets
  for update
  to authenticated
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

-- No DELETE policy: targets are corrected via UPDATE (set fields back to
-- NULL), not removed — keeps the admin surface area to exactly what the
-- product spec asks for (SELECT / INSERT / UPDATE).
