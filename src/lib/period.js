// Period math for the dashboard filter. All boundaries are computed as
// plain 'YYYY-MM-DD' strings and compared lexically against the `tanggal`
// business date column — never through a Date object round trip, which
// would apply local/UTC timezone shifts and could move a transaction into
// the wrong month.

function pad2(n) {
  return String(n).padStart(2, '0');
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return DAYS_IN_MONTH[month - 1];
}

/** Returns { start, end } as 'YYYY-MM-DD' inclusive bounds for a calendar month. */
export function monthBounds(year, month) {
  const start = `${year}-${pad2(month)}-01`;
  const end = `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`;
  return { start, end };
}

/** { year, month } for the current local calendar month. */
export function currentYearMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

/** Adds `delta` calendar months to { year, month }, wrapping the year. */
export function shiftYearMonth(year, month, delta) {
  const zeroBased = (year * 12 + (month - 1)) + delta;
  const nextYear = Math.floor(zeroBased / 12);
  const nextMonth = (zeroBased % 12) + 1;
  return { year: nextYear, month: nextMonth };
}

const MONTH_NAMES = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

export function formatYearMonth(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** Validates a custom range: both dates present and start <= end (lexical, since both are 'YYYY-MM-DD'). */
export function isValidCustomRange(startDate, endDate) {
  if (!startDate || !endDate) return false;
  return startDate <= endDate;
}

/**
 * Resolves a period selection into a query descriptor for laserJobs fetch.
 * period: { mode: 'monthly', year, month } | { mode: 'custom', startDate, endDate } | { mode: 'all' }
 * Returns: { mode: 'range', start, end } | { mode: 'all' }
 */
export function resolvePeriodRange(period) {
  if (period.mode === 'monthly') {
    const { start, end } = monthBounds(period.year, period.month);
    return { mode: 'range', start, end };
  }
  if (period.mode === 'custom') {
    if (!isValidCustomRange(period.startDate, period.endDate)) {
      throw new Error('Rentang tanggal tidak valid: tanggal mulai harus sebelum atau sama dengan tanggal akhir.');
    }
    return { mode: 'range', start: period.startDate, end: period.endDate };
  }
  return { mode: 'all' };
}
