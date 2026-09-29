import { describe, it, expect, vi } from 'vitest';

// laserJobs.js imports the shared supabase client at module load time; stub
// it so these payload-mapping tests never touch the network.
vi.mock('./supabase', () => ({ supabase: {} }));

const { toNewJobPayload, toUpdatePayload, toMigrationRowPayload } = await import('./laserJobs');

describe('toNewJobPayload', () => {
  const formData = {
    tanggal: '2026-01-15',
    operator: 'Budi',
    invoice_code: 'INV/CG/001',
    customer: 'PT Maju',
    deskripsi: 'Grafir logo',
    jumlah_unit: '12',
    harga_per_unit: '35000',
    durasi_menit: '8',
  };

  it('never includes total_penghasilan — it is a GENERATED column', () => {
    const payload = toNewJobPayload(formData);
    expect(payload).not.toHaveProperty('total_penghasilan');
  });

  it('always sets legacy_firebase_id to null for a normal job', () => {
    const payload = toNewJobPayload(formData);
    expect(payload.legacy_firebase_id).toBeNull();
  });

  it('coerces numeric fields from form string input', () => {
    const payload = toNewJobPayload(formData);
    expect(payload.jumlah_unit).toBe(12);
    expect(payload.harga_per_unit).toBe(35000);
    expect(payload.durasi_menit).toBe(8);
  });

  it('normalizes empty optional strings to null', () => {
    const payload = toNewJobPayload({ ...formData, customer: '', invoice_code: '' });
    expect(payload.customer).toBeNull();
    expect(payload.invoice_code).toBeNull();
  });
});

describe('toUpdatePayload', () => {
  it('never includes id, total_penghasilan, created_at, or legacy_firebase_id', () => {
    const job = {
      id: 'some-uuid',
      legacy_firebase_id: null,
      tanggal: '2026-01-15',
      operator: 'Budi',
      invoice_code: '',
      customer: '',
      deskripsi: '',
      jumlah_unit: 5,
      harga_per_unit: 35000,
      durasi_menit: 8,
      total_penghasilan: 175000,
      created_at: '2026-01-15T00:00:00.000Z',
    };
    const payload = toUpdatePayload(job);
    expect(payload).not.toHaveProperty('id');
    expect(payload).not.toHaveProperty('total_penghasilan');
    expect(payload).not.toHaveProperty('created_at');
    expect(payload).not.toHaveProperty('legacy_firebase_id');
  });
});

describe('toMigrationRowPayload', () => {
  it('carries legacy_firebase_id and created_at through, but drops total_penghasilan', () => {
    const validatedRow = {
      legacy_firebase_id: 'firebase-doc-abc123',
      tanggal: '2026-01-15',
      operator: 'Budi',
      invoice_code: 'INV/CG/001',
      customer: 'PT Maju',
      deskripsi: 'Grafir logo',
      jumlah_unit: 12,
      harga_per_unit: 35000,
      durasi_menit: 8,
      total_penghasilan: 420000,
      created_at: '2026-01-15T03:22:10.123Z',
    };
    const payload = toMigrationRowPayload(validatedRow);
    expect(payload).not.toHaveProperty('total_penghasilan');
    expect(payload.legacy_firebase_id).toBe('firebase-doc-abc123');
    expect(payload.created_at).toBe('2026-01-15T03:22:10.123Z');
    expect(payload.jumlah_unit).toBe(12);
  });
});
