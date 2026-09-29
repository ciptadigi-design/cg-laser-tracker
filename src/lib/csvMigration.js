import Papa from 'papaparse';

// Canonical column order for the migration-safe CSV transport.
// legacy_firebase_id + created_at are included so the export/import round trip
// is lossless and can later be replayed into a different backend (Supabase).
export const CANONICAL_HEADERS = [
  'legacy_firebase_id',
  'tanggal',
  'operator',
  'invoice_code',
  'customer',
  'deskripsi',
  'jumlah_unit',
  'harga_per_unit',
  'durasi_menit',
  'total_penghasilan',
  'created_at',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INT_RE = /^-?\d+$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const TOTAL_TOLERANCE = 0.01;

export function isValidDateString(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isValidIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  return !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseStrictInt(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!INT_RE.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

function parseStrictNumber(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!NUMBER_RE.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Maps live laser_jobs records to canonical export rows.
 * legacy_firebase_id comes from the record's own legacy_firebase_id column
 * (null/blank for normal Supabase-native rows, set only for rows carried
 * over from the original Firestore migration) — never from the row's own
 * primary key.
 */
export function buildExportRows(jobs) {
  return jobs.map((job) => ({
    legacy_firebase_id: job.legacy_firebase_id ?? '',
    tanggal: job.tanggal ?? '',
    operator: job.operator ?? '',
    invoice_code: job.invoice_code ?? '',
    customer: job.customer ?? '',
    deskripsi: job.deskripsi ?? '',
    jumlah_unit: job.jumlah_unit ?? '',
    harga_per_unit: job.harga_per_unit ?? '',
    durasi_menit: job.durasi_menit ?? '',
    total_penghasilan: job.total_penghasilan ?? '',
    created_at: job.created_at ?? '',
  }));
}

/** RFC 4180-compatible CSV serialization (quoting handled by Papa Parse). */
export function exportJobsToCsv(jobs) {
  const rows = buildExportRows(jobs);
  return Papa.unparse(rows, { columns: CANONICAL_HEADERS, newline: '\r\n' });
}

/**
 * Validates a single parsed CSV row against the canonical migration schema.
 * Never falls back to `parseInt(value) || 0` — an invalid value is a hard error.
 */
export function validateRow(rawRow, rowNumber) {
  const errors = [];
  const get = (key) => (rawRow[key] ?? '').toString().trim();

  const legacy_firebase_id = get('legacy_firebase_id');
  if (!isNonEmptyString(legacy_firebase_id)) errors.push('legacy_firebase_id is required');

  const tanggal = get('tanggal');
  if (!isValidDateString(tanggal)) errors.push('tanggal must be a valid YYYY-MM-DD date');

  const operator = get('operator');
  if (!isNonEmptyString(operator)) errors.push('operator is required');

  const jumlah_unit = parseStrictInt(rawRow.jumlah_unit);
  if (jumlah_unit === null || jumlah_unit <= 0) errors.push('jumlah_unit must be a valid integer > 0');

  const harga_per_unit = parseStrictNumber(rawRow.harga_per_unit);
  if (harga_per_unit === null || harga_per_unit < 0) errors.push('harga_per_unit must be a valid number >= 0');

  const durasi_menit = parseStrictInt(rawRow.durasi_menit);
  if (durasi_menit === null || durasi_menit < 0) errors.push('durasi_menit must be a valid integer >= 0');

  const total_penghasilan = parseStrictNumber(rawRow.total_penghasilan);
  if (total_penghasilan === null) errors.push('total_penghasilan must be a valid number');

  const created_at = get('created_at');
  if (!isValidIsoTimestamp(created_at)) errors.push('created_at must be a valid ISO timestamp');

  if (jumlah_unit !== null && harga_per_unit !== null && total_penghasilan !== null) {
    const expected = jumlah_unit * harga_per_unit;
    if (Math.abs(expected - total_penghasilan) > TOTAL_TOLERANCE) {
      errors.push(
        `total_penghasilan mismatch: stored=${total_penghasilan}, expected=${expected} (jumlah_unit * harga_per_unit)`
      );
    }
  }

  const invoice_code = get('invoice_code');
  const customer = get('customer');
  const deskripsi = get('deskripsi');

  return {
    rowNumber,
    valid: errors.length === 0,
    errors,
    data:
      errors.length === 0
        ? {
            legacy_firebase_id,
            tanggal,
            operator,
            invoice_code,
            customer,
            deskripsi,
            jumlah_unit,
            harga_per_unit,
            durasi_menit,
            total_penghasilan,
            created_at,
          }
        : null,
  };
}

/**
 * Full pre-flight pipeline: parse -> validate headers -> validate every row ->
 * check duplicates. Never returns a partial "some rows ok" result — callers
 * only ever get ok:true (all rows ready to write) or ok:false (write nothing).
 */
export function parseImportCsv(csvText, existingJobs = []) {
  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  if (parsed.errors && parsed.errors.length > 0) {
    return {
      ok: false,
      stage: 'parse',
      headerErrors: [],
      rowErrors: [],
      duplicateErrors: [],
      message: `CSV parse error: ${parsed.errors.map((e) => `${e.message} (row ${e.row})`).join('; ')}`,
      rows: [],
    };
  }

  const fields = parsed.meta.fields || [];
  const missingHeaders = CANONICAL_HEADERS.filter((h) => !fields.includes(h));
  if (missingHeaders.length > 0) {
    return {
      ok: false,
      stage: 'headers',
      headerErrors: missingHeaders,
      rowErrors: [],
      duplicateErrors: [],
      message: `Missing required column(s): ${missingHeaders.join(', ')}`,
      rows: [],
    };
  }

  // +2: header occupies row 1, data starts at row 2
  const validations = parsed.data.map((row, idx) => validateRow(row, idx + 2));
  const rowErrors = validations.filter((v) => !v.valid);

  if (rowErrors.length > 0) {
    return {
      ok: false,
      stage: 'validation',
      headerErrors: [],
      rowErrors,
      duplicateErrors: [],
      message: `${rowErrors.length} invalid row(s) found`,
      rows: [],
    };
  }

  const validRows = validations.map((v) => v.data);

  const seenInCsv = new Map();
  const duplicateErrors = [];
  validRows.forEach((row, idx) => {
    const rowNumber = validations[idx].rowNumber;
    if (seenInCsv.has(row.legacy_firebase_id)) {
      duplicateErrors.push({
        legacy_firebase_id: row.legacy_firebase_id,
        rows: [seenInCsv.get(row.legacy_firebase_id), rowNumber],
        reason: 'duplicate legacy_firebase_id within CSV',
      });
    } else {
      seenInCsv.set(row.legacy_firebase_id, rowNumber);
    }
  });

  const previouslyImportedIds = new Set(
    existingJobs
      .map((j) => j.legacy_firebase_id)
      .filter((v) => typeof v === 'string' && v.length > 0)
  );
  validRows.forEach((row, idx) => {
    if (previouslyImportedIds.has(row.legacy_firebase_id)) {
      duplicateErrors.push({
        legacy_firebase_id: row.legacy_firebase_id,
        rows: [validations[idx].rowNumber],
        reason: 'legacy_firebase_id already imported previously',
      });
    }
  });

  if (duplicateErrors.length > 0) {
    return {
      ok: false,
      stage: 'duplicates',
      headerErrors: [],
      rowErrors: [],
      duplicateErrors,
      message: `${duplicateErrors.length} duplicate migration identity issue(s) found`,
      rows: [],
    };
  }

  return {
    ok: true,
    stage: 'ready',
    headerErrors: [],
    rowErrors: [],
    duplicateErrors: [],
    message: `${validRows.length} row(s) validated`,
    rows: validRows,
  };
}
