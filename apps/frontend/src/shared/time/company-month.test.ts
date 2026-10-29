import { describe, expect, it } from 'vitest';
import {
  earliestPossibleCompanyMonth,
  futureMonthCertainty,
  isCertainlyPastMonth,
  latestPossibleCompanyMonth,
} from './company-month';

// All instants are absolute (UTC, "Z"), so results do not depend on the time zone of the test runner.
const at = (iso: string) => new Date(iso);

describe('SP-08b F-2 — earliest possible company month (UTC-12 .. UTC+14)', () => {
  it('is the UTC month of "now - 12 h"', () => {
    expect(earliestPossibleCompanyMonth(at('2026-12-15T12:00:00Z'))).toBe('2026-12');
    // 1 Nov 11:59 UTC is still 31 Oct 23:59 at UTC-12.
    expect(earliestPossibleCompanyMonth(at('2026-11-01T11:59:59Z'))).toBe('2026-10');
    // From 1 Nov 12:00 UTC on, every zone (also UTC-12) is in November.
    expect(earliestPossibleCompanyMonth(at('2026-11-01T12:00:00Z'))).toBe('2026-11');
  });

  it('year boundary', () => {
    expect(earliestPossibleCompanyMonth(at('2027-01-01T11:59:59Z'))).toBe('2026-12');
    expect(earliestPossibleCompanyMonth(at('2027-01-01T12:00:00Z'))).toBe('2027-01');
  });

  it('UTC+14 being already in the next month does not make the previous month "past"', () => {
    // 31 Oct 10:00 UTC = 1 Nov 00:00 at UTC+14, but 30 Oct 22:00 at UTC-12.
    const now = at('2026-10-31T10:00:00Z');
    expect(isCertainlyPastMonth('2026-10', now)).toBe(false);
    expect(isCertainlyPastMonth('2026-09', now)).toBe(true);
  });
});

describe('SP-08b F-2 — certainly past months', () => {
  it('browser Berlin (already November), company New York (still October): October is NOT locked', () => {
    // 2026-11-01T03:30Z = Berlin 04:30 on 1 Nov, New York 23:30 on 31 Oct.
    expect(isCertainlyPastMonth('2026-10', at('2026-11-01T03:30:00Z'))).toBe(false);
  });

  it('browser Berlin (still October), company Tokyo (already November): October is offered; the server decides', () => {
    // 2026-10-31T16:00Z = Berlin 17:00 on 31 Oct, Tokyo 01:00 on 1 Nov.
    expect(isCertainlyPastMonth('2026-10', at('2026-10-31T16:00:00Z'))).toBe(false);
  });

  it('real historical months stay locked; the current and future months never are', () => {
    const now = at('2026-12-15T12:00:00Z');
    expect(isCertainlyPastMonth('2026-11', now)).toBe(true);
    expect(isCertainlyPastMonth('2025-12', now)).toBe(true);
    expect(isCertainlyPastMonth('2026-12', now)).toBe(false);
    expect(isCertainlyPastMonth('2027-01', now)).toBe(false);
  });

  it('does not depend on the local time zone methods of Date', () => {
    const now = at('2026-11-01T03:30:00Z');
    // A Date whose LOCAL fields would claim November everywhere must not change the UTC-based result.
    const local = Object.assign(new Date(now.getTime()), { getMonth: () => 10, getFullYear: () => 2026 });
    expect(isCertainlyPastMonth('2026-10', local)).toBe(false);
  });
});

describe('#73 R2-a — latest possible company month and the future-month hint (UTC-12 .. UTC+14)', () => {
  it('the latest month is the UTC month of "now + 14 h", also across the year boundary', () => {
    // 31 Oct 09:59:59 UTC is still 31 Oct 23:59:59 at UTC+14; from 10:00 on, UTC+14 is in November.
    expect(latestPossibleCompanyMonth(at('2026-10-31T09:59:59Z'))).toBe('2026-10');
    expect(latestPossibleCompanyMonth(at('2026-10-31T10:00:00Z'))).toBe('2026-11');
    expect(latestPossibleCompanyMonth(at('2026-12-31T09:59:59Z'))).toBe('2026-12');
    expect(latestPossibleCompanyMonth(at('2026-12-31T10:00:00Z'))).toBe('2027-01');
  });

  it('mid-month: the current month is never removable, the next one always', () => {
    const now = at('2026-12-15T12:00:00Z');
    expect(futureMonthCertainty('2026-11', now)).toBe('never');
    expect(futureMonthCertainty('2026-12', now)).toBe('never');
    expect(futureMonthCertainty('2027-01', now)).toBe('always');
    expect(futureMonthCertainty('2028-06', now)).toBe('always');
  });

  it.each([
    // [instant, month, expected, why]
    ['2026-11-30T09:59:59Z', '2026-12', 'always', 'no zone (not even UTC+14) has reached December yet'],
    ['2026-11-30T10:00:00Z', '2026-12', 'uncertain', 'UTC+14 is in December, UTC-12 still in November'],
    ['2026-11-30T23:30:00Z', '2026-12', 'uncertain', 'Berlin already December (refused), New York still November (removable)'],
    ['2026-12-01T11:59:59Z', '2026-12', 'uncertain', 'UTC-12 is still in November'],
    ['2026-12-01T12:00:00Z', '2026-12', 'never', 'every zone (also UTC-12) is in December'],
    ['2026-12-31T10:00:00Z', '2027-01', 'uncertain', 'year boundary: UTC+14 is in January'],
    ['2026-12-31T23:30:00Z', '2027-01', 'uncertain', 'year boundary: Berlin January, New York December'],
    ['2027-01-01T12:00:00Z', '2027-01', 'never', 'year boundary: every zone is in January'],
    ['2026-12-31T23:30:00Z', '2027-02', 'always', 'the month after the boundary month is future everywhere'],
  ] as const)('at %s, %s is %s (%s)', (instant, month, expected, _why) => {
    expect(futureMonthCertainty(month, at(instant))).toBe(expected);
  });

  it('a correct device clock never hides a month that is removable in some zone', () => {
    // Every hour of a month change: if any zone in UTC-12..UTC+14 has the month in the future, it is not 'never'.
    for (let hour = -30; hour <= 30; hour += 1) {
      const now = new Date(Date.UTC(2026, 11, 1, 0, 0, 0) + hour * 3_600_000);
      const futureSomewhere = [-12, -5, 0, 1, 9, 14].some((offset) => {
        const local = new Date(now.getTime() + offset * 3_600_000);
        return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}` < '2026-12';
      });
      if (futureSomewhere) expect(futureMonthCertainty('2026-12', now), now.toISOString()).not.toBe('never');
    }
  });
});
