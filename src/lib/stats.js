// Validated KPI formulas, extracted so they can be unit tested independent
// of rendering. Do not change these without re-validating against the
// production dashboard — see docs/SUPABASE_MIGRATION.md.

/**
 * Total Pemasukan: SUM(total_penghasilan).
 * Unit Terproduksi: SUM(jumlah_unit).
 * Runtime Mesin Total: SUM(jumlah_unit * durasi_menit).
 */
export function computeStats(jobs) {
  return {
    income: jobs.reduce((acc, curr) => acc + (curr.total_penghasilan || 0), 0),
    units: jobs.reduce((acc, curr) => acc + (parseInt(curr.jumlah_unit) || 0), 0),
    duration: jobs.reduce((acc, curr) => acc + ((parseInt(curr.jumlah_unit) || 0) * (parseInt(curr.durasi_menit) || 0)), 0),
  };
}

/**
 * Percentage progress toward a target. Returns null when there is no
 * target to compare against (target is null/undefined/<=0). Never clamps
 * the returned number — callers may exceed 100.
 */
export function computeProgress(current, target) {
  if (target == null || target <= 0) return null;
  return (current / target) * 100;
}
