import { describe, it, expect } from 'vitest';
import { computeStats, computeProgress } from './stats';

describe('computeStats', () => {
  it('sums income, units, and unit*duration runtime across jobs', () => {
    const jobs = [
      { total_penghasilan: 100000, jumlah_unit: 5, durasi_menit: 10 },
      { total_penghasilan: 200000, jumlah_unit: 3, durasi_menit: 20 },
    ];
    expect(computeStats(jobs)).toEqual({
      income: 300000,
      units: 8,
      duration: 5 * 10 + 3 * 20, // 50 + 60 = 110
    });
  });

  it('returns zeroed KPIs for an empty period (no jobs)', () => {
    expect(computeStats([])).toEqual({ income: 0, units: 0, duration: 0 });
  });

  it('tolerates missing/non-numeric fields by treating them as 0', () => {
    const jobs = [{ total_penghasilan: null, jumlah_unit: undefined, durasi_menit: 'x' }];
    expect(computeStats(jobs)).toEqual({ income: 0, units: 0, duration: 0 });
  });
});

describe('computeProgress', () => {
  it('returns null when no target is set', () => {
    expect(computeProgress(1000, null)).toBeNull();
    expect(computeProgress(1000, undefined)).toBeNull();
  });

  it('returns null for a non-positive target', () => {
    expect(computeProgress(1000, 0)).toBeNull();
  });

  it('computes progress below 100%', () => {
    expect(computeProgress(14500000, 20000000)).toBeCloseTo(72.5, 5);
  });

  it('computes progress at exactly 100%', () => {
    expect(computeProgress(2000, 2000)).toBe(100);
  });

  it('computes progress above 100% without clamping', () => {
    expect(computeProgress(22000000, 20000000)).toBeCloseTo(110, 5);
  });
});
