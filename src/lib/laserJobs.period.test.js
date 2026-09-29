import { describe, it, expect, vi } from 'vitest';

// Chainable Supabase query-builder stub for fetchJobsForPeriod/countAllJobs.
// Records which filter methods were called with what arguments so tests can
// assert the query itself, not just its result.
function makeSupabaseStub(pages) {
  let pageIndex = 0;
  const calls = { gte: [], lte: [], rangeCalls: [] };
  const builder = {
    select: vi.fn(() => builder),
    order: vi.fn(() => builder),
    gte: vi.fn((col, val) => { calls.gte.push([col, val]); return builder; }),
    lte: vi.fn((col, val) => { calls.lte.push([col, val]); return builder; }),
    range: vi.fn((from, to) => {
      calls.rangeCalls.push([from, to]);
      const page = pages[pageIndex] ?? [];
      pageIndex += 1;
      return Promise.resolve({ data: page, error: null });
    }),
  };
  return { supabase: { from: vi.fn(() => builder) }, calls };
}

describe('fetchJobsForPeriod', () => {
  it('applies gte/lte tanggal filters for a monthly/custom range', async () => {
    const { supabase, calls } = makeSupabaseStub([[{ id: '1' }]]);
    vi.doMock('./supabase', () => ({ supabase }));
    const { fetchJobsForPeriod } = await import('./laserJobs');

    await fetchJobsForPeriod({ mode: 'range', start: '2026-09-01', end: '2026-09-30' });
    expect(calls.gte).toEqual([['tanggal', '2026-09-01']]);
    expect(calls.lte).toEqual([['tanggal', '2026-09-30']]);
    vi.doUnmock('./supabase');
    vi.resetModules();
  });

  it('applies inclusive range boundaries exactly as given', async () => {
    const { supabase, calls } = makeSupabaseStub([[]]);
    vi.doMock('./supabase', () => ({ supabase }));
    const { fetchJobsForPeriod } = await import('./laserJobs');

    await fetchJobsForPeriod({ mode: 'range', start: '2026-06-05', end: '2026-06-05' });
    expect(calls.gte).toEqual([['tanggal', '2026-06-05']]);
    expect(calls.lte).toEqual([['tanggal', '2026-06-05']]);
    vi.doUnmock('./supabase');
    vi.resetModules();
  });

  it('applies no date filter for all-time mode', async () => {
    const { supabase, calls } = makeSupabaseStub([[{ id: '1' }, { id: '2' }]]);
    vi.doMock('./supabase', () => ({ supabase }));
    const { fetchJobsForPeriod } = await import('./laserJobs');

    const rows = await fetchJobsForPeriod({ mode: 'all' });
    expect(calls.gte).toEqual([]);
    expect(calls.lte).toEqual([]);
    expect(rows).toHaveLength(2);
    vi.doUnmock('./supabase');
    vi.resetModules();
  });

  it('returns an empty array for an empty period with no matching jobs', async () => {
    const { supabase } = makeSupabaseStub([[]]);
    vi.doMock('./supabase', () => ({ supabase }));
    const { fetchJobsForPeriod } = await import('./laserJobs');

    const rows = await fetchJobsForPeriod({ mode: 'range', start: '2026-01-01', end: '2026-01-31' });
    expect(rows).toEqual([]);
    vi.doUnmock('./supabase');
    vi.resetModules();
  });

  it('pages past the 1000-row PostgREST cap, filters staying applied on every page', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `a${i}` }));
    const page2 = [{ id: 'last' }];
    const { supabase, calls } = makeSupabaseStub([page1, page2]);
    vi.doMock('./supabase', () => ({ supabase }));
    const { fetchJobsForPeriod } = await import('./laserJobs');

    const rows = await fetchJobsForPeriod({ mode: 'range', start: '2026-01-01', end: '2026-12-31' });
    expect(rows).toHaveLength(1001);
    expect(calls.rangeCalls).toEqual([[0, 999], [1000, 1999]]);
    expect(calls.gte).toHaveLength(2); // filter re-applied on each page's query
    vi.doUnmock('./supabase');
    vi.resetModules();
  });
});
