import { describe, it, expect } from 'vitest';
import {
  monthBounds, shiftYearMonth, formatYearMonth,
  isValidCustomRange, resolvePeriodRange,
} from './period';

describe('monthBounds', () => {
  it('returns inclusive first/last day for a 30-day month', () => {
    expect(monthBounds(2026, 9)).toEqual({ start: '2026-09-01', end: '2026-09-30' });
  });

  it('returns inclusive first/last day for a 31-day month', () => {
    expect(monthBounds(2026, 1)).toEqual({ start: '2026-01-01', end: '2026-01-31' });
  });

  it('handles February in a leap year', () => {
    expect(monthBounds(2028, 2)).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });

  it('handles February in a non-leap year', () => {
    expect(monthBounds(2026, 2)).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });
});

describe('shiftYearMonth', () => {
  it('moves to the previous month within the same year', () => {
    expect(shiftYearMonth(2026, 9, -1)).toEqual({ year: 2026, month: 8 });
  });

  it('moves to the next month within the same year', () => {
    expect(shiftYearMonth(2026, 9, 1)).toEqual({ year: 2026, month: 10 });
  });

  it('wraps to the previous year across a January boundary', () => {
    expect(shiftYearMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
  });

  it('wraps to the next year across a December boundary', () => {
    expect(shiftYearMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  });

  it('supports navigating into a future month arbitrarily far ahead', () => {
    expect(shiftYearMonth(2026, 9, 6)).toEqual({ year: 2027, month: 3 });
  });
});

describe('formatYearMonth', () => {
  it('formats a month/year as an Indonesian label', () => {
    expect(formatYearMonth(2026, 9)).toBe('September 2026');
  });
});

describe('isValidCustomRange', () => {
  it('accepts start before end', () => {
    expect(isValidCustomRange('2026-09-01', '2026-09-30')).toBe(true);
  });

  it('accepts start equal to end (single-day range)', () => {
    expect(isValidCustomRange('2026-09-15', '2026-09-15')).toBe(true);
  });

  it('rejects start after end', () => {
    expect(isValidCustomRange('2026-09-30', '2026-09-01')).toBe(false);
  });

  it('rejects missing start or end', () => {
    expect(isValidCustomRange('', '2026-09-30')).toBe(false);
    expect(isValidCustomRange('2026-09-01', '')).toBe(false);
  });
});

describe('resolvePeriodRange', () => {
  it('resolves monthly mode to inclusive month bounds', () => {
    expect(resolvePeriodRange({ mode: 'monthly', year: 2026, month: 9 }))
      .toEqual({ mode: 'range', start: '2026-09-01', end: '2026-09-30' });
  });

  it('resolves current-month monthly mode (default) correctly', () => {
    const result = resolvePeriodRange({ mode: 'monthly', year: 2026, month: 9 });
    expect(result.start).toBe('2026-09-01');
    expect(result.end).toBe('2026-09-30');
  });

  it('resolves a future month the same way as any other month', () => {
    expect(resolvePeriodRange({ mode: 'monthly', year: 2027, month: 3 }))
      .toEqual({ mode: 'range', start: '2027-03-01', end: '2027-03-31' });
  });

  it('resolves custom range with inclusive boundaries', () => {
    expect(resolvePeriodRange({ mode: 'custom', startDate: '2026-06-05', endDate: '2026-06-20' }))
      .toEqual({ mode: 'range', start: '2026-06-05', end: '2026-06-20' });
  });

  it('throws on an invalid custom range (start after end)', () => {
    expect(() => resolvePeriodRange({ mode: 'custom', startDate: '2026-06-20', endDate: '2026-06-05' }))
      .toThrow();
  });

  it('resolves all-time mode with no date bounds', () => {
    expect(resolvePeriodRange({ mode: 'all' })).toEqual({ mode: 'all' });
  });
});
