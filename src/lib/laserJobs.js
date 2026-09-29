import { supabase } from './supabase';

const TABLE = 'laser_jobs';

// Supabase/PostgREST caps a single response at 1000 rows by default. A plain
// SELECT would silently truncate history once the table passes that size, so
// fetchAllJobs pages through .range() until a page comes back short.
const PAGE_SIZE = 1000;

// A single INSERT statement (one .insert() call with an array of rows) is one
// atomic Postgres statement: it succeeds or fails as a whole. That gives true
// atomicity for a CSV import up to this many rows in one call. Splitting a
// larger file into multiple chunks means each chunk is atomic on its own, but
// the import as a whole is NOT atomic across chunks — an earlier chunk can
// already be committed when a later one fails. See insertMigrationRows below.
const MIGRATION_CHUNK_SIZE = 500;

function toInt(value) {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toNumber(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Builds the insert payload for an ordinary, app-created job.
 * total_penghasilan is never included: it is a GENERATED ALWAYS AS STORED
 * column and Postgres rejects any attempt to write it directly.
 * legacy_firebase_id is always null here — only CSV migration rows set it.
 */
export function toNewJobPayload(formData) {
  return {
    legacy_firebase_id: null,
    tanggal: formData.tanggal,
    operator: formData.operator,
    invoice_code: formData.invoice_code || null,
    customer: formData.customer || null,
    deskripsi: formData.deskripsi || null,
    jumlah_unit: toInt(formData.jumlah_unit),
    harga_per_unit: toNumber(formData.harga_per_unit),
    durasi_menit: toInt(formData.durasi_menit),
  };
}

/** Builds the update payload for an edited job. Never touches id, legacy_firebase_id, total_penghasilan, created_at. */
export function toUpdatePayload(job) {
  return {
    tanggal: job.tanggal,
    operator: job.operator,
    invoice_code: job.invoice_code || null,
    customer: job.customer || null,
    deskripsi: job.deskripsi || null,
    jumlah_unit: toInt(job.jumlah_unit),
    harga_per_unit: toNumber(job.harga_per_unit),
    durasi_menit: toInt(job.durasi_menit),
  };
}

/**
 * Maps one validated CSV row (from csvMigration.validateRow) to a Supabase
 * insert payload. total_penghasilan is deliberately dropped: the CSV value
 * was already checked against jumlah_unit * harga_per_unit during
 * validation, and the database recomputes it itself.
 */
export function toMigrationRowPayload(validatedRow) {
  return {
    legacy_firebase_id: validatedRow.legacy_firebase_id,
    tanggal: validatedRow.tanggal,
    operator: validatedRow.operator,
    invoice_code: validatedRow.invoice_code || null,
    customer: validatedRow.customer || null,
    deskripsi: validatedRow.deskripsi || null,
    jumlah_unit: validatedRow.jumlah_unit,
    harga_per_unit: validatedRow.harga_per_unit,
    durasi_menit: validatedRow.durasi_menit,
    created_at: validatedRow.created_at,
  };
}

/** Fetches every row in laser_jobs, paging past the PostgREST row cap. Sorted by tanggal desc, matching prior app behavior. */
export async function fetchAllJobs() {
  const rows = [];
  let from = 0;
  for (;;) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('tanggal', { ascending: false })
      .range(from, to);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

export async function insertJob(formData) {
  const { data, error } = await supabase
    .from(TABLE)
    .insert(toNewJobPayload(formData))
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateJob(id, job) {
  const { data, error } = await supabase
    .from(TABLE)
    .update(toUpdatePayload(job))
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteJob(id) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw error;
}

/**
 * Maps one validated legacy-format row (from csvMigration.validateLegacyRow)
 * to a Supabase insert payload. No legacy_firebase_id (the source format has
 * no document ID to carry over — never fabricate one) and no created_at
 * (the source format has no original timestamp; Postgres' own default
 * applies, which is why this is disclosed to the caller as a real loss of
 * historical accuracy, not silently absorbed).
 */
export function toLegacyImportPayload(validatedRow) {
  return {
    legacy_firebase_id: null,
    tanggal: validatedRow.tanggal,
    operator: validatedRow.operator,
    invoice_code: validatedRow.invoice_code || null,
    customer: validatedRow.customer || null,
    deskripsi: validatedRow.deskripsi || null,
    jumlah_unit: validatedRow.jumlah_unit,
    harga_per_unit: validatedRow.harga_per_unit,
    durasi_menit: validatedRow.durasi_menit,
  };
}

/**
 * One-time legacy CSV migration path. Writes ALL rows in a single atomic
 * INSERT statement (caller/parseLegacyImportCsv already caps the file at
 * LEGACY_IMPORT_MAX_ROWS so this never needs chunking). Re-checks the table
 * is empty against the live database right before writing — not just the
 * caller's in-memory state — so a second accidental run is blocked even if
 * the UI hasn't refreshed.
 */
export async function insertLegacyMigrationRows(validatedRows) {
  const { count, error: countError } = await supabase
    .from(TABLE)
    .select('*', { count: 'exact', head: true });
  if (countError) throw countError;
  if (count > 0) {
    throw new Error(
      `laser_jobs already has ${count} row(s). Legacy import requires an empty table and can only run once.`
    );
  }

  const payloads = validatedRows.map(toLegacyImportPayload);
  const { error } = await supabase.from(TABLE).insert(payloads);
  if (error) throw error;
  return { inserted: payloads.length };
}

/**
 * Writes pre-validated migration rows (already passed through
 * csvMigration.parseImportCsv, so headers/types/duplicates are already
 * clean). Chunks at MIGRATION_CHUNK_SIZE; each chunk is one atomic INSERT.
 * NOT atomic across chunks — if chunk 2 fails, chunk 1 is already committed.
 * The unique constraint on legacy_firebase_id is the final safety net against
 * re-import, on top of the in-memory duplicate check already performed.
 */
export async function insertMigrationRows(validatedRows) {
  const payloads = validatedRows.map(toMigrationRowPayload);
  const chunked = payloads.length > MIGRATION_CHUNK_SIZE;
  let inserted = 0;
  const failedChunks = [];

  for (let i = 0; i < payloads.length; i += MIGRATION_CHUNK_SIZE) {
    const chunk = payloads.slice(i, i + MIGRATION_CHUNK_SIZE);
    const { error } = await supabase.from(TABLE).insert(chunk);
    if (error) {
      failedChunks.push({ startIndex: i, count: chunk.length, message: error.message });
    } else {
      inserted += chunk.length;
    }
  }

  return {
    total: payloads.length,
    inserted,
    failed: payloads.length - inserted,
    failedChunks,
    chunked,
    // True only when the whole file fit in one chunk and that chunk succeeded
    // or failed as a unit — i.e. the import as a whole was one atomic write.
    fullyAtomic: !chunked,
  };
}
