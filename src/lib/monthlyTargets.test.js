import { describe, it, expect, vi } from 'vitest';

// Chainable Supabase query-builder stub: every method returns `this` except
// the terminal ones (maybeSingle/single), which resolve with the captured
// call info so each test can assert on what was actually queried/written.
function makeSupabaseStub({ selectResult = { data: null, error: null }, upsertResult = { data: null, error: null } } = {}) {
  const calls = { eq: [], upsert: null };
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((col, val) => { calls.eq.push([col, val]); return builder; }),
    maybeSingle: vi.fn(() => Promise.resolve(selectResult)),
    upsert: vi.fn((payload, opts) => { calls.upsert = { payload, opts }; return builder; }),
    single: vi.fn(() => Promise.resolve(upsertResult)),
  };
  return { supabase: { from: vi.fn(() => builder) }, calls, builder };
}

describe('fetchMonthlyTarget', () => {
  it('queries by year and month and returns the row when one exists', async () => {
    const row = { id: 'target-1', year: 2026, month: 9, revenue_target: 20000000, unit_target: 2000 };
    const { supabase, calls } = makeSupabaseStub({ selectResult: { data: row, error: null } });
    vi.doMock('./supabase', () => ({ supabase }));
    const { fetchMonthlyTarget } = await import('./monthlyTargets');

    const result = await fetchMonthlyTarget(2026, 9);
    expect(result).toEqual(row);
    expect(calls.eq).toEqual([['year', 2026], ['month', 9]]);
    vi.doUnmock('./supabase');
    vi.resetModules();
  });

  it('returns null when no target row exists for that month', async () => {
    const { supabase } = makeSupabaseStub({ selectResult: { data: null, error: null } });
    vi.doMock('./supabase', () => ({ supabase }));
    const { fetchMonthlyTarget } = await import('./monthlyTargets');

    const result = await fetchMonthlyTarget(2026, 11);
    expect(result).toBeNull();
    vi.doUnmock('./supabase');
    vi.resetModules();
  });

  it('throws when the query errors', async () => {
    const { supabase } = makeSupabaseStub({ selectResult: { data: null, error: new Error('boom') } });
    vi.doMock('./supabase', () => ({ supabase }));
    const { fetchMonthlyTarget } = await import('./monthlyTargets');

    await expect(fetchMonthlyTarget(2026, 9)).rejects.toThrow('boom');
    vi.doUnmock('./supabase');
    vi.resetModules();
  });
});

describe('upsertMonthlyTarget payload shaping', () => {
  it('sends both fields when both are provided (revenue + units)', async () => {
    const { supabase, calls } = makeSupabaseStub({ upsertResult: { data: {}, error: null } });
    vi.doMock('./supabase', () => ({ supabase }));
    const { upsertMonthlyTarget } = await import('./monthlyTargets');

    await upsertMonthlyTarget(2026, 9, { revenueTarget: '20000000', unitTarget: '2000' });
    expect(calls.upsert.payload).toEqual({
      year: 2026, month: 9, revenue_target: 20000000, unit_target: 2000,
    });
    expect(calls.upsert.opts).toEqual({ onConflict: 'year,month' });
    vi.doUnmock('./supabase');
    vi.resetModules();
  });

  it('sends revenue only, leaving unit_target null', async () => {
    const { supabase, calls } = makeSupabaseStub({ upsertResult: { data: {}, error: null } });
    vi.doMock('./supabase', () => ({ supabase }));
    const { upsertMonthlyTarget } = await import('./monthlyTargets');

    await upsertMonthlyTarget(2026, 9, { revenueTarget: '20000000', unitTarget: '' });
    expect(calls.upsert.payload.revenue_target).toBe(20000000);
    expect(calls.upsert.payload.unit_target).toBeNull();
    vi.doUnmock('./supabase');
    vi.resetModules();
  });

  it('sends units only, leaving revenue_target null', async () => {
    const { supabase, calls } = makeSupabaseStub({ upsertResult: { data: {}, error: null } });
    vi.doMock('./supabase', () => ({ supabase }));
    const { upsertMonthlyTarget } = await import('./monthlyTargets');

    await upsertMonthlyTarget(2026, 9, { revenueTarget: '', unitTarget: '2000' });
    expect(calls.upsert.payload.revenue_target).toBeNull();
    expect(calls.upsert.payload.unit_target).toBe(2000);
    vi.doUnmock('./supabase');
    vi.resetModules();
  });

  it('sends both as null when neither is provided — clearing an existing target is allowed', async () => {
    const { supabase, calls } = makeSupabaseStub({ upsertResult: { data: {}, error: null } });
    vi.doMock('./supabase', () => ({ supabase }));
    const { upsertMonthlyTarget } = await import('./monthlyTargets');

    await upsertMonthlyTarget(2026, 9, { revenueTarget: '', unitTarget: '' });
    expect(calls.upsert.payload.revenue_target).toBeNull();
    expect(calls.upsert.payload.unit_target).toBeNull();
    vi.doUnmock('./supabase');
    vi.resetModules();
  });
});
