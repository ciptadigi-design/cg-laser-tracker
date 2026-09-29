import { supabase } from './supabase';

const TABLE = 'monthly_targets';

function toNumberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** Fetches the target row for one calendar month, or null if none is set. */
export async function fetchMonthlyTarget(year, month) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('year', year)
    .eq('month', month)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Creates or updates the target for one calendar month. Either field may be
 * left empty (mapped to null) — the product spec forbids forcing an admin
 * to fill in both. Uses the (year, month) unique constraint as the upsert
 * conflict target, so a month's target is always a single row.
 */
export async function upsertMonthlyTarget(year, month, { revenueTarget, unitTarget }) {
  const payload = {
    year,
    month,
    revenue_target: toNumberOrNull(revenueTarget),
    unit_target: toIntOrNull(unitTarget),
  };
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: 'year,month' })
    .select()
    .single();
  if (error) throw error;
  return data;
}
