import { describe, it, expect } from 'vitest';
import { exportJobsToCsv, parseImportCsv, validateRow, CANONICAL_HEADERS } from './csvMigration';

const baseJob = {
  id: '11111111-1111-4111-8111-111111111111',
  legacy_firebase_id: 'firebase-doc-abc123',
  tanggal: '2026-01-15',
  operator: 'Budi',
  invoice_code: 'INV/CG/001',
  customer: 'PT Maju, Jaya',
  deskripsi: 'Laser logo "Premium"',
  jumlah_unit: 12,
  harga_per_unit: 35000,
  durasi_menit: 8,
  total_penghasilan: 420000,
  created_at: '2026-01-15T03:22:10.123Z',
};

function roundTrip(jobs, existingJobs = []) {
  const csv = exportJobsToCsv(jobs);
  const result = parseImportCsv(csv, existingJobs);
  return { csv, result };
}

describe('CSV export/import round trip', () => {
  it('preserves every canonical field for a normal record', () => {
    const { result } = roundTrip([baseJob]);
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.legacy_firebase_id).toBe(baseJob.legacy_firebase_id);
    expect(row.tanggal).toBe(baseJob.tanggal);
    expect(row.operator).toBe(baseJob.operator);
    expect(row.invoice_code).toBe(baseJob.invoice_code);
    expect(row.customer).toBe(baseJob.customer);
    expect(row.deskripsi).toBe(baseJob.deskripsi);
    expect(row.jumlah_unit).toBe(baseJob.jumlah_unit);
    expect(row.harga_per_unit).toBe(baseJob.harga_per_unit);
    expect(row.durasi_menit).toBe(baseJob.durasi_menit);
    expect(row.total_penghasilan).toBe(baseJob.total_penghasilan);
    expect(row.created_at).toBe(baseJob.created_at);
  });

  it('emits canonical headers in the recommended order', () => {
    const csv = exportJobsToCsv([baseJob]);
    const firstLine = csv.split(/\r?\n/)[0];
    expect(firstLine.split(',')).toEqual(CANONICAL_HEADERS);
  });

  it('survives a customer field containing a comma', () => {
    const job = { ...baseJob, customer: 'PT Maju, Jaya' };
    const csv = exportJobsToCsv([job]);
    expect(csv).toContain('"PT Maju, Jaya"');
    const { result } = roundTrip([job]);
    expect(result.ok).toBe(true);
    expect(result.rows[0].customer).toBe('PT Maju, Jaya');
  });

  it('survives a deskripsi field containing double quotes', () => {
    const job = { ...baseJob, deskripsi: 'Laser logo "Premium"' };
    const csv = exportJobsToCsv([job]);
    expect(csv).toContain('"Laser logo ""Premium"""');
    const { result } = roundTrip([job]);
    expect(result.ok).toBe(true);
    expect(result.rows[0].deskripsi).toBe('Laser logo "Premium"');
  });

  it('survives a deskripsi field containing an embedded newline', () => {
    const job = { ...baseJob, deskripsi: 'Grafir lensa\nsisi depan & belakang' };
    const { result } = roundTrip([job]);
    expect(result.ok).toBe(true);
    expect(result.rows[0].deskripsi).toBe('Grafir lensa\nsisi depan & belakang');
  });

  it('preserves an empty optional invoice_code', () => {
    const job = { ...baseJob, invoice_code: '' };
    const { result } = roundTrip([job]);
    expect(result.ok).toBe(true);
    expect(result.rows[0].invoice_code).toBe('');
  });

  it('preserves Indonesian text with diacritics/punctuation', () => {
    const job = { ...baseJob, customer: 'CV Berkah Jaya Sejahtera', deskripsi: 'Gravir piring kenang-kenangan, ukiran nama & tanggal' };
    const { result } = roundTrip([job]);
    expect(result.ok).toBe(true);
    expect(result.rows[0].customer).toBe(job.customer);
    expect(result.rows[0].deskripsi).toBe(job.deskripsi);
  });

  it('preserves large numeric values', () => {
    const job = { ...baseJob, jumlah_unit: 250000, harga_per_unit: 25000, total_penghasilan: 6250000000 };
    const { result } = roundTrip([job]);
    expect(result.ok).toBe(true);
    expect(result.rows[0].jumlah_unit).toBe(250000);
    expect(result.rows[0].harga_per_unit).toBe(25000);
    expect(result.rows[0].total_penghasilan).toBe(6250000000);
  });

  it('exports a normal Supabase-native record (legacy_firebase_id null) with a blank column, not the row id', () => {
    const nativeJob = { ...baseJob, id: '22222222-2222-4222-8222-222222222222', legacy_firebase_id: null };
    const csv = exportJobsToCsv([nativeJob]);
    const dataLine = csv.split(/\r?\n/)[1];
    expect(dataLine.startsWith(',')).toBe(true); // legacy_firebase_id is the first column and is blank
    expect(dataLine).not.toContain(nativeJob.id);
  });

  it('round-trips multiple mixed edge-case rows together', () => {
    const jobs = [
      baseJob,
      { ...baseJob, legacy_firebase_id: 'doc-2', customer: 'PT Maju, Jaya', invoice_code: '' },
      { ...baseJob, legacy_firebase_id: 'doc-3', deskripsi: 'Logo "Premium"\nedisi 2' },
    ];
    const { result } = roundTrip(jobs);
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r) => r.legacy_firebase_id)).toEqual(['firebase-doc-abc123', 'doc-2', 'doc-3']);
  });
});

describe('validateRow', () => {
  it('rejects a row with malformed date', () => {
    const { valid, errors } = validateRow({ ...baseJob, legacy_firebase_id: 'x', tanggal: '15/01/2026' }, 2);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('tanggal'))).toBe(true);
  });

  it('never coerces an invalid number to 0 — it fails instead', () => {
    const { valid, errors, data } = validateRow(
      { ...baseJob, legacy_firebase_id: 'x', jumlah_unit: '1.234.567', tanggal: baseJob.tanggal, created_at: baseJob.created_at },
      2
    );
    expect(valid).toBe(false);
    expect(data).toBeNull();
    expect(errors.some((e) => e.includes('jumlah_unit'))).toBe(true);
  });

  it('flags total_penghasilan drift instead of silently accepting it', () => {
    const { valid, errors } = validateRow(
      {
        legacy_firebase_id: 'x',
        tanggal: '2026-01-15',
        operator: 'Budi',
        invoice_code: '',
        customer: '',
        deskripsi: '',
        jumlah_unit: '10',
        harga_per_unit: '35000',
        durasi_menit: '8',
        total_penghasilan: '999999',
        created_at: '2026-01-15T03:22:10.123Z',
      },
      2
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('mismatch'))).toBe(true);
  });

  it('rejects a missing legacy_firebase_id', () => {
    const { valid, errors } = validateRow({ ...baseJob, legacy_firebase_id: '' }, 2);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('legacy_firebase_id'))).toBe(true);
  });

  it('rejects an invalid created_at timestamp', () => {
    const { valid, errors } = validateRow({ ...baseJob, legacy_firebase_id: 'x', created_at: 'not-a-date' }, 2);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('created_at'))).toBe(true);
  });
});

describe('parseImportCsv pre-flight gating', () => {
  it('rejects the whole import (zero rows returned) if any row is invalid', () => {
    const goodCsv = exportJobsToCsv([baseJob]);
    const badCsv = goodCsv.replace('2026-01-15', 'not-a-date');
    const result = parseImportCsv(badCsv);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('validation');
    expect(result.rows).toHaveLength(0);
  });

  it('rejects import when required headers are missing', () => {
    const result = parseImportCsv('tanggal,operator\n2026-01-15,Budi\n');
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('headers');
    expect(result.headerErrors.length).toBeGreaterThan(0);
  });

  it('rejects import on duplicate legacy_firebase_id within the same CSV', () => {
    const csv = exportJobsToCsv([baseJob, { ...baseJob }]); // same id twice
    const result = parseImportCsv(csv);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('duplicates');
  });

  it('rejects import when legacy_firebase_id was already imported previously', () => {
    const csv = exportJobsToCsv([baseJob]);
    const existingJobs = [{ legacy_firebase_id: baseJob.legacy_firebase_id }];
    const result = parseImportCsv(csv, existingJobs);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('duplicates');
  });

  it('accepts a clean CSV with no duplicates', () => {
    const csv = exportJobsToCsv([baseJob]);
    const result = parseImportCsv(csv, [{ legacy_firebase_id: 'some-other-id' }]);
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
  });
});
