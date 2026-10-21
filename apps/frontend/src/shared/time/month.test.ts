import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  currentMonth,
  dateInMonth,
  daysInMonth,
  formatDate,
  formatMonthLabel,
  parseMonth,
  todayOf,
} from './month';

// Fixed local-midday clocks: the same calendar day in every time zone, including CI (UTC).
const clockAt = (year: number, month: number, day: number) => () => new Date(year, month - 1, day, 12, 0, 0);

describe('F1 — month helpers (deterministic dates)', () => {
  it('T-MONTH-1: steps across year boundaries in both directions', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2027-01', -1)).toBe('2026-12');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-11', 2)).toBe('2027-01');
    expect(addMonths('2026-10', 0)).toBe('2026-10');
  });

  it('T-MONTH-2: derives the current month and day only from the injected clock', () => {
    expect(currentMonth(clockAt(2026, 12, 31))).toBe('2026-12');
    expect(currentMonth(clockAt(2027, 1, 1))).toBe('2027-01');
    expect(todayOf(clockAt(2026, 12, 31))).toBe('2026-12-31');
    expect(todayOf(clockAt(2027, 1, 1))).toBe('2027-01-01');
  });

  it('T-MONTH-3: handles leap February', () => {
    expect(daysInMonth('2028-02')).toBe(29);
    expect(dateInMonth('2028-02', 29)).toBe('2028-02-29');
    expect(daysInMonth('2027-02')).toBe(28);
    expect(dateInMonth('2027-02', 29)).toBeNull();
    expect(dateInMonth('2026-12', 31)).toBe('2026-12-31');
    expect(dateInMonth('2026-12', 0)).toBeNull();
  });

  it('T-MONTH-4: rejects malformed or out-of-range month values', () => {
    for (const value of ['2026-13', '2026-00', '2026-1', '26-10', '2026-10x', '', ' 2026-10', '1999-12', '2100-01']) {
      expect(parseMonth(value), value).toBeNull();
    }
    expect(parseMonth(undefined)).toBeNull();
    expect(parseMonth('2026-10')).toBe('2026-10');
    expect(parseMonth('2027-01')).toBe('2027-01');
  });

  it('T-MONTH-5: formats German labels without time-zone or DST shifts', () => {
    expect(formatMonthLabel('2027-01')).toBe('Januar 2027');
    expect(formatMonthLabel('2026-12')).toBe('Dezember 2026');
    // 25.10.2026 is the end of daylight saving time in Germany.
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(formatDate('2026-10-25')).toBe('So., 25.10.2026');
    expect(formatDate('2026-12-31')).toBe('Do., 31.12.2026');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(formatDate('2027-01-01')).toBe('Fr., 01.01.2027');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });
});
