-- CG Laser Tracker — post-migration reconciliation queries
--
-- Reference/validation tool only. NOT part of the schema migration and
-- NOT meant to run automatically. Use these manually after a production
-- CSV import into Supabase to reconcile against the Firebase dashboard
-- snapshot captured before export.
--
-- Do not execute against production data as part of Phase 3A.

-- A. Row count
select count(*) as row_count
from public.laser_jobs;

-- B. Total Pemasukan (compare against the Firebase dashboard figure
--    captured immediately before export)
select coalesce(sum(total_penghasilan), 0) as total_pemasukan
from public.laser_jobs;

-- C. Unit Terproduksi
select coalesce(sum(jumlah_unit), 0) as unit_terproduksi
from public.laser_jobs;

-- D. Runtime Mesin Total (minutes)
select coalesce(sum(jumlah_unit * durasi_menit), 0) as runtime_menit_total
from public.laser_jobs;

-- E. Earliest record
select min(tanggal) as earliest_tanggal
from public.laser_jobs;

-- F. Latest record
select max(tanggal) as latest_tanggal
from public.laser_jobs;

-- G. Duplicate legacy_firebase_id detection
-- Expected: zero rows. The UNIQUE constraint should make this structurally
-- impossible post-migration, but this is a cheap independent sanity check.
select legacy_firebase_id, count(*) as occurrences
from public.laser_jobs
where legacy_firebase_id is not null
group by legacy_firebase_id
having count(*) > 1;

-- H. total_penghasilan integrity check
-- Expected: zero rows. total_penghasilan is a GENERATED column
-- (jumlah_unit * harga_per_unit), so a mismatch here would indicate the
-- generated-column definition itself was altered, not a data-entry error —
-- treat any result as a schema-integrity incident, not a data-cleanup task.
select id, legacy_firebase_id, jumlah_unit, harga_per_unit, total_penghasilan,
       (jumlah_unit * harga_per_unit) as expected_total
from public.laser_jobs
where total_penghasilan <> (jumlah_unit * harga_per_unit);

-- Supplementary: spot-check a random sample of historical records
-- (Section M of the pre-migration audit — manual eyeball comparison
-- against the pre-migration CSV backup).
select *
from public.laser_jobs
order by random()
limit 20;
